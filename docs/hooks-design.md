# 훅 선택 기능 설계 (Claude Code · Codex)

상태: 1·2단계 구현 · 2026-10-25. 0단계 실제 동작 확인 끝(12절). 사용자 설정에 켜서 쓰는 확인(13절)은 남아 있다. 요청은 concos 메시지 #17(사용자 요청, concos development 세션 전달)이다. 결정 사항은 10절, 남은 결정은 14절에 있다. 과거 훅 구현과 검증 기록은 [hooks-plan.md](hooks-plan.md), 설계 전반은 [SCAFFOLD.md](../SCAFFOLD.md)에 있다.

## 1. 목적과 범위

MCP가 기본이고 훅은 선택 기능이다. 한 OS 사용자에 대합실 하나, User 범위 등록 한 번, 영어 CLI라는 지금 구조를 그대로 둔다. 훅이 없어도 대합실은 MCP만으로 완결된다. 2026-10-25 개정: Claude Code·Codex를 처음 등록하면 훅이 MCP와 함께 기본으로 켜지고(8절), 등록 화면이나 `--hooks off`로 끌 수 있다. 훅 없이도 완결된다는 원칙은 그대로다.

훅이 하는 일:

- 참가자 식별: 호스트 세션 키로 같은 참가자를 만들거나 되찾는다.
- 상태: 작업 중·대기·종료를 모델 호출 없이 기록한다.
- 편집 선언: 수정한 파일을 `editing`에 넣고 턴이 끝나면 회수한다.
- 안내: 알림 대상 메시지(5절)를 프롬프트 때 한 줄로 알리고, 턴 끝에 한 번 상기한다(6절).

훅이 하지 않는 일: 메시지 읽음 처리, 메시지 발송, 요약·체크포인트 작성, `check_in` 호출.

1단계 대상은 Claude Code와 Codex다. Gemini CLI·Cursor·Copilot CLI 어댑터는 코드에 있지만 실제 세션 검증 뒤에 연다. [SCAFFOLD.md 1절](../SCAFFOLD.md#1-사용자-요구사항)의 규칙에 따라 1단계에는 두 클라이언트에서 같은 동작만 넣는다. 대기 중인 세션 깨우기는 Claude Code에서만 가능하다. 0단계에서 실제 동작을 확인한 뒤, 사용자가 규칙의 예외로 2단계에 넣기로 정했다(11절).

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
| 외부에서 세션 깨우기 | `asyncRewake`, Channels(연구 프리뷰) | 문서에 없음 |

## 3. 결론

- 두 클라이언트 모두 **명령 훅**을 쓴다. Codex의 `mcp_tool` 훅은 쓰지 않는다.
    - 훅에서 `check_in`을 부르면 메시지가 모델에게 전달된 것으로 처리되어 다음 호출 때 자동 확인된다. 훅이 감지했다는 이유로 읽음 처리하지 않는다는 규칙과 충돌한다.
    - 브리지는 마지막으로 `join`한 핸들로 참가자를 찾으므로 모델이 `join`하기 전에는 실패한다. 명령 훅은 세션 키로 찾으므로 순서와 무관하다.
    - 훅 전용 MCP 도구를 새로 만들면 모든 클라이언트의 도구 목록 비용이 늘고, 실제로는 Codex만 쓰게 된다.
- **Channels는 채택하지 않는다.** 연구 프리뷰이고, 세션마다 `--channels`로 켜야 하며, 직접 만든 채널은 개발용 플래그로만 켠다. Claude Code 전용이다.
- **1단계**: 공통 훅 다섯 개와 Stop 상기. 두 클라이언트에서 같은 동작이다.
- **2단계**: Claude Code 대기 세션 깨우기. SCAFFOLD 1절 규칙의 유일한 예외로, Claude 전용 선택 기능이다(사용자 결정).

## 4. 내부 이벤트와 동작 (1단계)

| 내부 이벤트 | Claude Code | Codex | 동작 | 모델 문맥에 넣는 것 |
| --- | --- | --- | --- | --- |
| `session-start` | SessionStart | SessionStart | 세션 키로 참가 또는 복귀 | 핸들과 `join` 방법 한 줄, 대합실 요약 한 줄 |
| `prompt` | UserPromptSubmit | UserPromptSubmit | `working`, 생존 시각 갱신, 종료 표시 해제 | 알림 대상(5절)이 있을 때만 한 줄 |
| `file-edited` | PostToolUse: Edit·Write·MultiEdit·NotebookEdit | PostToolUse: 성공한 apply_patch | `editing`에 추가 | 없음 |
| `turn-end` | Stop | Stop | 6절 판단. 상기하면 이어가기, 아니면 `waiting`과 `editing` 회수 | 상기할 때만 이어가기 사유 |
| `session-end` | SessionEnd | SessionEnd | 연결 끊김 기록, `editing` 회수 | 없음 |

공통 로직(`applyHookEvent`)과 두 어댑터는 지금 코드에 있다. 1단계의 코드 변경은 알림 대상 판정, Stop 상기, 등록 화면이다.

`session-start`가 넣는 문구 예:

```text
concos shared waiting room; agent_id=agt_…; handle=…
Call join with resume_handle=<handle>, your absolute working_directory and this session's name as display_name to keep this participant.
Hooks record your working/waiting status and edited files; keep reporting summary and next step with check_in. 2 other participant(s).
```

## 5. 알림 대상

프롬프트 알림, Stop 상기, 2단계 깨우기가 같은 기준을 쓴다(사용자 결정). 2026-10-25 개정: 프롬프트와 세션 시작의 한 줄 알림과 대기 깨우기에는 자기에게 온 note·notice도 넣는다(게시물 제외). Stop 상기는 아래 기준 그대로다.

- **대상**: 아직 받지 않은(`received_at`이 비어 있는) 다음 두 가지.
    - 나에게 온 질문: `kind = question`이고 나에게 직접(`direct`) 또는 여럿 중 하나로(`group`) 온 것.
    - 내 질문의 답: `kind = reply`이고 `reply_to`가 내가 보낸 질문인 것.
- **제외**: 대합실 전체(`all`) 메시지, `note`·`notice`, 답에 대한 답.
- **이유**: 답에 대한 답으로 깨우거나 이어가지 않아야 에이전트끼리 주고받기가 끝없이 이어지지 않는다. 전체 메시지는 활동 중인 세션 수만큼 이어가기를 일으킨다.
- **표시**: 메시지 번호, 보낸 이름, 첫 주제만 넣는다. 본문은 넣지 않는다. 본문은 MCP로 읽어야 수신 확인 규칙이 그대로 서고, 다른 에이전트가 쓴 글이 훅 문맥으로 그대로 들어가지 않는다.
- 모든 도구 응답의 `inbox`는 지금처럼 미확인 전체를 센다. 훅 알림과 숫자가 다를 수 있다.

```text
concos: unread for you — question #17 from concos development [concos_hooks]; answer #19 from Dev / API 01. Read them with read_messages.
```

## 6. Stop 상기

턴이 끝날 때 답하지 않은 질문이 있으면 한 번 이어서 답하게 한다(사용자 결정). 두 클라이언트 모두 같은 JSON을 쓴다.

- **조건**: 알림 대상 가운데 `seq`가 그 참가자의 `hook_nudged_seq`보다 큰 것이 있고, 입력의 `stop_hook_active`가 거짓이다.
- **상기할 때**: `{"decision":"block","reason":"…"}`를 출력하고 `hook_nudged_seq`를 대상의 가장 큰 `seq`로 올린다. 턴이 이어지므로 상태는 `working`으로 두고 `editing`을 회수하지 않는다.
- **아닐 때**: `waiting`으로 바꾸고 `editing`을 회수하고 `{}`를 출력한다.
- **한 메시지는 한 번만 상기한다.** 자동 수신 확인은 그 에이전트의 다음 MCP 호출 때 일어나므로, 방금 읽은 메시지도 Stop 시점에는 미확인으로 보인다. 미확인 여부만으로 상기하면 이미 답한 질문을 다시 상기한다. 모델이 읽지 않은 메시지는 다음 프롬프트 알림과 `inbox`에 계속 보인다.
- Codex에서는 사유가 사용자 프롬프트처럼 들어가 이어진다. 이때 UserPromptSubmit은 다시 발생하지 않는다(0단계 V3, 비대화형 확인). 화면에 어떻게 보이는지는 대화형으로 확인한다.

```text
concos: question #17 from concos development is unread. Read it with read_messages, answer with kind reply if it needs one, then finish.
```

## 7. 참가자 식별과 중복 방지

- 세션 키는 `(host, session_id)`이고 핸들은 `meta.hook_handle_secret`과 세션 키의 HMAC이다(스키마 2부터, 기존 구현).
- 재개(`resume`)와 압축(`compact`)은 같은 세션 키라 같은 참가자로 돌아오고 핸들을 다시 넣는다. `/clear`와 `fork`는 새 `session_id`라 새 참가자가 된다. 이전 참가자는 SessionEnd로 종료 표시된다.
- 서브에이전트에서 온 입력(`agent_id` 포함)은 무시한다(기존). `--agent`로 시작한 Claude Code 세션은 `agent_type`만 넣고 `agent_id`는 넣지 않으므로 정상으로 기록된다(0단계 V8).
- 모델이 `resume_handle` 없이 `join`하면 별도 참가자가 생긴다. 같은 폴더라는 이유로 합치는 추정은 하지 않는다(기존 결정 유지). 대신 주입 문구로 `join` 방법을 분명히 알린다.
- 훅이 만든 참가자의 이름은 지금 `claude`·`codex`다. `Claude Code · npm.concos`처럼 클라이언트와 폴더 이름으로 바꾼다. 모델이 `join`하면 세션 이름으로 바뀐다.
- 늦게 온 이벤트, 세션 시작 없이 온 이벤트, `leave` 뒤의 이벤트는 무시한다(기존).

## 8. 등록·신뢰·해제

- **화면**: 등록 화면의 클라이언트 행에 `MCP registered · Hooks off`처럼 두 상태를 함께 보인다. 행을 고르면 동작을 고른다: MCP 등록(미등록일 때), Turn on hooks, Turn off hooks, Back. 훅은 MCP를 등록한 뒤에만 켤 수 있다. 1단계에서는 Claude Code·Codex 행에만 훅 동작이 있다. 2026-10-25 개정: 처음 등록할 때는 MCP와 훅, Claude Code의 대기 깨우기를 한 미리보기와 한 번의 확인으로 함께 쓴다(`planRegistration`). 훅 파일을 안전하게 고칠 수 없으면 그 파일은 그대로 두고 MCP만 등록하며, 이유를 미리보기에 적는다. 이미 등록된 행은 위 동작으로 켜고 끈다.
- **비대화형**: `concos setup --host claude --hooks on [--apply]`, `--hooks off`. 2026-10-25부터 `--hooks on`은 MCP가 없으면 함께 등록하고, `--wake on`은 빠진 MCP와 훅까지 함께 켠다.
- **쓰기**: 미리보기 → 확인 → `.concos-mcp-backup-*` 백업 → 원자적 교체(기존 `applySetup`). 다른 훅과 주석은 보존한다. 결과를 concos가 다시 읽을 수 없는 변경은 쓰지 않는다. `command`가 `concos hook `으로 시작하는 항목을 concos 소유로 본다.
- **켜기**: 없는 항목만 추가한다. concos 그룹은 각 이벤트 목록의 맨 뒤에 붙인다. Codex는 신뢰를 `<파일>:<이벤트>:<그룹 번호>:<항목 번호>`와 명령 해시로 기록하므로(0단계 V4), 앞에 끼워 넣으면 뒤에 있던 사용자 훅을 다시 신뢰해야 한다. 옛 형식의 concos 훅(`--room` 인수 등)은 같은 자리에서 현재 형식으로 바꾼다.
- **끄기**: concos 항목만 지우고, 그 때문에 비게 된 그룹만 함께 지운다. concos 그룹 뒤에 다른 훅이 있었다면 번호가 당겨져 Codex에서 다시 신뢰해야 할 수 있다. 미리보기에 그 사실을 적는다.
- **상태 표시**: 기대하는 다섯 항목이 모두 있으면 `Hooks on`, 일부만 있으면 `Hooks 4/5`처럼 개수, 없으면 `Hooks off`.
- **Claude Code**: `~/.claude/settings.json`에 쓴다. 적용 뒤 안내: 새 세션부터 적용되고, 폴더 신뢰를 받아야 실행된다.
- **Codex**: `~/.codex/hooks.json`에 쓴다. `config.toml`에 concos 훅이 이미 있으면 중복으로 넣지 않고 알린다. 적용 뒤 안내: Codex에서 `/hooks`로 검토·신뢰해야 실행된다.
- **명령 문자열 고정**: `concos hook <이벤트> --host <클라이언트>`. Codex 신뢰가 명령에 묶이므로 버전이 바뀌어도 문자열을 바꾸지 않는다.
- 훅은 전역 설치한 `concos`를 쓴다. `npx`는 호출마다 수백 ms가 걸린다.
- **걸리는 시간**: Windows에서 훅 한 번은 Claude 경로(새 Git Bash → `concos` → node) 중앙값 약 290ms, Codex 경로(새 PowerShell → `concos.ps1` → node) 약 350ms다. node만은 약 95ms로, 대부분 셸을 띄우는 비용이다(2026-10-25, 10회). 그래서 출력이 필요 없는 `file-edited`는 두 클라이언트 모두 `async: true`로 등록해 편집마다 기다리지 않게 한다. 문맥이나 결정을 돌려줘야 하는 나머지 넷은 동기로 둔다.
- **실행 정책**: PowerShell 실행 정책이 `.ps1`을 막는 PC에서는 Codex 훅이 `concos.ps1`을 못 돌릴 수 있다. 그때는 `commandWindows`에 `concos.cmd hook …`을 쓴다. 이 PC에서는 막히지 않았다.
- **`CONCOS_HOME`**: 기본 위치를 쓰면 문제없다. `CONCOS_HOME`을 바꿔 쓰는 경우 Codex MCP 항목에 `env = { CONCOS_HOME = "…" }`를 함께 써야 훅과 같은 DB를 본다. 등록 화면이 이 값을 넣는다.

## 9. 설정 예시

Claude Code `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "concos hook session-start --host claude", "timeout": 10 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "concos hook prompt --host claude", "timeout": 10 }] }],
    "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "concos hook file-edited --host claude", "timeout": 10, "async": true }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "concos hook turn-end --host claude", "timeout": 10 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "concos hook session-end --host claude", "timeout": 10 }] }]
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
    "Stop": [{ "hooks": [{ "type": "command", "command": "concos hook turn-end --host codex", "timeout": 10 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "concos hook session-end --host codex", "timeout": 3 }] }]
  }
}
```

이 PC에서는 두 클라이언트 모두 `concos`를 찾았다(0단계 V1). PowerShell 실행 정책 때문에 `concos.ps1`이 막히는 PC에서만 Codex에 `commandWindows`를 함께 쓴다(8절).

## 10. 결정 사항 · 2026-10-25

| 항목 | 결정 |
| --- | --- |
| 구성 | MCP 기본, 훅은 선택 기능. User 범위 등록 한 번, 영어 CLI |
| 훅 종류 | 두 클라이언트 모두 명령 훅. `mcp_tool` 훅과 Channels는 쓰지 않음 |
| 대기 세션 깨우기 | Claude Code 전용 선택 기능으로 넣음(사용자 결정, 0단계 확인 뒤). SCAFFOLD 1절 규칙의 예외. 1단계 다음 2단계로 구현 |
| Stop 상기 | 답하지 않은 질문이 있으면 한 번 이어서 답하게 함(사용자 결정). 두 클라이언트 공통 |
| 알림·깨우기 대상 | 나에게 온 질문과 내 질문의 답(사용자 결정). 전체 메시지·메모·답에 대한 답 제외 |
| 1단계 클라이언트 | Claude Code·Codex 먼저(사용자 결정). 나머지 셋은 검증 뒤 |
| 읽음 처리 | 훅은 확인 처리하지 않음. 본문이 MCP로 모델에게 간 뒤 다음 호출에서 확인(기존 규칙) |
| 기존 화면 | 쓰레드 설계 기록과 Messages 탭(세 줄 미리보기, Enter로 전문)은 그대로 |

## 11. 2단계: Claude Code 대기 세션 깨우기

사용자 결정으로 SCAFFOLD 1절 규칙의 예외로 둔다(2026-10-25, 0단계 V6 확인 뒤). Claude Code 행에만 따로 켜는 선택 기능이며, 1단계 훅을 켠 경우에만 켤 수 있다. Codex 세션은 깨어나지 않고 프롬프트 알림과 Stop 상기만 받는다. 등록 화면과 README에 이 차이를 적는다.

구현 · 2026-10-25. 값은 아래로 시작하고 쓰면서 조정한다(`src/_defs/limits.ts`의 `WAKE_*`).

- **구조**: Stop에 `asyncRewake` 감시 훅을 하나 더 둔다. `concos hook watch --host claude`, `"asyncRewake": true`, `timeout` 3660초. 감시는 60분 뒤 스스로 끝나고, `timeout`은 그보다 1분 늦은 클라이언트 쪽 안전장치다. 등록은 `concos setup --host claude --wake on`과 등록 화면의 "Turn on idle wake". 훅을 끄면 감시 훅도 함께 지운다.
- **하나만 살아 있게**: 참가자마다 감시 세대 번호(`agent.wake_generation`, 스키마 6)를 둔다. 새 감시가 시작될 때와 UserPromptSubmit 때 세대를 올리고, 세대가 바뀐 감시는 종료 코드 0으로 끝난다.
- **사용 중에는 깨우지 않음**: 감시 시작(Stop) 뒤 60초가 지나야 깨울 수 있다. 사용자가 그사이 입력하면 세대가 바뀌어 감시가 끝난다.
- **감지**: 3초마다 DB를 읽어, 아직 상기하지 않은(`hook_nudged_seq`보다 새) 알림 대상(5절)을 찾는다. 찾으면 Stop 상기와 같은 형식의 문구를 stderr에 쓰고 종료 코드 2로 끝난다. 읽기는 잠금 없이 하고, 깨울 때만 쓰기 잠금 안에서 다시 확인한 뒤 기록한다.
    - "감시를 시작한 뒤 도착한 것"으로 좁히지 않은 이유: 이어가던 턴이나 깨어난 턴은 끝에서 상기하지 못하므로(`stop_hook_active`가 참), 그 사이에 온 질문이 다음 프롬프트까지 묻힌다. 상기 위치 하나로 Stop 상기와 깨우기가 같은 메시지를 두 번 알리지 않는다.
- **반복 방지**: 메시지당 한 번, 참가자당 한 시간에 4회(`agent.woken_at_list`), 60초 유휴 조건, 5절 대상 규칙. 깨어난 턴이 끝나면 새 감시가 시작되고, 이미 알린 메시지로는 다시 깨우지 않는다.
- **0으로 끝나는 경우**: 세대가 바뀜, 세션 종료·퇴장, 60분 경과. 감시할 참가자가 없거나 깨울 수 없는 클라이언트면 바로 끝난다.
- **stderr**: 종료 코드 2의 stderr가 그대로 모델에게 가므로, 감시 프로세스는 로그 수준을 `none`으로 두고 깨울 때의 한 줄만 쓴다(사용자가 `CONCOS_LOG_LEVEL`을 정했으면 그 값을 따른다).
- Notification(`idle_prompt`)에서 시작하지 않는 이유: Notification 훅은 종료 코드를 무시한다고 문서에 적혀 있다.
- **0단계 V6에서 확인한 동작**: 깨운 턴은 `<task-notification>`으로 시작하는 프롬프트로 들어오므로 UserPromptSubmit 훅이 실행되어 세대가 오른다. 이미 끝난 감시에는 영향이 없다. 그 턴의 Stop에는 `stop_hook_active`가 참이라 6절의 Stop 상기와 겹치지 않는다. 제한 시간이 지난 감시는 화면 표시 없이 정리된다.
- **남는 위험**: 세션을 닫을 때 감시 프로세스가 정리되는지(감시는 세션 종료 기록을 보고 스스로도 끝난다), 깨운 턴의 토큰 비용. 이어가던 턴이 60초를 넘기는 동안 새 대상이 오면 바쁜 세션에 알림이 한 번 들어갈 수 있다. 바쁜 세션에서는 다음 기회에 전달되므로 해는 작다고 보고 두었다.

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

비대화형 확인은 임시 데이터 폴더(`CONCOS_HOME`), 사용자 설정을 읽지 않는 옵션(Claude `--setting-sources project --strict-mcp-config`, Codex `--ignore-user-config`), 이번 실행에만 쓰는 훅(Claude `--settings`, Codex `-c hooks.…`와 `--dangerously-bypass-hook-trust`)으로 했다. Codex MCP 서버는 바깥 환경을 물려받지 않으므로 `-c mcp_servers.concos={…, env={CONCOS_HOME=…}}`로 넘겨야 한다. 처음 실행에서 이를 빠뜨려 실제 대합실에 테스트 참가자 하나가 생겼고, 메시지가 없는 것을 확인한 뒤 바로 지웠다.

**1단계 — 공통 훅.** 구현 · 2026-10-25. 아래 파일을 바꿨고 자동 테스트 150개와 타입 검사가 통과했다. 사용자 설정에 실제로 켜서 쓰는 확인(13절)은 남아 있다.

- `src/_defs/limits.ts`, `src/modules/store/schema.ts`: 스키마 5, `agent.hook_nudged_seq INTEGER NOT NULL DEFAULT 0`.
- `src/modules/store/room-store.ts`: 알림 대상 조회, `turn-end`의 Stop 상기 판단, 훅 참가자 기본 이름.
- `src/modules/hooks/types.ts`, `handler.ts`, `adapters/claude.ts`, `adapters/codex.ts`: `stop_hook_active` 읽기, Stop의 `decision: block` 출력, 알림 문구, 이벤트별 `timeout`.
- `src/modules/cli/clients.ts`, `setup.ts`: 훅 설정 위치, 켜기·끄기 계획, 상태 조회, `--hooks on|off`.
- `src/modules/cli/menu.ts`: 클라이언트 행의 동작 목록. concos development 세션이 같은 파일을 고치므로 시작 전에 범위를 맞춘다.
- `dbml/concos.dbml`, `README.md`, `SCAFFOLD.md`, 이 문서.
- 테스트: Stop 상기가 메시지당 한 번인지, `stop_hook_active`, 대상 규칙(직접·그룹 포함, 전체 제외, 내 질문의 답 포함, 답에 대한 답 제외), 상기 중 `waiting` 미전환, 설정 켜기·끄기의 보존·백업·중복 방지, Codex `config.toml` 중복 감지, 실제 `dist/cli.js` 자식 프로세스로 두 클라이언트 입력 fixture 실행.

**2단계 — 대기 세션 깨우기 (Claude Code 전용).** 구현 · 2026-10-25. 스키마 6(`wake_generation`, `woken_at_list`), `RoomStore.startWakeWatch`·`checkWakeWatch`, `src/modules/hooks/watch.ts`, `concos setup --host claude --wake on|off`, Claude Code 행의 "Turn on idle wake". 자동 테스트 158개 통과.

실제 확인 · 2026-10-25 (Claude Code 2.1.310, haiku, 임시 데이터 폴더, 등록 결과와 같은 훅 설정):

- 세션이 `join`한 뒤 턴이 18:14:21에 끝나 감시가 시작됐다. 18:14:58에 Reviewer가 질문 #1을 보냈다.
- 18:15:21, 감시 시작 1분 지점에 세션이 깨어났다. 깨운 기록이 1건 남았고 상기 위치가 질문까지 올라갔다.
- 깨어난 세션이 `read_messages`로 질문을 읽고 18:15:28에 `reply`로 답했다. 질문은 그 MCP 호출로 수신 확인됐다. 훅이 확인 처리한 것은 없다.
- 감시 세대는 2(프롬프트, 감시 시작) → 3(깨움) → 4(깨운 턴의 UserPromptSubmit) 순서로 올랐다.
- 그 세션은 답한 뒤 스스로 `leave`했다. 퇴장한 참가자는 감시하지 않으므로 다음 감시는 시작되지 않았고, 남은 감시 프로세스도 없었다.

**3단계 — 다른 클라이언트.** Gemini CLI·Cursor·Copilot CLI를 실제 세션으로 확인한 뒤 등록 화면에 연다. 프롬프트 알림을 넣을 수 없는 클라이언트는 그 사실을 화면에 적는다.

## 13. 1단계 검증 계획 (실제 세션)

Claude Code와 Codex에서 각각 확인한다.

1. 훅을 켜고 새 세션을 연다 → 참가자가 하나 생기고, 모델이 `join`한 뒤에도 하나로 유지된다.
2. 프롬프트를 보낸다 → 카드가 `working`이 된다. 다른 세션에서 질문을 보내 두면 프롬프트 때 한 줄 알림이 들어간다.
3. 파일을 수정한다 → `editing`에 그 파일이 오른다.
4. 턴 도중 다른 세션이 질문을 보낸다 → 턴 끝에 한 번 이어서 질문을 읽고 답한다. 같은 질문으로 두 번 이어가지 않는다.
5. 알림 대상이 없는 턴이 끝난다 → `waiting`, `editing` 비움.
6. 압축·재개 → 같은 참가자, 핸들 다시 주입.
7. 세션을 닫는다 → 종료 표시, `editing` 비움.
8. 훅을 끈다 → concos 항목만 사라지고 다른 훅은 남는다. 백업 파일이 생긴다.

## 14. 남은 결정

- 2단계 깨우기의 값: 유휴 60초, 확인 간격 3초, 감시 60분, 시간당 4회로 시작했다. 쓰면서 조정한다.
- 3단계에서 다른 클라이언트를 여는 시점.

## 공식 출처

- [Claude Code hooks](https://code.claude.com/docs/en/hooks): 이벤트, `async`·`asyncRewake`, Stop의 `stop_hook_active`, 폴더 신뢰
- [Claude Code channels](https://code.claude.com/docs/en/channels): 연구 프리뷰, `--channels`, 허용 목록
- [Codex hooks](https://learn.chatgpt.com/docs/hooks): 이벤트, `mcp_tool`, `async`, Stop 이어가기, `/hooks` 신뢰, `commandWindows`
