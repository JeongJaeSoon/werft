# 재시도, Idempotency-Key, 오류

`src/reliability.ts`는 SDK가 실패를 어떻게 다루는지 실제 서버에 대고 보여 준다. 공통 준비는 [SDK 샘플](https://jeongjaesoon.github.io/werft/ko/reference/examples/)에 있다.

1. 같은 Idempotency-Key로 같은 세션 생성을 두 번 보내면 세션은 하나다. 같은 key에 다른 본문이면 409 `IDEMPOTENCY_CONFLICT`이고, 오류는 그 key를 싣는다.
2. 서버가 메시지를 받은 뒤 응답만 사라지게 하는 `fetch`를 끼운다. SDK는 같은 key로 다시 보내고 서버는 첫 응답을 재생하므로 turn은 하나만 생긴다.
3. 시도 하나가 `timeoutMs`를 넘기게 해 `TimeoutError`를 받는다. 오류의 `idempotencyKey`로 다시 보내면 첫 시도가 서버에 닿았든 아니든 명령은 한 번만 실행된다.
4. 아무도 듣지 않는 포트로 `ConnectionError`(재시도 1회 = 시도 2번), 이미 abort한 `signal`로 `AbortedError`를 받는다.
5. 호출마다 주는 `headers`는 `Authorization`과 `Idempotency-Key`를 바꾸지 못한다.

## key와 실행

개인 key를 `sessions:read`, `sessions:write`, `sessions:control`로 발급한다. 모든 요청에 `defaultHeaders`로 `x-werft-sample` 헤더를 붙인다. `WERFT_AGENT_RELEASE_ID`(필수)로 세션을 만들 에이전트 릴리스를 정한다.

```sh
bun examples/sdk-reliability/src/reliability.ts
```

## 실행 결과

```text
create twice with one key: same session …
same key, other body: 409 IDEMPOTENCY_CONFLICT, retryable false, request id present, error key is ours
turn 1: completed
lost response: 2 attempts, 1 key, turn 2
turn 2: completed
timeout: TimeoutError TIMEOUT, attempts 1, key kept
resent with the saved key: turn 3, again: turn 3
turn 3: completed
turns: 1, 2, 3
no listener: ConnectionError NETWORK_ERROR, attempts 2
aborted: AbortError ABORTED, cause "cancelled by the operator"
reserved header: headers cannot set Idempotency-Key
every SDK failure above is a WerftError
close: receipt succeeded
```

- 재시도는 읽기와 Idempotency-Key가 있는 명령만 한다. key가 없는 `openPullRequest`·`commentPullRequest`는 응답을 잃으면 다시 보내지 않는다([sdk-push](../sdk-push)).
- 409와 500은 본문이 뭐라고 하든 재시도하지 않는다. `REVISION_CONFLICT` 같은 상태 충돌은 호출자가 다시 읽고 판단한다([sdk-control](../sdk-control)).
- 프로세스를 다시 띄운 뒤 이어서 재시도하려면 오류의 `idempotencyKey`를 저장해 두었다가 `{ idempotencyKey }`로 넘긴다.

`bun test examples/sdk-reliability`가 key별로 응답을 재생하는 가짜 API로 같은 출력과 메시지 요청 네 번(잃은 응답 2, 재전송 2)을 확인하고, 재생하지 않는 서버에서 종료 코드 1을 확인한다.
