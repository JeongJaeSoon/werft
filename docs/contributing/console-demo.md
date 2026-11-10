# 콘솔 데모 모드 (읽기 전용)

서버 없이 웹 콘솔 화면을 예시 데이터로 채워 보는 빌드 모드다. 화면만 바꾼 PR을 스택 없이 확인할 때 쓴다(verify-werft 스킬의 T1 절차). 데모 owner로 로그인된 상태로 열리고, 저장·실행 요청은 보내지 않고 "데모에서는 저장되지 않습니다"라고 알린다.

- `apps/web/src/demo/`: 데모 진입점(`vite --mode demo`). GET은 fixture로 답하고 쓰기는 막는다. 기록 없는 GET은 `NOT_FOUND` 화면이 된다.
- `apps/web/src/demo/fixtures.json`: 로그인 응답 하나만 든 자리표시. CI `demo` job은 이것으로 빌드만 확인한다.
- `DEMO_FIXTURES=<파일>`: 자리표시 대신 쓸 fixture. 구조는 `{ recorded_at, responses: { "<경로>": { status, json } } }`이고, 상대 경로는 `apps/web` 기준이라 절대 경로로 준다.

```bash
cd apps/web
DEMO_FIXTURES=<fixture.json> bun --bun vite --mode demo --port <port> --host 127.0.0.1   # dev server
DEMO_FIXTURES=<fixture.json> bun run build:demo                                         # static build: apps/web/dist-demo
```

fixture에는 실제 토큰·이메일·내부 호스트를 넣지 않는다. 응답 값은 `@werft-ai/contracts` 타입에 맞춰 쓴다.
