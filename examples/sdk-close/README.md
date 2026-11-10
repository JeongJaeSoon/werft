# 막힌 close 풀기

`src/close-drain.ts`는 close가 아무것도 죽이지 않고 기다린다는 것을 보여 준다. turn 1이 질문을 열어 둔 채 기다리고 turn 2가 그 뒤에 쌓인 상태에서 close한다. 세션은 `closing`이 되고, 그동안 보낸 메시지는 409 `SESSION_CLOSING`이다. drain이 60초를 넘기면 세션의 `attention`이 `CLOSE_BLOCKED`가 된다. 질문에 답하면 turn 1이 끝나고 close가 커밋되며, 쌓여 있던 turn 2는 취소된다. 공통 준비는 [SDK 샘플](https://jeongjaesoon.github.io/werft/ko/reference/examples/)에 있다.

## key와 실행

개인 key를 `sessions:read`, `sessions:write`, `sessions:approve`, `sessions:control`로 발급한다. `WERFT_AGENT_RELEASE_ID`(필수)로 세션을 만들 에이전트 릴리스를 정한다.

```sh
bun examples/sdk-close/src/close-drain.ts
```

## 실행 결과

`CLOSE_BLOCKED`를 기다리느라 1분 남짓 걸린다.

```text
session …: created
turn 1: waiting on a question, turn 2 queued
close: receipt accepted, admission closing (closing: true)
message while closing: 409 SESSION_CLOSING
waiting for the drain to report itself blocked…
attention: CLOSE_BLOCKED {
  code: "CLOSE_BLOCKED",
  reason: "pending_request",
}
question req_…: "Ship the release notes now?" -> no
answer req_…: accepted
close: receipt succeeded {
  checkpoint_revision: 0,
  cancelled_turn_count: 1,
  resulting_admission_state: "closed",
}
session: admission closed, status stopped, attention none; turn 2 cancelled
```

- `isClosing(session)`, `closeBlocked(session)`, `closeResult(receipt)`는 세션·receipt를 읽기 쉬운 값으로 바꾸는 helper다. `SESSION_ADMISSION_CLOSING`, `SESSION_CLOSING`, `CLOSE_BLOCKED`는 비교할 상수다.
- close를 기다릴 때는 `waitForReceipt`에 `signal`로 시한을 준다. 사람이 답하지 않으면 close는 계속 기다린다.
- 실패하면 세션을 그대로 두고 ID를 출력한다. 콘솔에서 질문에 답하거나 turn을 interrupt하면 close가 끝난다.

`bun test examples/sdk-close`가 가짜 API로 close·답의 본문과 출력을 확인하고, close receipt가 실패하면 종료 코드 1인지 확인한다.
