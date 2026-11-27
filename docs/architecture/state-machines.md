# 상태 기계

네 상태 기계(세션 admission, turn·attempt, 대화 turn, rollout 스위치)의 전이를 바꾸는 변경은 그 기계의 표를 여기에 적는다. 표는 지금 상태 → 다음 상태, 조건, 누가 일으키는지를 적고, 지켜야 할 성질을 함께 적는다.

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
- 세션을 닫은 멈춤의 Slack 안내를 쓰지 못하면 그 줄은 잃고, 그 Slack 이벤트는 다시 처리하지 않는다. 다시 처리하면 그 사이 닫힌 링크 때문에 멈춤 낱말이 새 멘션으로 들어갈 수 있다.
- 같은 멈춤을 같은 키로 다시 보내면 처음 결과를 돌려준다. 닫혔는지는 세션 행에서 다시 읽으므로, 이 변경 전에 요청이 취소된 채 열려 있던 작업을 나중 멈춤이 닫았다면 앞선 멈춤의 재시도도 닫힘으로 답한다.

시험: `packages/db/src/stop-control.test.ts`, `apps/control-host/src/slack/session-handler.integration.test.ts`의 Slack stop 시험.
