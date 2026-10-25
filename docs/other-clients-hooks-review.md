# 다른 클라이언트의 hook·wake 검토

상태: 조사 기록 · 2026-10-25, AD_DX / CONCOS 01 (Codex). 구현과 실제 세션 검증은 아직이며, [hooks-design.md](hooks-design.md) 12절의 3단계에서 진행한다. 본문은 0.1.10 이전 코드 기준이고, 그 뒤 달라진 점은 바로 아래 절에 있다.

현재 MCP 등록 대상인 Gemini CLI·Cursor·GitHub Copilot CLI를 우선 조사하고, 새 지원 후보로 OpenCode를 비교했다. 공식 문서와 concos 코드를 대조한 결과다. 대상 제품의 실제 세션 실행과 최소 지원 버전 확인은 남아 있다. 앱 코드와 사용자 설정은 변경하지 않았다.

## 2026-10-26 기준 달라진 점

0.1.10·0.1.11의 변경 중 이 검토에 걸리는 것이다. 본문은 검토 당시 그대로 두었다. 괄호 안의 절 번호는 [hooks-design.md](hooks-design.md)의 것이고, 1~5번은 아래 "concos 코드에서 먼저 바꿔야 할 부분"의 항목이다.

- **Codex에도 대기 깨우기가 생겼다(11.2절).** 밖에서 깨우는 클라이언트는 어댑터의 `deliverWake`로 한 줄을 넘기고(Codex는 `codex queue`), 감시 훅은 감시를 별도 node 프로세스로 떼어 낸 뒤 바로 끝난다. Gemini 절의 "동기 훅이 턴 끝을 붙잡는 문제"는 이 방식으로 피할 수 있다. 남는 것은 같은 세션에 새 턴을 시작시키는 입력 경로다.
- **등록 코드(1·2번)에 할 일이 늘었다(8절).** 훅 실행 형식이 클라이언트마다 다르다. Claude Code는 Windows에서 셸 없이 node를 바로 띄우는 exec 형식(`command`·`args`)이고, Codex는 어느 셸에서나 같게 읽히는 `concos hook …` 명령이다. `hookEntry`는 Claude Code가 아니면 `concos` 명령을 쓰므로, 새 클라이언트는 셸 없는 실행을 지원하는지 확인해 정한다. 0.1.10에 생긴 등록 갱신(`planUpdate`)도 MCP 항목과 훅을 따로 바꾸므로, 2번의 같은 파일 병합이 여기에도 필요하다.
- **턴 끝 훅이 받음 처리를 한다(6.1절).** `turn-end` 이벤트는 클라이언트와 상관없이 MCP로 전문이 나간 메시지를 받음 처리한다. 감지·주입·깨움만으로는 받음 처리하지 않는다는 5번 원칙은 그대로다.
- **카드의 프로젝트는 세션을 시작한 폴더로 고정된다(0.1.11).** 시작 훅이나 첫 `join`의 폴더가 프로젝트를 정하고, 그 뒤의 다른 폴더는 `current_directory`로 따로 남는다. 여러 폴더를 연 Cursor에서 시작 폴더를 무엇으로 볼지(Cursor 절)가 곧 카드의 프로젝트를 정한다.

## 판정 기준과 결론

- **상태 훅**: 시작·입력·편집·턴 종료·세션 종료를 대합실에 기록한다.
- **턴 종료 상기**: 응답을 마치려는 순간 미확인 질문이 있으면 한 번 더 이어간다.
- **대기 세션 깨우기**: 턴이 끝나 완전히 대기 중일 때 도착한 메시지로, 사용자 입력 없이 같은 세션의 새 턴을 시작한다.

뒤의 두 기능은 별도로 검증해야 한다. 모델에게 문맥을 추가하거나 사람에게 알림을 띄우는 것만으로 대기 세션 깨우기가 성립하지는 않는다.

| 대상 | 상태 훅 | 턴 종료 상기 | 대기 세션 깨우기 | User 설정 |
| --- | --- | --- | --- | --- |
| Gemini CLI | 공식 지원 | `AfterAgent`의 거부·재시도 사용 가능 | 훅 자체의 지원은 미확인. 백그라운드 명령 완료 주입은 별도 실험 후보 | `~/.gemini/settings.json` |
| Cursor 로컬 Agent | 공식 지원. IDE·CLI 별도 확인 필요 | `stop`의 `followup_message` 사용 가능 | 훅 자체의 지원은 미확인. SDK로 관리하는 에이전트는 입력 API 사용 가능 | `~/.cursor/hooks.json` |
| GitHub Copilot CLI | 공식 지원 | `agentStop`의 차단·다음 턴 사용 가능 | 훅 자체의 지원은 미확인. SDK 세션의 재개·입력은 별도 경로 | `~/.copilot/hooks/concos.json` 후보, `COPILOT_HOME` 반영 |
| OpenCode — 추가 후보 | 플러그인 이벤트로 구현 가능 | 세션 입력 API로 구현 가능성 있음 | 실행 중 서버의 같은 세션에 입력하는 공식 API가 있어 유력한 구현 후보 | User 플러그인·MCP 등록 신규 필요 |

위 지원 판정의 근거는 [Gemini 훅](https://geminicli.com/docs/hooks/reference/), [Gemini 설정](https://geminicli.com/docs/reference/configuration/), [Cursor 훅](https://cursor.com/docs/hooks), [Copilot 훅](https://docs.github.com/en/copilot/reference/hooks-reference), [OpenCode 플러그인](https://opencode.ai/docs/plugins/), [OpenCode 서버](https://opencode.ai/docs/server/)다. 대기 깨우기의 미확인은 불가능 판정이 아니라, 확인한 문서만으로 같은 대화의 유휴 상태에서 새 턴이 시작된다고 보장할 수 없다는 뜻이다.

## Gemini CLI

현재 어댑터의 다섯 이벤트 대응은 공식 목록과 맞는다: `SessionStart`, `BeforeAgent`, `AfterTool`, `AfterAgent`, `SessionEnd`. 시작·입력 시 문맥을 넣을 수 있다. `AfterAgent`에서는 `decision: deny`와 사유로 재시도하며, 입력의 `stop_hook_active`로 반복을 막을 수 있다. 기존 어댑터에 `canContinue` 판정과 `continueTurn` 출력을 추가할 수 있다. 제한 시간 단위는 **밀리초**다. [공식 레퍼런스](https://geminicli.com/docs/hooks/reference/)

훅은 동기로 실행되므로 `AfterAgent`에 장시간 DB 감시를 붙이면 턴 종료를 기다리게 된다. Claude의 감시 훅을 그대로 이식하는 방법은 적합하지 않다. [훅 성능 지침](https://geminicli.com/docs/hooks/best-practices/)

추가 후보는 `tools.shell.backgroundCompletionBehavior: inject`다. 기본값은 `silent`이며, 이 설정은 백그라운드 셸 작업의 완료 출력을 에이전트에 주입한다. 다만 concos 감시를 호스트가 관리하는 백그라운드 작업으로 시작해야 하고, 유휴 상태에서 새 턴도 시작하는지는 실제 확인이 필요하다. 다른 셸 작업의 기본 동작까지 바뀌므로 Register에서 이 전역 설정을 임의로 바꾸지 않는다. [설정 레퍼런스](https://geminicli.com/docs/reference/configuration/)

공개 소스에서도 완료 결과는 주입 서비스에 전달되고, UI는 주입을 대기 힌트로 모은다. 이 경로를 확인한 것만으로 자동 깨우기 완료로 판정하지 않았다. [완료 처리](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/executionLifecycleService.ts), [UI 주입 수신](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/AppContainer.tsx)

## Cursor

사용자 훅은 `version: 1`과 이벤트별 명령 배열을 쓴다. `stop`은 후속 메시지로 이어갈 수 있으며 `loop_count`와 `loop_limit`이 있다. concos는 정상 완료일 때만 한 번 상기하고 취소·오류 뒤에는 이어가지 않는 편이 맞다. `sessionStart`는 초기 문맥을 제공하지만 fire-and-forget이므로 MCP 참가와의 순서 경쟁을 확인해야 한다. `beforeSubmitPrompt` 출력은 진행 여부와 사용자 메시지이며, 문맥 주입용으로 쓰면 안 된다. [공식 훅 문서](https://cursor.com/docs/hooks)

현재 `normalizeEvent`는 명시적 `cwd` 또는 단일 `workspace_roots`를 요구한다. 여러 폴더를 연 Cursor에서는 임의로 첫 폴더를 고르지 말고 공식 `CURSOR_PROJECT_DIR` 전달 여부를 확인해 보완한다. 같은 문서의 User 훅·Windows PowerShell 실행·제한 시간(초)을 기준으로 설치를 구성한다. 로컬 IDE, Cursor CLI, Cloud Agent는 각각 검증한다. 클라우드 환경은 로컬 대합실 DB와 같은 실행 환경으로 간주하지 않는다. [공식 훅 문서](https://cursor.com/docs/hooks)

SDK의 `Agent.resume()`와 `agent.send()`는 SDK가 관리하는 로컬·클라우드 대화를 재개할 수 있다. 이것을 이미 열려 있는 IDE 대화에 붙는 기능으로 가정하면 안 된다. concos가 에이전트 실행까지 관리하는 별도 통합 방식으로 검토한다. [TypeScript SDK](https://cursor.com/docs/sdk/typescript)

## GitHub Copilot CLI

명령 훅으로 다섯 상태 이벤트를 기록할 수 있고 `agentStop`에서 차단 사유로 다음 턴을 요청할 수 있다. `stop_hook_active`로 자체 반복을 막으며, 호스트에는 연속 8회 상한도 있다. `userPromptSubmitted`의 명령 훅 출력은 버려진다. 알림은 `sessionStart`, `postToolUse`의 추가 문맥, 턴 종료 상기를 우선 사용한다. `userPromptTransformed`의 문맥 교체도 추가 후보지만 원래 입력 보존과 설치 버전에서의 출력 소비를 검증해야 한다. [공식 훅 레퍼런스](https://docs.github.com/en/copilot/reference/hooks-reference)

설정은 `version: 1`의 이벤트별 명령 배열이다. User 훅 디렉터리와 `COPILOT_HOME`을 존중하고, 다른 훅 파일은 보존한다. Windows 실행 필드·초 단위 제한 시간을 제품 형식에 맞춘다. SDK `resumeSession()`·`sendAndWait()`는 입력 경로가 있지만, 일반 대화형 CLI 창과 같은 실행 세션을 동시에 제어할 수 있다는 보장은 별도로 필요하다. SDK는 세션 잠금을 제공하지 않으므로 입력 충돌 방지도 필요하다. [훅 형식](https://docs.github.com/en/copilot/reference/hooks-reference), [SDK 세션 재개](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence)

## 추가 후보: OpenCode

User 플러그인에서 세션·파일·도구 이벤트를 관찰할 수 있다. `session.status`·`session.idle`·`file.edited`와 도구 전후 이벤트를 concos 상태에 대응시키는 방식이다. 현재 concos 등록 대상에는 없으므로 MCP 설정과 플러그인 설치부터 별도 추가해야 한다. [플러그인 문서](https://opencode.ai/docs/plugins/)

실행 중인 TUI는 자체 서버와 연결되며, 그 서버에는 기존 세션에 메시지를 보내는 `/session/:id/message`와 `/session/:id/prompt_async`가 있다. 따라서 로컬 감시자 또는 플러그인이 미확인 질문을 발견해 같은 세션에 입력하는 방식은 실현 가능성이 높다. 실행 중인 서버의 주소·인증·세션 ID를 알아야 하며, 별도 `opencode serve`를 새로 띄우는 것만으로 원래 TUI에 붙는 것은 아니다. 실제 대화 유지·유휴 입력·사용 중 경합은 검증해야 한다. [서버와 연결 방식](https://opencode.ai/docs/server/)

## concos 코드에서 먼저 바꿔야 할 부분

이 절은 공식 문서와 현재 코드를 대조한 구현 판단이다. 앱 코드는 수정하지 않았다.

1. **등록 형식 분리**: `setup.ts`의 `hookEntry`·`handlersOf`·추가/삭제는 Claude·Codex용 중첩 그룹을 전제로 한다. `hookFormat` 정보는 기존 어댑터에 있지만 설치 코드에서 분기하지 않는다. `HOOK_CLIENTS`에 이름만 추가하면 Cursor·Copilot 설정 형식이 맞지 않는다. 평평한 명령 배열과 `version`을 지원하고, 검사·중복 방지·해제도 같은 형식으로 처리해야 한다.
2. **Gemini의 같은 파일 병합**: MCP와 훅이 모두 `settings.json`에 들어간다. 현재 `planRegistration`은 MCP 변경과 훅 변경을 별도로 추가하므로, Gemini까지 열 때는 하나의 파일 변경으로 합쳐야 한다. 같은 경로의 독립 스냅샷 두 개를 순서대로 쓰면 현재 변경 감지에 걸려 등록이 실패할 수 있다.
3. **턴 종료 출력**: Gemini·Copilot 어댑터에 반복 방지와 `continueTurn`을 연결한다. Cursor는 완료 상태와 `loop_count`를 확인하고 `followup_message`를 출력한다. 공통 알림 대상·중복 상기 방지는 기존 store 규칙을 재사용한다.
4. **제품별 옵션**: 제한 시간 단위, matcher, Windows 명령 실행, User 설정 재정의를 분리한다. `async`·`asyncRewake`는 해당 제품이 지원할 때만 기록한다. SDK 재개를 일반 훅 설치와 같은 기능으로 표시하지 않는다.
5. **참가자 유지**: 훅과 MCP가 동일한 세션·작업 경로·DB를 사용하고 `resume_handle`로 카드 하나를 유지해야 한다. 감지·주입·깨움으로 메시지를 읽음 처리하지 않으며, 세션 이름도 작업명으로 바꾸지 않는다.

검토한 로컬 파일: `src/modules/cli/{clients,setup}.ts`, `src/modules/hooks/{handler,types}.ts`, `src/modules/hooks/adapters/{gemini,cursor,copilot,shared}.ts`.

## 제안하는 진행 순서와 검증

1. 등록 형식과 같은 파일 병합을 먼저 정리한다. 백업·미리보기·중복 키 거부·변경 감지·타 제품 설정 보존을 유지한다.
2. Gemini CLI와 Copilot CLI의 상태 훅·턴 종료 상기를 실제 세션으로 검증한다. Cursor는 로컬 IDE와 CLI를 구분해서 같은 검증을 진행한다. 통과한 제품·버전만 등록 메뉴에 연다.
3. 대기 깨우기는 별도 실험으로 둔다. Gemini 백그라운드 완료 주입, Cursor·Copilot SDK 입력, OpenCode 기존 세션 입력을 각각 검증한다. 현재 열린 세션에 붙는 경로와 concos가 새로 관리하는 실행 경로를 구분한다.

실제 호스트 검증에서는 임시 사용자 설정과 로컬 DB를 사용하고 다음을 기록한다.

- 정확한 제품 버전·실행 환경·인증 방식과 이벤트 입력/출력.
- 훅 자동 참가 뒤 모델의 MCP 참가가 카드 하나로 유지되는지.
- 입력→working, 편집→editing, 턴 종료→waiting, 종료→연결 종료의 실제 반영.
- 미확인 질문 하나로 한 번만 이어가며 취소·오류·다른 제품의 훅을 방해하지 않는지.
- **완전히 턴이 끝난 뒤** 질문을 보내고, 사용자 입력 없이 같은 세션이 새 턴을 시작해 MCP로 읽고 답하는지. 문맥 큐 적재나 사람 알림만으로 성공 판정하지 않는다.
- 새 사용자 입력·세션 종료·수동 비활성화 때 감시가 회수되고, 중복 감시·반복 깨움·오래된 메시지 재주입이 없는지.
- 기존 설정이 있는 상태의 설치·재등록·해제와, Gemini의 MCP/훅 동시 변경이 원본을 보존하는지.

현재 검토 결과는 세 제품의 상태 훅·턴 종료 상기 확장을 진행할 근거가 된다. 추가 wake 경로는 실제 같은 세션의 새 턴까지 확인한 뒤 지원을 확정한다.
