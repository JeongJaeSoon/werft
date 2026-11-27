# 상태 기계

Werft에는 전이를 바꿀 때 표와 시험을 함께 고쳐야 하는 상태 기계가 넷 있다.

1. 세션 admission
2. turn·attempt (checkpoint pointer 포함)
3. 대화 turn
4. rollout 스위치

기계의 전이를 더하거나 바꾸는 변경은 그 기계의 절을 함께 고친다. 절마다 세 가지를 적는다.

- 전이 표: 지금 상태, 다음 상태, 조건, 누가 일으키는지.
- 막을 전이: 일어나면 안 되는 전이와 그것을 거절하는 시험.
- 지킬 성질: 어떤 전이를 거쳐도 참이어야 하는 문장과 그것을 고정하는 시험.

허용 전이마다 성공 시험을 하나, 막을 전이마다 거절 시험을 하나 둔다.

## 1. 세션 admission

이 절은 세션 admission 전이를 바꾸는 변경이 채운다. 2번 절이 기대는 전이 하나만 적어 둔다.

| 지금 상태 | 다음 상태 | 조건 | 누가 |
| --- | --- | --- | --- |
| active | recovery_required (status failed, reason context_gap) | 실행이 사라진 것이 확인됐거나 새 worker가 claim했고, 열린 turn이 없고, 마지막으로 돈 turn을 덮는 checkpoint가 없다 | scheduler(실행 종료 확인), worker의 claim |

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
| T12 | 앞의 turn(cancelled 제외)이 failed(`emergency_stopped`), 새 turn의 첫 전달 | 새 turn 시작. 끊긴 입력은 앞에 붙이지 않고 `prepend_skip_reason` = `emergency_stopped` | 정지를 풀고, 세션이 일시 정지됐으면 재개한 뒤 | worker의 next-input |

빚진 checkpoint는 worker가 기억하는 값이다. 마지막으로 끝낸 turn이 checkpoint 없이 끝났거나, 마지막 캡처 뒤에 engine이 스스로 답을 냈으면 빚이 있다.

- T5와 T6은 빚이 있을 때만 일어난다. 빚이 없으면 idle 종료는 캡처 없이 끝난다.
- T5와 T6의 캡처가 거절되거나 실패하면 worker는 새 checkpoint 없이 끝난다. 덮이지 않은 turn이 있으면 T10으로 간다. T6에서 멈춘 뒤 run이 `settleWaitMs` 안에 조용해지지 않은 경우도 같다(engine이 알림에 답하다가 새 작업을 시작한 경우 등).
- T6에서 멈추는 것은 그 run의 자손 프로세스다. worker 컨테이너에는 그 run의 프로세스만 있고, checkpoint를 `background_writer`로 거절하게 하는 프로세스 목록과 같은 목록을 쓴다. 신호를 보내기 직전에 목록을 다시 읽는다. SIGTERM을 보내고, 남으면 SIGKILL을 보낸다. worker가 종료 신호를 받았거나 lease를 잃었으면 신호를 보내지 않는다.
- 멈춘 프로세스의 명령 이름(커널의 `comm`, 15자 이하)만 `system` 이벤트(`background_tasks_stopped`)에 적는다. 인자와 환경 값은 적지 않는다. 이름은 영문자, 숫자, `.`, `_`, `+`, `-`만 남기고, 읽는 쪽(웹, engine 입력)도 그 모양인 이름만 최대 16개 쓴다.
- 그 이벤트는 세션 상세에 한 줄로 보이고, 다음 turn의 engine 입력 맨 앞에도 한 줄로 붙는다. 사이에 끊긴 turn이 있으면 복원 지점이 그 앞이므로 그 뒤의 turn에도 다시 붙는다(`keeps the line past a cut-off turn, …`).
- T7의 재시도가 성공하면 T2가 일어나고 queued였던 turn이 바로 시작한다.
- T7의 보류는 turn 하나의 빚에 한 번이고, 첫 실패부터 센다. 보류를 벗어난 뒤 다시 인프라 실패가 나도 시간을 새로 세지 않는다. 상한에 닿거나 넘는 재시도는 하지 않고, 상한에서 보류를 끝낸다. 그때 진행 중이던 캡처와 commit은 끝까지 가므로 다음 입력은 그만큼 더 기다릴 수 있다. 캡처가 끝나지 않으면 turn 끝 캡처와 같은 단계 예산(worker 시작 timeout)에서 worker가 실패로 끝난다.
- T8 뒤의 빚은 pause 직전과 idle 종료 직전에 한 번씩 다시 시도한다. 그래도 덮지 못하면 T10으로 간다.
- T10의 판정(context gap, claim gate)은 이 절의 전이가 바꾸지 않는다.
- 끊긴 turn(`worker_ownership_lost`, `emergency_stopped`)은 돈 turn으로 세지 않아 덮이지 않아도 T10을 일으키지 않는다. 그 앞의 turn이 덮이지 않았으면 T10은 그대로 일어난다.
- 긴급 정지는 열린 turn이 없어도 실행을 fence한다. 정지 뒤에는 그 worker의 T2·T3이 일어나지 않고 새 T4 판정도 거절된다. 정지 전에 이미 허가받은 provider 호출은 정지 뒤에 예산에 잡힐 수 있다. 그때 덮이지 않은 turn은 덮이지 않은 채 남고, 지금의 context gap 판정(실행 종료 확인, claim, 재개)을 그대로 받는다.
- T11로 끊긴 turn은 사람이 [이어서 하기]를 해야만 다시 돈다.

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

R7과 R8을 빼면, 파일을 적지 않은 시험은 `packages/db/src/worker-unit-of-work.outside-turn.test.ts`에 있다.

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
| P5 | 인프라 실패 pending 동안 다음 turn은 시작하지 않는다. 결정적 거절은 다음 turn을 막지 않고, 보류는 상한에서 끝난다 | `apps/worker/src/worker-host-outside-turn.test.ts`의 `a publish the infrastructure failed is retried in the lease, …`, `a capture the workspace itself refuses does not hold the next turn, …`, `past the hold's limit input is asked for again …`, 흐름 시험 `a publish the store failed is retried in the lease while the next message stays queued, …` |

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

이 절은 대화 turn 전이를 바꾸는 변경이 채운다.

## 4. rollout 스위치

이 절은 rollout 스위치 전이를 바꾸는 변경이 채운다.
