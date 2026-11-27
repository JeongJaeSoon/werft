# 상태 기계

네 상태 기계(세션 admission, turn·attempt, 대화 turn, rollout 스위치)의 전이를 더하거나 바꾸는 변경은 그 기계의 표를 여기에 적거나 함께 고친다. 표마다 지금 상태, 입력과 조건, 다음 상태, 누가 일으키는지를 적고, 지켜야 할 성질을 함께 적는다.

## 세션 admission

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
