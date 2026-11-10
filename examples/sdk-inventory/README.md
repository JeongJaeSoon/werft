# 세션 목록과 상세

`src/inventory.ts`는 제목에 이번 실행만의 표시를 붙인 세션 셋을 만들고, 목록에서 그 셋을 찾는다. `await`로 받은 첫 페이지에서 `nextPage()`로 끝까지 가고, `for await`로 모든 페이지를 한 번에 돌고, `status` 필터를 건다. 그 가운데 하나의 상세(`get`), 사용량(`usage`), 공유 범위(`share`)를 읽은 뒤 셋을 모두 닫는다. 공통 준비는 [SDK 샘플](https://jeongjaesoon.github.io/werft/ko/reference/examples/)에 있다.

## key와 실행

개인 key를 `sessions:read`, `sessions:write`, `sessions:control`로 발급한다. 에이전트 key는 세션 목록을 읽지 못하므로 쓰지 않는다. `WERFT_AGENT_RELEASE_ID`(필수)로 세션을 만들 에이전트 릴리스를 정한다.

```sh
bun examples/sdk-inventory/src/inventory.ts
```

## 실행 결과

```text
session …: created
session …: created
session …: created
3 first turns: completed
page 1 of q=inventory-mvsbs40v limit=2: 2 item(s), more after it
page 2: 1 item(s), last page
page 3: null
for await, relation=started limit=1: 3 sessions
status=idle: 3 sessions
session …: "inventory-mvsbs40v #1", status idle, admission active, revision 0, model claude-sonnet-5, repository agent/sample-app
usage: estimated $0.000042 (complete true), 5 tokens, 0/20 queued
share: workspace, revision 0
3 sessions: closed
```

- `q`는 제목 부분 일치와 세션 ID prefix로 찾는다. `relation=started`는 이 key(또는 key를 만든 사람)가 시작한 세션만 남긴다.
- 첫 turn을 마친 세션의 목록 상태는 `idle`이다. idle 세션은 worker를 계속 쥐고 있으므로 샘플은 끝에 닫는다.
- 사용량의 금액은 platform 가격표로 계산한 추정치(`estimated`)다. `complete`가 false면 아직 열린 turn이 있다.

`bun test examples/sdk-inventory`가 가짜 API로 페이지 순회, 필터 query, 세 세션의 close, 목록에서 세션이 빠졌을 때의 종료 코드 1을 확인한다.
