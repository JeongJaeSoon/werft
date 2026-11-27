# 상태 기계

네 상태 기계(세션 admission, turn·attempt, 대화 turn, rollout 스위치)의 전이를 더하거나 바꾸는 변경은 그 기계의 표를 여기에 적거나 함께 고친다. 표마다 지금 상태, 입력과 조건, 다음 상태, 누가 일으키는지를 적고, 지켜야 할 성질을 함께 적는다.

절에는 세 가지를 적는다.

- 전이 표: 지금 상태, 다음 상태, 조건, 누가 일으키는지.
- 막을 전이: 일어나면 안 되는 전이와 그것을 거절하는 시험.
- 지킬 성질: 어떤 전이를 거쳐도 참이어야 하는 문장과 그것을 고정하는 시험.

허용 전이마다 성공 시험을 하나, 막을 전이마다 거절 시험을 하나 둔다.

## 1. 세션 admission

### 덮이지 않은 turn이 일으키는 전이

2번 절이 기대는 전이다.

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| active | recovery_required (status failed, reason context_gap) | 실행이 사라진 것이 확인됐거나 새 worker가 claim했고, 열린 turn이 없고, 마지막으로 돈 turn을 덮는 checkpoint가 없다. 끊긴 turn은 돈 turn으로 세지 않는다 | scheduler(실행 종료 확인), worker의 claim |

### 멈춤(stop)이 일으키는 전이

멈춤은 요청자의 Slack 멈춤 낱말 같은 stop 요청이다(`packages/db/src/stop-control.ts`). 기다리던 입력을 취소하고, 도는 턴이 있으면 그 턴을 중단하게 한다.

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| `active` | `closed` (status `stopped`) | 작업 세션(`task_closing` 있음)이고, 시작된 턴(`started_at` 있음)도 도는 턴도 없으며, 멈춤이 기다리던 입력을 하나 이상 취소했다 | 세션을 제어할 수 있는 사람의 멈춤 |
| `active` | `active` | 위 조건이 아닐 때: 작업이 아닌 세션, 첫 턴이 시작된 작업, 취소할 입력이 없는 멈춤 | 같음 |
| `closing`, `closed` | 그대로 | 멈춤은 `closed`로 답하고 아무것도 바꾸지 않는다 | 같음 |
| `paused`, `stopped`, `recovery_required` 등 | 그대로 | 기다리던 입력을 취소하고, 도는 턴이 있으면 중단을 요청한다 | 같음 |

`active` → `closed`는 recovery close와 같은 방식으로 닫는다(`closeSessionRow`). 디스패치 대기열(`unassigned_sessions`)에서 빠지고, 묶인 execution에는 kill intent를 쓰고, lease epoch를 올려 claim한 worker를 막는다. 작업은 `task_closed_reason = cancelled`로 끝나고, 스트림에는 `closed_by: stop_before_start`인 status 이벤트와 `session_closed` 이벤트가 남는다.

지켜야 할 성질:

- 시작된 턴이 하나라도 있는 세션은 멈춤으로 닫히지 않는다. 멈춘 세션은 열린 채로 다음 입력을 받는다.
- 멈춤으로 닫힌 작업은 열린 작업 상한(`openTaskLimit`)의 칸을 그 트랜잭션에서 돌려준다.
- 멈춤으로 닫힌 세션에는 새 launch가 나지 않는다. scheduler가 예약할 수 없다. 멈춤 전에 provider 호출에 들어간 launch는 kill intent(`desired_state = terminated`)를 보고 거둔다. close와 terminate도 같은 방식으로 거둔다.
- 세션을 닫은 멈춤의 Slack 안내를 쓰지 못하면 그 줄은 잃고, 그 실패로 이벤트를 다시 처리하게 하지 않는다. 다시 처리하면 그 사이 닫힌 링크 때문에 멈춤 낱말이 새 멘션으로 들어갈 수 있다. 같은 글이 다른 길로 다시 처리되는 경우(같은 글의 `message`와 `app_mention`이 따로 도착할 때, 멈춤 커밋 뒤 inbox lease가 끝났을 때)는 아직 막지 않는다(후속 작업).
- 멈춤의 Slack 안내(닫힘 안내와 옛 멈춤 안내)는 멈춤 낱말을 쓴 사람의 Werft 사용자 locale로 쓴다. 연결된 사용자가 없으면 배포 기본 locale이다. outbox kind는 스레드 안내의 `failure_notice`이다. kind로 실패를 세는 곳은 없고, outbox 집계(`sent`·`failed`)는 kind와 상관없이 전송 결과로 센다.
- 멈춤으로 닫힌 작업의 스레드 링크는 세션의 `task_closed_reason`(`cancelled`)으로 닫힌다(`closeFinishedLinks`). 작업 사유가 없는 세션만 close receipt로 `completed`·`abandoned`를 가른다.
- 같은 멈춤을 같은 키로 다시 보내면 처음 결과를 돌려준다. 닫혔는지는 세션 행에서 다시 읽으므로, 이 변경 전에 요청이 취소된 채 열려 있던 작업을 나중 멈춤이 닫았다면 앞선 멈춤의 재시도도 닫힘으로 답한다.

시험: `packages/db/src/stop-control.test.ts`, `apps/control-host/src/slack/session-handler.integration.test.ts`의 Slack stop 시험.

### terminate가 일으키는 전이

terminate는 사람이 세션을 강제로 끝내는 제어다(`POST /v1/sessions/{id}/terminate`, 관리자 terminate, 웹의 '세션 종료'). 판정은 `packages/db/src/control-unit-of-work.ts`의 `terminateAtomic`이 한다.

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| `recovery_required` (status `failed` 또는 `stopped`) | `closed` (status `stopped`) | `expected_revision`이 맞고, `expected_admission_state`를 보냈다면 `recovery_required`이고, 레거시 pod 바인딩(execution 없이 pod만)이 아니다. 묶인 execution이 없으면 receipt가 응답에서 `succeeded`다. 묶여 있으면 kill intent를 쓰고 receipt는 `accepted`로 남는다 | 세션을 제어할 수 있는 사람의 terminate |
| `active`, `pausing`, `paused`, `resuming`, `closing`, `stopping` | `stopping` 뒤 `stopped` (실행이 끊은 turn이 `outcome_unknown`이면 `recovery_required`) | 묶인 execution이 있을 때. 없으면 바로 `stopped` | 같음 |
| `stopped` | 그대로 | 묶인 execution이 없으면 admission·status·revision·lease epoch를 바꾸지 않는다 | 같음 |
| `closed`가 아닌 어느 상태든 | 그대로 | 앞선 검사(아래 순서)를 통과한 새 요청의 `expected_admission_state`가 지금 admission과 다르면 409 `REVISION_CONFLICT`(메시지에 지금 admission). 검사 순서: 이미 쓴 Idempotency-Key(본문이 같으면 receipt를 지금 상태로 replay, 다르면 `IDEMPOTENCY_CONFLICT`) → `closed`면 `SESSION_CLOSED` → `expected_revision` → `expected_admission_state`. 둘 다 다르면 메시지는 revision을 말한다. `recovery_required`로 가는 전이가 모두 revision을 올리지는 않으므로, 웹은 확인 창을 연 때의 admission을 이 값으로 보낸다(창이 열린 뒤 세션이 바뀌어도 창의 문구와 보내는 값은 그대로이고, 화면이 다른 세션으로 넘어가면 창은 닫힌다) | 같음 |
| `closed` | 그대로 | 409 `SESSION_CLOSED`로 거절한다 | 같음 |

`recovery_required` → `closed`는 복구 결정 `close`와 같은 방식으로 닫는다(`closeSessionRow`). 대기 입력은 `SESSION_CLOSED`로 취소되고, 디스패치 대기열에서 빠지고, lease epoch가 올라 claim한 worker를 막는다. 스트림에는 `closed_by: terminate`인 status 이벤트와 `session_closed` 이벤트가 남는다. 작업 세션의 Slack 링크는 recovery close처럼 `abandoned`로 닫힌다(close receipt가 없으므로). 링크는 Slack 후처리가 닫으므로, 아직 보고되지 않은 turn이 있으면 그 뒤에 닫힌다.

막을 전이:

- `recovery_required`가 아닌 세션은 terminate로 `closed`가 되지 않는다.
- `closed` 세션은 terminate로 다른 상태가 되지 않는다.
- 다른 admission을 보고 결정한 terminate(`expected_admission_state`가 다름)는 세션을 바꾸지 않는다.

지켜야 할 성질:

- terminate로 닫혀도 결과를 알 수 없는 turn에 답하지 않는다. 그 turn은 `outcome_unknown`으로 남고, receipt의 `unconfirmed_turn_id`가 가장 이른 그런 turn을 가리킨다(없으면 `null`, 예: 복원 실패로 `recovery_required`가 된 세션).
- 닫은 뒤 실행이 사라진 것을 보아도 세션은 다시 열리지 않는다. 그 관측은 바인딩과 worker 칸을 풀고 lease epoch를 한 번 더 올리고 terminate receipt를 `succeeded`로 정산한다. admission·status는 `closed`/`stopped` 그대로이고 close 이벤트를 다시 쓰지 않는다.
- 닫는 트랜잭션에서 lease epoch가 오르므로, 아직 살아 있는 worker의 heartbeat는 실행 종료가 관측되기 전에도 409 `STALE_EPOCH`다.
- 같은 terminate를 같은 키로 다시 보내면 처음 receipt를 돌려준다. 새 키의 terminate는 `closed`로 거절되고 세션의 revision은 그대로다.
- 웹 세션 상세는 `closed` 세션에 제어 버튼도 복구 결정도 그리지 않는다(`actionsFor`, `RecoveryDecisions`).

시험: `packages/db/src/terminate-recovery.test.ts`, `packages/db/src/control-unit-of-work.integration.test.ts`의 terminate 시험, `apps/web/src/routes/sessions.test.tsx`의 복구 화면 terminate 시험.

### Slack 멘션이 대화 계층에 들어가는 길

에이전트의 `conversation_rollout`이 `on`일 때 묶인 작업이 없는 스레드의 멘션을 처리표가 다룬다. 처리표는 생애주기 정지를 먼저 본다(보관, 강퇴, 승인 대기, 에이전트 비활성, 소유자 없음). 일으키는 쪽은 언제나 Slack에서 멘션한 사람이고, 판정은 receive path(`slack-session-handler.ts`)가 한다.

| 지금 상태 | 입력·조건 | 다음 상태 | 남는 것 |
| --- | --- | --- | --- |
| 에이전트 활성, 소유자 있음 또는 유예(14일) 안, 채널 사용 중, 듣기 `mention`·`free` | 멘션 | 대화 턴 후보(`m2`). 인가·입력 검사를 지나면 턴 | 턴 1개 |
| 위와 같고 듣기 `off` | 멘션 | 버림(`drop_with_off_notice`) | 스레드에 `channelOff` 한 줄 |
| 에이전트 `paused`, 채널 사용 중 | 멘션 | 정지(`lifecycle_stopped`, `agent_inactive`) | 스레드에 `agentInactive` 한 줄 |
| 소유자 없음이 유예를 넘김, 채널 사용 중 | 멘션 | 정지(`lifecycle_stopped`, `agent_ownerless`) | 스레드에 `agentOwnerless` 한 줄 |
| 채널 보관·강퇴·승인 대기(에이전트 정지와 겹쳐도), 또는 Slack이 이제 비공개라고 알리는 공개 채널 | 멘션 | 정지(`lifecycle_stopped`) 또는 승인 대기 | 없음(승인 대기는 멘션한 사람에게만 `pendingApproval`) |
| 에이전트 `archived` | 멘션 | 처리표 앞에서 버림(보관이 바인딩과 identity를 취소한다) | 없음 |
| 에이전트 정지 또는 소유자 없음이 유예를 넘김 | 멘션 없는 글 | 정지 | 판단 버퍼에 담지 않음 |
| 소유자 없음이 유예를 넘김, 열린 작업에 묶인 스레드 | 요청자의 중단 말 | 작업 중단(`stop_session`) | 중단 안내 |
| DM, 에이전트 정지 | DM | 정지 | 없음 |
| rollout `off`·`shadow` | 멘션 | 지금 길(세션). 멘션은 처리표를 묻지 않는다 | 안내 없음 |

지켜야 할 성질:

- 안내 한 줄은 턴, 모델 호출, 예산 예약을 만들지 않는다.
- 안내는 사람·채널·UTC 날짜마다 한 번이다. 같은 날 다른 스레드에서 다시 불러도 다시 달지 않고, 다른 사람에게는 따로 단다. 하루 한 번은 outbox dedupe 키로 지킨다.
- 소유자 없음 판정은 세션 생성의 `agent_ownerless` 거절과 같은 함수(`ownerlessPastGrace`)를 쓴다. 두 곳의 기준이 갈라지지 않는다.
- 소유자 없음은 이미 도는 작업을 멈추지 않으므로, 요청자의 중단 말은 막지 않는다.
- 채널 쪽 정지(보관·강퇴·승인 대기)가 있는 곳에는 에이전트 정지 안내를 쓰지 않는다. 채널 종류 검사(공개 채널이 비공개가 됨)를 지난 뒤에만 쓴다.
- 다른 조직 사람(인가와 같은 `slackUserKindOf` 기준: `is_stranger`·`is_external`·다른 team)의 멘션에는 스레드 안내를 쓰지 않는다. 채널 종류 검사가 내는 요청자용 안내는 그대로다.
- 에이전트 정지 안내는 처리표가 `lifecycle_stopped`라고 답할 때만 고른다. 바인딩 `mode`가 `off`(`not_received`)이면 아무것도 하지 않는다.
- 채널 승인보다 먼저 쓴 멘션에는 안내를 쓰지 않는다(입력 길과 같은 `approvedAt` 기준).
- 안내는 다시 읽은 바인딩이 여전히 쓰이고(`mode` `on`) Slack이 채널 종류를 확인했을 때만 쓴다.
- 공유 채널에서는 내부 사람이 일으킨 안내를 다른 조직 사람도 같은 스레드에서 본다.
- 판정은 inbox가 이벤트를 처리할 때의 상태로 한다. 안내를 큐에 넣은 뒤 에이전트가 다시 켜지거나 바인딩이 바뀌어도 그 안내는 취소하지 않는다.
- dedupe 키는 설치·채널·사람·문구·이벤트의 UTC 날짜다. 한 판정에 듣기 `off`와 에이전트 정지가 겹치면 정지 안내가 이긴다. 같은 날 다른 판정에서 다른 문구가 나오면 문구마다 한 번씩 나간다.
- 소유자 없음이 되기 전에 버퍼에 담긴 글은 지우지 않는다. 버퍼의 수명(10분)이 지나면 사라진다. 비활성은 버퍼의 정리 길이 따로 지운다.

## 2. turn·attempt

turn은 `queued → running → completed | failed | interrupted | outcome_unknown | cancelled`로 간다. attempt는 worker 하나가 세션을 쥔 기간이다. checkpoint pointer는 세션이 복원할 수 있는 마지막 revision을 가리키고, 그 revision의 행은 자기가 덮는 turn을 이름으로 가진다.

### 용어

- **pending 사유**: turn이 checkpoint 없이 끝난 까닭. 세션에 적힌다.
  - advisory: `background_writer`, `tool_in_flight`, `checkpoint_lease_held`, `publish_failed`. 세션은 계속 일한다.
  - blocking(`mirror_error`), exhausted(`transcript_too_large`, `transcript_part_too_large`): 새 turn을 받지 않는다.
- **`publish_failed`의 두 갈래**: worker는 둘을 구분한다. 세션에 적히는 사유는 같다.
  - 인프라 실패: checkpoint 요청, 업로드, commit이 오류나 503으로 끝났다. worker 로그의 `category`가 `error`다. 잠시 뒤 같은 캡처가 통과할 수 있다.
  - 결정적 거절: 캡처가 스스로 거절했다(작업 공간이 한도를 넘음 등). 로그의 `category`가 `refused`다. 다음 turn이 작업 공간을 고쳐야 통과한다.
- **turn 밖 commit**: 이미 끝난 turn에 checkpoint를 붙이는 commit. turn은 끝난 상태 그대로 두고 pointer만 올린다. worker가 `POST /internal/worker/checkpoint-commit`으로 보낸다.
- **capture_kind**: manifest의 `captureKind`. turn 끝 캡처는 적지 않는다. turn 밖 캡처는 `between_turns`(turn 사이)나 `before_idle_exit`(idle 종료 직전)를 적는다. 판정 키에는 들어가지 않는다.
- **run이 조용하다**: engine이 추적하는 도구와 배경 작업이 없고, engine이 스스로 내던 답이 끝났고, engine 아래에 남은 프로세스가 없다. 배경 작업이 끝나면 engine은 그 알림을 받아 입력 없이 한 번 더 답한다. 알림을 받은 때부터 그 답의 result까지는 조용하지 않다. 그 사이에 찍은 transcript에는 알림만 있고 답이 없어서, 거기서 복원한 engine이 같은 알림에 다시 답한다. transcript에 넣지 않는 알림(ambient 작업)은 답을 열지 않는다. 작업이 목록에서 빠지는 것과 알림의 순서는 정해져 있지 않으므로, 캡처하는 동안 그 답이 시작됐으면, 답이 그 안에 끝났더라도 그 캡처는 버리고 답이 끝난 뒤 다시 찍는다. idle 종료 직전의 캡처가 그렇게 버려지면 한 번 더 찍는다. run에 조용한지 묻는 호출에도 캡처와 같은 단계 예산이 걸려 있다.

### 전이 표

| # | 지금 상태 | 다음 상태 | 조건 | 누가 |
| --- | --- | --- | --- | --- |
| T1 | turn running | turn completed, pointer 그대로, pending = advisory 사유 | finalize에 checkpoint가 없고 사유가 advisory다 | worker (finalize) |
| T2 | turn completed, pending advisory | pointer rev N+1(turn = 그 attempt가 마지막으로 끝낸 turn), pending 없음. turn은 completed 그대로 | 같은 attempt, 같은 lease epoch, lease가 살아 있음, 그 attempt에 열린 turn이 없음, 뒤에 시작한 turn이 없음, run이 조용함 | worker의 재시도 → gateway의 turn 밖 commit |
| T3 | 열린 turn 없음, 그 attempt의 이벤트 도착 | 이벤트가 그 attempt가 마지막으로 끝낸 turn에 붙고 `after_turn`으로 표시됨 | 같은 attempt, 같은 epoch, 그 attempt가 끝낸 turn이 있음. 어느 turn인지는 이벤트가 도착한 때로 정한다 | gateway (append-events) |
| T4 | 열린 turn 없음, 그 attempt의 provider 호출 | 호출이 그 attempt가 마지막으로 끝낸 turn의 예산 root로 잡힘 | 같은 attempt, 그 attempt가 끝낸 turn이 있음 | egress 판정 (예산 선택) |
| T5 | attempt running(idle), 빚진 checkpoint 있음, 배경 작업 없음 | 캡처(`before_idle_exit`) → turn 밖 commit → attempt exited. 캡처나 commit이 안 되면 그대로 exited | idle timeout | worker |
| T6 | attempt running(idle), 빚진 checkpoint 있음, 배경 작업 있음 | 유예 → 유예 안에 끝나면 캡처 → exited. 유예가 지나면 배경 작업 멈춤 → 알림 이벤트 → run이 조용해지기를 기다림 → 캡처 → exited | idle timeout | worker |
| T7 | turn completed, pending = `publish_failed`(인프라 실패), 새 입력 도착 | 새 turn은 queued로 남음 | 재시도가 성공하거나 보류 상한이 찰 때까지 | worker (next-input을 묻지 않음) |
| T8 | T7의 보류가 상한에 닿음 | 새 turn 시작. pending = `publish_failed`는 남음 | 첫 실패부터 `retryHoldMs`가 지남 | worker |
| T9 | turn completed, pending = `publish_failed`(결정적 거절) 또는 `background_writer`, 새 입력 도착 | 새 turn 시작. 그 turn의 finalize가 checkpoint를 commit하면 pending 없음 | 사유가 advisory다 | worker |
| T10 | attempt exited, 덮이지 않은 turn 있음 | 세션 recovery_required | 1번 절의 조건 | scheduler |
| T11 | turn running | turn failed(`emergency_stopped`). 대기 중인 입력은 cancelled. 실행이 있으면 lease epoch가 올라감 | 관리자가 그 세션이 일하는 Slack 채널에서 에이전트를 긴급 정지함 | 긴급 정지 트랜잭션 |
| T12 | 앞의 turn(cancelled 제외)이 failed(`emergency_stopped`), 새 입력으로 만든 turn의 첫 전달([이어서 하기] 제외) | 새 turn 시작. 끊긴 입력은 앞에 붙이지 않고 `prepend_skip_reason` = `emergency_stopped` | 정지를 풀고, 세션이 일시 정지됐으면 재개한 뒤 | worker의 next-input |
| T13 | attempt draining(요청된 drain: SIGTERM·SIGINT), 열린 turn 없음, 빚진 checkpoint 있음 | 배경 작업이 있으면 유예 없이 바로 멈춤 → 알림 이벤트 → run이 조용해지기를 기다림 → 캡처(`before_idle_exit`) → turn 밖 commit → release(`stop_kind: drain`) → exited. 캡처나 commit이 안 되거나 drain 예산이 다하면 그대로 exited | worker가 종료 신호를 받음(배포, 노드 정리, 컨테이너 재시작). T6의 유예 중이든 아니든 같다 | worker |
| T14 | turn running | turn failed(`worker_ownership_lost`), `outcome_unknown` 아님. 입력 receipt는 `WORKER_OWNERSHIP_LOST`로 failed. checkpoint와 pointer는 그대로. admission이 `active`이고 그 앞에 덮이지 않은 turn이 없으면 세션 admission은 그대로이고 status는 기다리는 입력이 있으면 `queued`, 없으면 `idle`. 그 앞에 덮이지 않은 turn이 있으면 T10이 함께 일어난다 | worker가 lease를 스스로 내려놓고 끝났다는 기록(exit 75)이 있고, 그 실행의 attempt가 가진 lease가 DB 시계로 모두 끝났다. 승인 대기 checkpoint가 온전한 turn은 park가 먼저다 | scheduler (실행 종료 확인) |

빚진 checkpoint는 worker가 기억하는 값이다. 마지막으로 끝낸 turn이 checkpoint 없이 끝났거나, 마지막 캡처 뒤에 engine이 스스로 답을 냈으면 빚이 있다.

- T5, T6, T13은 빚이 있을 때만 일어난다. 빚이 없으면 idle 종료와 drain은 캡처 없이 끝난다.
- T5와 T6의 캡처가 거절되거나 실패하면 worker는 새 checkpoint 없이 끝난다. 덮이지 않은 turn이 있으면 T10으로 간다. T6에서 멈춘 뒤 run이 `settleWaitMs` 안에 조용해지지 않은 경우도 같다(engine이 알림에 답하다가 새 작업을 시작한 경우 등).
- T6에서 멈추는 것은 그 run의 자손 프로세스다. worker 컨테이너에는 그 run의 프로세스만 있고, checkpoint를 `background_writer`로 거절하게 하는 프로세스 목록과 같은 목록을 쓴다. 신호를 보내기 직전에 목록을 다시 읽는다. SIGTERM을 보내고, 남으면 SIGKILL을 보낸다. lease를 잃었거나 다른 이유로 멈추는 중이면 신호를 보내지 않는다. T13(종료 신호)에서는 보낸다.
- 멈춘 프로세스의 명령 이름(커널의 `comm`, 15자 이하)만 `system` 이벤트(`background_tasks_stopped`)에 적는다. 인자와 환경 값은 적지 않는다. 이름은 영문자, 숫자, `.`, `_`, `+`, `-`만 남기고, 읽는 쪽(웹, engine 입력)도 그 모양인 이름만 최대 16개 쓴다.
- 그 이벤트는 세션 상세에 한 줄로 보이고, 다음 turn의 engine 입력 맨 앞에도 한 줄로 붙는다. 알림은 앞선 turn 가운데 끊기지도 `cancelled`도 아닌 마지막 turn의 것을 본다. 그래서 알림을 받은 turn이 끊기거나 버려지면 그 뒤의 turn에도 다시 붙는다(`keeps the line past a cut-off turn, …`, `keeps the line past a delivered turn an operator abandoned`).
- T7의 재시도가 성공하면 T2가 일어나고 queued였던 turn이 바로 시작한다.
- T7의 보류는 turn 하나의 빚에 한 번이고, 첫 실패부터 센다. 보류를 벗어난 뒤 다시 인프라 실패가 나도 시간을 새로 세지 않는다. 상한에 닿거나 넘는 재시도는 하지 않고, 상한에서 보류를 끝낸다. 그때 진행 중이던 캡처와 commit은 끝까지 가므로 다음 입력은 그만큼 더 기다릴 수 있다. 캡처가 끝나지 않으면 turn 끝 캡처와 같은 단계 예산(worker 시작 timeout)에서 worker가 실패로 끝난다.
- T8 뒤의 빚은 pause 직전과 idle 종료 직전에 한 번씩 다시 시도한다. 그래도 덮지 못하면 T10으로 간다.
- T13의 모든 대기는 drain 예산(`WORKER_DRAIN_TIMEOUT_SEC`, 기본 100초)이 끝나면 멈춘다. drain 예산은 설정에서 launcher의 종료 유예(`WORKER_STOP_GRACE_SEC`)보다 12초 짧게 잘리고, 그 12초가 engine 종료와 release의 몫이다. 프로세스 목록 읽기, 조용한지 묻기, 캡처, commit과 그 거절 보고는 모두 drain 예산과 경주한다. idle 종료가 배경 작업을 보는 목록 읽기도 같다. 예산이 다하면 보낸 commit의 답을 기다리지 않고 shutdown으로 간다(그 commit이 DB fence를 release보다 먼저 얻으면 들어가고, 아니면 막힌다). 예산 안에 답하지 않은 목록 읽기는 "프로세스 없음"이 아니라 "모름"이다. 그래서 run이 조용하다고 보지 않고 캡처를 시작하지 않는다. 조용해지기를 기다리는 시간은 기다림을 시작할 때마다 `settleWaitMs`와 그때 남은 drain 예산의 절반 가운데 작은 값으로 정하고, 그 안의 질문 하나하나도 그 시간에서 끊는다. 멈추기의 목록 읽기(신호 전과 신호를 기다리는 동안)는 하나하나 신호 하나를 기다리는 시간(`stopSignalWaitMs`)에서 끊는다. SIGKILL 전의 목록 읽기가 끊기면 무엇이 남았는지 모르므로 SIGKILL을 보내지 않는다. 남은 프로세스는 worker 컨테이너가 정리될 때 끝난다(worker는 자손이 모두 끝났는지 확인하지 않고 release한다). T13은 캡처를 한 번 시도한다(T7의 보류를 하지 않는다. 캡처 중에 engine 답이 끼어들면 그 답 뒤에 한 번 더 찍는다). 실패하면 T10으로 간다.
- 멈춤 알림(`background_tasks_stopped`)은 attempt 하나에 한 번이고, 멈추기를 끝까지 한 쪽이 낸다. idle 종료가 배경 작업을 멈추는 중에 종료 신호(또는 lease 잃음·실패)가 오면, idle 종료는 기다림을 바로 그만두고 다음 신호도 알림도 보내지 않는다. 종료 신호였으면 T13이 남은 프로세스를 다시 읽어 멈추고 알림을 낸다. drain 예산이 다해 T13의 멈추기가 끊긴 경우에도 알림은 내지 않는다.
- 요청되지 않은 drain(`mirror_error`, 복구 결정이 필요한 turn), lease 잃음, 실패에서는 T13이 일어나지 않는다.
- T10의 판정(context gap, claim gate)은 이 절의 전이가 바꾸지 않는다.
- 끊긴 turn(`worker_ownership_lost`, `emergency_stopped`)은 돈 turn으로 세지 않아 덮이지 않아도 T10을 일으키지 않는다. 그 앞의 turn이 덮이지 않았으면 T10은 그대로 일어난다.
- 긴급 정지는 열린 turn이 없어도 실행을 fence한다. 정지 뒤에는 그 worker의 T2·T3이 일어나지 않고 새 T4 판정도 거절된다. 정지 전에 이미 허가받은 provider 호출은 정지 뒤에 예산에 잡힐 수 있다. 그때 덮이지 않은 turn은 덮이지 않은 채 남고, 지금의 context gap 판정(실행 종료 확인, claim, `stopped`에서의 재개)을 그대로 받는다.
- T11로 끊긴 turn은 사람이 [이어서 하기]를 해야만 다시 돈다.
- T14의 조건은 둘 다 있어야 한다. 기록이 없으면, park되지 않고 열려 있던 turn은 `outcome_unknown`(`execution_gone`)이 되고 세션은 `recovery_required`로 간다(R13). 기록은 있는데 lease가 아직 살아 있으면, kill이 요청되지 않은 실행은 아무것도 닫지 않고 lease가 끝난 뒤의 물음이 닫는다(R14).
- T14로 끊긴 turn은 저절로 다시 돌지 않는다. 세션은 다음 입력을 새 worker에서 받고(P7), 새 입력으로 만든 turn은 끊긴 turn의 입력을 앞에 붙여 받는다. 그 입력의 출처가 지워졌거나 입력을 읽을 수 없으면 붙이지 않고 `prepend_skip_reason`을 적는다. [이어서 하기]로 만든 turn은 끊긴 turn의 입력이 곧 자기 입력이다.

### 값

값은 `apps/worker/src/worker-host.ts`의 `OUTSIDE_TURN_CHECKPOINT` 하나에 모여 있다.

| 이름 | 값 | 뜻 |
| --- | --- | --- |
| `idleBackgroundGraceMs` | 5분 | T6의 유예 |
| `afterIdleGrace` | `stop` | 유예 뒤 동작. `wait`이면 멈추지 않고 배경 작업이 끝날 때까지 종료를 미룬다 |
| `stopSignalWaitMs` | 10초 | SIGTERM에서 SIGKILL까지 |
| `settleWaitMs` | 60초 | 멈춘 뒤 run이 조용해지기를 기다리는 상한. engine이 알림에 답하는 시간이 여기에 든다 |
| `retryBackoffMs` | 1, 2, 4, 8, 15초(마지막 값 반복) | T7 재시도 간격 |
| `retryHoldMs` | 120초 | T7 보류의 총 시간 상한. 첫 실패부터 세고, 이 뒤에는 재시도를 시작하지 않는다 |
| `commitRetryMs` | 30초 | commit 하나가 5xx를 받으며 다시 보내는 상한 |

### 막을 전이

| # | 막을 전이 | 답 | 시험 |
| --- | --- | --- | --- |
| R1 | lease를 잃었거나 epoch가 지난 attempt의 turn 밖 commit | 409 `LEASE_EXPIRED` 또는 `STALE_EPOCH` | `is refused from an attempt whose epoch has passed or whose lease has lapsed` |
| R2 | 그 attempt가 마지막으로 끝낸 turn이 아닌 turn id로 하는 commit | 409 `REQUEST_STALE`(다른 attempt의 turn은 404) | `is refused on a turn that is not the last the attempt finalized`, `is refused on another attempt's turn, and on a turn the session does not have` |
| R3 | 다음 turn이 시작된 뒤 도착한 turn 밖 commit | 409 `REQUEST_STALE`. manifest를 판정하기 전에 거절한다. 판정하는 동안 다음 turn이 시작됐으면, 한도 판정을 적는 transaction이 fence 아래에서 turn을 다시 보고 적지 않는다 | `is refused once a later turn has started: that turn's finalize commits what covers both`, `is refused from the turn alone before its manifest is judged, …`, `packages/platform/src/workers/worker-gateway.test.ts`의 `a checkpoint for a turn that takes none any more is refused before its manifest is judged, …`, `a limit verdict on a checkpoint outside a turn is handed to the store with its turn, …`, `a limit its manifest reached is recorded while the turn still takes a checkpoint, and not once the next turn has started` |
| R4 | blocking 사유(`mirror_error`)를 그 사유를 낸 attempt의 turn 밖 commit이 지우는 것 | commit은 되지만 사유는 남고, pointer는 복원 지점으로 믿지 않는다 | `does not clear the blocking reason of the attempt that raised it, so the pointer stays untrusted` |
| R5 | revision이 pointer의 다음 번호가 아닌 commit | 409 `REVISION_CONFLICT` | `is refused when its revision is not the pointer's next` |
| R6 | 다른 attempt가 끝낸 turn에 이벤트를 `after_turn`으로 붙이는 것 | 이벤트는 어느 turn에도 붙지 않는다 | `are never put on another attempt's turn` |
| R7 | 긴급 정지가 fence한 worker의 turn 밖 commit(끊긴 turn은 `failed`라 상태만으로는 checkpoint를 받는다) | 409 `STALE_EPOCH`, pointer 그대로 | `packages/db/src/emergency-stop.test.ts`의 `the fenced worker puts no checkpoint outside a turn on the turn the stop cut off` |
| R8 | 긴급 정지로 끊긴 turn의 입력이 다음 turn 앞에 저절로 붙는 것 | 붙지 않고 `prepended_turn`과 `prepend_skip_reason`이 적힌다 | `packages/db/src/emergency-stop.test.ts`의 `the next message is not given the stopped turn's input, and the skip is recorded`, `the next message after input the stop cancelled is not given the stopped turn's input either` |
| R9 | 덮인 turn 뒤의 drain이 캡처하는 것 | 캡처하지 않고 끝난다 | `apps/worker/src/worker-host-outside-turn.test.ts`의 `a drain after a covered turn takes no capture` |
| R10 | T13의 캡처나 commit, idle 종료의 목록 읽기가 drain 예산을 넘어 종료를 붙잡는 것. 조용한지 묻는 질문 하나가 캡처 몫까지 쓰는 것 | 예산(질문은 settle 시간)에서 기다림을 그만두고 release한다 | 같은 파일의 `a drain capture that never returns is given up at the drain budget`, `a drain commit the gateway never answers is left at the drain budget, …`, `a process scan that stalls while the idle exit checks the work does not hold a drain past its budget`, `a scan that stalls after SIGTERM is cut at the signal window, …`, `a quiet probe that does not answer is cut at the settle window, …` |
| R11 | 멈춤 알림이 한 attempt에서 두 번 나가는 것 | 한 번을 넘지 않는다 | 같은 파일의 `a drain that comes while the idle exit is stopping the work stops what is left and announces it once` |
| R12 | 예산 안에 답하지 않은 목록 읽기를 "프로세스 없음"으로 보고 worker가 포기한 뒤 캡처를 시작하는 것 | 조용하다고 보지 않고 캡처(checkpoint lease)를 시작하지 않는다 | 같은 파일의 `a scan the drain budget cut short is not read as a quiet run, …` |
| R13 | lease를 내려놓았다는 기록(exit 75) 없이 사라진 worker의 열린 turn(승인 대기 checkpoint에 park되지 않은 것)을 `worker_ownership_lost`로 닫는 것 | turn은 `outcome_unknown`(`execution_gone`), 세션은 `recovery_required`. 사람의 복구 결정이 그 turn을 정한다 | `packages/db/src/worker-ownership-lost.test.ts`의 `word absent, lease expired: turn outcome_unknown, session recovery_required`, `word absent, lease live: turn outcome_unknown, session recovery_required`, `the sweep records lease_expired and the turn is unknown, as before`, D2 gate의 D-03 |
| R14 | 기록은 있지만 lease가 아직 살아 있고 kill이 요청되지 않은 실행의 turn을 닫는 것 | 닫지 않는다. 기록만 남기고 slot과 세션 연결을 그대로 둔다(`lease_pending`). kill이 요청된 실행은 기다리지 않고, 열려 있던 turn은 `outcome_unknown`으로 닫힌다 | 같은 파일의 `word kept, lease live: nothing is settled, the word is recorded and the look is asked again`, `a later look that no longer sees the exit code still waits while the lease is live`, `is not held up by a live lease: the exit settles at once, the turn unknown as before` |

R7~R14를 빼면, 파일을 적지 않은 시험은 `packages/db/src/worker-unit-of-work.outside-turn.test.ts`에 있다.

열린 turn, `outcome_unknown` turn, `cancelled` turn에 하는 commit도 409 `REQUEST_STALE`로 거절한다(`is refused on a turn that is %s`).

turn만 보고 거절할 수 있는 commit(R2, R3, 위 문장)은 manifest를 읽기 전에, lease를 보기 전에 거절한다. 그래서 lease를 잃은 attempt가 R1의 답 대신 409 `REQUEST_STALE`나 404를 먼저 받을 수 있다. pointer와 pending 사유를 쓰는 일은 언제나 fence 아래에서 한다.

turn을 이름으로 가진 채 저장된 이벤트를 turn 없이 다시 보내면 같은 이벤트로 받지 않는다(409, `an event stored for a turn it named is not the same event sent again for no turn`). 같은 commit의 재전송은 revision, manifest 위치, digest, object version이 모두 같을 때만 저장된 답을 돌려준다(`a resend that names another version of the manifest object is not the commit that landed`).

### 지킬 성질

| # | 성질 | 시험 |
| --- | --- | --- |
| P1 | 덮이지 않은 turn이 있는 세션은 새 worker로 넘어가지 않는다 | `tests/context-gap-flow.integration.test.ts`의 `an idle exit without a covering checkpoint waits on an operator, …` |
| P2 | 배경 작업을 남긴 turn 뒤에 idle 종료가 와도, 캡처가 성공하면 세션은 recovery_required가 되지 않는다 | 같은 파일의 `a turn that left background work running is checkpointed once the work ends, …`, `apps/worker/src/worker-host-outside-turn.test.ts`의 유예 안·밖 시험 |
| P3 | turn 없는 checkpoint는 어느 turn도 덮지 않는다. turn 밖 commit은 언제나 turn id를 가진다 | `a checkpoint that names no turn covers none, …`, `a commit outside a turn always names the turn it is put on` |
| P4 | turn 밖 출력과 비용은 언제나 한 turn에 속한다 | `go on the turn it ended last, marked as after it, …`, `packages/db/src/exchange-budget.test.ts`의 `a call between turns is charged as the turn the attempt ended last, …` |
| P5 | 인프라 실패 pending 동안 다음 turn은 시작하지 않는다. 결정적 거절은 다음 turn을 막지 않고, 보류는 상한에서 끝난다 | `apps/worker/src/worker-host-outside-turn.test.ts`의 `a publish the infrastructure failed is retried in the lease, …`, `a capture the workspace itself refuses does not hold the next turn, …`, `past the hold's limit input is asked for again …`, 업로드만 실패시킨 `an upload the store fails is retried in the lease on the backoff, …`와 commit만 실패시킨 `a commit the gateway fails is retried in the lease on the backoff, …`, 흐름 시험 `an upload the store failed is retried in the lease while the next message stays queued, …`, `a commit the gateway failed is retried in the lease while the next message stays queued, …` |
| P6 | 배경 작업 유예 중에 종료 신호를 받아도, 캡처가 성공해 마지막 turn이 덮이면 세션은 recovery_required가 되지 않는다. 캡처가 실패해 마지막 turn이 덮이지 않은 채 남으면 지금처럼 recovery_required다 | 흐름 시험 `SIGTERM during the background grace stops the work, checkpoints the turn …`, `SIGTERM during the background grace whose capture fails still leaves the session to a recovery decision`, `apps/worker/src/worker-host-outside-turn.test.ts`의 `a drain during the background grace stops the work at once …`, `a drain whose capture fails leaves the turn uncovered and still drains` |
| P7 | lease를 스스로 내려놓고 끝난 worker의 turn(T14)은 승격되지 않는다(checkpoint 행도 pointer도 생기지 않는다). admission이 `active`이고 그 앞에 덮이지 않은 turn이 없으면 세션은 recovery_required가 되지 않고, 다음 입력을 새 worker에서 돈다 | `packages/db/src/worker-ownership-lost.test.ts`의 `word kept, lease expired: turn failed, session active`, `the look after the lease runs out fails the turn and keeps the session, from the record alone`, `input queued behind the lost turn is signalled, and the next worker gets it, never the lost turn`, D2 gate의 D-02·D-04 |

D2 gate의 check(D-02~D-04)는 `tests/d2-gate/gate.e2e.test.ts`의 `D: a worker that loses its lease mid-turn promotes nothing`이 낸다. 이 시험은 `scripts/d2-gate/run.sh`가 띄운 스택에서만 돈다(야간과 수동 실행, gate 자신을 바꾼 PR, release candidate 전의 `scripts/soak/rc.sh`).

P4에는 예외가 하나 있다. 그 attempt가 아직 끝낸 turn이 없으면(시작 직후) 이벤트는 어느 turn에도 붙지 않고, 호출은 세션의 첫 turn의 예산 root로 잡힌다.

P4의 turn은 이벤트와 호출이 각각 control plane에 도착한 때로 정한다. turn N 뒤에 engine이 낸 이벤트가 늦게 도착해 turn N+1이 도는 중에 저장되면 어느 turn에도 붙지 않고, N+1이 끝난 뒤에 저장되면 N+1에 붙는다. 호출도 도착한 때의 turn으로 잡히므로, turn 경계에 걸친 답은 이벤트와 비용이 서로 다른 turn에 잡힐 수 있다. `after_turn` 이벤트는 답 판정(Slack 답, 예산 거절 경계)에 쓰이지 않는다.

`after_turn` 표시는 control plane만 붙인다. worker payload에 같은 이름의 키가 있어도 읽히지 않는다. payload가 객체가 아닌 이벤트는 표시를 옆에 저장만 하고, 읽을 때는 payload 그대로 나간다. Slack이 원문을 지워 가려진 turn의 이벤트는 표시 없이 읽힌다.

### 알려진 한계

- 이미 checkpoint가 있는 turn 뒤에 engine이 스스로 답을 냈는데 그 답을 다시 캡처하지 못한 채 worker가 끝나면, pointer는 여전히 그 turn을 덮는다고 읽힌다. 다음 worker는 그 답이 없는 transcript에서 이어 간다. 답은 세션의 이벤트(`after_turn`)로는 남아 있다. worker는 그 답을 다시 캡처하려고 시도하지만, 판정(context gap)은 이 경우를 보지 않는다.
- 살아 있는 run에서 engine이 입력 없이 답하는 중에 다음 입력이 전달되고, 그 답의 result가 입력을 이름으로 갖지 않으면 worker는 새 turn을 `outcome_unknown`으로 닫는다(전부터 있던 동작). 배경 작업이 끝난 직후에 메시지가 들어오면 일어날 수 있다. 이 절의 전이는 복원한 engine이 같은 알림에 다시 답하는 경우만 막는다.
- ambient가 아닌 알림 뒤에 engine이 result를 내지 않으면, 그 run은 다음 turn의 result가 올 때까지 조용하지 않다고 읽힌다. 그동안 turn 밖 캡처는 거절되고, 덮이지 않은 turn이 있으면 idle 종료는 T10으로 간다.
- 배경 작업 멈춤 알림은 checkpoint commit과 따로 보낸다. commit이 먼저 닿고 알림이 닿기 전에 worker가 fence되면(긴급 정지, 종료 등) 다음 turn의 입력과 세션 상세에 그 줄이 없다.
- T6에서 멈춘 뒤 engine이 답하면서 새 작업을 시작하면, 알림 이벤트에는 처음 목록의 명령 이름만 들어 있다.

## 3. 대화 turn

### 작업 효과

멘션 턴이 `spawn_task`(새 작업 만들기)나 `route_to_task`(열린 작업에 넘기기)로 끝나면, slack 역할의 턴 끝내기 pass가 그 결정의 효과를 한 번 낸다. 결과는 `conversation_turns.task_effect`에 남는다. 값이 없으면 아직 끝을 쓰지 않은 것이다. `route_to_task`의 입력은 끝을 쓰기 전에 들어갈 수 있다.

#### `route_to_task`

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| `decided`, `task_effect` 없음 | `routed` | 출처 글이 지워지지 않았고, 대상이 턴과 같은 대화의 열린 작업이고, 글쓴이가 그 작업에 `session.submit` 권한이 있고, 보관한 요청 사본이 있어 그 작업에 입력이 들어갔다. 이 턴의 입력이 이미 작업에 있으면(앞선 실행이나 나란히 돈 실행이 넣었다) 그 뒤 글이 지워졌거나 권한이 바뀌었어도 판정 없이 `routed`다 | 턴 끝내기 pass |
| `decided`, `task_effect` 없음 | `refused` | (아래 셋은 이 턴의 입력이 작업에 없을 때만) 글쓴이의 `session.submit`이 거절됐다. 요청자에게만 알리고, 그 글이 닿지 않으면 스레드에 서버 한 줄을 단다 | 턴 끝내기 pass |
| `decided`, `task_effect` 없음 | `failed` | 대상이 닫혔거나 다른 대화(다른 채널, 다른 사람의 DM)의 작업이다. 턴이 Slack 앱이나 Slack 주체에 묶여 있지 않다. 출처 집합이 넘쳤다. 요청 사본의 기한(1시간)이 지났다. 그 밖의 세션 거절. 스레드에 서버 한 줄을 단다 | 턴 끝내기 pass |
| `decided`, `task_effect` 없음 | `voided` | 턴이 읽은 글에 지움 표식이 있다(효과 직전, 또는 입력을 받을 때). 아무것도 쓰지 않고 말하지 않는다 | 턴 끝내기 pass |
| `routed`, `refused`, `failed`, `voided` | (없음) | 끝 상태다. 다시 돌려도 바뀌지 않는다 | — |

지키는 성질:

- 끝 상태는 다른 끝 상태로 가지 않는다. 효과는 `task_effect`가 비어 있을 때만 쓴다.
- `route_to_task`의 효과는 작업을 새로 만들지 않는다. 대상 작업이 실행 중이면 입력은 그 뒤에 줄을 선다.
- `routed`면 대상 작업에 그 글의 입력이 하나 있고, 다른 값이면 없다. 입력은 턴 id를 키로, 호출자가 보내는 어떤 키와도 겹치지 않는 범위에서 받는다. `routed`가 아닌 끝은 그 입력이 없을 때만 쓴다. 같은 턴을 몇 번 돌려도 입력, mirror 줄, 스레드 안내 줄은 하나다.
- 입력을 넣는 일과 끝을 쓰는 일은 같은 잠금(그 턴의 입력 영수증 범위)을 잡는다. 끝을 쓰는 쪽은 잠금 뒤에 영수증을 읽고, 입력을 넣는 쪽은 잠금 뒤에 그 턴이 `routed`가 아닌 값으로 끝났으면 넣지 않는다. 그래서 같은 턴의 두 실행이 나란히 돌아도 입력과 끝이 어긋나지 않는다. 입력이 있어 끝을 쓰지 못한 실행은 그 자리에서 `routed`로 끝낸다.
- 열린 작업인지는 입력을 넣기 전에 본다. 그 뒤 작업이 `failed`가 되었어도 입력 허용(admission)이 열려 있으면 입력은 들어가고 작업은 다시 줄을 선다. 원래 스레드의 후속 글과 같다.
- 요청자에게만 보이는 거절 알림은 끝을 쓰기 전에 보낸다. 끝을 쓰기 전에 실행이 멈추거나 두 실행이 나란히 돌면 또 갈 수 있고, 다른 실행이 입력을 막 넣었다면 결국 `routed`로 끝나는 턴에도 갈 수 있다(`spawn_task`의 거절 알림과 같다).
- 넘긴 입력은 턴의 출처 집합 전체(direct와 inherited)를 싣는다. 그중 하나가 지워지면 그 출처를 실은 보내기가 막힌다.
- `spawn_task`의 값(`opened`)과 `route_to_task`의 값(`routed`)은 섞이지 않는다. `routed_session_id`는 `route_to_task` 턴에만 있고, `routed`면 반드시 있다. 결정이 없는 턴에는 `task_draft`, `routed_session_id`, `task_effect`가 모두 없다(CHECK `conversation_turns_task_check`).

#### `spawn_task`

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| `decided`, `task_effect` 없음 | `opened` | `task.spawn`을 다시 판정해 허용되고 작업 세션이 열려 스레드에 묶였다(앞선 실행이 연 세션도 같다) | 턴 끝내기 pass |
| `decided`, `task_effect` 없음 | `refused` | `task.spawn` 거절, 열린 작업 한도, 쓸 수 없는 저장소 | 턴 끝내기 pass |
| `decided`, `task_effect` 없음 | `failed` | 턴이 묶여 있지 않다, 출처 집합이 넘쳤다, 스레드를 다른 글이 잡았다, 요청 사본이 없다 | 턴 끝내기 pass |
| `decided`, `task_effect` 없음 | `voided` | 턴이 읽은 글에 지움 표식이 있다 | 턴 끝내기 pass |
| 끝 상태 | (없음) | 다시 돌려도 바뀌지 않는다 | — |

### mirror 스레드: 가리키는 작업

다른 스레드의 글을 열린 작업에 넘기면, 그 스레드(`task_thread_mirrors`의 한 줄, 스레드당 하나)가 그 작업을 가리킨다. 작업의 보고는 작업의 스레드에만 가고, mirror 스레드에는 "원래 스레드에서 이어서 할게요 ↗" 한 줄과 원래 스레드 링크만 간다. mirror 스레드에 또 글이 오면 대화가 다시 판단한다.

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| 줄 없음 | 작업 A를 가리킴(`rev` 1) | 그 스레드의 글이 작업 A로 넘어갔다. 안내 한 줄을 단다 | 넘기기 효과(같은 transaction) |
| 작업 A를 가리킴 | 작업 A를 가리킴 | 또 A로 넘어갔다. 안내를 달지 않는다 | 넘기기 효과 |
| 작업 A를 가리킴 | 작업 B를 가리킴(`rev` + 1) | B로 넘어갔다. 안내 한 줄을 단다 | 넘기기 효과 |
| 가리킴 | 줄 없음 | 가리키던 작업 세션이 지워졌다(외래 키 cascade) | 세션 삭제 |
| 그대로 | 그대로 | 입력이 들어간 뒤 끝을 쓰기 전에 대상 작업이 닫혔다(첫 턴 전 멈춤 등). 턴은 `routed`로 끝나지만 mirror 줄을 바꾸지 않고 안내도 달지 않는다. 끝을 쓰는 transaction은 세션 행을 잡고 열린 작업인지 다시 본다 | 넘기기 효과 |

지키는 성질:

- 안내는 가리키는 작업이 바뀔 때만 단다. A→B→A면 두 번 단다. 안내의 중복 키는 mirror 줄의 id와 `rev`라서 같은 바뀜에 두 번 달리지 않는다. cascade로 지워진 뒤 새로 생긴 줄은 id가 달라 `rev` 1부터 다시 안내한다.
- 줄 바꾸기와 안내 달기는 한 transaction이다. 두 글이 같은 작업으로 동시에 넘어가도 안내는 하나다(스레드의 유일 인덱스가 순서를 정한다).

## 4. rollout 스위치

이 절은 rollout 스위치 전이를 바꾸는 변경이 채운다.