# 제품 중립 훅 연동 계획

상태: 과거 훅 설계 및 검증 기록 · 2026-10-24. 현재 제품은 MCP 전용 기본 기능으로 범위를 줄였으며 신규 등록은 MCP만 추가한다. 실제 제품 세션에서의 전체 흐름 검증은 남아 있다. 훅을 Claude Code·Codex의 선택 기능으로 다시 붙이는 설계는 [hooks-design.md](hooks-design.md)에 있다(2026-10-25, 구현 전). 설계 전반은 [SCAFFOLD.md](../SCAFFOLD.md)에 있다.

사용자 확정: 한 컴퓨터의 같은 OS 사용자에 공통 대합실 하나를 둔다. 등록은 User 범위로 고정하고 프로젝트·방 이름 선택을 제공하지 않는다. 실제 작업 경로는 참가자의 `working_directory`와 `workspace_id`로 구분한다.

현재 기능 범위: 참가·상태/편집 선언·요약·메시지는 MCP 도구로 처리한다. 에이전트가 작업 경계와 대기 전에 보고하며, 브리지는 연결 상태와 종료 정리만 처리한다. 정확한 턴 종료 감지·실제 파일 편집 자동 추적·호스트 세션 키를 이용한 자동 복원은 기본 기능에서 제외했다. 이하 제품별 훅 설계는 과거 설정 호환을 위한 기록이며 신규 설치 안내가 아니다.

## 1. 목적

훅은 호스트가 정해진 시점마다 실행하는 셸 명령이다. 모델을 거치지 않으므로 토큰을 거의 쓰지 않고, 다음 세 가지를 자동으로 처리한다.

- 참가자 식별: 호스트의 세션 식별자로 참가자를 만들거나 되찾는다. 모델이 핸들을 잃어도 이어진다.
- 기계적 상태 기록: 작업 중·대기 전환, 수정한 파일의 `editing` 등록과 회수.
- 메시지 알림: 사용자 입력 시점에 새 질문이 있으면 한 줄로 알린다.

작업 요약, 다음 할 일, 체크포인트처럼 모델만 아는 내용은 훅이 쓸 수 없다. 이것은 계속 모델이 `check_in`으로 남긴다.

[SCAFFOLD.md 1절](../SCAFFOLD.md#1-사용자-요구사항)의 요구대로 특정 제품에 종속되지 않아야 한다. 훅이 없는 호스트에서도 대합실은 MCP만으로 완결되어야 한다.

## 2. 제품별 훅 현황

조사일 2026-10-24. 구현 전에 공식 문서를 다시 확인하여 기존 제3자 자료의 이벤트와 주입 가능 여부를 아래처럼 보정했다. 오래된 호스트 버전에서는 일부 이벤트가 없을 수 있다.

| 제품 | 이벤트 | 설정 위치 | 문맥 주입 | 확인 수준 |
| --- | --- | --- | --- | --- |
| Claude Code | SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd | `.claude/settings.json` | SessionStart, UserPromptSubmit | 공식 문서 |
| Codex CLI | SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd | `.codex/hooks.json` 또는 `config.toml` | SessionStart, UserPromptSubmit | 공식 문서. Stop은 JSON 출력 |
| Gemini CLI | SessionStart, BeforeAgent, AfterTool, AfterAgent, SessionEnd | `.gemini/settings.json` | SessionStart, BeforeAgent | 공식 문서 |
| Cursor | sessionStart, beforeSubmitPrompt, afterFileEdit, stop, sessionEnd | `.cursor/hooks.json` | sessionStart의 `additional_context`. prompt 훅은 알림 주입 불가 | 공식 문서 |
| Copilot CLI | sessionStart, userPromptSubmitted, postToolUse, agentStop, sessionEnd | `.github/hooks/*.json`, `~/.copilot/hooks/*.json` | sessionStart의 `additionalContext`. 명령형 prompt 훅 출력은 무시됨 | 공식 문서 |

공통점: 셸 명령을 실행하고, 표준 입력으로 JSON을 넘기고, 표준 출력으로 결과를 받는다. 차이점: 이벤트 이름, 입력 필드 이름, 출력 형식, 설정 위치, 문맥 주입 가능 여부.

## 3. 구조

세 층으로 나눈다.

```
호스트 훅 ─▶ 어댑터 (제품별) ─▶ 내부 이벤트 ─▶ 훅 공통 로직 ─▶ RoomStore
MCP 도구 ───────────────────────────────────────────────────▶ RoomStore
```

1. **공통 바닥: MCP 도구와 `instructions`.** 모든 MCP 호스트에서 동작한다. 훅 없이도 기능이 완결되어야 한다.
2. **훅 공통 로직.** 아래 내부 이벤트 다섯 개를 제품과 무관하게 처리한다. 참가 등록, 상태 전환, `editing` 등록과 회수를 여기서 한 번만 구현한다.
3. **제품별 어댑터.** 그 제품의 입력 JSON을 내부 이벤트로 바꾸고, 결과를 그 제품의 출력 형식으로 쓴다. 설정 위치와 이벤트 정의도 가진다. 새 제품은 `src/modules/hooks/adapters`에 파일을 추가하고 레지스트리에 등록한다. 저장소·설정 병합 로직은 공통이다.

## 4. 내부 이벤트

| 내부 이벤트 | 동작 | 모델 문맥에 넣는 것 |
| --- | --- | --- |
| `session-start` | 세션 키로 참가 또는 복귀. 작업 폴더는 입력의 `cwd` | 핸들과 대합실 현황 서너 줄 |
| `prompt` | 상태를 `working`으로, 미확인 메시지 확인 | 질문이 있을 때만 한 줄. 본문은 넣지 않는다 |
| `file-edited` | 수정한 파일을 `editing`에 추가 | 없음 |
| `turn-end` | 상태를 `waiting`으로, `editing` 회수 | 없음 |
| `session-end` | 연결 끊김 기록, `editing` 회수 | 없음 |

제품 이벤트와의 대응:

| 내부 이벤트 | Claude Code | Codex CLI | Gemini CLI | Cursor | Copilot CLI |
| --- | --- | --- | --- | --- | --- |
| `session-start` | SessionStart | SessionStart | SessionStart | sessionStart | sessionStart |
| `prompt` | UserPromptSubmit | UserPromptSubmit | BeforeAgent | beforeSubmitPrompt | userPromptSubmitted |
| `file-edited` | PostToolUse (Edit·Write 계열) | PostToolUse | AfterTool (쓰기 도구) | afterFileEdit | postToolUse |
| `turn-end` | Stop | Stop | AfterAgent | stop | agentStop |
| `session-end` | SessionEnd | SessionEnd | SessionEnd | sessionEnd | sessionEnd |

## 5. 참가자 연결

세션 키는 `(host, session_id)`로 둔다. `agent` 테이블의 `host`, `host_session_id` 열과 고유 인덱스를 스키마 버전 2에서 추가했다. 스키마 3부터 모든 참가자는 공통 대합실을 사용하며 작업 폴더에 따라 나뉘지 않는다. 훅 핸들은 `meta.hook_handle_secret`과 세션 키의 HMAC으로 복원한다. 세션 ID만으로는 핸들을 유추할 수 없고, 공개 카드에는 핸들이 나오지 않는다.

- **문맥 주입이 되는 호스트**: `session-start`가 참가자를 만들고 핸들을 모델 문맥에 넣는다. 모델은 그 핸들로 MCP 도구를 부른다. 이어서 열기와 압축 뒤에도 같은 세션 키라 같은 참가자로 돌아온다. 압축 뒤 호스트가 `session-start`를 다시 보내면 핸들을 다시 넣는다.
- **주입이 안 되는 경우**: 같은 폴더라는 이유로 합치는 추정은 채택하지 않았다. 훅에서 받은 핸들을 `join.resume_handle`로 명시해 연결한다. 주입이 없거나 핸들을 잃고 일반 `join`을 부르면 별도 참가자가 된다. 지원하는 다섯 제품의 현재 공식 문서는 모두 세션 시작 주입을 제공하지만 실제 제품 동작은 별도 확인이 필요하다.
- 훅은 `check_in`을 호출하지 않는다. 메시지 수신 확인, 전달 커서, 모델의 요약·체크포인트를 건드리지 않는다. 세션 시작 없이 들어온 후속 이벤트와 `leave` 이후 늦게 도착한 이벤트는 무시한다. 부모 세션을 공유하는 서브에이전트 입력도 무시한다.

## 6. 공통 바닥 보강

훅이 없는 호스트를 위해 MCP 쪽도 보강한다.

- 미확인 메시지가 있으면 `check_in`뿐 아니라 도구 6개의 응답에 짧은 알림 필드를 붙인다. 예: `"inbox": { "questions": 1, "notes": 2 }`. 없으면 붙이지 않는다. `notes`는 질문 외 종류(note·reply·notice)를 합한 수다. 명시한 핸들의 참가자를 기준으로 계산하며 읽기만 해서는 확인 처리하지 않는다.
- 설치 안내에 AGENTS.md·CLAUDE.md·GEMINI.md용 짧은 사용 규칙 스니펫을 둔다.

## 7. 명령과 실행 규칙

```
concos hook <내부 이벤트> --host <claude|codex|gemini|cursor|copilot>
concos setup --host <제품> [--apply]
```

- 현재 `setup`은 MCP 항목만 미리 보여 주고 `--apply`일 때 쓴다. JSON 주석과 다른 설정을 보존하며 TOML에는 서버 테이블을 추가한다. 같은 설정은 중복 추가하지 않고, 기존 concos 설정과 충돌하거나 파싱할 수 없으면 쓰기 전에 중단한다. 기존 파일은 `.concos-backup-*`로 백업한다. 훅은 추가·삭제하지 않으며, 별도 훅 파일의 파싱 오류는 MCP 등록을 막지 않는다.
- 등록은 항상 User 설정에 저장한다. MCP 명령은 `concos mcp`, 훅 명령은 `concos hook <이벤트> --host <제품>`이다. 방 이름은 인수로 받지 않고 공통 대합실을 사용한다. 이전 등록의 `--room`·`--room-base64`는 호환용으로 허용하되 방을 나누지 않으며, `CONCOS_ROOM`은 더 이상 사용하지 않는다.
- 훅은 호출마다 Node 프로세스를 새로 띄운다. `npx`는 매번 수백 ms 이상 걸리므로 훅에는 전역 설치한 `concos`를 등록한다.
- 훅 실패가 호스트 작업을 막으면 안 된다. 오류는 로그로만 남기고 차단 의미가 없는 종료 코드로 끝낸다. 제품마다 요구하는 출력 형식은 어댑터가 맞춘다. 예를 들어 Codex의 Stop은 JSON 출력을 요구한다는 보고가 있다.
- 훅 하나의 처리 시간 목표는 100 ms 이내다. MCP SDK는 훅 실행 때 불러오지 않는다. 훅의 DB 잠금 대기는 100 ms, stdin 대기는 2초, 입력 상한은 1 MiB다. 최초 DB 생성·백업·잠금 경합은 일반 호출보다 오래 걸릴 수 있다.

## 8. 진행 단계

1. **공통 바닥 보강**: 모든 도구 응답에 미확인 알림 추가 → 검증: 메시지가 있을 때와 없을 때의 응답 크기 측정, 기존 테스트 통과.
2. **스키마 버전 2와 훅 공통 로직**: 세션 키 열 추가, 내부 이벤트 다섯 개 구현 → 검증: 버전 1 DB가 백업 후 버전 2로 올라가는지, 이벤트별 단위 테스트.
3. **Claude Code·Codex 어댑터**: 두 제품은 이벤트 모델이 같아 차이가 가장 작다 → 검증: 실제 두 호스트에서 참가, 편집 선언, 질문 알림, 종료 회수를 확인.
4. **`concos setup`**: 두 제품의 설정 생성 → 검증: 기존 설정이 있는 파일과 없는 파일 모두에서 결과 확인.
5. **Gemini CLI·Cursor·Copilot CLI 어댑터**: 각 공식 문서로 이벤트와 출력 형식을 확인한 뒤 추가 → 검증: 제품별 실제 호스트 확인. 문맥 주입이 안 되는 제품은 5절의 연결 규칙 결정 후 진행.

### 구현 및 검증 결과

- 1~5단계 코드 구현. 52개 자동 테스트와 타입 검사 통과. 스키마 1의 WAL 데이터를 포함한 백업, 백업 실패 시 마이그레이션 중단, 스키마 2 이행, 세션 복원, 동시 등록·편집, DB 잠금 시 훅 실패 격리, 모든 도구의 알림, 훅→MCP 연결, 설정 보존·중복 방지를 검증했다.
- 다섯 호스트의 공식 입력을 fixture로 구성하여 실제 `dist/cli.js` 자식 프로세스로 실행했다. Codex 0.164.0과 Claude Code 2.1.305의 `mcp get concos`로 임시 폴더에 생성한 설정의 인식도 확인했다. 실제 제품 세션에서 모델이 주입된 핸들을 쓰고 각 이벤트를 발생시키는 전체 흐름은 미검증이다.
- 대화형 CLI 추가 후 전체 73개 테스트와 타입 검사 통과. 등록 폼의 미리보기·승인, Enter·Esc·EOF 취소 시 쓰기 방지, 설정 중복·충돌 처리, 영어 화면, 메시지 확인 후 전송을 검증했다. 실제 Windows TTY에서 `concos` 기본 메뉴와 등록 폼 진입 및 Ctrl+C 종료를 확인했다.
- User·공통 대합실 전환 후 전체 78개 테스트와 타입 검사 통과. 서로 다른 프로젝트에서 방 인수 없이 훅·MCP·CLI가 같은 참가자와 메시지를 보고, 같은 User 설정에 중복 없이 등록되는지 검증했다. 스키마 3은 마이그레이션 백업 뒤 기존 방을 통합하며 핸들·작업 공간·체크포인트·메시지·수신 확인과 페이지 조회를 보존한다. 트리거로 다른 방 생성도 막는다.
- 등록 화면을 지원 클라이언트 목록으로 변경한 뒤 전체 79개 테스트와 타입 검사 통과. 클라이언트별 등록 상태 표시, 행에서 바로 미리보기·확인, 등록 후 상태 갱신 및 다른 클라이언트 연속 등록을 검증했다. 실제 Windows TTY에서도 목록 진입과 Ctrl+C 종료를 확인했다.
- MCP 전용 기본 기능으로 축소한 뒤 전체 81개 테스트와 타입 검사 통과. 다섯 클라이언트 모두 MCP 설정 하나만 생성하고, 별도 훅 파일을 읽거나 수정하지 않으며, Gemini처럼 파일을 공유할 때도 기존 훅을 보존하는지 검증했다. 훅 없이 상태 보고·메시지 교환·수신 확인·대기 상태 보고가 동작한다. 현재 MCP 등록 대상 목록은 레거시 훅 어댑터와 분리했다.
- User 전환 후 로컬 재측정: Windows, Node 24.19.0, 프로세스 시작 포함 20회. 최초 67.3 ms, 중앙값 57.4 ms, 95백분위 62.7 ms. 변경 없는 응답 62자, 미확인 수만 추가한 응답 96자(34자 증가), 수신 확인 후 62자. 문자 수는 커서·메시지 값에 따라 달라지며 모델 토큰 측정은 아니다.
- 재측정: `npm run build` 다음 `node scripts/measure-hooks.mjs`. 임시 로컬 DB만 사용한다.

## 9. 적용한 기본값과 남은 항목

- **`turn-end`의 `editing` 회수**: 턴마다 회수한다. 모델의 요약과 체크포인트는 유지한다.
- **참가자 연결**: 세션 키와 명시적 핸들만 사용한다. 폴더 기반 추정은 하지 않는다.
- **편집 수집 범위**: Claude의 Edit·Write·MultiEdit·NotebookEdit, Codex의 성공한 apply_patch, Gemini의 write_file·replace, Cursor의 afterFileEdit, Copilot의 create·edit·str_replace_editor·apply_patch를 처리한다. 임의 셸 명령의 파일 변경은 추측하지 않으며 이때는 MCP `check_in.editing`을 쓴다. 기존 카드 제한(20항목, 항목당 300자)을 적용한다.
- **Cursor·Copilot prompt 알림**: 상태는 갱신하지만 해당 명령형 이벤트가 문맥 출력을 지원하지 않으므로 질문 알림은 MCP 응답으로 제공한다. Cursor의 작업 위치가 다중 루트뿐이고 `cwd`가 없으면 임의로 첫 폴더를 선택하지 않는다.
- **실제 호스트 검증**: 설치·신뢰 승인 후 신규 참가, 재개·압축, 편집 선언, 질문 알림, 턴/세션 종료 회수를 제품별로 확인해야 한다. 현재 사용자 호스트 설정은 변경하지 않았다.
- **배포 형태**: Claude Code는 MCP 등록과 훅을 플러그인 하나로 묶을 수 있다. 다른 제품의 플러그인·확장 형태는 조사하지 않았다.

## 10. 설치 및 사용 규칙

아직 npm에 게시하지 않았으므로 저장소에서 전역 설치한 뒤 프로젝트 폴더에서 설정한다(2026-10-24 기준 기록. 0.1.0부터는 `npm install -g concos`로 설치한다).

```sh
npm install -g .
concos
```

대화형 CLI는 영어로 동작한다. `Register MCP`를 열면 지원하는 다섯 클라이언트와 현재 MCP 등록 상태가 바로 목록으로 나온다. 클라이언트 행을 고르면 실제 추가할 User MCP 설정을 미리 보여 주며, `y`를 입력하면 백업·적용한다. 적용 후 상태를 갱신한 목록으로 돌아가 다른 클라이언트를 이어서 등록할 수 있다. 훅 설치나 Scope·Project folder·Room 항목은 없다. 방향키와 Enter로 선택하고 Esc로 뒤로 간다. `concos config` 또는 `concos setup`으로 등록 목록을 바로 열 수 있다. `concos ui`는 명시적으로 전체 메뉴를 연다.

같은 메뉴에서 `Enter concos`, `Send a message`를 사용할 수 있다. 현황은 Agents·Messages 두 탭으로 보며 Tab 또는 ←/→로 전환한다. Agents 탭은 사람마다 이름·상태 줄과 막힘·작업·다음 할 일 줄을, Messages 탭은 최신 메시지의 한 줄 헤더와 본문 앞 세 줄을 보여 주고, 터미널에서는 열려 있는 동안 매초 갱신된다. 에이전트를 고르면 상세 카드와 최근 체크포인트를 보고 바로 메시지를 보낼 수 있다. 메시지는 수신자·본문을 확인한 후 전송한다. TTY가 아니면 명시적 메뉴 명령은 번호 또는 항목 키를 줄 단위로 받는다. EOF·Ctrl+C는 종료하며, 등록 확인에서 Enter만 누르거나 Esc로 나가면 쓰지 않는다. 기본 명령 `concos`는 TTY에서 메뉴를 열고 그 외에는 도움말을 출력한다.

제품을 지정하면 비대화형 명령으로 미리보기·적용한다.

```sh
concos setup --host codex
concos setup --host codex --apply
```

`--host`에는 `claude`, `gemini`, `cursor`, `copilot`도 가능하다. 등록은 User 범위이며 실행 폴더에 영향을 받지 않는다. `--scope project`는 거부한다. Codex의 `CODEX_HOME`, Copilot의 `COPILOT_HOME`을 지정하면 사용자 설정 위치에 반영한다. 호스트에서 MCP를 활성화한 후 새 세션을 연다. 이미 설치된 concos 훅이 있다면 MCP 전용 사용을 위해 호스트 설정에서 비활성화한다. MCP와 CLI가 같은 로컬 `CONCOS_HOME`을 사용해야 한다.

AGENTS.md·CLAUDE.md·GEMINI.md에 선택적으로 추가할 공통 스니펫:

```text
concos를 사용할 때 작업 시작 시 절대 작업 경로로 join한다.
훅이 준 handle이 있으면 resume_handle로 전달해 같은 참가자로 연결한다.
작업 경계·막힘·대기 전에 바뀐 요약과 다음 작업만 check_in한다.
inbox 또는 question을 받으면 read_messages로 읽는다. 받은 메시지는 다음 호출 때
자동으로 수신 확인된다. 응답이 필요하면 reply로 답한다.
작업 종료 시 leave한다. 타이머로 check_in하지 않는다.
```

## 공식 출처

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Gemini CLI hooks reference](https://geminicli.com/docs/hooks/reference/)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)
- [Cursor MCP](https://cursor.com/docs/mcp)
- [Copilot CLI MCP configuration](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)

### 초기 조사 자료 (구현 기준은 위 공식 문서)

- [Codex CLI Hooks: Complete Guide](https://codex.danielvaughan.com/2026/04/15/codex-cli-hooks-complete-guide-events-policy-patterns/)
- [Codex CLI Hooks: Lifecycle Governance](https://codex.danielvaughan.com/2026/05/17/codex-cli-hooks-lifecycle-pretooluse-posttooluse-governance-enforcement/)
- [Codex CLI Hooks: Events, Payloads, Exit Codes](https://www.turboai.dev/docs/codex/hooks)
- [Gemini CLI Hooks reference](https://geminicli.com/docs/hooks/reference/)
- [Gemini CLI hooks (mintlify)](https://www.mintlify.com/google-gemini/gemini-cli/reference/hooks)
- [AIコーディングCLIのHooks機能比較](https://lilting.ch/articles/gemini-cli-hooks-research)
- [Cursor hooks](https://cursor.com/docs/agent/hooks)
- [Cursor hooks deep dive (GitButler)](https://blog.gitbutler.com/cursor-hooks-deep-dive)
- [Cursor forum: hooks in 2.4.7](https://forum.cursor.com/t/hooks-in-2-4-7-are-still-not-working-properly/149431)
- [GitHub Copilot CLI hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference)
- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [About hooks for GitHub Copilot](https://docs.github.com/en/copilot/concepts/agents/hooks)
