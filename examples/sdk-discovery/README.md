# key와 카탈로그 확인

`src/discover.ts`는 세션을 만들기 전에 할 일을 한다. key가 새는 설정을 client가 생성 시점에 거절하는지 보고, key의 주인과 scope(`auth.me`), 서버 응답(`root.get`), 릴리스가 쓸 수 있는 모델 연결(`connections.list`), 설치 상한(`limits.get`)을 읽는다. 공통 준비는 [SDK 샘플](https://jeongjaesoon.github.io/werft/ko/reference/examples/)에 있다.

## key와 실행

scope가 `sessions:read`인 아무 key면 된다. `WERFT_REQUIRED_SCOPES`(쉼표로 구분, 기본 `sessions:read`)에 앞으로 쓸 scope를 주면 key에 빠진 scope가 있을 때 종료 코드 1로 끝난다.

```sh
WERFT_REQUIRED_SCOPES=sessions:read,sessions:write bun examples/sdk-discovery/src/discover.ts
```

## 실행 결과

FAKE 스택에서 `sessions:read`만 가진 개인 key로 돌린 출력이다.

```text
@werft-ai/sdk 0.1.0, API spec 0.1.0-alpha, SSE schema 1
refused no API key: No API key: pass apiKey or set WERFT_API_KEY
refused plain http to a remote host: baseUrl is plain http to a remote host: the API key would cross the wire in clear text. Use https or set allowInsecureHttp.
refused a default Authorization header: headers cannot set Authorization
refused a negative retry count: maxRetries must be a non-negative integer
api: ok, key owner …
principal: api_key, scopes sessions:read
connection fake-messages: anthropic, metered, models claude-sonnet-5
limits: 403 FORBIDDEN (owner sign-in only)
```

- 거절된 네 설정은 요청을 하나도 보내지 않는다. 브라우저(`window`가 있는 곳)에서 만드는 것도 같은 방식으로 거절된다.
- 연결 줄은 에이전트 릴리스가 `connection_id`로 고를 수 있는 연결과, 그 연결에서 카드가 고를 수 있는 모델이다. endpoint와 자격 증명은 나오지 않는다.
- `limits.get`은 로그인한 workspace owner만 읽는다. API key는 항상 403이므로 샘플은 그 오류를 예상한 결과로 출력한다.

`bun test examples/sdk-discovery`가 가짜 API로 같은 출력과 scope 부족 시의 종료 코드 1을 확인한다.
