# 이벤트 스트림과 이어 받기

`src/events.ts`는 세션의 이벤트를 처음부터 받다가 turn 1의 `result` 이벤트에서 스트림을 닫고 `lastEventId`를 저장한다. turn 2를 보낸 뒤 저장한 cursor로 새 스트림을 열어 그 뒤의 이벤트만 받는지, 같은 이벤트가 두 번 오지 않는지 확인한다. 스트림은 세션이 끝나도 닫히지 않으므로 세 번째 스트림은 `signal`로 끝낸다. turn 목록은 한 페이지에 하나씩(`limit: 1`) 읽는다. 공통 준비는 [SDK 샘플](https://jeongjaesoon.github.io/werft/ko/reference/examples/)에 있다.

## key와 실행

에이전트 key(`sessions:read`, `sessions:write`, `sessions:control`)와 그 에이전트의 릴리스 ID로 돌린다. 에이전트 key는 자기 에이전트의 릴리스로만 세션을 만든다. `WERFT_AGENT_RELEASE_ID`는 필수다. 개인 key로도 돈다.

| 환경 변수 | 값 |
| --- | --- |
| `WERFT_API_KEY` | 에이전트 key |
| `WERFT_AGENT_RELEASE_ID` | 그 에이전트 릴리스의 `sha256:…` ID |

```sh
bun examples/sdk-events/src/events.ts
```

## 실행 결과

```text
session …: created, turn 1
  stream 1 status (turn 1)
  stream 1 system (turn 1)
  stream 1 system (turn 1)
  stream 1 system (turn 1)
  stream 1 assistant (turn 1): first turn
  stream 1 result (turn 1)
stream 1: 6 events; turn 1 was running at its result event, then completed
  stream 2 status (turn 1)
  stream 2 system
  stream 2 status (turn 2)
  …
  stream 2 assistant (turn 2): second turn
  stream 2 result (turn 2)
stream 2: 9 events after the saved cursor, none repeated
turn 2: completed
stream 3: ended by its signal after 2 new events
turns page 1: turn 1, page 2: turn 2, then null
all turns: 1:completed, 2:completed
stream of an unknown session: 404 NOT_FOUND
close: receipt succeeded
```

- `result` 이벤트를 받은 순간 turn 1은 아직 `running`이었다. 이벤트는 진행을 보여 줄 뿐 turn이 끝났다는 판정이 아니다. 끝났는지는 `turns.get`이나 `waitForTurn`으로 본다.
- 두 번째 스트림의 첫 이벤트는 저장한 cursor 바로 다음 것이다(turn 1의 마지막 `status`). cursor를 파일이나 DB에 저장하면 다른 프로세스에서도 같은 자리부터 받는다.
- 서버가 거절한 스트림(400·401·403·404·410)은 다시 연결하지 않고 `APIError`를 던진다.

`bun test examples/sdk-events`가 가짜 SSE로 `Last-Event-ID` 헤더(`없음 → e3 → e5`)와 중복 이벤트를 받았을 때의 종료 코드 1을 확인한다.
