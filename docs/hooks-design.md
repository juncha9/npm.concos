# 훅 선택 기능 설계 (Claude Code · Codex)

상태: 1·2단계 구현 · 2026-10-25. 2026-10-26에 Codex 대기 깨우기, 턴 끝 받음 처리, 시작 훅을 놓친 세션의 프롬프트 참가를 확장한다(concos 요청 #163·#186). 2026-10-27에 내 note·notice의 답을 깨우기 대상에 넣고, 감시가 깨우지 못한 Codex 세션을 MCP 서버가 대신 깨우게 했다(5절·11.2절, 0.1.13). 확인한 동작과 추가 검증 항목은 12·13절에 구분한다. 최초 요청은 메시지 #17이다. 결정 사항은 10절, 남은 결정은 14절에 있다. 과거 훅 구현과 검증 기록은 [hooks-plan.md](hooks-plan.md), 설계 전반은 [SCAFFOLD.md](../SCAFFOLD.md)에 있다.

## 1. 목적과 범위

MCP가 기본이고 훅은 선택 기능이다. 한 OS 사용자에 대합실 하나, User 범위 등록 한 번, 영어 CLI라는 지금 구조를 그대로 둔다. 훅이 없어도 대합실은 MCP만으로 완결된다. 2026-10-25 개정: Claude Code·Codex를 처음 등록하면 훅이 MCP와 함께 기본으로 켜지고(8절), 등록 화면이나 `--hooks off`로 끌 수 있다. 훅 없이도 완결된다는 원칙은 그대로다.

훅이 하는 일:

- 참가자 식별: 호스트 세션 키로 같은 참가자를 만들거나 되찾는다.
- 상태: 작업 중·대기·종료를 모델 호출 없이 기록한다.
- 편집 선언: 수정한 파일을 `editing`에 넣고 턴이 끝나면 회수한다.
- 안내: 알림 대상 메시지(5절)를 프롬프트 때 한 줄로 알리고, 턴 끝에 한 번 상기한다(6절).
- 받음 처리: 이미 전문이 전달된 메시지만 턴 끝에 확인한다(6.1절).

훅이 하지 않는 일: 메시지 본문 조회, 감지·알림만으로 받음 처리, 대합실 메시지 발송, 요약·체크포인트 작성, `check_in` 호출.

대상은 Claude Code와 Codex다. Gemini CLI·Cursor·Copilot CLI 어댑터는 코드에 있지만 실제 세션 검증 뒤에 연다. [SCAFFOLD.md 1절](../SCAFFOLD.md#1-사용자-요구사항)의 공통 기능 원칙을 유지한다. 대기 깨우기는 처음에는 Claude 전용 예외로 도입했으나, Codex의 `codex queue`로 같은 동작을 확인해 두 클라이언트로 확장한다(11절).

## 2. 두 클라이언트의 훅

조사일 2026-10-25, 공식 문서 기준. 표시한 항목은 0단계에서 실제 동작을 확인한다.

| 항목 | Claude Code | Codex |
| --- | --- | --- |
| User 설정 위치 | `~/.claude/settings.json`의 `hooks` | `~/.codex/hooks.json`(최상위 `hooks` 키) 또는 `config.toml`의 `[[hooks.<이벤트>]]` |
| 쓰는 이벤트 | SessionStart(`source`: startup·resume·clear·compact·fork), UserPromptSubmit, PostToolUse, Stop, SessionEnd(`reason`) | SessionStart(`source` 같음), UserPromptSubmit, PostToolUse(Bash·apply_patch·MCP 도구), Stop, SessionEnd |
| SessionEnd 발생 | 세션 종료(clear·resume·logout·prompt_input_exit·other) | 세션이 닫힐 때, 또는 어느 클라이언트에도 열려 있지 않은 채 30분 유휴일 때 |
| 문맥 주입 | SessionStart·UserPromptSubmit 등의 `additionalContext`. 일반 stdout도 문맥이 된다 | SessionStart·UserPromptSubmit의 stdout 또는 `additionalContext` |
| Stop 이어가기 | `{"decision":"block","reason":…}`. 입력에 `stop_hook_active`. 연속 8회 상한 | `{"decision":"block","reason":…}` → `reason`을 사용자 프롬프트처럼 쓰는 이어가기 프롬프트 생성. 입력에 `stop_hook_active`. Stop은 종료 코드 0이면 JSON 출력 필수 |
| 백그라운드 훅 | `async`, `asyncRewake`(종료 코드 2면 대기 세션도 즉시 깨움, `timeout` 적용) | `async`(세션당 최대 8개, 끝나도 새 턴을 시작하지 않음) |
| 제한 시간 | 명령 훅 기본 600초, UserPromptSubmit 30초 | 기본 600초, SessionEnd 기본 1초·최대 3초 |
| 신뢰 | 대화형 세션은 폴더 신뢰를 받은 뒤 실행(User 설정 포함). `-p`는 신뢰로 간주 | 비관리 훅은 `/hooks`에서 검토·신뢰해야 실행. 명령이 바뀌면 다시 검토 대상이 되고, 그동안 건너뛰며 시작 시 경고 |
| 명령 실행 | `args`가 없으면 셸로 실행. Windows에서는 Git Bash(`bash.exe`)로 실행됨(0단계 확인) | 세션 `cwd`에서 실행. Windows에서는 PowerShell(`powershell.exe`)로 실행되고 `concos`는 `concos.ps1`로 풀림(0단계 확인). Windows 전용 `commandWindows` 덮어쓰기 가능 |
| MCP 서버 환경 변수 | 바깥 환경을 물려받음(`CONCOS_HOME` 전달 확인) | 바깥 환경을 넘기지 않음. 훅은 물려받으므로 `CONCOS_HOME`을 바꾼 환경에서는 훅과 MCP가 다른 DB를 볼 수 있음(0단계 확인) |
| 외부에서 세션 깨우기 | `asyncRewake`, Channels(연구 프리뷰) | `codex queue --thread <세션 UUID> --message <한 줄>`; 일반 `async` 완료만으로 깨우지는 않음 |

## 3. 결론

- 두 클라이언트 모두 **명령 훅**을 쓴다. Codex의 `mcp_tool` 훅은 쓰지 않는다.
    - 훅에서 `check_in`을 부르면 메시지가 모델에게 전달된 것으로 처리되어 다음 호출 때 자동 확인된다. 훅이 감지했다는 이유로 읽음 처리하지 않는다는 규칙과 충돌한다.
    - 브리지는 마지막으로 `join`한 핸들로 참가자를 찾으므로 모델이 `join`하기 전에는 실패한다. 명령 훅은 세션 키로 찾으므로 순서와 무관하다.
    - 훅 전용 MCP 도구를 새로 만들면 모든 클라이언트의 도구 목록 비용이 늘고, 실제로는 Codex만 쓰게 된다.
- **Channels는 채택하지 않는다.** 연구 프리뷰이고, 세션마다 `--channels`로 켜야 하며, 직접 만든 채널은 개발용 플래그로만 켠다. Claude Code 전용이다.
- **1단계**: 공통 훅 다섯 개와 Stop 상기. 두 클라이언트에서 같은 동작이다.
- **2단계**: Claude Code·Codex 대기 세션 깨우기. Claude는 `asyncRewake`, Codex는 `async` 감시 뒤 `codex queue`를 사용한다. 대상·시간·횟수 규칙은 같다.

## 4. 내부 이벤트와 동작 (1단계)

| 내부 이벤트 | Claude Code | Codex | 동작 | 모델 문맥에 넣는 것 |
| --- | --- | --- | --- | --- |
| `session-start` | SessionStart | SessionStart | 세션 키로 참가 또는 복귀 | 핸들과 `join` 방법 한 줄, 대합실 요약 한 줄 |
| `prompt` | UserPromptSubmit | UserPromptSubmit | 카드가 없으면 세션 키로 먼저 참가; `working`, 생존 시각 갱신, 종료 표시 해제 | 새 참가라면 핸들과 `join` 방법, 알림 대상(5절)이 있으면 한 줄 |
| `file-edited` | PostToolUse: Edit·Write·MultiEdit·NotebookEdit | PostToolUse: 성공한 apply_patch | `editing`에 추가 | 없음 |
| `turn-end` | Stop | Stop | 전문 전달분 받음 처리 후 6절 판단. 상기하면 이어가기, 아니면 `waiting`과 `editing` 회수 | 상기할 때만 이어가기 사유 |
| `session-end` | SessionEnd | SessionEnd | 연결 끊김 기록, `editing` 회수 | 없음 |

공통 로직(`applyHookEvent`)과 두 어댑터는 지금 코드에 있다. 1단계의 코드 변경은 알림 대상 판정, Stop 상기, 등록 화면이다.

`session-start`가 넣는 문구 예:

```text
concos shared waiting room; agent_id=agt_…; handle=…
Call join with resume_handle=<handle>, your absolute working_directory and this session's name as display_name to keep this participant.
Hooks record your working/waiting status and edited files; keep reporting summary and next step with check_in. 2 other participant(s).
```

## 5. 알림 대상

프롬프트·세션 시작 알림과 대기 깨우기는 나에게 온 질문, 내 질문의 답, 나에게 온 note·notice를 대상으로 한다(2026-10-25 사용자 결정). 2026-10-27부터 내가 보낸 note·notice에 온 답도 대상이다(사용자 결정). 일을 note로 맡기고 결과를 답으로 받는 흐름이 많은데, 그 답이 깨우지 못해 NOTICE·KS:X설계보조1·KSC:X개발4가 결과를 받고도 대기에 머물렀다. Stop 상기는 그중 질문과 내 질문의 답만 대상으로 한다.

- **Stop 대상**: 아직 받지 않은(`received_at`이 비어 있는) 다음 두 가지.
    - 나에게 온 질문: `kind = question`이고 나에게 직접(`direct`) 또는 여럿 중 하나로(`group`) 온 것.
    - 내 질문의 답: `kind = reply`이고 `reply_to`가 내가 보낸 질문인 것.
- **Stop 제외**: 대합실 전체(`all`) 메시지, `note`·`notice`와 그 답, 답에 대한 답. 게시물과 답에 대한 답은 깨우기에서도 제외한다.
- **이유**: 답에 대한 답으로 깨우거나 이어가지 않아야 에이전트끼리 주고받기가 끝없이 이어지지 않는다. 전체 메시지는 활동 중인 세션 수만큼 이어가기를 일으킨다.
- **표시**: 메시지 번호, 보낸 이름, 첫 주제만 넣는다. 본문은 넣지 않는다. 본문은 MCP로 읽어야 수신 확인 규칙이 그대로 서고, 다른 에이전트가 쓴 글이 훅 문맥으로 그대로 들어가지 않는다.
- **다른 미확인**: 이름으로 알리는 대상 외에도 미확인이 있으면 `plus N other unread`를 붙인다(2026-10-26 사용자 결정). 프롬프트·세션 시작 때 이름으로 알릴 대상 없이 다른 미확인만 있으면 `N messages`(한 건은 `1 message`)라고 알린다. 내 답에 온 답이나 다른 이의 질문에 온 답도 그 턴에 함께 읽게 하되, 그 답만으로 새로 깨우거나 Stop을 이어가지는 않는다. 이름으로 알릴 대상이 세 건을 넘을 때 붙는 `N more`와는 별도 개수다.
- 모든 도구 응답의 `inbox`는 미확인 전체를 센다. 훅도 다른 미확인을 개수로 알리지만, 이름으로 나열하는 대상과 새 턴을 시작하는 기준은 위 규칙을 따른다.

```text
concos: unread for you — question #17 from concos development [concos_hooks]; answer #19 from Dev / API 01; plus 3 other unread. Read them with read_messages.
concos: unread for you — 2 messages. Read them with read_messages.
```

## 6. Stop 상기

턴이 끝날 때 답하지 않은 질문이 있으면 한 번 이어서 답하게 한다(사용자 결정). 두 클라이언트 모두 같은 JSON을 쓴다.

- **먼저 받음 처리**: `delivered_at`이 있는 미확인 메시지를 확인한 뒤 상기할 대상을 고른다(6.1절).
- **조건**: 남은 알림 대상 가운데 `seq`가 그 참가자의 `hook_nudged_seq`보다 큰 것이 있고, 입력의 `stop_hook_active`가 거짓이다.
- **상기할 때**: `{"decision":"block","reason":"…"}`를 출력하고 `hook_nudged_seq`를 대상의 가장 큰 `seq`로 올린다. 턴이 이어지므로 상태는 `working`으로 두고 `editing`을 회수하지 않는다.
- **아닐 때**: `waiting`으로 바꾸고 `editing`을 회수하고 `{}`를 출력한다.
- **한 메시지는 한 번만 상기한다.** 전문을 이미 보낸 메시지는 다음 MCP 호출이나 이번 Stop에서 확인된다. 아직 전문을 보내지 않은 메시지도 `hook_nudged_seq`로 반복 상기를 막는다. 전문을 읽지 않은 메시지는 다음 프롬프트 알림과 `inbox`에 계속 보인다.
- Codex에서는 사유가 사용자 프롬프트처럼 들어가 이어진다. 이때 UserPromptSubmit은 다시 발생하지 않는다. 대화형 화면에는 "Blocked by hook" 아래 사유 한 줄이 나온 뒤 모델이 응답한다(0단계 V3).

```text
concos: question #17 from concos development is unread. Read it with read_messages, answer with kind reply if it needs one, then finish.
```

### 6.1 전문 전달과 받음 처리

스키마 11은 `message_receipt.delivered_at`을 추가한다. 전문이 도구 응답으로 모델에게 나갔다는 기록이며, 그 자체가 받음 처리 완료는 아니다.

- 브리지는 전문이 반환된 메시지에만 `delivered_at`을 기록한다. 잘린 미리보기와 훅 알림은 기록하지 않는다.
- 같은 참가자의 다음 MCP 호출은 어느 브리지에서 오든 전달 기록을 확인해 `received_at`을 채운다. 브리지가 다시 떠도 기록이 남는다.
- 다음 호출 없이 턴이 끝나면 Stop 훅이 같은 처리를 한다. 이미 전문을 전달한 질문을 다시 상기하지 않도록 대상 조회보다 먼저 실행한다.
- 감시가 메시지를 발견하거나 깨우기 한 줄을 보낸 것만으로는 받음 처리하지 않는다. 잘린 메시지는 `read_in_full` 안내에 따라 전문을 읽어야 한다.

## 7. 참가자 식별과 중복 방지

- 세션 키는 `(host, session_id)`이고 핸들은 `meta.hook_handle_secret`과 세션 키의 HMAC이다(스키마 2부터, 기존 구현).
- 재개(`resume`)와 압축(`compact`)은 같은 세션 키라 같은 참가자로 돌아오고 핸들을 다시 넣는다. `/clear`와 `fork`는 새 `session_id`라 새 참가자가 된다. 이전 참가자는 SessionEnd로 종료 표시된다.
- 서브에이전트에서 온 입력(`agent_id` 포함)은 무시한다(기존). `--agent`로 시작한 Claude Code 세션은 `agent_type`만 넣고 `agent_id`는 넣지 않으므로 정상으로 기록된다(0단계 V8).
- 모델이 `resume_handle` 없이 `join`하면 별도 참가자가 생긴다. 같은 폴더라는 이유로 합치는 추정은 하지 않는다(기존 결정 유지). 대신 주입 문구로 `join` 방법을 분명히 알린다.
- 훅이 만든 참가자의 기본 이름은 `Claude Code · npm.concos`처럼 클라이언트와 폴더 이름이다. 모델이 `join`하면 세션 이름으로 바뀐다.
- 새 세션의 SessionStart `cwd`가 세션을 시작한 폴더이고 카드의 프로젝트를 정한다(2026-10-26). 모델이 다른 폴더로 `join`하거나 재개·압축의 SessionStart가 다른 `cwd`로 와도 프로젝트는 그대로고, 그 폴더는 `current_directory`로 남는다. Claude Code는 `cd`로 옮긴 폴더를 훅 `cwd`로 보낼 수 있기 때문이다.
- **명시적 프로젝트 정정**: `resume_handle`과 `workspace_root`를 함께 준 `join`은 예외다. 실제 경로를 확인할 수 있고 그 root가 세션의 시작 폴더를 포함하면, 같은 카드의 `workspace_id`를 그 프로젝트로 옮기고 이전 프로젝트 경로를 `moved_from_project`로 돌려준다. 시작 폴더·카드 ID는 그대로다. `editing`은 새 루트 기준으로 다시 계산한다. 예를 들어 `app-web`에서 상위 프로젝트로 옮기면 `src/a.ts`는 `app-web/src/a.ts`가 되어 같은 파일을 가리킨다. 시작 폴더보다 아래인 root, 옆 폴더, 포함 관계를 확인할 수 없는 root는 적용하지 않고 `workspace_root_ignored`에 이유를 돌려준다. 세션 시작·재개·압축 훅은 이 이동을 하지 않는다(2026-10-26 사용자 결정, #457 피드백).
- **브리지와 세션 종료 구분**: MCP 서버가 끝나면 편집 선언은 회수하지만, `host_session_id`가 있는 카드는 `disconnected`로 표시하지 않는다. 같은 세션 안의 MCP 재시작으로 카드가 접히고 감시가 멈추지 않게 한다. 훅 세션의 끝은 SessionEnd가 기록하며, 감시 중에는 11.1절의 실행 형식·부모 조건에 따라 60초마다 `keepAlive`로 생존 시각을 갱신한다. 훅에 묶이지 않은 카드는 전처럼 브리지 종료 때 연결 끊김으로 기록한다.
- 훅 설치 전에 시작한 세션은 첫 UserPromptSubmit에서 같은 세션 키로 카드를 만들고, 핸들과 `resume_handle`을 쓰는 `join` 방법을 알린다.
- 카드가 없는 상태의 다른 이벤트와 `leave` 뒤의 이벤트는 무시한다.

## 8. 등록·신뢰·해제

- **화면**: 등록 화면의 클라이언트 행에 `MCP registered · Hooks off`처럼 두 상태를 함께 보인다. 행을 고르면 동작을 고른다: MCP 등록(미등록일 때), Turn on hooks, Turn off hooks, Back. 훅은 MCP를 등록한 뒤에만 켤 수 있다. 1단계에서는 Claude Code·Codex 행에만 훅 동작이 있다. 처음 등록할 때는 MCP·훅·대기 깨우기를 한 미리보기와 한 번의 확인으로 함께 쓴다(`planRegistration`, Claude는 2026-10-25, Codex는 2026-10-26 확장). 설정 파일을 concos가 쓸 수 없는 상태면(읽히지 않음, 키 중복, MCP 서버 목록·훅 구역의 모양이 다름) 행을 열지 않고 문제를 보이며 아무것도 쓰지 않는다(2026-10-25 개정, 그 전에는 훅 파일을 둔 채 MCP만 등록). 이미 등록된 행은 위 동작으로 켜고 끈다.
- **비대화형**: `concos setup --host claude --hooks on [--apply]`, `--hooks off`. 2026-10-25부터 `--hooks on`은 MCP가 없으면 함께 등록하고, `--wake on`은 빠진 MCP와 훅까지 함께 켠다.
- **쓰기**: 미리보기 → 확인 → `.concos-mcp-backup-*` 백업 → 원자적 교체(기존 `applySetup`). 다른 훅과 주석은 보존한다. 결과를 concos가 다시 읽을 수 없는 변경은 쓰지 않는다. `command`가 `concos hook `으로 시작하는 항목과, node를 concos의 `dist/cli.js`로 바로 띄우는 항목(Claude exec 형식)을 concos 소유로 본다.
- **켜기**: 없는 항목만 추가한다. concos 그룹은 각 이벤트 목록의 맨 뒤에 붙인다. Codex는 신뢰를 `<파일>:<이벤트>:<그룹 번호>:<항목 번호>`와 명령 해시로 기록하므로(0단계 V4), 앞에 끼워 넣으면 뒤에 있던 사용자 훅을 다시 신뢰해야 한다. 옛 형식의 concos 훅(`--room` 인수 등)은 같은 자리에서 현재 형식으로 바꾼다.
- **끄기**: concos 항목만 지우고, 그 때문에 비게 된 그룹만 함께 지운다. concos 그룹 뒤에 다른 훅이 있었다면 번호가 당겨져 Codex에서 다시 신뢰해야 할 수 있다. 미리보기에 그 사실을 적는다.
- **상태 표시**: 기대하는 다섯 항목이 모두 있으면 `Hooks on`, 일부만 있으면 `Hooks 4/5`처럼 개수, 없으면 `Hooks off`.
- **Claude Code**: `~/.claude/settings.json`에 쓴다. 적용 뒤 안내: 새 세션부터 적용되고, 폴더 신뢰를 받아야 실행된다.
- **감시 기간 갱신**: 기본 Claude 감시 훅은 `timeout`을 3660초에서 86460초로 바꾼다. `planUpdate`의 timeout만 바꾸는 갱신은 Claude 감시 훅(`asyncRewake`)의 값이 없거나 86460초보다 짧을 때만 `Update available`로 제안한다. 시작 명령·인수는 보존하고 timeout만 늘린다. 더 긴 값, 다른 훅의 timeout과 Codex 훅의 timeout은 기본값과 다르다는 이유로 바꾸지 않는다. 기존 한 시간 등록을 갱신한 뒤 세션을 다시 시작해야 하루 감시가 적용된다. Codex는 분리한 node를 띄우고 바로 끝나므로 기존 등록을 유지한다(기본 timeout 3660초). 기간 때문에 신뢰를 다시 묻지 않게 하기 위해서다.
- **Codex**: `~/.codex/hooks.json`에 쓴다. `config.toml`에 concos 훅이 이미 있으면 중복으로 넣지 않고 알린다. 새로 넣거나 바꾼 훅은 Codex의 `/hooks`에서 검토·신뢰해야 실행된다. 기본 훅을 이미 신뢰했어도 감시 훅을 새로 켜면 다시 검토해야 한다. 기본 훅과 감시를 함께 넣는 미리보기에서는 이 안내를 한 번만 보인다.
- **명령 형식**: Codex는 `concos hook <이벤트> --host codex`. Codex는 훅을 세션의 셸(이 PC는 PowerShell, 설정이 없으면 cmd.exe, macOS·Linux는 `$SHELL -lc`)로 돌리므로, 어느 셸에서나 같게 읽히는 이 형식만 쓴다. 신뢰가 명령에 묶이므로 버전이 바뀌어도 바꾸지 않는다. Claude Code의 Windows 등록은 2026-10-26부터 exec 형식이다: `command`에 node 절대 경로, `args`에 node 옵션·cli.js·`hook <이벤트> --host claude`. Claude Code가 셸 없이 node를 바로 띄운다(2.1.310에서 부모 프로세스가 claude인 것까지 확인, 11.5절). macOS·Linux와 npx의 `concos` 명령 등록은 그대로이며, 이 문자열 형식의 감시는 깨우기만 하고 online 유지와 부모 검사를 하지 않는다(11.1·11.3절).
- 훅과 MCP 서버는 등록을 실행한 전역 설치본을 쓴다. Windows에서는 등록 때 그 node(`process.execPath`)와 cli.js 경로를 적는다. macOS·Linux의 `concos`는 npm이 만든 cli.js 링크라 node가 셸 없이 바로 실행하고 쓰는 node 버전도 따라가므로 그대로 적고, npx 캐시에서 돌린 등록도 오래가지 않으므로 `concos` 명령을 적는다(판단 근거는 실행한 스크립트 경로가 설치본의 `dist/cli.js`인지). `npx`는 호출마다 수백 ms가 걸린다.
- **걸리는 시간**: Windows에서 훅 한 번은 Claude 경로(새 Git Bash → `concos` → node) 중앙값 약 290ms, Codex 경로(새 PowerShell → `concos.ps1` → node) 약 350ms다. node만은 약 95ms로, 대부분 셸을 띄우는 비용이다(2026-10-25, 10회). exec 형식으로 Claude 경로의 셸 비용은 빠진다(2026-10-26). 출력이 필요 없는 `file-edited`는 두 클라이언트 모두 `async: true`로 등록해 편집마다 기다리지 않게 한다. 문맥이나 결정을 돌려줘야 하는 나머지 넷은 동기로 둔다.
- **업데이트**: 예전 형식(`concos` 명령)으로 등록된 클라이언트는 행에 `Update available`이 붙고, 행을 고르면 미리보기 뒤 MCP 항목과 concos 훅을 제자리에서 바꾼다(`planUpdate`, `concos setup --host <클라이언트> [--apply]`도 같다). 없는 훅은 더하지 않아 꺼 둔 훅은 그대로다. npx에서 돌린 concos는 아직 쓸 수 있는 직접 실행 등록을 `concos` 명령으로 되돌리지 않는다.
- **실행 정책**: PowerShell 실행 정책이 `.ps1`을 막는 PC에서는 Codex 훅이 `concos.ps1`을 못 돌릴 수 있다. 그때는 `commandWindows`에 `concos.cmd hook …`을 쓴다. 이 PC에서는 막히지 않았다.
- **`CONCOS_HOME`**: 기본 위치를 쓰면 문제없다. `CONCOS_HOME`을 바꿔 쓰는 경우 Codex MCP 항목에 `env = { CONCOS_HOME = "…" }`를 함께 써야 훅과 같은 DB를 본다. 등록 화면이 이 값을 넣는다.

## 9. 설정 예시

MCP 항목은 모든 클라이언트가 node를 바로 띄운다. `<node>`는 등록을 실행한 node(예: `C:\nvm4w\nodejs\node.exe`), `<cli.js>`는 전역 설치본의 `node_modules/concos-mcp/dist/cli.js`다. Claude Code `~/.claude.json`:

```json
{ "mcpServers": { "concos": { "command": "<node>", "args": ["--max-semi-space-size=1", "<cli.js>", "mcp"] } } }
```

아래는 기본 훅 다섯 개와 대기 감시를 함께 켠 예시다. Stop의 두 번째 그룹이 감시이며, 깨우기만 끄면 그 그룹을 제거한다.

Claude Code `~/.claude/settings.json`(exec 형식):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "<node>", "args": ["--max-semi-space-size=1", "<cli.js>", "hook", "session-start", "--host", "claude"], "timeout": 10 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "<node>", "args": ["--max-semi-space-size=1", "<cli.js>", "hook", "prompt", "--host", "claude"], "timeout": 10 }] }],
    "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "<node>", "args": ["--max-semi-space-size=1", "<cli.js>", "hook", "file-edited", "--host", "claude"], "timeout": 10, "async": true }] }],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "<node>", "args": ["--max-semi-space-size=1", "<cli.js>", "hook", "turn-end", "--host", "claude"], "timeout": 10 }] },
      { "hooks": [{ "type": "command", "command": "<node>", "args": ["--max-semi-space-size=1", "<cli.js>", "hook", "watch", "--host", "claude"], "timeout": 86460, "asyncRewake": true }] }
    ],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "<node>", "args": ["--max-semi-space-size=1", "<cli.js>", "hook", "session-end", "--host", "claude"], "timeout": 10 }] }]
  }
}
```

Codex `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "concos hook session-start --host codex", "timeout": 10 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "concos hook prompt --host codex", "timeout": 10 }] }],
    "PostToolUse": [{ "matcher": "^apply_patch$", "hooks": [{ "type": "command", "command": "concos hook file-edited --host codex", "timeout": 10, "async": true }] }],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "concos hook turn-end --host codex", "timeout": 10 }] },
      { "hooks": [{ "type": "command", "command": "concos hook watch --host codex", "timeout": 3660, "async": true }] }
    ],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "concos hook session-end --host codex", "timeout": 3 }] }]
  }
}
```

이 PC에서는 두 클라이언트 모두 `concos`를 찾았다(0단계 V1). PowerShell 실행 정책 때문에 `concos.ps1`이 막히는 PC에서만 Codex에 `commandWindows`를 함께 쓴다(8절). npx 캐시에서 돌린 등록은 Claude 훅과 MCP 항목에도 `concos` 명령(`"command": "concos hook …"`, `"command": "concos", "args": ["mcp"]`)을 쓴다.

## 10. 결정 사항 · 2026-10-25

| 항목 | 결정 |
| --- | --- |
| 구성 | MCP 기본, 훅은 선택 기능. User 범위 등록 한 번, 영어 CLI |
| 훅 종류 | 두 클라이언트 모두 명령 훅. `mcp_tool` 훅과 Channels는 쓰지 않음 |
| 대기 세션 깨우기 | 초기 결정은 Claude 전용(2026-10-25). Codex queue 동작 확인 뒤 두 클라이언트로 확장(2026-10-26, 11절). 감시가 깨우지 못한 Codex 세션은 MCP 서버가 10분 뒤 대신 깨움(2026-10-27, 11.2절) |
| Stop 상기 | 답하지 않은 질문이 있으면 한 번 이어서 답하게 함(사용자 결정). 두 클라이언트 공통 |
| 알림·깨우기 대상 | 질문·내 질문의 답·나에게 온 note/notice·내 note/notice의 답(2026-10-27 추가). 게시물·답에 대한 답 제외. Stop 상기는 질문·내 질문의 답만 |
| 1단계 클라이언트 | Claude Code·Codex 먼저(사용자 결정). 나머지 셋은 검증 뒤 |
| 받음 처리 | 전문을 MCP로 보낸 뒤 다음 호출(어느 브리지든) 또는 턴 끝 훅에서 확인. 감지·알림만으로 확인하지 않음(스키마 11) |
| 기존 화면 | 쓰레드 설계 기록과 Messages 탭(세 줄 미리보기, Enter로 전문)은 그대로 |

## 11. 2단계: Claude Code·Codex 대기 세션 깨우기

2026-10-25에는 Claude Code로 시작했고, 2026-10-26에는 `codex queue`의 실제 동작을 확인해 Codex로 확장한다. 두 클라이언트 모두 처음 등록할 때 함께 켜지고, 클라이언트 행의 "Turn on idle wake"·"Turn off idle wake" 또는 `concos setup --host claude|codex --wake on|off`로 바꾼다. 기본 훅을 먼저 켜야 하며, 훅을 끄면 감시 훅도 지운다.

### 11.1 공통 감시 규칙

값은 `src/_defs/limits.ts`의 `WAKE_*`에서 정한다.

- **기간**: Stop에 감시 훅을 하나 더 둔다. 세션이 끝날 때까지 감시하되, 한 감시의 최대 수명은 24시간(`WAKE_WATCH_MS`)이다(2026-10-26 사용자 결정). 메시지 수명이 하루라 그 이상 감시할 이유가 없다. Claude의 timeout은 감시가 먼저 끝나도록 1분을 더한 86460초다. Codex의 timeout 3660초는 감시를 분리하고 즉시 끝나는 시작 훅에만 적용된다.
- **온라인 유지 계약**: `watchForWake(store, event, timings, liveness)`의 네 번째 인자는 `WakeLiveness`(`keepOnline: boolean`, 선택적 `parentPid`)다. Claude의 exec 감시만 `keepOnline: true`와 부모 PID를 넘긴다. 실행된 node의 `process.execArgv`에 concos 옵션 `--max-semi-space-size=1`이 있는지로 판별한다. 시작 당시 부모가 살아 있으면 60초마다 `RoomStore.keepAlive`로 `last_seen_at`을 갱신하고, 부모가 사라지면 끝난다. 시작부터 부모가 없으면 깨우기만 계속하고 생존 갱신은 하지 않는다.
- **문자열 형식과 Codex**: Claude의 `concos ...` 문자열 형식은 `keepOnline: false`로, 부모 검사를 하지 않는다. 부모 셸이 죽은 클라이언트보다 오래 살아서 그 존재만으로 세션이 열렸다고 판단할 수 없기 때문이다. Codex의 분리된 감시는 `keepOnline: true`이고 부모 PID가 없으므로 SessionEnd나 수명 상한까지 60초마다 생존 시각을 갱신한다. keepAlive는 `last_call_at`이나 모델의 조회 위치를 바꾸지 않는다.
- **일을 받지 않은 세션(2026-10-28 사용자 보고·결정, 0.1.16)**: 0.1.15로 업데이트하며 다시 연 세션 가운데 아무 작업도 받지 않은 세션은 모델이 concos를 한 번도 부르지 않았다. 그래서 MCP 서버의 하트비트 대상(`joinedAgentIds`)에 들지 못했고, 시작 훅이 남긴 생존 시각만 있다가 3분 뒤 오프라인이 됐다. 같은 시각 MCP 로그에는 하트비트 실패도 서버 종료도 없었고, 이 PC는 모던 스탠바이를 지원하지 않아 화면이 꺼져도 프로세스가 멈추지 않는다. 두 가지로 막는다. (1) Claude Code: 훅이 클라이언트 프로세스 번호를 `agent.client_pid`(스키마 15)에 남긴다. 값은 `CLAUDE_PID`(어댑터의 `clientPidVariable`)이고, 없으면 exec 형식 훅의 부모다. MCP 서버는 같은 번호(`CLAUDE_PID`, 없으면 자기 부모)로 하트비트마다 `keepAliveForClient`를 불러, join 전에도 카드를 온라인으로 둔다. 그 프로세스가 살아 있을 때만 그렇게 한다. 같은 프로세스에서 새 세션이 시작되면(`/clear`, 재개) 이전 카드는 번호를 내놓는다. claude.exe가 `CLAUDE_PID`이고 concos MCP 서버의 부모임은 2026-10-28 이 PC에서 확인했다. (2) Codex: 훅이 셸을 거쳐 돌고 클라이언트 번호를 알려 주지 않는다. 대신 대기 깨우기가 켜져 있으면(`inspectWake`) 세션 시작 훅이 턴 끝과 같은 분리 감시를 띄운다. 첫 턴 전에도 온라인이고, 메시지가 오면 깨운다. Claude Code는 밖에서 턴을 시작할 방법이 없어, 아직 턴을 끝낸 적 없는 세션은 여전히 직접 입력해야 깨어난다.
- **Windows에서 감시 띄우기(2026-10-28 회귀 수정, 0.1.17)**: 0.1.16의 Codex 세션 시작 감시는 Windows에서 시작 훅을 10초 시간 초과로 실패시켰다. 훅을 돌린 PowerShell을 거치며 감시 프로세스가 훅의 표준 출력 파이프를 물려받았기 때문이다. Codex는 동기 훅의 출력 파이프가 닫힐 때까지 기다린다. 결과로 세션 시작 문맥(handle과 join 안내)이 전달되지 않았고, 모델의 concos 호출이 `call join first`로 실패했다. 턴 끝 감시 훅은 `async`로 등록돼 있어 드러나지 않았다. 같은 조건(PowerShell → node 훅 → 15초 자식)에서 node `spawn`(detached, stdio ignore)과 `cmd /c start`는 파이프를 15초 붙잡았고, PowerShell `Start-Process`만 0.4초에 놓았다. 그래서 Windows에서는 `-EncodedCommand`로 `Start-Process -WindowStyle Hidden`을 실행해 감시를 띄운다. 런처 PowerShell을 detached(콘솔 없음)로 띄우면 `Start-Process`가 아무것도 실행하지 않는다. 또 훅 node가 먼저 끝나면 같은 콘솔의 런처도 끝나므로, 훅은 런처가 끝날 때까지(약 0.5초, 최대 5초) 기다린다. 실제 훅으로 잰 결과 파이프는 0.7초에 닫혔고, 문맥에 handle이 있었고, 감시가 떴고(`wake_generation` 1), 세션 종료 뒤 감시가 끝났다. macOS·Linux는 지금처럼 `spawn`한다. 그쪽에서 같은 문제가 있는지는 확인하지 않았다.
- **하나만 유지**: 참가자마다 감시 세대 번호(`agent.wake_generation`, 스키마 6)를 둔다. 새 감시와 UserPromptSubmit이 세대를 올리고, 세대가 달라진 감시는 조용히 끝난다.
- **유휴 조건**: 감시 시작 뒤 60초가 지나야 깨울 수 있다. 그사이 새 프롬프트가 들어오면 이전 감시는 끝난다.
- **감지**: 3초마다 DB에서 아직 상기하지 않은 대상 메시지를 찾는다. 읽기는 잠금 없이 하고, 깨울 때만 쓰기 잠금 안에서 세대·상태·횟수를 다시 확인하고 기록한다. 질문·내 질문의 답·나에게 온 note/notice·내 note/notice의 답이 대상이며, 대합실 게시물은 제외한다.
- **누락·중복 방지**: 감시 시작 전부터 남은 메시지도 본다. 이어가던 턴은 `stop_hook_active` 때문에 끝에서 다시 상기하지 못하기 때문이다. Stop 상기와 감시는 같은 `hook_nudged_seq`를 사용해 같은 메시지를 두 번 알리지 않는다.
- **횟수**: 메시지당 한 번 깨운다. 참가자당 시간 상한은 두지 않는다(2026-10-26 사용자 결정). 처음에는 시간당 4회였는데, 여러 에이전트가 보고하는 허브 에이전트가 몇 분 만에 4회를 다 쓰고 남은 시간 동안 메시지를 받지 못했다(11.4절). 두 에이전트가 note를 계속 주고받으면 서로를 계속 깨운다. 답에 대한 답은 대상이 아니므로 확인 답장으로는 이어지지 않는다. 깨운 시각은 최근 한 시간 것만 `agent.woken_at_list`에 남겨 진단에 쓴다. 깨어난 턴이 끝나면 다음 감시가 시작된다.
- **종료**: 세대 변경, 세션 종료·퇴장, 최대 24시간 경과, 참가자 없음, 깨우기를 지원하지 않는 클라이언트면 종료 코드 0으로 끝난다. Claude가 직접 띄운 감시는 시작 당시 살아 있던 부모 클라이언트가 사라져도 끝난다. 시작부터 부모가 없으면 부모 검사와 생존 갱신을 하지 않고 감시만 계속한다. MCP 브리지만 종료한 것은 훅 세션의 종료로 취급하지 않는다(7절). 메시지 감지나 깨우기만으로 받음 처리하지 않는다.
- **출력**: 사용자가 `CONCOS_LOG_LEVEL`을 지정하지 않으면 감시의 로그 수준은 `none`이다. 훅 출력에 운영 로그가 섞이지 않게 한다.

### 11.2 Codex 감시와 큐 입력

기존 Stop 목록의 맨 뒤에 아래 그룹을 추가한다. 다른 그룹이나 사용자 설정은 그대로 둔다.

```json
{
  "hooks": [{
    "type": "command",
    "command": "concos hook watch --host codex",
    "timeout": 3660,
    "async": true
  }]
}
```

`asyncRewake`는 쓰지 않는다. 훅은 바로 끝나고, 감시는 따로 띄운 node 하나가 이어받는다(2026-10-26). Codex는 훅을 세션의 셸로 돌리므로, 훅이 감시 내내 살아 있으면 그 셸(이 PC의 PowerShell은 놀고 있어도 약 64 MB)도 같은 기간 남기 때문이다. 시작 훅의 timeout은 3660초 그대로이며, 분리된 감시의 최대 수명은 24시간이다. SessionEnd 훅이 남긴 종료 기록을 다음 확인(3초 안)에서 보고 스스로 끝난다. 종료 훅 없이 Codex가 죽었다면 최대 24시간 상한이 남는다. 감시가 대상 메시지를 찾으면 `deliverWake`가 세션 UUID와 한 줄 알림으로 다음 명령을 호출한다.

```sh
codex queue --thread <session-UUID> --message "concos: unread for you ..."
```

[Codex CLI 공식 설명](https://learn.chatgpt.com/docs/cli/reference#codex-queue)은 기존 세션에 메시지를 큐로 넣는 명령과 `--thread`·`--message` 인수를 안내한다. concos는 이름 대신 UUID로 세션을 지정한다.

- 열린 대기 세션에는 공유 app-server를 통해 새 턴이 시작된다. 구현 담당자가 Codex CLI 0.164.0에서 큐 입력 후 약 1초 만에 새 턴이 시작되고 질문 #151을 읽은 것을 확인했다(V9).
- 실행 중인 세션에는 다음 턴으로 예약된다. 감지 뒤 명령을 보내기 전에 사용자가 입력해도 큐가 전달 순서를 맡는다.
- 닫힌 세션에는 큐에 저장만 된다. Codex 소스의 `thread/queue/add`는 저장하고, 턴은 열린 스레드에서만 시작한다. 다시 열 때 전달되는지는 확인하지 않았다(V10).
- 새 감시 훅은 Codex의 `/hooks`에서 신뢰해야 실행된다. 기존 기본 훅을 신뢰한 것만으로 새 감시 훅까지 신뢰되지는 않는다.
- 훅은 감시를 띄운 뒤 표준 출력에 `{}`를 쓰고 종료 코드 0으로 바로 끝난다. Codex를 깨우는 수단은 종료 코드가 아니라 떼어 낸 감시의 큐 입력이다.
- **MCP 서버의 보조 깨우기(2026-10-27 사용자 결정)**: 실패한 턴은 Stop 훅 없이 끝난다. KSC:X개발4의 턴이 `failed`로 끝난 뒤 카드의 마지막 활동은 실패 전 시각에 머물렀고, 카드는 `working`인 채 감시가 없어 답 세 건을 받지 못했다. 감시가 수명을 다했거나(0.1.12까지 1시간) 시작되지 않은 세션도 같은 처지다(X/AKMS_MCP_02·03, KS:X설계보조1·2, 10-27 확인). 그래서 MCP 서버가 60초 하트비트마다 카드를 본다. 카드가 `deliverWake`가 있는 클라이언트(지금은 Codex)의 세션에 묶여 있고, 깨울 대상 메시지가 `WAKE_FALLBACK_MS`(10분) 넘게 상기되지 않았고, 에이전트가 그만큼 concos를 부르지 않았으면 감시와 같은 줄을 `codex queue`로 넣는다(`RoomStore.fallbackWake`). 상태는 보지 않는다. 0.1.13에서는 서버가 자기에게 `join`한 카드만 봤다. 그래서 세션을 다시 시작하고 모델이 concos를 한 번 불러야 켜졌고, 이미 떠 있던 Codex 세션은 모두 옛 서버라 아무도 받지 못했다. 0.1.14부터는 모든 MCP 서버가 이 PC의 대상 카드 전부를 본다(`fallbackWakeCandidates`, 2026-10-27 사용자 결정). 새 판 서버 하나만 떠 있으면 어느 클라이언트의 것이든 모든 Codex 세션을 돌본다. 대신 최근 3분(`OFFLINE_AFTER_MS`) 안에 생존 신호가 있는 온라인 카드만 본다. 종료 훅 없이 닫힌 세션의 카드를 깨우지 않기 위해서다. 기록은 감시와 같다: `hook_nudged_seq`·`woken_at_list`를 쓰고 `wake_generation`을 올려 남은 감시를 끝낸다. 판단은 쓰기 잠금 안에서 다시 하므로 감시와 겹쳐도 한 번만 깨운다. 에이전트가 실제로는 긴 턴을 도는 중이면 위 항목대로 다음 턴으로 예약될 것으로 보지만, 실행 중인 세션에서 확인하지는 않았다. 자기 MCP 서버만 다시 시작되고 모델이 아직 concos를 부르지 않은 세션은 하트비트가 없다. 감시가 생존 신호를 갱신하지 않는 한 3분 뒤 오프라인이 되어 이 보조 깨우기도 받지 못한다.

### 11.3 Claude Code 감시

Stop에 감시 훅(`hook watch --host claude`), `asyncRewake: true`, `timeout: 86460`을 추가한다. 감시의 최대 수명 24시간보다 1분 늦은 안전장치다. 대상 메시지를 찾으면 한 줄 알림을 stderr에 쓰고 종료 코드 2로 끝나 `asyncRewake`가 세션을 깨운다. 감시가 취소되거나 시간이 끝나면 종료 코드 0이다. 깨우는 수단이 이 훅의 종료 코드라 Codex처럼 떼어 낼 수는 없다. Windows 전역 설치에서 등록을 갱신하면 exec 형식으로, 대기 중 남는 프로세스는 node 하나다(그 전에는 bash·bash·sh·node). macOS·Linux와 npx의 명령 등록은 `concos`를 유지한다.

exec 형식인지는 node가 concos 옵션 `--max-semi-space-size=1`로 시작했는지로 판별한다. 이 감시만 부모 PID가 사라지면 끝나, SessionEnd 없이 클라이언트가 죽어도 하루 동안 남지 않게 한다. 시작부터 부모가 없으면 부모 검사와 keepAlive를 모두 하지 않는다. `concos ...` 문자열 형식은 살아 있는 셸 부모가 있어도 부모 검사와 online 유지를 하지 않는다. 두 경우 모두 감지·깨우기는 그대로 동작한다. 기존 3660초 등록이나 timeout이 없는 등록은 `Update available`로 갱신한 뒤 세션을 다시 시작해야 24시간 감시가 적용된다. 86460초보다 긴 사용자 값은 timeout만 갱신하는 대상으로 삼지 않는다(8절).

Notification(`idle_prompt`)은 종료 코드를 무시하므로 감시 시작점으로 쓰지 않는다. 0단계 V6에서 깨운 턴이 `<task-notification>` 프롬프트로 들어와 UserPromptSubmit을 일으키고, 그 턴의 Stop에는 `stop_hook_active`가 참인 것을 확인했다. 제한 시간이 지난 감시는 화면 표시 없이 정리됐다.

두 클라이언트 모두 취소·종료 때 남는 프로세스, 전달 직전 새 입력, 깨운 턴의 토큰 비용을 확인한다. 큐 전달이나 종료 코드만으로 성공을 판단하지 않고, 같은 세션이 새 턴에서 전문을 읽고 답하는 것까지 확인한다.

### 11.4 Claude Code 미확인 누적 진단

2026-10-26 KST에 실DB를 읽기 전용으로 열고, 확장 세션의 기록에서 알림 시각·도구 이름·반환 메시지 번호만 대조했다. 메시지 본문은 출력하지 않았다. 관측 당시 전역 concos는 0.1.7, 실DB는 스키마 10이었다.

16:04:49 UTC 스냅샷의 Claude Code 미확인 8건은 다음과 같았다. 이 수치는 그 시점의 기록이며 현재 건수를 뜻하지 않는다.

| 분류 | 건수 | 판정 |
| --- | --- | --- |
| 훅 세션 키가 없고 연결이 끊긴 옛 카드 | 4 | 깨울 세션이 없음. 같은 이름의 현 세션이 있는지도 구분해야 함 |
| 답에 대한 답 | 2 | 반복 대화를 막기 위해 깨우기 대상에서 제외. 한 건은 이미 전문을 읽었지만 받음이 지연됨 |
| 깨워진 턴이 전문을 읽은 note | 1 | 깨우기 성공. 마지막 도구 응답 뒤 받음 처리가 남음 |
| 작업 중인 세션에 방금 온 질문의 답 | 1 | 도착 직후이므로 깨우기 실패로 판단할 근거 없음 |

VS Code 확장 2.1.310의 두 사례에서는 `task-notification` 뒤 같은 세션이 `read_messages`로 전문을 읽었다. 두 번째는 알림 16:03:56 UTC → 전문 반환 16:04:00 → 추가 MCP 호출 없이 Stop 16:04:11 순서였다. 이 버전의 확장에서 깨우기가 동작함을 확인했으며, 모든 버전과 세션을 검증했다는 뜻은 아니다.

이 마지막 읽기는 구버전 브리지에서 다음 호출까지 미확인으로 남는다. 스키마 11의 전문 전달 기록과 턴 끝 받음 처리(6.1절)가 해결하는 경로다. 깨워진 턴의 `stop_hook_active`가 참이어도 전달분은 확인해야 하고, 한 줄 상기만 한 다른 메시지는 확인하지 않는다. 새 버전 배포 후에도 이미 실행 중인 옛 브리지는 전문 전달 기록을 쓰지 않으므로 MCP 재연결이나 세션 재시작이 필요하다. 옛 기록의 `delivered_seq`만으로 전문 전달 여부를 추정해 받음 처리해서는 안 된다.

진단할 때 `woken_at_list`는 깨우기를 시도한 기록이지 전문을 읽었다는 증거가 아니다. `last_call_at`도 훅에서 갱신되므로 MCP 호출의 증거로 단독 사용하지 않는다. 대상 종류·상기 위치·최근 한 시간의 횟수·감시 시작 시각과 프로세스의 생존 여부를 확인한 뒤, 같은 세션의 알림 → 전문 반환 → 받음 처리 순서를 대조한다. 확인한 사례에서는 대상 메시지가 시간당 4회 제한이나 감시 만료 때문에 남은 근거는 없었다.

2026-10-26 03:2x KST에 같은 방법으로 본 KS/마스터(Claude Code, 대기)는 시간당 4회 제한 때문이었다. 미확인 7건이 모두 깨우기 대상이었다(나에게 온 note 3, 그 세션의 질문에 온 답 4). 아직 상기하지 않은 것이었고, 전문을 전달한 기록도 없었다. 감시는 턴 끝(03:07:35)과 같은 시각에 node로 떠서 살아 있었다. 그런데 02:34:11~02:41:59 사이에 이미 4번 깨운 뒤라, 첫 깨움이 한 시간을 넘기는 03:34까지 깨울 수 없었다. 이 사례로 시간 상한을 없앴다(11.1절).

#### 19:4x KST 추가 진단: 감시가 끝난 뒤 도착한 메시지

구현 담당자가 실DB를 읽기 전용으로 확인해 보고한 결과다(concos #818). 살아 있는 카드의 미확인 45건을 다음과 같이 나눴다. 문서 담당자가 실DB를 다시 조회한 수치는 아니다.

| 분류 | 건수 | 반영 |
| --- | --- | --- |
| 60분 감시가 끝난 뒤 도착한 깨우기 대상 | 24 | 감시를 세션 종료까지, 최대 24시간으로 늘림 |
| 깨우기 대상이 아닌 답 | 13 | 알림에 `plus N other unread` 또는 `N messages`로 세고 같은 턴에 함께 읽게 함. 그 답만으로 깨우지는 않음 |
| leave 뒤 새로 join해 훅에 묶이지 않은 카드 | 5 | 훅 세션과 MCP 참가자를 구분해야 함. 감시 기간만 늘려도 이 카드는 연결되지 않음 |
| 일시적인 미확인 | 3 | 도착 직후의 상태와 지속적인 누적을 구분 |

감시가 살아 있는 동안 도착했는데 깨우지 못한 대상 메시지는 이번 표본에서 0건이었다. 감시가 없어진 뒤의 도착을 놓친 것과, 대상이 아닌 답이 남은 것을 나누어 고친다. 별도로 MCP 재시작이 훅 세션을 끝낸 것으로 기록해 감시를 멈추던 경로도 막는다. online 유지는 exec·부모 조건을 충족하는 Claude 감시와 Codex 감시에 한해 60초 생존 갱신으로 처리한다(7·11.1절).

### 11.5 프로세스와 메모리 · 2026-10-26

사용자 요청으로 concos가 띄우는 프로세스를 줄였다. 이 PC(Windows, Node 24.19)에서 실제로 떠 있던 것을 전용 메모리로 쟀다: MCP 브리지 18개(node 개당 약 24 MB, 그 앞의 `concos.cmd` 때문에 cmd.exe 개당 약 4 MB), Claude 대기 깨우기 감시 5개(bash·bash·sh 합계 약 13 MB 위에 node). Codex 감시를 훅 안에서 돌렸다면 PowerShell(놀고 있어도 약 64 MB)이 그만큼 더 붙었을 것이다.

| 프로세스(세션마다) | 전 | 후 | 바꾼 것 |
| --- | --- | --- | --- |
| MCP 서버 | cmd.exe 3.9 + node 26.5 MB | node 24.1 MB | node를 cli.js로 바로 띄움, `--max-semi-space-size=1` |
| Claude 대기 감시 | bash 3.7 + bash 3.7 + sh 5.8 + node 24.6 MB | node 22.5 MB | exec 형식, 같은 node 옵션 |
| Codex 대기 감시 | PowerShell 64 + node 24.6 MB(훅 안에서 돌렸을 때) | node 22.5 MB | 훅은 바로 끝내고 감시를 떼어 냄 |

이 측정 당시의 감시 상한은 60분이었다. 현재 수명은 11.1절의 최대 24시간을 따르며, 위 수치가 24시간 연속 측정 결과를 뜻하지는 않는다.

- node 옵션은 젊은 세대를 1 MB로 둔다. 브리지에 같은 호출 450번을 보낸 뒤 쟀을 때 26.5 → 24.1 MB(세 번 반복, 속도 차이 없음)였고 `--optimize-for-size`를 더해도 더 줄지 않았다. 옵션은 node를 바로 띄울 때만 붙일 수 있다.
- 보드(`concos` 화면)를 4분 동안 바쁜 방에서 돌렸을 때 강제 GC 뒤 힙은 15.8 MB 안팎으로 일정해 누수는 없었다. 4시간 떠 있던 0.1.7 보드의 168 MB는 늘지 않고 멈춰 있었다. 원인은 확인하지 못했다.
- 짧은 훅(세션 시작·프롬프트·편집·턴 끝·종료)은 상주하지 않는다. Claude는 exec 형식으로 셸을 띄우는 비용이 빠지고, Codex는 세션 셸을 그대로 쓴다.
- 등록이 바뀐 뒤에도 이미 떠 있는 프로세스는 그대로다. 세션을 다시 시작해야 줄어든다.

## 12. 단계별 구현

**0단계 — 실제 동작 확인 (코드 전).** 사용자 설정은 건드리지 않는다. 비대화형으로 되는 항목은 임시 설정 파일과 기록용 스크립트로 확인하고(`claude -p --settings <임시 파일>`, Codex는 한 번만 신뢰를 건너뛰는 옵션), 대화형 화면이 필요한 항목은 사용자가 실제 창에서 확인한다.

| 번호 | 확인할 것 | 방법 | 결과 (2026-10-25, Claude Code 2.1.305 · Codex 0.164.0) |
| --- | --- | --- | --- |
| V1 | Windows에서 `concos hook …` 명령이 두 클라이언트에서 실행되는지, 쓰는 셸과 걸리는 시간 | 비대화형 | 확인. Claude는 Git Bash, Codex는 PowerShell. 시간은 8절 |
| V2 | Stop `decision: block`이 한 번 이어지고 다음 Stop의 `stop_hook_active`가 참인지 | 비대화형 | 확인(두 클라이언트) |
| V3 | Codex 이어가기 프롬프트가 UserPromptSubmit을 다시 일으키는지, 화면에 어떻게 보이는지 | 비대화형·대화형 | 확인. 비대화형·대화형 모두 다시 일으키지 않음. 화면에는 "Blocked by hook" 아래 사유 한 줄, 이어서 모델 응답 |
| V4 | Codex `/hooks` 검토·신뢰 흐름과 명령 변경 시 재검토 | 대화형 | 폴더 신뢰와 훅 신뢰 뒤 실행 확인. 신뢰는 `~/.codex/config.toml`의 `[hooks.state.'<hooks.json 경로>:<이벤트>:<그룹 번호>:<항목 번호>'] trusted_hash = "sha256:…"`로 저장됨. 명령 변경 시 재검토 화면은 직접 보지 않았고, 해시로 묶이는 저장 형식과 문서로 판단 |
| V5 | Codex SessionEnd가 3초 안에 끝나는지 | 비대화형 | 확인. 종료가 기록됨 |
| V6 | `asyncRewake` 훅이 종료 코드 2로 대기 세션을 실제로 깨우는지, 제한 시간이 끝나거나 세션을 닫을 때 어떻게 되는지 | 대화형 | 확인(Claude Code 2.1.310). Stop 75초 뒤 종료 코드 2로 대기 세션이 깨어남. 화면에는 "Stop hook feedback" 뒤 응답. 깨운 턴은 `<task-notification>`으로 시작하는 프롬프트라 UserPromptSubmit이 다시 발생하고, 그 턴의 Stop에는 `stop_hook_active`가 참. 제한 시간 30초 훅은 화면 표시 없이 끝났고 남은 프로세스 없음 |
| V7 | 세션 시작 주입 뒤 모델이 `resume_handle`로 `join`해 참가자가 하나로 유지되는지 | 비대화형 | 확인(두 클라이언트). 지시문에 핸들을 언급하지 않아도 이어받음 |
| V8 | `--agent` 세션의 `agent_id` 처리 | 비대화형 | `agent_type`만 오고 `agent_id`는 없음. 정상 기록 |
| V9 | Codex 큐 입력으로 열린 대기 세션에 새 턴이 시작되는지 | 실제 세션 | 2026-10-26 구현 담당자 확인, concos #163·#186 보고. Codex CLI 0.164.0에서 큐 입력 뒤 약 1초 만에 새 턴이 시작되고 질문 #151을 읽음. 문서 담당자가 별도 재현한 결과는 아님 |
| V10 | 닫힌 Codex 세션의 큐가 재개 때 전달되는지 | 소스 확인·실제 세션 | 구현 담당자가 Codex `thread/queue/add` 소스로 확인. 실제 종료 → 큐 입력 → 재개 검증은 남음 |

비대화형 확인은 임시 데이터 폴더(`CONCOS_HOME`), 사용자 설정을 읽지 않는 옵션(Claude `--setting-sources project --strict-mcp-config`, Codex `--ignore-user-config`), 이번 실행에만 쓰는 훅(Claude `--settings`, Codex `-c hooks.…`와 `--dangerously-bypass-hook-trust`)으로 했다. Codex MCP 서버는 바깥 환경을 물려받지 않으므로 `-c mcp_servers.concos={…, env={CONCOS_HOME=…}}`로 넘겨야 한다. 처음 실행에서 이를 빠뜨려 실제 대합실에 테스트 참가자 하나가 생겼고, 메시지가 없는 것을 확인한 뒤 바로 지웠다.

**1단계 — 공통 훅.** 구현 · 2026-10-25. 아래 파일을 바꿨고 자동 테스트 150개와 타입 검사가 통과했다. 사용자 설정에 실제로 켜서 쓰는 확인(13절)은 남아 있다.

- `src/_defs/limits.ts`, `src/modules/store/schema.ts`: 스키마 5, `agent.hook_nudged_seq INTEGER NOT NULL DEFAULT 0`.
- `src/modules/store/room-store.ts`: 알림 대상 조회, `turn-end`의 Stop 상기 판단, 훅 참가자 기본 이름.
- `src/modules/hooks/types.ts`, `handler.ts`, `adapters/claude.ts`, `adapters/codex.ts`: `stop_hook_active` 읽기, Stop의 `decision: block` 출력, 알림 문구, 이벤트별 `timeout`.
- `src/modules/cli/clients.ts`, `setup.ts`: 훅 설정 위치, 켜기·끄기 계획, 상태 조회, `--hooks on|off`.
- `src/modules/cli/menu.ts`: 클라이언트 행의 동작 목록. concos development 세션이 같은 파일을 고치므로 시작 전에 범위를 맞춘다.
- `dbml/concos.dbml`, `README.md`, `SCAFFOLD.md`, 이 문서.
- 테스트: Stop 상기가 메시지당 한 번인지, `stop_hook_active`, 대상 규칙(직접·그룹 포함, 전체 제외, 내 질문의 답 포함, 답에 대한 답 제외), 상기 중 `waiting` 미전환, 설정 켜기·끄기의 보존·백업·중복 방지, Codex `config.toml` 중복 감지, 실제 `dist/cli.js` 자식 프로세스로 두 클라이언트 입력 fixture 실행.

**2단계 — 대기 세션 깨우기 (초기 Claude Code 구현).** 구현 · 2026-10-25. 스키마 6(`wake_generation`, `woken_at_list`), `RoomStore.startWakeWatch`·`checkWakeWatch`, `src/modules/hooks/watch.ts`, `concos setup --host claude --wake on|off`, Claude Code 행의 "Turn on idle wake". 자동 테스트 158개 통과.

초기 구현 실제 확인 · 2026-10-25 (Claude Code 2.1.310, haiku, 임시 데이터 폴더, 등록 결과와 같은 훅 설정; 스키마 11 적용 전 기록):

- 세션이 `join`한 뒤 턴이 18:14:21에 끝나 감시가 시작됐다. 18:14:58에 Reviewer가 질문 #1을 보냈다.
- 18:15:21, 감시 시작 1분 지점에 세션이 깨어났다. 깨운 기록이 1건 남았고 상기 위치가 질문까지 올라갔다.
- 깨어난 세션이 `read_messages`로 질문을 읽고 18:15:28에 `reply`로 답했다. 질문은 그 MCP 호출로 수신 확인됐다. 훅이 확인 처리한 것은 없다.
- 감시 세대는 2(프롬프트, 감시 시작) → 3(깨움) → 4(깨운 턴의 UserPromptSubmit) 순서로 올랐다.
- 그 세션은 답한 뒤 스스로 `leave`했다. 퇴장한 참가자는 감시하지 않으므로 다음 감시는 시작되지 않았고, 남은 감시 프로세스도 없었다.

**2026-10-26 확장.** Codex Stop의 `async` 감시와 `codex queue` 전달을 추가한다(11.2절). 스키마 11의 `message_receipt.delivered_at`으로 전문 전달분을 기록해 브리지가 다시 떠도 다음 호출이나 턴 끝 훅에서 받음 처리한다(6.1절). 시작 훅을 놓친 세션은 첫 프롬프트에서 참가자를 만들고 `resume_handle`로 연결하도록 안내한다(7절). 자동 검증은 설정 보존·신뢰 안내·두 클라이언트의 감시 등록과 받음 처리를 포함하며, 실제 세션에서 이어서 확인할 항목은 아래에 둔다.

**3단계 — 다른 클라이언트.** Gemini CLI·Cursor·Copilot CLI를 실제 세션으로 확인한 뒤 등록 화면에 연다. 프롬프트 알림을 넣을 수 없는 클라이언트는 그 사실을 화면에 적는다. 제품별 훅·깨우기 조사와 먼저 바꿀 코드는 [other-clients-hooks-review.md](other-clients-hooks-review.md)에 있다(2026-10-25 조사, 10-26 보완).

## 13. 실제 세션 검증 계획

Claude Code와 Codex에서 각각 확인한다.

1. 훅을 켜고 새 세션을 연다 → 참가자가 하나 생기고, 모델이 `join`한 뒤에도 하나로 유지된다.
2. 프롬프트를 보낸다 → 카드가 `working`이 된다. 다른 세션에서 질문을 보내 두면 프롬프트 때 한 줄 알림이 들어간다.
3. 파일을 수정한다 → `editing`에 그 파일이 오른다.
4. 턴 도중 다른 세션이 질문을 보낸다 → 턴 끝에 한 번 이어서 질문을 읽고 답한다. 같은 질문으로 두 번 이어가지 않는다.
5. 알림 대상이 없는 턴이 끝난다 → `waiting`, `editing` 비움.
6. 압축·재개 → 같은 참가자, 핸들 다시 주입.
7. 세션을 닫는다 → 종료 표시, `editing` 비움.
8. 훅을 끈다 → concos 항목만 사라지고 다른 훅은 남는다. 백업 파일이 생긴다.
9. 메시지 전문을 전달받은 뒤 브리지를 다시 띄우거나 다른 브리지에서 호출한다 → 이전 전달분이 받음 처리된다.
10. 전문을 받은 뒤 다음 MCP 호출 없이 턴을 끝낸다 → Stop 훅에서 받음 처리된다. 잘린 미리보기나 한 줄 상기만 받은 메시지는 남는다.
11. 훅을 설치하기 전에 열었던 세션에서 첫 프롬프트를 보낸다 → 참가자가 생기고, 안내된 `resume_handle`로 `join`한 뒤에도 카드가 하나다.
12. Codex에서 60초 이상 대기한 세션에 대상 질문을 보낸다 → 같은 세션의 새 턴이 질문 전문을 읽고 `reply`로 답한다. 큐 명령 성공만으로 끝내지 않는다.
13. 닫힌 Codex 세션에 큐 입력 후 재개한다 → 닫힌 동안 실행되지 않고, 재개 후 메시지가 전달된다(V10).

## 14. 남은 결정

- 2단계 깨우기의 현재 값: 유휴 60초, 확인 간격 3초, 세션 종료까지 최대 24시간 감시, 60초마다 생존 갱신이다. Claude timeout은 86460초, 분리된 감시를 띄우는 Codex 훅은 3660초를 유지한다. 처음의 시간당 4회 상한은 2026-10-26에 없앴다. 이 값은 쓰면서 조정한다(11.1절).
- 3단계에서 다른 클라이언트를 여는 시점.

## 공식 출처

- [Claude Code hooks](https://code.claude.com/docs/en/hooks): 이벤트, `async`·`asyncRewake`, Stop의 `stop_hook_active`, 폴더 신뢰
- [Claude Code channels](https://code.claude.com/docs/en/channels): 연구 프리뷰, `--channels`, 허용 목록
- [Codex hooks](https://learn.chatgpt.com/docs/hooks): 이벤트, `mcp_tool`, `async`, Stop 이어가기, `/hooks` 신뢰, `commandWindows`
- [Codex CLI queue](https://learn.chatgpt.com/docs/cli/reference#codex-queue): 기존 세션에 `--thread`·`--message`로 메시지를 큐에 넣는 명령
