# 결정(설계): egress proxy forward 경로에서 client 연결을 요청 하나씩 이어 쓴다

- 상태: 설계. 같은 PR에서 구현한다.
- 티켓 번호: 저장소의 마크다운은 티켓 번호를 적지 못한다(`tests/docs-links.test.ts`). 티켓 이름은 "egress proxy를 거치는 Bun fetch가 non-2xx 뒤 닫힌 연결을 다시 써서 다음 요청이 끊긴다"이고, 번호는 이 문서를 들인 PR 본문에 있다.
- 기준 커밋: `origin/main` `df2524d0c`. `파일:줄`은 이 커밋에서 읽은 값이다.
- 범위: 평문 `http://` forward(absolute-form) 경로만. CONNECT 터널은 연결 수명을 upstream이 정하므로 이 문제가 없다. Bun 자체 수정도 범위 밖이다.

## 요약

| 항목 | 결론 |
|---|---|
| 고른 안 | (a) client 연결에서 요청을 **하나씩 순서대로** 받는다. 요청마다 머리를 새로 읽고, policy 판정·upstream 연결·body framing을 새로 한다. pipelining은 받지 않는다 |
| 이어 쓰는 조건 | 모두 맞을 때만 이어 쓴다: client가 HTTP/1.1로 `Connection: keep-alive`를 보냈고 `close`를 보내지 않았다, upstream 응답이 HTTP/1.1이고 길이나 chunked로 끝을 알린다, 응답 머리를 보낼 때 요청 body가 끝났고 upstream에 다 넘겼다, 요청을 보낸 dispatch가 끝났다, 요청 body 뒤의 바이트를 하나도 보지 않았다, 응답을 client 소켓에 다 썼다. 하나라도 어긋나면 지금처럼 `connection: close`를 말하고 응답 뒤에 닫는다 |
| 지키는 불변식 | "upstream 연결 하나에 forward 요청 하나"는 그대로다. 보안은 셋에서 나온다: 요청마다 머리를 엄격하게 읽는다, 요청마다 policy를 새로 판정한다, 끝난 교환의 upstream은 그 뒤 client에 아무것도 하지 못한다. pipelining을 받지 않는 것은 proxy가 본 바이트로 하는 정책이고, 보안 논증은 거기에 기대지 않는다 |
| 머리 검사 강화 | 요청·응답 머리의 칸 값과 응답 상태 줄에 제어 문자(HTAB 말고)가 있으면 거절한다. 칸 이름은 token이어야 하고, 요청 method도 token이어야 한다. 원래 있던 틈이지만, 연결을 이어 쓰면 숨긴 칸 하나로 다음 origin의 응답을 앞 응답의 body로 읽힐 수 있게 되므로 함께 막는다 |
| proxy가 직접 만든 응답 | 400·403·408·431·502·503·504는 지금처럼 `connection: close`를 보내고 닫는다 |
| 응답 머리 | 이어 쓸 때만 `connection: close`를 빼고, 닫을 때는 지금처럼 넣는다. 머리에 close를 썼으면 반드시 닫는다(RFC 9112 §9.6) |
| 쉬는 연결 | 교환 사이의 빈 연결에는 머리 기한(`headTimeoutMs`, 기본 15초)을 다시 건다. 그동안 한 바이트도 오지 않으면 408 없이 닫는다 |

## 1. 문제

worker 안 도구가 Bun `fetch`로 평문 http 주소에 요청을 잇달아 보낸다. 앞 응답이 non-2xx이면 다음 요청이 가끔 `The socket connection was closed unexpectedly`로 실패한다.

- 실측(`werft-worker:dev`, Linux, bun 1.3.14). 실제 `startEgressProxy`를 쓰고, upstream은 await 뒤에 401·403을 답하는 Bun.serve다. client는 POST 4번(401·401·403·401)을 보내고, 프로세스마다 새로 300번 돌린다.
  - proxy 경유: 티켓 때 64·68·51번 실패, 이 설계를 쓰며 다시 돌렸을 때 33번 실패.
  - upstream 직결: 0번 실패. proxy 경유에 `keepalive: false`: 0번 실패. macOS: 0번 실패.
- 지금 proxy의 동작: 최종 응답 머리를 `connection: close`로 바꾸고, 응답 body가 끝나면 client 연결을 닫는다(`apps/egress-proxy/src/proxy.ts:719-725`, `apps/egress-proxy/src/response.ts:135`).
- Bun은 그 소켓을 pool에 돌려놓고 다음 요청을 보낸다. 응답 직후 도착하는 FIN보다 다음 `fetch()`가 먼저 돈다. 그 뒤 EOF를 받으면 다시 보내지 않고 오류를 낸다. `response.ts` 머리 주석의 가정("a client that had already sent another request on it gets an EOF and sends it again on a fresh one")은 Bun fetch에는 맞지 않는다.
- Bun fetch와 Bun의 node:http는 둘 다 proxy에 `Proxy-Connection: Keep-Alive`와 `Connection: keep-alive`를 보낸다(bun 1.3.14 실측). curl과 git(libcurl)은 HTTP/1.1에서 이 머리를 보내지 않는다.

## 2. 지금의 smuggling 방어

proxy는 "client 연결 하나에 forward 요청 하나"로 request smuggling을 막는다.

- 요청 머리는 엄격하게 읽는다. CL과 TE가 함께 오면, Content-Length가 둘 이상이면, chunked가 아닌 TE, 숫자가 아닌 길이, obs-fold는 모두 거절한다(`apps/egress-proxy/src/request.ts:90-108`, `:115-128`).
- body는 `createBodyFramer`로 센다. body 뒤의 바이트는 upstream에 가지 않고 버린다(`request.ts:205-300`, `proxy.ts:570-593`). 버린 바이트에 다른 목적지의 자격 증명이 실려 있을 수 있으므로, 이 요청을 위해 판정한 upstream에 닿으면 안 된다.
- 응답도 같은 framer로 세고, 끝나면 upstream과 client를 둘 다 닫는다(`proxy.ts:719-725`). upstream이 `connection: close`를 무시해도(Bun.serve는 비동기로 답한 뒤 연결을 열어 둔다) 다음 요청이 앞 upstream으로 가지 않는다.

이 방어의 핵심은 두 가지다. 첫째, 한 요청을 위해 판정한 upstream 소켓에는 그 요청의 바이트만 간다. 둘째, 바이트를 요청과 요청으로 가르는 경계를 proxy와 상대가 다르게 읽을 틈이 없다. 연결을 닫는 것은 둘째 조건을 지키는 한 방법일 뿐이다.

둘째 조건에는 원래 틈이 있었다(Codex 설계 리뷰가 찾았다). 머리는 CRLF로만 줄을 나눈다(`request.ts:115-128`, `response.ts:227-244`). 그래서 칸 값 안의 bare LF가 그대로 전달된다. 예를 들어 `X-Test: value\nTransfer-Encoding: chunked` 뒤에 `Content-Length: 4`가 오면, proxy는 길이 4로 읽고, LF를 줄 끝으로 받는 상대는 chunked로도 읽는다. 응답 쪽에서는 `X-Test: a\nContent-Length: 99` 뒤의 `Content-Length: 0`을 proxy가 길이 0으로 읽는다. 연결을 닫던 때는 같은 upstream 안의 일이었다. 이어 쓰면 그런 client는 다음 origin의 응답을 앞 응답의 body로 읽는다. 그래서 이 변경에서 함께 막는다(5.4절).

## 3. 후보 비교

### (a) 요청을 하나씩 순서대로 받는다 — 고름

교환이 끝나면 client 연결의 상태를 처음 머리를 기다리던 때로 되돌린다. 다음 요청은 새 연결에 온 요청과 똑같이 다룬다. 머리를 엄격하게 읽고, policy를 판정하고(이름 조회 포함), upstream에 새로 연결하고, framer를 새로 만든다.

- 보안 논증: 다음 요청이 어떤 바이트에서 오든, 그 요청은 새 연결의 첫 요청과 같은 검사를 받는다. 엄격한 머리 읽기, 새 policy 판정, 새 upstream이다. 앞 요청의 upstream에는 앞 요청 framer 안의 바이트만 간다. 그래서 경계를 proxy가 어떻게 가르든, 한 목적지를 위해 판정한 소켓에 다른 요청의 바이트가 실리지 않는다.
- pipelining 거절은 proxy가 **본** 바이트로 하는 정책이다. 앞 교환이 끝나기 전에 proxy가 받은 body 밖의 바이트는 지금처럼 버리고, 그 연결은 이어 쓰지 않는다. 시점으로 pipelining을 완전히 가를 수는 없다. 응답을 소켓에 다 썼다는 것은 kernel이 받았다는 뜻이지 client가 읽었다는 뜻이 아니다. 그사이에 client가 보낸 요청은 다음 요청으로 읽힌다. 위 논증 덕분에 그래도 안전하다. 읽기를 멈춘 client 소켓의 kernel buffer에 남은 바이트도 같다. 다만 읽기를 멈추는 경우는 upstream 쪽 queue가 밀렸을 때뿐이고, 그때는 queue가 비지 않아 이어 쓰지 않는다(5.2절 3).
- 끝난 교환의 upstream: 응답이 끝나는 순간, `upstream.end()`를 부르기 **전에** 그 attempt를 끝난 상태로 바꾼다. 그 뒤 그 소켓의 data·close·error·drain과, `adopt`가 다시 내보내는 held 바이트는 client에 아무것도 하지 못한다. `drain`이 특히 위험하다. 그 handler는 client의 `toUpstream` queue를 자기 소켓에 쓰는데, 상태를 되돌린 뒤에는 그 queue가 다음 교환의 것이다.
- 비용: `proxy.ts`의 교환 상태를 되돌리는 함수 하나, response rewriter의 선택 인자 하나, 요청 머리에서 keep-alive를 읽는 칸 하나. pipelining을 받지 않으므로 앞 요청이 도는 동안 다음 요청을 쌓아 둘 queue가 필요 없다.

### (b) client가 그 연결을 다시 쓰지 못하게 한다 — 고르지 않음

- `connection: close`는 이미 보낸다. Bun은 그것을 지키지 않는다.
- 응답을 close-delimited로 바꾼다(Content-Length·chunked를 떼고 EOF로 끝내기). 그러면 client는 EOF 전에는 응답이 끝났다고 보지 못하므로 다시 쓰지 못한다. 그러나 잘린 응답과 다 받은 응답을 client가 가르지 못하게 된다. 데이터 손실을 숨기는 길이라 거부한다. body가 없는 응답(HEAD, 204, 304)에는 효과도 없다.
- FIN 대신 RST를 보내면 응답 자체를 잃을 수 있다. 응답 직전에 반쯤 닫아도 client가 pool에 넣기 전에 기다린다는 보장이 없다.
- client마다 `keepalive: false`를 쓴다: e2e 시험(PR #1681)이 쓴 방법이고 실측으로 효과가 있다. 그러나 client 쪽 완화일 뿐이다. 사용자의 에이전트가 쓰는 임의의 client를 고치지 못한다.

### (c) 그 밖의 방법 — 고르지 않음

- "close라고 말하고 다음 요청이 오면 받는다": RFC 9112 §9.6이 금지한다(`close`를 보낸 서버는 그 뒤의 요청을 처리하면 안 된다). 규칙을 지키는 client와 경계를 다르게 읽게 된다.
- pipelining까지 받는다(앞 응답이 끝날 때까지 다음 요청을 쌓아 둔다): 요청마다 따로 판정하므로 smuggling은 막을 수 있다. 그러니 이것을 빼는 것은 보안 판단이 아니라 범위 판단이다. 받으려면 쌓아 둘 queue의 상한, 순서 보장, 앞 교환이 실패했을 때 쌓인 요청을 처리하는 규칙이 새로 필요한데, 실제로 그렇게 보내는 client가 없다. YAGNI로 미룬다.
- 문서화만 한다: 오너가 수정을 골랐다(아래 4절).

## 4. 오너 판단

티켓은 "고치는 방향을 정하기 전에 오너 판단을 받는다"를 인수 조건으로 둔다. 오너는 2026-11-14에 "고치는 게 맞지 않나?"라고 답했다. 문서화가 아니라 수정을 원한다는 뜻으로 읽고, 이 조건은 채워졌다고 본다.

## 5. 이어 쓰는 규칙

### 5.1 요청 머리

`parseRequestHead`가 forward 요청에 `keepAlive`를 더한다. 버전이 `HTTP/1.1`이고, `connection` 칸들의 토큰에 `keep-alive`가 있고, `connection`과 `proxy-connection` 어느 쪽에도 `close`가 없을 때만 참이다.

- HTTP/1.1의 기본은 이어 쓰기다. 그래도 명시한 client에만 이어 쓴다. 그러면 curl·git처럼 `connection: close`를 잘 지키는 client는 지금과 똑같이 동작하고, 바뀌는 범위가 이 문제를 겪는 client로 좁아진다. proxy는 언제든 연결을 닫기로 할 수 있으므로 규칙에 어긋나지 않는다. 이 조건은 smuggling 방어를 더하지 않는다. 바뀌는 범위를 좁히는 출시 판단이다(Codex도 같은 의견). HTTP/1.0 client는 proxy를 거치면 이어 쓰지 않는다(RFC 9112 §9.3).
- 대소문자와 여러 `connection` 칸을 모두 본다. `close`가 하나라도 있으면 `close`가 이긴다.
- upstream에 보내는 머리는 지금처럼 `connection: close`이고, hop-by-hop 칸은 빠진다(`request.ts:130-145`).

### 5.2 응답 머리

response rewriter가 최종 머리를 만들 때 proxy에 묻는다(`keepOpen`). 아래가 모두 맞으면 `connection: close`를 넣지 않는다.

1. 요청이 `keepAlive`다.
2. 응답 framing이 길이·chunked다. close-delimited body는 upstream이 닫아야 끝나므로 client도 닫아야 한다.
3. 그 시점에 요청 body가 끝났고(framer `complete`), 그 바이트가 `early`와 `toUpstream` queue에 남지 않았다. upload 도중에 upstream이 먼저 답하면(401 등) 남은 body를 받아 줄 곳이 없으므로 닫는다.
4. 그 시점까지 body 밖의 바이트가 오지 않았다.
5. 요청을 보낸 dispatch가 끝났다(`dispatching`이 거짓). upstream이 묻기도 전에 답을 보냈으면, 그 답은 `adopt`가 dispatch 도중에 내보낸다. 그 자리에서 상태를 되돌리면 dispatch가 남은 일(요청 머리 쓰기, early 바이트 넘기기)을 다음 교환의 queue에 한다.
6. upstream 응답이 HTTP/1.1이다. 상태 줄은 upstream이 쓴 그대로 가는데, `keep-alive`를 빼 버린 HTTP/1.0 응답은 client에게 close를 뜻한다.

조건이 하나라도 어긋나면 지금처럼 `connection: close`를 넣는다. 그 연결은 응답 뒤에 반드시 닫는다. interim 1xx 머리는 지금처럼 hop-by-hop 칸만 뺀다.

### 5.3 교환의 끝

응답이 끝나면(`answer.complete`) 먼저 그 attempt를 끝난 상태로 바꾸고(3절 (a)), 그다음 upstream을 닫는다. 그리고 아래를 본다.

- 머리에서 close를 말했거나, 5.2절의 조건이 이제는 맞지 않으면(그 뒤 body 밖의 바이트가 왔다 등): 지금처럼 queue를 비운 뒤 닫는다.
- 아니면: client queue가 비어 있으면 바로, 남아 있으면 client의 `drain`에서 queue가 빈 순간 상태를 되돌린다. queue가 빌 때까지 `phase`는 `piping`이고 끝난 upstream 소켓도 상태에 남아 있다. 그래서 그사이 client가 보낸 바이트도 끝난 framer를 지나 버려지고 `discarding`이 선다. 되돌리기 직전에 그것을 한 번 더 보고, 섰으면 닫는다. stall 기한도 그동안 그대로 걸려 있다.
- 되돌리는 상태: `phase = "head"`, 머리 buffer, body framer, `keepAlive`, `early`, upstream, `toUpstream` queue, stall timer. 연결 단위 상태(`counted`, `dispatching`, `releaseDeferred`)는 건드리지 않는다. connection cap의 자리는 연결이 닫힐 때까지 그대로 쥔다. 상태를 다 바꾼 **뒤에** client 읽기를 다시 켜고 머리 기한을 건다.
- 쉬는 연결에는 머리 기한을 다시 건다. 기한이 될 때까지 한 바이트도 오지 않으면 408 없이 닫는다. 이어 쓰는 client는 그때 보낸 요청이 408을 자기 답으로 읽을 수 있기 때문이다. 머리를 보내다 만 경우는 지금처럼 408이다.

### 5.4 머리 검사 강화

- 요청 머리의 칸은 응답·trailer와 같은 `parseField`로 읽는다. 칸 이름은 token이어야 한다. 그래서 콜론 앞 공백(RFC 9112 §5.1)도 거절된다. 칸 값에 HTAB 말고 제어 문자(`\x00-\x08`, `\x0a-\x1f`, `\x7f`)가 있으면 거절한다. obs-text(`\x80` 이상)는 받는다.
- 요청 method는 upstream에 받은 그대로 가므로 token이어야 한다. target은 `URL`로 다시 쓰므로 따로 검사하지 않는다.
- 응답 상태 줄의 reason phrase에도 제어 문자를 받지 않는다. 응답 칸과 chunked trailer는 `parseField`를 함께 쓰므로 같은 규칙을 따른다. 응답에서 걸리면 502이고, 이미 client에 무언가를 보냈으면 연결을 끊는다(`refuseAnswer`, 지금과 같다).

### 5.5 바뀌지 않는 것

- upstream 연결 하나에 forward 요청 하나. 요청마다 policy 판정과 이름 조회를 새로 한다. 앞 요청이 허용됐다고 다음 요청이 허용되지 않는다.
- proxy가 직접 만든 응답(`reply`)과 framing 실패(`refuseAnswer`), upstream 오류(`onError`)는 모두 연결을 닫는다. upstream이 body 도중에 닫혀 잘린 응답도 닫는다(`onClose` → `endClient`).
- CONNECT 터널: 한 번 터널이 되면 끝까지 터널이다. 다만 forward 교환 뒤에 이어 쓰는 연결에서 CONNECT가 올 수 있다. 새 연결의 CONNECT와 똑같이 다룬다.

## 6. 시험

기존 proxy 시험은 하나도 지우거나 느슨하게 하지 않는다. 아래는 새로 넣는다. proxy 사례는 `apps/egress-proxy/src/proxy.test.ts`에서 실제 소켓으로 확인하고, 시험 upstream이 받은 바이트(`scriptedHeard`, `sunk`)로 어디에도 닿지 않았음을 본다.

| 사례 | 보내는 것 | 기대 |
|---|---|---|
| 이어 쓰기(기본) | keep-alive 요청 두 개를 한 연결에서 차례로. 두 번째는 다른 origin이고 머리를 두 번에 나눠 씀 | 각자 자기 upstream의 답을 받고, 첫 응답 머리에 `connection: close`가 없다 |
| 요청마다 판정 | 같은 연결에서 link-local로 풀리는 host | 403이고 연결이 닫힌다 |
| CL/TE 충돌 | 이어 쓰는 연결의 두 번째 요청이 `content-length`와 `transfer-encoding: chunked`를 함께 보냄 | 400, 연결이 닫히고, upstream이 그 요청을 받지 않는다 |
| 중복 Content-Length | 두 번째 요청이 다른 길이 둘, 또는 같은 길이 둘 | 400, 연결이 닫히고, upstream이 그 요청을 받지 않는다 |
| 남는 body 바이트 | keep-alive 요청 + body + body 밖의 요청을 한 번에 씀 | 첫 응답 머리가 `connection: close`, 연결이 닫히고, body 밖의 요청은 아무 upstream에도 닿지 않는다 |
| pipelined 두 번째 요청 | 첫 요청을 upstream이 받은 뒤, 답이 오기 전에 두 번째 요청을 보냄. upstream은 proxy가 그 바이트를 버렸다고 로그에 남긴 뒤에야 답한다 | 응답 머리가 close, 연결이 닫히고, 두 번째 요청은 아무 upstream에도 닿지 않는다 |
| 이어 쓰기 머리 뒤의 pipelining | 머리가 close를 말하지 않은 뒤, body가 끝나기 전에 두 번째 요청을 보냄. body의 나머지는 버렸다는 로그 뒤에 온다 | body가 끝까지 오고 연결이 닫히며, 두 번째 요청은 아무 upstream에도 닿지 않는다 |
| upstream 오류 뒤 재사용 | 응답 머리가 잘린 upstream(502), body가 Content-Length보다 짧게 끊긴 upstream | 둘 다 연결이 닫힌다 |
| 이어 쓰지 않는 응답 | 길이 없이 닫혀서 끝나는 응답, HTTP/1.0 응답 | 머리가 `connection: close`, 연결이 닫힌다 |
| upload 도중의 답 | body 100바이트 중 10바이트만 보냈는데 upstream이 401 | 머리가 close, 연결이 닫힌다 |
| 끝난 upstream의 늦은 handler | 다음 교환의 upstream이 쓰기를 받지 않아 다음 요청 머리가 `toUpstream`에 남은 동안, 끝난 upstream의 `drain`·`data`(가짜 응답)·`error`·`close` handler를 시험이 직접 다시 부름 | 끝난 upstream에 한 바이트도 쓰이지 않고, client 연결은 열린 채, 다음 응답에 가짜 바이트가 섞이지 않는다 |
| body 없는 응답 뒤의 바이트 | HEAD 응답, 204 응답과 같은 write로 upstream이 가짜 응답을 붙임 | 다른 origin으로 간 다음 응답에 섞이지 않는다 |
| 묻기 전에 온 답 | 연결하자마자 답을 쓰는 upstream. dial 결과는 proxy가 그 답을 받아 둔 뒤에 돌려준다 | 머리가 close, 연결이 닫힌다(dispatch가 끝나지 않았다) |
| forward 뒤 CONNECT | 이어 쓰는 연결에서 CONNECT, 맞는 이름과 다른 이름의 ClientHello | 맞으면 터널이 통하고, 다르면 한 바이트도 건너가지 않고 닫힌다 |
| queue가 밀린 응답 | 읽기를 멈춘 client에 32 MiB 응답. upstream이 답을 마친 뒤(proxy가 upstream을 닫은 뒤), 아직 queue가 남은 동안 두 번째 요청을 보내는 경우와 보내지 않는 경우 | 보내면 응답이 끝까지 온 뒤 닫히고 새 dial이 없다. 안 보내면 drain 뒤의 두 번째 요청에 답이 온다 |
| 쉬는 연결 | 짧은 머리 기한의 proxy에서 한 교환 뒤 아무것도 보내지 않음. 머리를 반만 보냄 | 앞은 408 없이 닫히고, 뒤는 408 |
| connection cap | client당 1개인 proxy에서 한 연결로 요청 셋, 그동안 두 번째 연결 | 셋 다 답을 받고, 두 번째 연결은 503 |
| 머리에 숨긴 줄 | 요청·응답 칸 값의 bare LF·bare CR·NUL, 콜론 앞 공백, token이 아닌 method, 상태 줄의 LF, trailer의 LF | 모두 거절한다(단위 시험 `request.test.ts`, `response.test.ts`). HTAB와 obs-text는 받는다 |
| keep-alive 읽기 | 대소문자, 여러 칸, `close` 섞임, `Proxy-Connection: close`, HTTP/1.0 | `close`가 이기고, HTTP/1.0과 칸 없는 HTTP/1.1은 이어 쓰지 않는다 |
| keep-alive를 말하지 않은 client | `connection` 칸 없는 HTTP/1.1 요청 | 지금처럼 `connection: close` 뒤에 닫힌다(기존 시험 그대로) |
| Bun client | client당 연결 1개인 proxy로 `testing/pooled-client.ts`가 401·401·403·401 fetch POST를 10번 | 모두 자기 답을 받는다. 두 번째 연결을 열었으면 503이 났을 것이다 |

새 시험이 무엇을 잡는지는 고친 부분을 하나씩 되돌린 복사본에서 확인한다. main 코드에서는 새 시험 23개가 실패한다. 끝난 upstream 검사는 자리마다 따로 뺀다. `deliver`의 검사를 빼면 1개(늦은 handler), `close`·`error` 검사를 빼면 11개, `drain`이 끝난 attempt에도 쓰게 하면 1개(늦은 handler)가 실패한다. `discarding` 검사는 `reusable`에서 빼면 2개(남는 body 바이트, pipelined 두 번째 요청), 되돌리기 직전에서 빼면 1개(queue가 밀린 동안 보낸 요청)가 실패한다. 제어 문자 검사를 빼면 4개, dispatch·queue 조건을 빼면 1개(묻기 전에 온 답)가 실패한다. `toUpstream`이 비었다는 조건만 빼는 경우를 잡는 시험은 없다. 그 경우 되돌릴 때 queue를 버리므로 바이트가 새지 않는다. 그래도 남은 upload를 받아 줄 곳이 없으니 닫는 보수적인 조건으로 둔다.

재현 확인은 1절과 같은 조건(worker 이미지, `keepalive` 지정 없음, 300번)으로 돌리고 실패 0을 PR에 적는다.

## 7. 남는 위험

- 쉬는 연결을 proxy가 닫는 순간 client가 그 연결로 요청을 보내면 같은 오류가 날 수 있다. keep-alive를 쓰는 모든 서버에 있는 경쟁 조건이다. 정상적인 client도 머리 기한(15초)의 경계에 보내면 겪는다. 지금 실패는 응답이 끝날 때마다 생기지만, 이 경우는 15초를 쉰 뒤 그 순간에 보낸 요청에서만 생긴다.
- upload 도중에 upstream이 먼저 답한 경우와 proxy가 직접 만든 응답 뒤에는 지금처럼 닫는다. 그 뒤의 Bun 요청은 같은 이유로 실패할 수 있다. 앞의 요청이 이미 오류를 받은 경우라서 이번 범위에서 뺀다.
- e2e의 `keepalive: false`(PR #1681)는 이 변경 뒤에도 남긴다. 지울지는 이 변경이 main에서 돈 결과를 본 뒤 정한다.

## 8. Codex 설계 리뷰

판정은 APPROVE WITH CHANGES였다. smuggling 방어를 지키며 고칠 수 없다는 지적은 없었다. 지적과 반영은 아래와 같다.

| 지적 | 심각도 | 반영 |
|---|---|---|
| 끝난 upstream의 `drain`이 client의 지금 `toUpstream` queue를 자기 소켓에 쓴다. 늦은 close·error·data와 `adopt`의 held 재생도 다음 교환을 건드린다 | blocker | attempt에 끝난 상태(`finished`)를 두고 `upstream.end()` 전에 바꾼다. 모든 handler와 `deliver`가 이 상태를 본다(3절 (a)). 늦은 쓰기 시험 |
| 응답 뒤 queue가 빌 때까지 온 client 바이트가 `discarding`을 세우지 않을 수 있다 | major | 그동안 `phase`와 upstream을 그대로 두어 끝난 framer를 지나게 하고, 되돌리기 직전에 다시 본다(5.3절). 머리 뒤 pipelining 시험 |
| 콜백 경계는 pipelining이 없었다는 증명이 아니다 | major | 보안 논증을 시점에서 떼어 엄격한 읽기·새 판정·끝난 upstream 분리로 옮겼다. pipelining 거절은 본 바이트로 하는 정책이라고 적었다(3절 (a)) |
| 칸 값의 bare LF로 framing 칸을 숨길 수 있다(원래 있던 틈) | major | 요청·응답·trailer 칸 값과 상태 줄의 제어 문자, token이 아닌 칸 이름과 method를 거절한다(2절, 5.4절) |
| 상태를 되돌리기 전에 dispatch가 끝나야 하고 남은 upload를 버려야 한다 | major | `dispatching`이 거짓이고 `early`·`toUpstream`이 빌 때만 이어 쓴다. 연결 단위 상태는 되돌리지 않는다(5.2절, 5.3절). 묻기 전에 온 답 시험 |
| 시험 표가 상태 전이를 놓친다 | major | 6절 표에 늦은 쓰기, body 없는 응답 뒤의 바이트, interim 머리, upload 도중의 답, forward 뒤 CONNECT, cap, 숨긴 줄을 더했다 |
| keep-alive opt-in은 출시 판단이다. upstream HTTP/1.0 응답은 따로 다뤄야 한다 | minor | 출시 판단이라고 적고, HTTP/1.0 응답은 닫는다(5.1절, 5.2절 6) |
| 대안 기각 이유를 다듬고 쉬는 연결 경쟁의 설명을 고쳐라 | minor | 3절 (b)·(c)와 7절을 고쳤다. `keepalive: false`는 client 쪽 완화라고 적었다 |

받지 않은 것: Codex가 제안한 시험 중 쪼개진 100·103 머리 뒤의 이어 쓰기는 단위 시험(최종 머리만 묻는다)으로 갈음했다. 큐에 남은 upload는 위 6절의 이유로 시험하지 않았다.

구현 리뷰 결과는 PR 본문에 적는다.
