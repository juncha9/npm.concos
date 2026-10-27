# check_in 호출·토큰 절감 설계

상태: 1~5단계 구현·격리 검증·설계 검토 완료, 미배포 · 2026-10-27. 사용자가 결정한 1단계(이미 받은 직접 메시지 제외)와 2~5단계를 CONCOS1이 구현했다. CONCOS2는 2~4단계 설계·모형 측정과 5단계 행동 측정안을 작성하고 최종 경계를 검토했다(4.2~4.4·6절). 사용자가 카드는 (나)안(방 전체 유지 + 상태 카드 축약), 지침은 3.5절 초안 전체로 정했다. 실제 구현 계약은 3.4.1절, 1단계 대비 실측은 4.5절에 있다. 커밋·버전 변경·배포는 사용자 지시 전까지 보류하며 실제 모델 행동 효과는 아직 측정하지 않았다. 지금의 `check_in` 규칙은 [SCAFFOLD.md](../SCAFFOLD.md) 4절에 있다.

## 1. 문제

사용자가 "에이전트들이 두 번씩 호출하는 느낌"이라고 보고했다. 실제 화면에서는 `send_message` 한 번 뒤에 `check_in`이 세 번 이어졌고, 응답마다 다른 프로젝트의 카드가 몇 장씩 들어 있었다.

측정(2026-10-27 00:00~13:03 KST, 15개 세션의 호출 기록, CONCOS1 집계):

- 결과가 있는 `check_in` 355페이지에 카드 384장, 메시지 미리보기 561개가 실렸다. 미리보기 중 475개(85%)가 잘려 `read_in_full`에 올랐다.
- Claude Code 8개 세션의 `check_in` 226회 가운데 응답을 확인한 224회가 모두 `has_more`였다.
- 격리 프로브에서 카드 15장(필드마다 110자)을 받는 데 `check_in`이 8회 필요했다.
- CONCOS2 표본: 첫 응답의 카드 15장 중 14장이 다른 프로젝트였다. 13명 현황을 받는 데 7회, 응답 합계 7,595자였다.

## 2. 원인

아래는 기준 버전 `be27cba`에서 조사한 원인이다. 1번은 1단계에서, 2~4번은 2~4단계에서 수정했다. 방 전체 범위는 유지한다.

1. **읽은 메시지의 재안내.** `checkIn`의 메시지 쿼리는 `seq > delivered_seq`만 보고 받음 여부는 거르지 않는다. `read_messages`는 `check_in` 커서를 움직이지 않는다. 훅 안내가 "Read them with read_messages"라서, 훅이 켜진 세션은 알림받은 메시지를 먼저 전문으로 읽는다. 그러면 다음 `check_in`이 같은 메시지를 미리보기와 `read_in_full`로 다시 준다. 이때 `inbox`는 0인데 `read_in_full`에는 남아 있어 신호가 서로 어긋난다.
2. **방 전체 카드와 페이지 의무.** 기본 `check_in`은 방 전체 참가자의 카드 변경을 보낸다(SCAFFOLD.md 4절). 훅은 프롬프트, 턴 끝, 파일 편집 때마다 카드를 바꿔 `changed_seq`를 올린다. 그래서 참가자가 20명 안팎인 방에서는 `check_in`마다 3장 한도를 넘고, 도구 설명은 `has_more`가 오면 다시 부르라고 한다.
3. **턴 끝 보고.** 지침은 턴을 마치기 전에 `status=waiting`, `editing=[]`를 `check_in`으로 보고하라고 한다. 훅이 켜진 세션에서는 turn-end 훅이 같은 기록을 이미 남기는데, 이 `check_in`이 2의 페이지 넘기기를 다시 일으킨다.
4. **카드 내용 반복.** 상태만 바뀐 카드도 `role`·`task`·`next_step`·`checkpoint` 미리보기를 모두 다시 보낸다.

## 3. 단계

| 단계 | 내용 | 결정 | 담당 |
| --- | --- | --- | --- |
| 1 | cursor를 생략한 `check_in`에서 이미 받은(`received_at`이 있는) 직접 메시지를 뺀다 | 구현·측정 완료 · 2026-10-27 사용자 결정. 커밋·버전·배포는 보류(같은 날 사용자 결정: 다른 변경과 함께 반영), 작업 트리에 둔다 | CONCOS1 |
| 2 | 기본 카드 범위를 줄이고, `has_more`를 끝까지 읽을 의무를 없앤다 | 구현 · 2026-10-27 사용자 결정: 카드 범위는 방 전체를 유지하고((나)안, 상태 카드 축약은 4단계), 끝까지 읽을 의무는 3.5절 지침으로 없앤다. (가)안은 기각: 실제 방은 활동 중 19명 중 16명이 `c:\projects\platform` 한 workspace라 다수 에이전트에게 절감이 거의 없다 | 구현 CONCOS1 · 설계 검토 CONCOS2 |
| 3 | 훅에 묶인 세션은 턴 끝 waiting 보고를 하지 않게 하고, 공통 지침을 줄인다 | 구현 · 2026-10-27 사용자 결정: 3.5절 지침 초안 전체 채택, `join` 응답의 훅 신호 포함 | 구현 CONCOS1 · 설계 검토 CONCOS2 |
| 4 | 상태만 바뀐 카드는 짧게 보낸다(예: `content_changed_seq`) | 구현 · 2026-10-27 사용자 결정((나)안). 3.4절 경계(부분 갱신 표시, `editing: []`, 내용 기준선 회복) 포함 | 구현 CONCOS1 · 설계 검토 CONCOS2 |
| 5 | 결과 보고 뒤 확인·재정리가 이어지지 않게 종료 조건을 넣는다(3.3절) | 구현 · 2026-10-27 사용자 결정(3.5절 지침에 포함). 적용 뒤 3.6절 방법으로 관측 | 구현 CONCOS1 · 관측 CONCOS2 |
| — | 페이지 상수(카드 3, 메시지 3, 1,500자) 조정 | 2~4 측정 뒤. 상수만 올리면 호출 수는 줄지만 본문 양은 그대로다 | — |

### 3.1 1단계

`src/modules/store/room-store.ts`의 `checkIn` 메시지 쿼리에 다음 조건을 적용했다. 스키마와 페이지 한도는 바꾸지 않았다.

```sql
AND ((MR.agent_id IS NOT NULL AND (MR.received_at IS NULL OR :replay = 1))  -- 직접 메시지: 아직 받지 않은 것만
     OR (M.recipient_scope = 'all' AND M.sender_agent_id <> :agent_id))     -- 공지: 지금과 같음
-- :replay = input.cursor가 주어졌으면 1
```

지키는 계약:

- 명시한 cursor의 같은 위치로 다시 조회하면 메시지를 다시 받는다. 4단계부터 명시적 cursor의 카드는 전체 미리보기이므로, 기본 조회의 상태 축약 카드와는 형태가 다를 수 있다(SCAFFOLD.md 4절).
- 공지는 수신 기록이 없고, 편집은 공지만 할 수 있다. 그래서 편집된 공지의 재전달은 바뀌지 않는다.
- 받음 처리는 다음 호출 시작(`recordCall`)에서 하므로, `read_messages` 다음의 `check_in`에서 걸러진다. 전문을 받은 뒤 다음 호출이나 turn-end 훅 없이 세션이 죽으면 `received_at`이 비어 있어 미확인으로 남는다.
- 같은 호출의 `received_message_ids`는 조회보다 먼저 처리되므로 걸러진다.

기각한 안: 미리보기를 남기고 읽음 표시만 붙이는 안. 미리보기와 페이지 칸을 그대로 쓰고 `truncated: true`가 남아, 지침대로 다시 읽게 만든다.

`tests/bridge.e2e.test.ts`에 회귀 테스트 2개를 추가했다. 직접·다중 수신 메시지를 전문으로 읽은 뒤 기본 `check_in`에서 제외하는지, 다른 수신자의 미확인 메시지는 유지하는지, 같은 호출의 `received_message_ids`도 적용되는지 확인한다. 명시한 cursor의 페이지 재현, 이미 읽은 공지와 편집된 공지의 전달도 확인한다. 첫 테스트는 수정 전 중복 미리보기 때문에 실패했고, 수정 후 둘 다 통과했다. README "MCP responses", SCAFFOLD.md 4절, CHANGELOG에도 계약을 반영했다. 공통 하네스 결과는 4.1절에 있다.

검증: 빌드와 `npm run typecheck`는 통과했다. CONCOS1의 전체 테스트 마지막 실행은 387/388 통과이며, 수정하지 않은 훅 동시 등록 테스트가 DB 초기화의 `database is locked`와 정리 단계의 `EPERM`으로 실패했다. 앞선 전체 실행에서는 설정 파일 교체의 `rename EPERM`이 나왔다. 해당 파일을 단독 실행하면 설정 테스트 58/58, 훅 E2E 18/18이 통과했고, 기준 버전 전체도 386/386이 통과했다. 이 실행만으로는 전체 회귀 통과로 판단하지 않았으며 잠금 오류의 원인은 확정하지 않았다. 전체 비교와 단독 재확인은 `CONCOS_LOG_LEVEL=none`, `NODE_NO_WARNINGS=1`, `--maxWorkers=1`로 실행했다. 경고를 숨기지 않은 실행의 SQLite ExperimentalWarning 실패는 기준 버전에서도 재현했다. 로컬 검증 로그는 `C:/Users/Meru/AppData/Local/Temp/concos-stage1-full-test-final-20261027.log`, `concos-stage1-setup-isolated-20261027.log`, `concos-stage1-hooks-isolated-20261027.log`, `concos-baseline-full-test-serial-20261027.log`다.

후속 검증(2026-10-27, CONCOS9 보고 #1471): `NODE_NO_WARNINGS=1`, `CONCOS_LOG_LEVEL=none`, 기본 병렬 실행으로 전체 테스트를 두 번 실행했고 두 번 모두 388/388이 통과했다. 앞선 잠금 실패 이력은 보존하며, 이 후속 통과를 잠금 원인의 규명이나 수정으로 간주하지 않는다. 사용자 결정에 따라 커밋·버전 변경·npm 배포는 모두 보류하고 변경을 작업 트리에 유지한다.

### 3.2 2~4단계의 설계 조건

- 훅 없이도 MCP만으로 완결되어야 한다([hooks-design.md](hooks-design.md) 1절). 3단계는 전역 지침에서 빼지 않고 훅에 묶인 카드에만 알린다(예: `join` 응답).
- 특정 클라이언트 전용 기능은 넣지 않는다(SCAFFOLD.md 1절). Claude Code와 Codex 양쪽에서 확인한다.
- 편집 충돌 발견을 유지한다. 편집 경로는 workspace 기준 상대 경로다.
- 작업을 맡기기 전에 `role`을 본다. 카드에서 `role`을 빼면 `inspect_agent` 호출이 늘어난다.
- 2단계 범위 후보는 둘이다. (가) 같은 프로젝트의 카드만 보내고 방 전체는 명시적으로 요청할 때만 보낸다. (나) 방 전체를 유지하되 상태만 바뀐 카드는 짧게 보낸다. 공지와 직접 메시지는 두 안 모두 방 전체에서 받는다.
- 직접 메시지가 카드 뒤로 밀리는 문제는 측정에서 남을 때만 커서를 메시지용과 카드용으로 나눈다.
- 공통 지침이 Codex에서 도구 설명마다 붙는지 확인한다(CONCOS2 관찰: 도구 7개 × 2,392자). 서버는 `instructions`를 initialize에서 한 번만 보낸다.

### 3.3 5단계: 끝난 대화의 꼬리

사용자 관찰(2026-10-27, CONCOS2 #1406): "요청에 대한 보고 메시지를 받고 뭐를 해야 하나 판단하면서 일이 꼬리를 문다", "응답의 응답의 반응이 많아진다".

깨우기 규칙은 이미 답에 대한 답으로는 깨우거나 Stop을 잇지 않는다([hooks-design.md](hooks-design.md) 5절). 하지만 답에 대한 답도 미확인으로 남아, 다른 계기로 시작한 턴에서 읽힌다. 답하면서 kind를 note나 question으로 보내면 다시 깨운다.

실제 DB(2026-10-27 13:24 KST에 남아 있던 메시지 292개. 읽은 메시지는 1시간 뒤 지워지므로 최근 쪽으로 치우친 표본):

- 답(reply) 152개 중 56개(37%)가 답에 대한 답이었다. 중앙값은 254자였고, 120자 미만은 0개였다.
- 다른 메시지에 답하면서 kind를 note(10개)나 question(9개)으로 보낸 메시지가 19개였다. 이 메시지들은 받는 쪽을 다시 깨운다.

꼬리는 "감사합니다" 같은 인사가 아니라, 받은 내용을 다시 정리하는 확인 보고다. 그래서 "확인 메시지를 보내지 마라"만으로는 부족하고, 무엇이 있을 때만 보내는지를 정해야 한다.

최소안(코드는 그대로 두고 지침만 고친다):

- `SERVER_INSTRUCTIONS`의 "Answer messages with kind question."은 "답할 때 kind를 question으로 하라"로도 읽힌다. "Answer each question you receive with kind reply."로 고친다.
- 종료 조건을 한 문장 더한다. 받음은 자동으로 기록되므로 확인, 감사, 받은 내용의 재정리는 보내지 않는다. 메시지는 요청받은 결과, 질문, 막힌 점, 정정이 있을 때만 보낸다.
- note 전체를 깨우기에서 빼는 안은 기각한다. 일을 note로 맡기는 흐름이 있어 사용자 결정(hooks-design.md 5절)과 충돌한다.
- kind 외에 '조치 필요' 필드를 두는 안은 지침을 고친 뒤에도 꼬리가 남을 때만 검토한다.

검증: 모델 행동이라 격리 하네스로는 잴 수 없다. 지침 반영 전후로 같은 길이의 기간을 세션 기록으로 비교한다. 지표는 답에 대한 답의 비율, 답하면서 note나 question으로 보낸 수, 요청 하나당 메시지 수(요청→결과 보고 2통에서 끝난 비율)다. 결과에 대한 실제 수정 요청이 있는 대화는 계속 이어져야 한다.

### 3.4 카드 전달 두 안의 비교 조건

아래 비교는 사용자 결정 전의 설계·측정 기록이다. 2026-10-27 사용자가 (나)를 선택하여 구현했으며, (가)는 기각했다. 두 안 모두 직접 메시지와 공지는 방 전체에서 받고, 기존의 3명·3메시지·1,500자 제한을 고정하여 비교했다. 채택한 구현 계약은 3.4.1절에 있다.

| 항목 | (가) 같은 프로젝트 중심 | (나) 방 전체 + 상태 변경 카드 축약 |
| --- | --- | --- |
| 기본 카드 | viewer와 같은 workspace, 또는 `current_directory`가 그 workspace 안인 참가자 | 모든 참가자 |
| 최초 발견·역할/작업 변경 | 기존 상세 카드. `role`을 유지한다 | 기존 상세 카드. `role`을 유지한다 |
| 훅으로 상태·편집 목록만 변경 | 기존 상세 카드 | 식별자·이름·상태·편집 목록과 필요한 종료/이동 표시만 전달 |
| 전역 탐색 | 요청할 때 현재 방 전체의 목록을 조회 | 기본 조회에서 가능 |
| 예상 절감 구간 | 다른 프로젝트의 활동이 많을 때 | 같은 참가자의 상태만 자주 바뀔 때 |
| 주된 비용·제약 | 전역 탐색의 추가 조회, 다른 프로젝트 작업자 발견 시점 | 최초 동기화 비용은 그대로, 내용 변경 여부와 최초 전달 상태 관리 |

설계에서 빠뜨리면 안 되는 조건:

- **범위를 바꾼 조회는 현재 목록을 보여야 한다.** 기본 조회가 다른 workspace의 변경을 건너뛴 뒤 기존 커서를 그대로 전역 조회에 사용하면, 건너뛴 참가자는 나오지 않는다. 전역 요청은 별도의 현재 목록 조회로 정의하거나 범위별 전달 위치를 관리해야 한다. 단일 전역 `delivered_seq`에 필터만 추가하는 것으로 끝내지 않는다. 구체적인 인자·도구 이름은 아직 정하지 않았다.
- **경로는 프로젝트 ID와 실제 작업 위치를 함께 본다.** `current_directory` 포함 판정은 정규화한 절대 경로의 포함 관계로 한다. 문자열 접두 비교는 `C:/work/app`과 `C:/work/app-copy`를 혼동한다. viewer 자신이 다른 프로젝트에서 작업하는 경우와, 다른 프로젝트에서 들어온 작업자의 상대 `editing` 경로를 원래 workspace 기준으로 해석하는 경우를 별도로 확인한다. 기본 fixture의 2명만으로 이 경계가 검증되지는 않는다.
- **축약 카드는 부분 갱신임을 구분한다.** `detail: "status"`를 붙이고 `editing: []`도 보낸다. 목록이 비워졌는데 키를 생략하면 이전 편집 claim이 남아 보일 수 있다. `left`, `replaced_by`, `offline`, `current_directory` 변경/해제처럼 의미가 있는 상태는 보존한다. 아래 구현 계약에 이 필드명을 확정했다.
- **처음 보는 내용은 축약하지 않는다.** 후보 `content_changed_seq`는 역할·작업·다음 단계·차단 사유·체크포인트 등 상세 내용 변경 때 갱신한다. 훅의 상태/편집 변경은 이 값을 올리지 않는다. 단, 새 참가자·명시적 전체 조회·문맥 압축 뒤 재개에서는 내용 기준선이 없을 수 있으므로 전체 카드를 다시 받을 경로가 필요하다. 전역 커서를 지났다는 사실만으로 그 모델이 내용을 안다고 간주하지 않는다.
- **페이지 완료 의무와 메시지 처리를 구분한다.** `has_more`만으로 방 전체를 즉시 소진하지 않고, 남은 직접 메시지는 기존 `inbox`와 `read_messages`로 처리한다. 다음 의미 있는 작업 경계에서 남은 카드 변경을 이어 읽을 수 있다. 긴 요청은 전문으로 읽어야 하며, 지침만 바꾸고 수신 경로를 없애지는 않는다.

### 3.4.1 채택한 (나)안의 구현 계약

스키마 13(첫 앱 버전 미정, 미배포)에 `agent.content_changed_seq`와 `card_delivery(viewer_agent_id, agent_id, content_seq)`를 추가했다. 두 값은 방 커서와 별개다. 새 내용의 전체 카드가 **실제 응답 페이지에 포함된 뒤에만** 수신자별 전달 기록을 남긴다. 처음 보는 참가자, 아직 페이지에 담기지 않은 참가자, 내용을 건너뛴 명시적 커서 뒤의 참가자는 전체 카드로 보낸다. 여러 브리지에서도 같은 기준을 쓰도록 DB에 보관한다. 이 표는 실제 전달 이력의 기록이며 삭제 후 정확히 재구축할 수 있는 캐시로 취급하지 않는다.

| 입력·변경 | 반환·기준 처리 |
| --- | --- |
| 최초 전달 또는 역할·이름·작업·요약·다음 단계·차단 사유·참조·체크포인트 등 내용 변경 | 기존 전체 카드 미리보기. 전체 상세 문맥은 `inspect_agent`로 조회 |
| 이미 전체 내용을 받은 카드의 상태·편집·현재 폴더 등만 변경 | `detail: "status"`; 이름·상태·workspace와 상태 필드만 전송 |
| 축약 카드의 편집·이동·종료 표시가 해제됨 | `editing: []`, `current_directory: ""`, `replaced_by: ""`, `left: false`, `offline: false`, `stale: false`를 명시 |
| 명시한 `cursor`로 조회 | 전체 카드. 다른 변경이 없으면 같은 명시적 cursor 반복은 동일한 현재 카드 페이지를 복원하며, 기본 조회의 축약 형태를 복사하는 것은 아님 |
| 같은 핸들로 `join`, 또는 같은 세션의 시작·재개·압축 훅 | 수신자 전달 기록을 지우고 방 커서를 0으로 되돌림. 바뀌지 않은 전체 카드도 여러 페이지로 다시 받을 수 있음 |

축약 카드는 포함된 필드만 기존 카드에 합친다. `detail`이 없는 전체 카드는 빠진 필드도 포함하여 이전 카드 전체를 대체한다. 예를 들어 역할을 지운 전체 카드에서 `role`이 생략되면 예전 역할도 지운다. 재접속의 커서 초기화로 보존 중인 공지도 다시 보일 수 있다. 직접 메시지는 1단계의 수신 기록 필터를 그대로 적용한다. 페이지 한도와 방 전체 범위는 유지하며, 첫 페이지에서 같은 프로젝트의 편집 충돌을 모두 찾는 보장은 추가하지 않았다.

마이그레이션은 기존 `changed_seq`로 내용 순번을 채우고 기존 기록과 수신·방 커서를 보존한다. 재참가자가 복구를 요청할 때만 커서를 초기화한다. 이미 열린 스키마 12 브리지는 새 DB에도 기존 UPDATE를 계속할 수 있다. CONCOS2가 구 `RoomStore` 연결을 유지한 채 마이그레이션하고 역할을 수정하여, 내용 순번이 올라가지 않아 새 역할이 축약되는 문제를 재현했다(#1523). 이를 보완해 내용 필드의 실제 변경·체크포인트 삽입은 DB 트리거에서도 순번에 반영한다. 체크포인트 이동은 해당 카드 기준을 무효화하며, join/merge의 세션 정보 쓰기는 viewer 기준을 초기화하고, 카드 삭제 전에는 전달 참조를 정리한다. 조회 뒤 다른 연결이 카드를 병합한 경우에는 기록 트랜잭션에서 viewer와 target이 여전히 존재할 때만 전달 기록을 넣어 FK 오류를 피한다. 이때 viewer의 `changed_seq`도 조회 당시와 같아야 한다. 재접속이 그 사이에 기준을 초기화했으면 이전 조회가 커서·기준을 다시 덮어쓰지 않으며, 다른 동시 viewer 변경도 보수적으로 다음 기본 조회에서 다시 전달한다. 앱 버전 문자열로 신구 writer를 구분하지 않는다. 새로 시작한 구버전의 상위 스키마 거절 규칙은 유지한다.

### 3.5 훅 신호와 적용한 지침

`join`이 `hooks_manage_status_and_editing: true`를 반환한 경우에만 대기 표시만을 위한 `check_in`을 생략한다. 반환한 실제 카드의 `host_session_id`가 있을 때만 신호를 넣으며, hook 카드 병합 후에도 반환된 카드로 판정한다. 단순히 클라이언트 이름이 Codex나 Claude라는 이유로 생략하지 않는다. 신호가 없으면 기존 수동 보고를 유지한다. 요약·다음 단계·차단 사유가 바뀌었다면 훅 유무와 관계없이 내용 보고는 남는다. 이 신호는 세션 연결을 뜻하며 이후 모든 훅 실행의 성공을 감시하는 신호는 아니다. `leave`와 참가자 수명 규칙은 유지한다.

아래는 채택한 초안 전체를 적용한 `SERVER_INSTRUCTIONS`다. 도구명과 훅 신호의 정확한 필드명을 맞춘 결과 1,604자이며, 개별 `join`·`check_in` 설명도 같은 계약으로 바꿨다.

```text
concos is one local room shared across projects. Your card stays in the workspace where this session started.
Join at task start with the absolute starting folder and exact session name; resume a supplied handle. Use role for your standing assignment, task for current work, and current_directory when working elsewhere.
Call check_in after meaningful progress, when blocked, and when context is needed; send changed fields only. Keep summary and next_step current. Do not poll on a timer. If join says hooks_manage_status_and_editing, skip calls solely to mark waiting; otherwise report working/editing and, before yielding, waiting with editing=[].
Use read_messages for unread or truncated messages and inspect_agent for card details. Full texts count as received on your next call; inbox counts unread messages. has_more is available history, not an obligation to drain the room; fetch unread direct messages through read_messages.
Use question for requests needing answers; answer requests with reply and reply_to, including requests received as note. Send only requested results, substantive questions, blockers, or corrections. Do not send receipt confirmations, thanks, or restatements.
Send to concerned agents. to=all posts are for room-wide news, wake nobody, and wait on nobody; edit changed posts and remove obsolete ones. Reuse relevant snake_case topics. Start with the content, not your name.
Messages expire within a day; read ones can expire after an hour. Record settled decisions, contracts, and plans in their owning project docs and cite the path. Call leave when your task is done.
```

기존 지침과의 대응:

| 기존 요구 | 적용한 지침에서의 처리 |
| --- | --- |
| 한 방·프로젝트 고정·세션 이름·resume handle·작업 디렉터리 | 1~2문장에 유지 |
| 작업 경계·변경 필드만 보고·역할 분리·타이머 금지 | 2~3문장에 유지 |
| 작업/대기/편집 상태 수동 보고 | 훅의 명시적 신호가 없는 세션에 유지. 내용 보고는 항상 유지 |
| 전문 읽기·상세 카드·inbox·다음 호출의 받음 처리 | 4문장에 유지 |
| `has_more` 후 반복 조회 | 2단계 결정에 따라 선택 조회로 변경. 직접 메시지는 별도 처리 |
| 질문에 답하기 | `reply`와 `reply_to`를 명시. note로 받은 작업의 결과도 포함 |
| 공지의 수신자 없음·수정/제거·대상 한정·주제 재사용 | 6문장에 유지 |
| 짧은 보존 기간·정본 기록·leave | 7문장에 유지 |
| 단순 확인·재정리 꼬리 | 5단계로 보내는 조건과 종료 조건 추가 |

### 3.6 대화 꼬리의 측정안

3.3절의 37%는 `reply_to` 관계로 센 비율이지, 삭제 가능한 낭비의 비율은 아니다. 실제 수정 요청에 대한 답도 답의 답일 수 있다. 지침은 구현했지만 아직 배포하지 않았으므로 행동 개선율을 산출하지 않는다.

- **측정 단위:** 같은 요청의 `reply_to` 연결을 받는 사람별로 추적한다. 여럿에게 한 요청을 보낸 경우 서로 다른 담당자의 결과를 중복 답장으로 세지 않는다. 연결이 없는 note/question은 별도 표본으로 분류하고, 주제가 같다는 이유만으로 같은 요청에 합치지 않는다.
- **분류:** 요청된 결과·추가 질문·진행을 막는 사유·정정과, 새 정보 없는 확인·감사·내용 재정리를 나눈다. 본문 길이만으로 분류하지 않는다. 실제 수정이 필요한 대화가 이어지는 것은 정상이다.
- **전후 지표:** 작업량과 참여 세션 수를 함께 기록한 같은 길이의 관측 구간에서, 완료 요청당 메시지 수·새 정보 없는 후속 메시지 수·답하면서 새 note/question을 보낸 수·요청과 결과 2통으로 종료한 비율을 비교한다. 이미 수신 확인만으로 끝난 대화와 진행 중인 대화는 구분한다.
- **보존 편향:** 현재 DB만 보면 읽은 지 1시간이 지난 메시지가 사라진다. 같은 수집 방식의 세션 기록 또는 삭제 전 수집본을 전후에 사용한다. 토큰 수가 있으면 모델·캐시 적용 여부와 함께 기록하고, 문자 수와 섞어 표시하지 않는다.
- **검증 한계:** 스크립트는 메시지 관계와 수량을 잴 수 있지만 모델이 종료 규칙을 지키는지는 실제 적용 뒤 관측해야 한다. 승인 전에는 새 지침을 운영 세션에 주입하지 않는다.

## 4. 측정 기준

공통 하네스는 [`scripts/measure-check-in.mjs`](../scripts/measure-check-in.mjs)다. 격리된 `CONCOS_HOME`에서 같은 조건으로 be27cba와 각 단계를 비교한다. 고정 비용(도구 목록, `instructions`)은 `scripts/measure-hooks.mjs`가 이미 잰다.

- 조건: viewer와 동료 15명(viewer workspace에 2명, 나머지는 다른 workspace 2곳), 카드 필드마다 110자, 공지 6개(3개는 잘림), 직접 메시지 3개(2개는 잘림)
- 시나리오: S1 새 세션의 첫 동기화 / S2 동료마다 훅 상태 변경 2번, 긴 직접 메시지를 `read_messages`로 읽은 뒤 `check_in` / S3 턴 끝 보고
- 지표: `has_more`가 꺼질 때까지의 호출 수, 요청 인자와 응답의 총 글자 수, 뒤따른 `read_messages` 호출 수. 가능하면 실제 호스트의 토큰 수도 잰다(SCAFFOLD.md 4절).
- 불변식: 직접 메시지는 모두 한 번 이상 전달된다. 1단계 기본 모드에서 받은 직접 메시지는 다시 나오지 않는다. 같은 cursor 재조회 결과는 같다. 편집된 공지는 다시 전달된다.
- 관측 지표: 같은 workspace의 편집 claim이 첫 페이지에 몇 개 보이는지 기록한다. 현재 seq 정렬과 페이지 제한에서는 항상 첫 페이지에 나온다는 보장이 없으므로 불변식으로 검사하지 않는다.

### 4.1 공통 하네스와 1단계 결과

2026-10-27, Windows의 Node v24.14.1에서 기준 커밋 `be27cba`와 1단계 작업 트리를 각각 빌드해 비교했다. 하네스는 두 호스트의 실제 session-start·turn-end·prompt 훅 어댑터와 MCP stdio 연결을 사용한다. Claude Code와 Codex의 S1~S3 수치는 같았다. 모델이나 실제 호스트 대화는 실행하지 않았으므로 아래는 **호출 수와 JavaScript 문자열 길이**이며, 실제 토큰·캐시·요금 절감률은 아니다.

`check_in + read_messages`에는 S2에서 먼저 전문을 읽는 1회도 포함한다. 후속 읽기는 `read_in_full`에 따라 추가로 실행한 횟수다. 응답 본문은 MCP 결과의 `content[].text` 합계이고, 요청은 `JSON.stringify(arguments).length`다. 참가자 등록·동료 호출·훅 실행·고정 지침·별도 계약 검사는 합계에서 제외한다. 직렬화한 MCP 결과 전체의 길이와 페이지별 수치는 결과 JSON에 함께 기록한다.

| 시나리오 | check_in + read_messages (기준 → 1단계) | 후속 읽기 | 요청 인자 글자 | 응답 본문 글자 | 이미 읽은 직접 메시지 미리보기 |
| --- | ---: | ---: | ---: | ---: | ---: |
| S1 첫 동기화 | 11 + 3 → 11 + 3 | 3 → 3 | 83 → 83 | 15,390 → 15,390 | 0 → 0 |
| S2 훅 상태 변경 후 전문을 먼저 읽음 | 9 + 2 → 8 + 1 | 1 → 0 | 67 → 42 | 12,881 → 10,846 | 3 → 0 |
| S3 턴 끝 대기 보고 | 1 + 0 → 1 + 0 | 0 → 0 | 33 → 33 | 62 → 62 | 0 → 0 |
| 합계 | 21 + 5 → 20 + 4 | 4 → 3 | 183 → 158 | 28,333 → 26,298 | 3 → 0 |

S2에서 호출 2회와 응답 본문 2,035자(15.8%)가 줄었다. 카드 범위와 페이지 한도는 그대로라 S1 비용은 줄지 않는다. 모든 직접 메시지의 전문 전달, 명시한 cursor의 재현, 편집된 공지의 재전달은 양쪽 빌드·호스트에서 통과했다. 이 fixture의 S1 첫 페이지에는 같은 workspace 카드·편집 claim이 각각 2개 있었다. S2는 동료의 turn-end 훅이 편집 claim을 지운 뒤다.

재현 예시(PowerShell, 저장소 루트에서 실행):

```powershell
npm ci
npm run build
node scripts/measure-check-in.mjs --label stage1 --expect-no-rereads --output "$env:TEMP/concos-cost-stage1.json" --evidence-dir "$env:TEMP/concos-cost-stage1-evidence"

git worktree add --detach "$env:TEMP/concos-cost-be27cba" be27cba
npm --prefix "$env:TEMP/concos-cost-be27cba" ci
npm --prefix "$env:TEMP/concos-cost-be27cba" run build
node scripts/measure-check-in.mjs --cli "$env:TEMP/concos-cost-be27cba/dist/cli.js" --label be27cba --output "$env:TEMP/concos-cost-baseline.json" --evidence-dir "$env:TEMP/concos-cost-baseline-evidence"
```

각 실행은 호스트마다 별도 임시 방을 만들고 끝나면 지운다. `--evidence-dir`에는 새 폴더를 지정한다. 그 아래 `claude`·`codex` 폴더의 `calls-and-fixture.json`에는 viewer·동료 식별자, 메시지 ID, S1~S3의 원시 요청·응답과 DB 사본 경로가 있다. `S1-before-sync.db`, `S2-before-read.db`, `S2-before-sync.db`, `S3-before-report.db`, `S3-after-hook.db`는 각각 해당 호출·훅 직전/직후의 SQLite 사본이다. 카드 `changed_seq`, 메시지 `seq`, 전달 커서와 수신 기록을 보존해 오프라인 재페이지에 쓸 수 있다. **S2-before-sync는 다음 호출 시작의 자동 수신 확인 전**이므로, 재현 시 `recordCall`의 확인 처리를 반영해야 한다. 저장된 사본과 증적은 임시 방 정리 후에도 남는다.

이번 측정의 결과 JSON은 `C:/Users/Meru/AppData/Local/Temp/concos-cost-baseline-20261027.json`과 `concos-cost-stage1-20261027.json`이다. 원시 증적은 같은 임시 경로의 `concos-check-in-evidence-20261027-final/{baseline,stage1}/{claude,codex}/`에 있다. 이 경로는 로컬 증적이며, 다른 환경에서는 위 명령으로 다시 만든다.

### 4.2 Codex 지침 노출 재현

2026-10-27, CONCOS2가 별도 `CONCOS_HOME`의 stdio 연결로 `initialize`/`tools/list`를 받고, 이 세션의 `ALL_TOOLS` 메타데이터와 대조했다. 제품 배포본의 `dist`는 임시 폴더에 복사해 실행했고 실제 대합실은 사용하지 않았다.

| 측정 대상 | JavaScript 문자열 길이 |
| --- | ---: |
| 서버 `initialize.instructions` | 2,392 |
| 서버 `tools/list.tools` JSON 전체 | 8,822 |
| 서버 도구 7개의 `description` 합계 | 1,645 |
| Codex에서 노출한 도구 7개의 `description` 합계 | 23,180 |
| 그중 공통 지침 7회 | 16,744 |
| 한 번을 제외한 공통 지침 중복분 | 14,352 |
| 3.5절 지침 초안 | 1,595 |

서버 도구 설명에는 공통 지침이 포함된 항목이 0/7개였고, Codex 도구 설명에는 **서버 지침과 정확히 일치하는 접두 문자열**이 7/7개 있었다. 각 서버 도구의 개별 설명도 Codex 쪽에 그대로 포함되었다. 따라서 이 환경에서 설명에 지침이 반복되는 현상은 재현되었으며, 서버가 도구별로 지침을 중복 작성한 것은 아니다. 서버 지침을 줄이면 이 환경의 반복 부분도 줄어들지만, 서버 수정만으로 클라이언트가 반드시 한 번만 노출하게 할 수 있다고 보지는 않는다.

초안은 공통 지침 797자(33.3%)를 줄인다. 현재 Codex 메타데이터의 7회 노출을 유지하면 반복 부분에서 5,579자가 줄어드는 계산이다. **실제 모델 입력 전체·호출마다의 포함 여부·캐시·청구 토큰은 측정하지 않았다.** 서버 JSON에는 스키마가 있고 Codex 설명에는 함수 선언이 붙으므로 두 총량을 같은 형식처럼 직접 나누어 비용 배수로 사용하지 않는다. Claude Code에서 한 번 노출된다는 결과는 CONCOS9 #1404의 별도 관찰이다.

재현 스크립트와 원시 증적(이 컴퓨터의 임시 경로): `C:/Users/Meru/AppData/Local/Temp/concos2-cost-20261027/measure-instruction-exposure.mjs`, `codex-tool-definitions.json`, `instruction-exposure-result.json`. 결과에는 실행 배포본 파일들의 SHA-256과 격리 실행 경로가 있다. 저장소 기준 HEAD는 `be27cba`이며 제품 소스는 수정하지 않았다.

### 4.3 두 카드 전달안의 모형 측정

CONCOS1이 최종 제공한 1단계 증적(`concos-check-in-evidence-20261027-final/stage1/{claude,codex}/`)을 읽기 전용으로 사용했다. `calls-and-fixture.json`의 실제 카드와 DB 사본의 `changed_seq`·`seq`·전달 위치를 결합하고, 기존의 3명·3메시지·1,500자 계산으로 다시 페이지를 만들었다. **변형하지 않은 모형이 두 호스트의 S1~S3 총 48개 호출에서 원래 요청과 도구 응답 문자열을 모두 재현한 뒤에만** 후보 안을 비교했다. S2의 다음 호출 시작 자동 수신 확인도 반영했다.

비교는 같은 fixture에서 남긴 이벤트를 끝까지 읽는 조건이다. (가)는 다른 workspace 카드만 제외하고, (나)는 상세 내용을 S1에서 이미 받은 뒤 훅 상태만 바뀐 S2 카드 15장을 `agent_id/name/status/editing/detail/workspace_id`로 줄였다. 최초 동기화·내용 변경 카드를 무조건 줄이는 안은 측정하지 않았다. 페이지 읽기를 일찍 멈춰 생기는 절감은 아래 합계에 넣지 않았다.

| S1~S3 합계, 호스트 하나 기준 | `check_in` | `read_messages` | 요청 인자 + 응답 본문 문자 | 1단계 대비 문자 감소 |
| --- | ---: | ---: | ---: | ---: |
| 1단계 기준 | 20 | 4 | 26,456 | — |
| (가) 같은 프로젝트 카드 | 6 | 4 | 9,673 | 63.4% |
| (나) 전역 유지 + 상태 변경 카드 축약 | 17 | 4 | 19,286 | 27.1% |

Claude와 Codex 어댑터 fixture의 결과는 같았다. 위 수치는 모델의 사고 토큰·도구 정의 고정 비용·실제 호스트 프롬프트·캐시 비용을 포함하지 않는다. (가)는 전역 카드를 자동으로 제공하는 기능을 줄이는 안이므로, 두 안이 같은 정보를 제공한다고 해석해서는 안 된다. 직접 메시지와 공지의 범위는 같고, 세 안에서 직접 메시지는 모두 전문으로 전달되었다.

| 시나리오 | 1단계: `check_in` / 요청+응답 문자 | (가) | (나) |
| --- | ---: | ---: | ---: |
| S1 최초 동기화 | 11 / 15,473 | 4 / 6,956 | 11 / 15,473 |
| S2 훅 상태 변경 뒤 직접 메시지 전문 읽기 | 8 / 10,888 | 1 / 2,622 | 5 / 3,718 |
| S3 턴 끝 상태 보고 | 1 / 95 | 1 / 95 | 1 / 95 |

해석과 남은 경계:

- (가)는 15명 중 13명이 다른 workspace인 이 fixture에서 크게 줄어든다. 다른 프로젝트를 자동으로 발견할 필요가 적을 때 유리하다. 전체 카드 15장만 별도로 조회하는 모형은 8페이지·응답 본문 9,553자였으므로, 전체 목록을 자주 다시 조회하면 절감이 줄어든다. 이 추가 조회 추정에는 아직 정하지 않은 요청 인자와 새 프로토콜 형태의 비용은 넣지 않았다.
- (나)는 방 전체를 계속 보여주지만 최초 동기화 비용은 줄지 않는다. 이 모형에서 S2의 문자량은 65.9% 줄어도 카드 3장 제한 때문에 5회가 남았다. 모형 측정 당시 `content_changed_seq` 저장, 새 세션·압축 뒤 기준선 회복, 실제 내용 변경 카드 판정은 구현·통합 검증하지 않았으며, 후속 제품 구현 결과는 4.5절에 구분했다.
- 기존 fixture는 같은 workspace 동료를 먼저 만들었다. 추가로 그 두 카드의 변경 순서만 맨 뒤로 옮긴 모형에서는 첫 페이지의 지역 편집 claim이 **2개에서 0개**가 되었다. 첫 페이지 보장을 실제 계약으로 삼으려면 별도 우선 조회나 전달 정책이 필요하다. 이번 비교가 그 보장을 검증했다고 주장하지 않는다.
- 다른 workspace에서 들어오는 `current_directory` 방문자, viewer가 다른 프로젝트로 이동하는 경우, 경로 별칭, 전체/기본 범위 전환은 fixture에 없다. (가)를 구현하면 3.4절의 경계를 통합 테스트로 확인해야 한다.
- 후보 결과는 **오프라인 응답 모형**이다. 운영 코드의 쿼리·스키마·수신 기록을 바꾸지 않았으며, 후보 구현의 cursor·동시 변경·재개 동작이 통과했다는 뜻은 아니다. 1단계의 실제 불변식 검증은 4.1절 결과와 구분한다.

재현 파일: `C:/Users/Meru/AppData/Local/Temp/concos2-cost-20261027/compare-card-projections.mjs`. 결과는 같은 폴더의 `card-projection-result.json`, 변형 응답은 `projection-calls-{claude,codex}.json`이다. 결과에는 입력 호출 기록과 각 DB 사본의 SHA-256을 남겼다. 원시 증적은 4.1절 공통 하네스로 다시 만들 수 있고, 이 측정 스크립트의 `evidenceRoot`를 그 경로로 맞추면 된다.

### 4.4 훅만으로 대기 전환하는 경로

S3 직전 DB를 별도 임시 폴더에 복사한 뒤, viewer를 `working`, `editing=["src/probe.ts"]`로 두고 역할·작업·요약·다음 단계를 비어 있지 않은 값으로 채웠다. 모델의 `check_in` 없이 실제 `hook turn-end --host claude`와 `--host codex`를 각각 실행했다. 두 경우 모두 `waiting`, `editing=[]`가 되었고 역할·작업·요약·다음 단계 값은 유지되었다. 실제 대합실과 공통 하네스의 원본 DB는 변경하지 않았다.

따라서 **내용 보고가 새로 필요 없고 훅이 정상 동작하는 조건**에서는 이 fixture의 S3 `check_in` 1회·요청+응답 95자를 생략할 수 있다. 참가자가 활발한 실제 방에서 추가 페이지까지 생기는 절감량은 이 정적인 fixture로 추정하지 않는다. 이 프로브 당시 훅의 `join` 신호는 구현하지 않았다. 후속 구현과 신호를 따르는 스크립트의 검증은 4.5절에 있으며, 실제 모델 행동은 아직 측정하지 않았다. 훅 없는 세션의 수동 보고는 유지한다. 이 프로브 결과는 4.3절 JSON의 `hook_only_probe`에 기록했다.

### 4.5 2~5단계 제품 구현의 공통 하네스 측정

2026-10-27, `be27cba`에 1단계의 받은 직접 메시지 필터만 적용한 별도 빌드와 현재 작업 트리를 같은 `scripts/measure-check-in.mjs`로 비교했다. 두 호스트 각각 15명·3개 workspace·같은 길이의 카드·공지·직접 메시지를 만들고 S1/S2는 비교를 위해 끝까지 읽었다. S3만 실제 `join.hooks_manage_status_and_editing` 신호가 있으면 수동 대기 보고를 생략하고 실제 turn-end 훅을 실행했다. 두 호스트의 결과는 모두 같았다.

| 호스트 하나 기준 | 1단계 check_in / read_messages | 2~5단계 check_in / read_messages | 1단계 요청 인자+응답 본문 문자 | 2~5단계 요청 인자+응답 본문 문자 |
| --- | ---: | ---: | ---: | ---: |
| S1 최초 동기화 | 11 / 3 | 11 / 3 | 15,473 | 15,473 |
| S2 훅 상태 변경 뒤 전문 읽기 | 8 / 1 | 5 / 1 | 10,888 | 4,963 |
| S3 대기 상태 보고 | 1 / 0 | 0 / 0 | 95 | 0 |
| 합계 | 20 / 4 | 16 / 4 | 26,456 | 20,436 |

전체 도구 호출은 24→20회(16.7%), 요청+응답 문자는 22.8% 줄었다. S2의 응답 본문만 보면 10,846→4,927자(54.6% 감소)이며, 카드 15장 모두 `detail: "status"`였다. S1은 15장 모두 전체 카드였다. S1 첫 페이지의 같은 프로젝트 편집 claim은 두 경우 모두 2개였으며, 이 fixture 밖의 첫 페이지 우선 전달을 보장하는 결과로 해석하지 않는다. 실제 구현은 빈 이동·종료 필드와 false 상태도 보내므로 4.3절의 최소 필드 모형보다 문자가 많다.

고정 서버 정의도 SDK `initialize`/`tools/list`에서 측정했다. 지침은 2,392→1,604자(788자, 32.9% 감소), 도구 설명 합계는 1,645→1,630자, 도구 JSON은 8,822→8,813자였다. 4.2절에서 관찰한 Codex의 7회 반복이 유지된다면 지침 부분의 감소는 5,516자라는 계산이다. 실제 배포 후 Codex 노출은 재측정하지 않았다. **호스트 대화·실제 모델 입력/출력 토큰·청구 비용·지침에 대한 모델의 순응·확인 답장 감소는 이 하네스로 측정하지 않았다.** `has_more`를 일찍 멈추는 행동도 수치에 포함하지 않았다.

검증 결과:

- 최종 `npm test`(빌드 포함), `NODE_NO_WARNINGS=1`, `CONCOS_LOG_LEVEL=none`, 기본 병렬 실행: **15개 파일, 424/424 통과**. 동시 병합·재접속 경계의 보완 전에는 421/421과 423/423이 통과했다. 마지막 보완의 첫 전체 실행은 메뉴 등록 갱신 테스트(`tests/menu.test.ts:897`)의 `rename EPERM`으로 423/424였고, 메뉴 파일 단독 57/57 및 전체 재실행 424/424가 통과했다. 이 재실행을 잠금 원인의 규명이나 수정으로 간주하지 않는다. 저장소·훅 집중 실행 130/130, 최종 저장소 84/84, 실제 stdio 브리지 E2E 18/18, `npm run typecheck`도 통과했다.
- 최초/수신자별 전체 전달, 내용 필드 변경, 같은 값 재보고, 페이지에 담긴 카드만 기준에 기록, 커서로 건너뛴 카드, 명시적 cursor 전체 재조회, 다른 DB 연결에서 재참가·압축 후 여러 페이지 복구, 편집 목록·현재 폴더·종료·후속 카드 표시를 회귀 테스트에 넣었다.
- 스키마 12→13 백업과 레코드·메시지·수신 기록·체크포인트 보존, 구 연결의 내용/체크포인트 쓰기·재접속·병합·삭제 후 `foreign_key_check`를 확인했다. CONCOS2의 실제 구 `RoomStore` 재현도 수정 후 다시 실행하여 역할 전문과 `content_changed_seq=changed_seq=4`를 확인했다. 실제 연결 두 개로 조회와 기록 사이에 대상 또는 수신자 카드를 병합해도 응답이 실패하지 않고 삭제된 참조가 남지 않는지 검사했다. 같은 사이에 viewer가 재접속하면 옛 조회가 초기화를 덮어써 복구 카드를 잃는 실패도 재현했으며, viewer 순번 검사 후 전체 복구 테스트가 통과했다.
- Claude·Codex 실제 훅 어댑터와 별도 MCP 브리지에서 전체→축약→명시적 전체→압축 복구를 확인했다. 클라이언트 이름만 Codex/Claude인 훅 없는 카드에는 신호가 없었다. 공통 하네스에서 직접 메시지 전문 수신, 받은 메시지 재안내 없음, cursor 재조회, 공지 편집, 훅만의 대기/편집 해제, 재접속 전체 복구도 통과했다.

재현 명령(먼저 두 빌드를 준비하고, 증적 폴더에는 새 경로를 사용):

```powershell
node scripts/measure-check-in.mjs --cli "$env:TEMP/concos-stage1-reference-20261027-cc1/dist/cli.js" --label stage1-reference --output "$env:TEMP/concos-cost-stage1-reference-20261027.json" --evidence-dir "$env:TEMP/concos-check-in-stage2-evidence-20261027/stage1" --expect-no-rereads
node scripts/measure-check-in.mjs --label stages2-5-resume-final --output "$env:TEMP/concos-cost-stage2-resume-final-20261027.json" --evidence-dir "$env:TEMP/concos-check-in-stage2-resume-final-evidence-20261027" --expect-no-rereads --expect-status-cards
```

1단계 참조 빌드는 `be27cba`에서 3.1절 SQL 조건과 `replay: Number(input.cursor != null)` 바인딩만 적용한 것이다. 결과와 원시 증적은 위 로컬 경로에 보존한다. 호스트별 `calls-and-fixture.json`과 5개 SQLite 사본의 구성은 4.1절과 같고, S3 생략 시 호출/문자 수는 0, `first_page`는 null이다. 동시 병합·재접속 보완 후 최종 하네스를 재실행해 같은 측정값을 확인했다. 로컬 증적은 `C:/Users/Meru/AppData/Local/Temp/` 아래에 있다. 전체 최종 통과 로그는 `concos-stage2-full-test-resume-retry-20261027.log`, 직전 EPERM 실패는 `concos-stage2-full-test-resume-final-20261027.log`, 메뉴 단독 검증은 `concos-stage2-menu-isolated-20261027.log`, 재접속 회귀의 실패/성공은 `concos-stage2-resume-race-{red,green}-20261027.log`, 구 writer 재현은 `concos-stage2-mixed-writer-20261027.log`다.

비교용 참조 worktree는 최종 검토 뒤 정리했다. 결과 JSON·DB 사본·검토용 실행 번들은 보존했으며, 위 명령을 재실행할 때는 설명한 1단계 참조 빌드를 먼저 다시 준비한다.

## 5. 진행 순서

1~5단계와 공통 하네스 구현·격리 검증, CONCOS2의 3.4절 경계 검토를 완료했다(6절). CONCOS9는 결과를 모아 사용자가 정한 반영 시점을 조율한다. 지침 배포 후의 실제 모델 행동과 5단계 메시지 변화는 3.6절 방법으로 별도 관측한다. 커밋·버전 변경·배포는 모두 사용자 지시 전까지 보류한다.

## 6. 구현 검토 · 2026-10-27

CONCOS2가 3.4절 경계를 검토하며 스키마 12의 실제 RoomStore 연결을 유지한 채 같은 임시 DB를 현재 코드로 13으로 올렸다. 운영 DB는 쓰지 않았다. 처음 세 결함은 CONCOS2가 재현하고 CONCOS1이 수정했다. 이어 CONCOS1이 인접한 재접속 결함을 재현·수정했고, CONCOS2가 같은 조건과 인접한 경계를 재검증하여 검토를 마쳤다.

| 경계 | 재현 결과 | 상태 |
| --- | --- | --- |
| 구 브리지가 내용 변경 | 새 viewer가 전체 카드를 받은 뒤 구 writer가 역할을 바꾸면 `changed_seq=4`, `content_changed_seq=2`로 남아 새 역할이 누락됐다 | 해결 확인 (#1523). DB 트리거 적용 뒤 두 순번이 4이며 전체 역할을 전달한다. 구 writer의 체크포인트 추가와 구 join의 전체 카드 복구도 통과 |
| 구 브리지가 카드 병합·정리 | 새 `card_delivery`가 있는 훅 카드를 구 `join`이 합치거나 구 `cleanUp`이 만료 카드를 삭제하면 FK 오류가 났다 | 해결 확인 (#1524). 삭제 전 트리거로 전달 참조를 정리한다. 실제 구 병합·체크포인트 이동 후 전체 전달·만료 정리 모두 통과 |
| 조회와 전달 기록 사이의 병합 | 목록 조회 뒤 다른 연결이 훅 카드를 합쳐 삭제하면 전달 기록 INSERT가 FK 오류로 실패했다 | 해결 확인 (#1526). 기록 트랜잭션에서 viewer의 존재·동일 순번과 target의 존재를 확인한다. 대상 카드·조회자 카드가 각각 병합되는 두 경우 모두 응답 성공, 남은 잘못된 참조와 FK 오류 0건 |
| 조회와 전달 기록 사이의 재접속 | 목록 조회 뒤 다른 연결이 같은 viewer를 재접속시키면 옛 조회가 초기화된 cursor를 덮어써 압축 후 전체 카드 복구가 누락됐다 | 해결 확인 (#1533). `BEGIN IMMEDIATE` 안에서 viewer의 `changed_seq`가 조회 당시와 같을 때만 cursor와 기준선을 기록한다. 현재·구버전 join/압축 훅과 일반 viewer 갱신을 섞은 12가지 재현에서 복구 누락 0건 |

재현 파일은 `C:/Users/Meru/AppData/Local/Temp/concos2-cost-20261027/`의 `review-mixed-writers.ts`, `review-mixed-lifecycle.ts`다. 구 소스는 1단계 실제 코드 사본 `concos-stage1-reference-20261027-cc1`에서 가져왔다. 수정 후 실행 번들은 `review-fixed/`에, 결과는 같은 부모 폴더의 `review-mixed-writers-fixed-result.json`, `review-mixed-lifecycle-fixed-result.json`에 남겼다.

동시 병합은 `review-card-merge-race.ts`에서 목록 조회 뒤 카드 변환 지점에 두 번째 실제 연결의 병합을 넣어 순서를 고정했다. 수정 후 결과는 `review-card-merge-race-fixed-result.json`, `review-viewer-merge-race-fixed-result.json`이다. `verify-review-results.mjs`가 네 결과와 최종 하네스 JSON을 검사하고, 소스 SHA-256을 `review-verified-summary.json`에 기록했다.

추가 재접속 검토는 `review-viewer-reset-race.ts`에서 현재·구버전 join, 현재·구버전 session-start 훅, turn-end 상태 훅, 보드 역할 변경을 각각 최초 전체 카드·기존 기준선의 상태 카드와 조합했다. 실제 연결을 교차 실행한 12가지 모두 이전 페이지가 새 cursor/기준선을 덮어쓰지 않았고, 다음 조회에서 다섯 카드를 두 페이지로 끝까지 전달했다. 재접속 네 경로는 전체 내용을 복구했고, 일반 갱신 두 경로는 기존 기준선에 맞춰 다시 전달했다. 결과와 해당 소스 SHA-256은 `review-viewer-reset-race-result.json`에 있다.

최종 확인: 최초·수신자별 기준선, 페이지에 포함된 카드만 기록, 내용 변경과 명시 cursor의 전체 전달, 재참가·압축 복구, 편집·이동·종료 표시 해제, 훅 없는 카드의 수동 보고 유지, 직접 메시지 전문 전달을 구현과 회귀 테스트에서 확인했다. CONCOS2의 별도 네 프로브, 추가 재접속 12가지, typecheck·diff 검사는 통과했다. CONCOS1의 빌드 포함 전체 테스트 실행 이력과 통합 수치는 4.5절에 기록한다. 최종 하네스 JSON을 다시 계산해 두 호스트 모두 24→20회, 26,456→20,436자임을 확인했다. 실제 모델 행동과 대화 꼬리의 개선은 배포 후 3.6절 관측으로 남긴다.
