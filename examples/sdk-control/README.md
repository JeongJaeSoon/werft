# 세션 제어와 복구

`src/control.ts`는 세션 하나에서 제어 명령을 차례로 돈다. 공통 준비는 [SDK 샘플](https://jeongjaesoon.github.io/werft/ko/reference/examples/)에 있다.

1. **interrupt**: 5분 늦게 답하는 turn을 실행 중에 멈춘다. worker는 남아 다음 메시지를 받는다.
2. **revision**: 맞지 않는 `expected_revision`의 pause는 409 `REVISION_CONFLICT`다. SDK는 revision을 대신 채우거나 다시 보내지 않는다.
3. **pause·resume**: 8초 걸리는 turn과 그 뒤에 쌓인 turn이 있을 때 pause한다. 돌던 turn은 끝나고 쌓인 turn은 남는다. 그 turn을 `waitForTurn`으로 기다리면 스스로 끝날 수 없으므로 `TurnBlockedError`다. paused 동안의 메시지는 409 `SESSION_PAUSED`, resume 뒤 쌓인 turn이 돈다.
4. **terminate와 복구 결정**: 실행 중인 turn을 terminate하면 그 turn은 `outcome_unknown`, 세션은 `recovery_required`다. `abandon` 결정으로 turn을 `cancelled`로 정리하고 resume한다.

## key와 실행

개인 key를 `sessions:read`, `sessions:write`, `sessions:control`, `sessions:recover`로 발급한다. 세션은 에이전트 릴리스로 만든다.

| 환경 변수 | 기본값 |
| --- | --- |
| `WERFT_AGENT_RELEASE_ID` | 없음(필수). 세션을 만들 에이전트 릴리스의 `sha256:…` ID |

```sh
bun examples/sdk-control/src/control.ts
```

## 실행 결과

전체 10분 제한 안에서 2–3분 걸린다.

```text
session …: created
turn 1: completed
interrupt: turn 2 interrupted
pause with a wrong revision: 409 REVISION_CONFLICT
pause: admission paused, turn 3 completed, turn 4 queued
wait on turn 4: TURN_BLOCKED (paused)
message while paused: 409 SESSION_PAUSED
resume: turn 4 completed
terminate: receipt accepted, external effects reverted false
session: failed/recovery_required, turn 5 outcome_unknown
recovery: abandon, turn 5 cancelled, resumable true
after recovery: turn 6 completed
close: receipt succeeded
```

- 모든 제어는 receipt를 주고, 샘플은 `waitForReceipt`로 `succeeded`를 확인한 뒤 다음으로 간다.
- terminate는 도구가 이미 바깥에 한 일을 되돌리지 않는다(`external_effects_reverted: false`). 그 turn이 무엇을 했는지 확인한 사람이 복구 결정을 고른다. `abandon` 말고 `confirm_completed`, `close`, `start_fresh`, `retry_restore`가 있다([API 가이드 7절](https://jeongjaesoon.github.io/werft/ko/reference/api-guide/#7-outcome_unknownrecovery_required-복구-결정)).

`bun test examples/sdk-control`이 세션 상태를 흉내 내는 가짜 API로 같은 출력과 복구 결정 본문을 확인하고, 복구 뒤 turn이 실패하면 종료 코드 1인지 확인한다.
