# @werft-ai/sdk

서버와 스크립트에서 API key로 Werft 세션을 다루는 TypeScript SDK다. 세션 생성, 메시지, 이벤트 스트림, 권한 요청 답변, push 요청, close를 감싸고 재시도·Idempotency-Key·turn 대기를 대신 한다. Node 20.3 이상과 Bun에서 돈다. 브라우저에서는 API key가 새므로 막혀 있다.

```sh
npm install @werft-ai/sdk
```

이 명령은 릴리스(dist-tag `latest`)를 설치한다. main push에서 프리릴리스를 자동 게시하지 않는다. 기존 `main` dist-tag는 갱신되지 않으므로 릴리스 버전을 사용한다.

```ts
import { Werft, waitForTurn } from "@werft-ai/sdk";

// WERFT_BASE_URL, WERFT_API_KEY 환경 변수를 읽는다.
const werft = new Werft();
const created = await werft.sessions.create({
  agent_release_id: process.env.WERFT_AGENT_RELEASE_ID!,
  message: "README를 요약해 줘",
});
const turn = await waitForTurn(werft, created.session_id, created.turn_id);
console.log(turn.status);
```

- 사용 안내: [TypeScript SDK](https://jeongjaesoon.github.io/werft/ko/sdk/)
- 유즈케이스별 샘플(세션 목록, 이벤트 스트림, 재시도, 질문·권한 답변, 세션 제어, close, push): [SDK 샘플](https://jeongjaesoon.github.io/werft/ko/reference/examples/)
- HTTP API 규칙: [API 유즈케이스 가이드](https://jeongjaesoon.github.io/werft/ko/reference/api-guide/)

## 라이선스

[Apache License 2.0](LICENSE)이다. npm 배포본에는 저장소의 `packages/client` 코드와 `packages/contracts` 타입이 함께 묶여 들어가며, 배포본 전체가 Apache-2.0이다([NOTICE](NOTICE)). 저장소의 나머지(서버, 웹 콘솔, 그 밖의 패키지)는 PolyForm Small Business 1.0.0을 따르는 source-available 코드다.
