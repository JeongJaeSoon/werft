# 결정(설계): egress proxy forward 경로에서 client 연결을 요청 하나씩 이어 쓴다

- 상태: 설계. 같은 PR에서 구현한다.
- 티켓 번호: 저장소의 마크다운은 티켓 번호를 적지 못한다(`tests/docs-links.test.ts`). 티켓 이름은 "egress proxy를 거치는 Bun fetch가 non-2xx 뒤 닫힌 연결을 다시 써서 다음 요청이 끊긴다"이고, 번호는 이 문서를 들인 PR 본문에 있다.
- 기준 커밋: `origin/main` `df2524d0c`. `파일:줄`은 이 커밋에서 읽은 값이다.
- 범위: 평문 `http://` forward(absolute-form) 경로만. CONNECT 터널은 연결 수명을 upstream이 정하므로 이 문제가 없다. Bun 자체 수정도 범위 밖이다.

## 요약

| 항목 | 결론 |
|---|---|
| 고른 안 | (a) client 연결에서 요청을 **하나씩 순서대로** 받는다. 요청마다 머리를 새로 읽고, policy 판정·upstream 연결·body framing을 새로 한다. pipelining은 받지 않는다 |
| 이어 쓰는 조건 | 다섯 가지가 모두 맞을 때만 이어 쓴다: client가 HTTP/1.1로 `Connection: keep-alive`를 보냈고 `close`를 보내지 않았다, 응답이 길이나 chunked로 끝을 알린다, 응답 머리를 보낼 때 요청 body가 끝났다, 요청 body 뒤에 아무 바이트도 오지 않았다, 응답을 client 소켓에 다 썼다. 하나라도 어긋나면 지금처럼 `connection: close`를 말하고 응답 뒤에 닫는다 |
| 지키는 불변식 | "upstream 연결 하나에 forward 요청 하나"는 그대로다. 바뀌는 것은 client 쪽뿐이고, 새 불변식은 "client 연결에 진행 중인 요청은 많아야 하나, 다음 머리는 앞 교환이 끝난 뒤 들어온 바이트에서만 읽는다"이다 |
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

이 방어의 핵심은 두 가지다. 첫째, 한 요청을 위해 판정한 upstream 소켓에는 그 요청의 바이트만 간다. 둘째, 바이트를 요청과 요청으로 가르는 경계를 proxy와 upstream이 다르게 읽을 틈이 없다. 연결을 닫는 것은 둘째 조건을 지키는 한 방법일 뿐이다.

## 3. 후보 비교

### (a) 요청을 하나씩 순서대로 받는다 — 고름

교환이 끝나면 client 연결의 상태를 처음 머리를 기다리던 때로 되돌린다. 다음 요청은 새 연결에 온 요청과 똑같이 다룬다. 머리를 엄격하게 읽고, policy를 판정하고(이름 조회 포함), upstream에 새로 연결하고, framer를 새로 만든다.

- 경계를 다르게 읽을 틈: 다음 머리는 앞 교환이 끝난 **뒤에** 들어온 바이트에서만 읽는다. 앞 교환이 끝나기 전에 들어온 body 밖의 바이트는 지금처럼 버리고, 그 연결은 이어 쓰지 않는다. 그래서 proxy가 "어디까지가 앞 요청인가"를 추측하는 일이 생기지 않는다. 앞 요청의 framer가 끝났다고 판정한 지점과 다음 머리의 시작 사이에는 앞 교환이 끝났다는 사건이 있다. 응답을 client 소켓에 다 쓴 때다.
- 시점: JS는 한 스레드로 돈다. 응답의 마지막 바이트를 소켓에 쓰고 상태를 되돌리는 일이 같은 콜백 안에서 일어나므로, 그 사이에 client 바이트가 끼어들 수 없다. 응답이 client 쪽 queue에 남아 있으면 아직 client가 응답을 다 받지 못한 것이다. 그때 오는 바이트는 pipelining이므로 버리고 연결을 닫는다.
- upstream 쪽은 바뀌지 않는다. 요청마다 새 연결이고, 응답이 끝나면 proxy가 닫는다. 그 upstream 소켓이 나중에 보내는 close·error·data는 이미 다음 교환으로 넘어간 client에 닿지 않게 끊는다.
- 비용: `proxy.ts`의 교환 상태를 되돌리는 함수 하나, response rewriter의 선택 인자 하나, 요청 머리에서 keep-alive를 읽는 칸 하나. pipelining을 받지 않으므로 앞 요청이 도는 동안 다음 요청을 쌓아 둘 queue가 필요 없다.

### (b) client가 그 연결을 다시 쓰지 못하게 한다 — 고르지 않음

- `connection: close`는 이미 보낸다. Bun은 그것을 지키지 않는다.
- 응답을 close-delimited로 바꾼다(Content-Length·chunked를 떼고 EOF로 끝내기). 그러면 client는 EOF 전에는 응답이 끝났다고 보지 못하므로 다시 쓰지 못한다. 그러나 잘린 응답과 다 받은 응답을 client가 가르지 못하게 된다. 데이터 손실을 숨기는 길이라 거부한다. body가 없는 응답(HEAD, 204, 304)에는 효과도 없다.
- FIN 대신 RST를 보내거나, 응답 직전에 반쯤 닫는 방법도 있다. 이것들은 client가 pool에서 소켓을 꺼내는 시점을 바꾸지 못한다. 경쟁 조건은 그대로 남는다.

### (c) 그 밖의 방법 — 고르지 않음

- "close라고 말하고 다음 요청이 오면 받는다": RFC 9112 §9.6이 금지한다(`close`를 보낸 서버는 그 뒤의 요청을 처리하면 안 된다). 규칙을 지키는 client와 경계를 다르게 읽게 된다.
- pipelining까지 받는다(앞 응답이 끝날 때까지 다음 요청을 쌓아 둔다): 요청마다 따로 판정하므로 smuggling은 막을 수 있다. 그러나 쌓아 둘 queue의 상한, 순서 보장, 앞 교환이 실패했을 때 쌓인 요청을 처리하는 규칙이 새로 필요하다. 실제로 그렇게 보내는 client가 없다. YAGNI로 미룬다.
- 문서화만 한다: 오너가 수정을 골랐다(아래 4절).

## 4. 오너 판단

티켓은 "고치는 방향을 정하기 전에 오너 판단을 받는다"를 인수 조건으로 둔다. 오너는 2026-11-14에 "고치는 게 맞지 않나?"라고 답했다. 문서화가 아니라 수정을 원한다는 뜻으로 읽고, 이 조건은 채워졌다고 본다.

## 5. 이어 쓰는 규칙

### 5.1 요청 머리

`parseRequestHead`가 forward 요청에 `keepAlive`를 더한다. 버전이 `HTTP/1.1`이고, `connection` 칸들의 토큰에 `keep-alive`가 있고, `connection`과 `proxy-connection` 어느 쪽에도 `close`가 없을 때만 참이다.

- HTTP/1.1의 기본은 이어 쓰기다. 그래도 명시한 client에만 이어 쓴다. 그러면 curl·git처럼 `connection: close`를 잘 지키는 client는 지금과 똑같이 동작하고, 바뀌는 범위가 이 문제를 겪는 client로 좁아진다. proxy는 언제든 연결을 닫기로 할 수 있으므로 규칙에 어긋나지 않는다.
- upstream에 보내는 머리는 지금처럼 `connection: close`이고, hop-by-hop 칸은 빠진다(`request.ts:130-145`).

### 5.2 응답 머리

response rewriter가 최종 머리를 만들 때 proxy에 묻는다(`keepOpen`). 아래가 모두 맞으면 `connection: close`를 넣지 않는다.

1. 요청이 `keepAlive`다.
2. 응답 framing이 길이·chunked다. close-delimited body는 upstream이 닫아야 끝나므로 client도 닫아야 한다.
3. 그 시점에 요청 body가 끝났다(framer `complete`). upload 도중에 upstream이 먼저 답하면(401 등) 남은 body를 받아 줄 곳이 없으므로 닫는다.
4. 그 시점까지 body 밖의 바이트가 오지 않았다.

조건이 하나라도 어긋나면 지금처럼 `connection: close`를 넣는다. 그 연결은 응답 뒤에 반드시 닫는다. interim 1xx 머리는 지금처럼 hop-by-hop 칸만 뺀다.

### 5.3 교환의 끝

응답이 끝나면(`answer.complete`) upstream을 닫고, 그 upstream의 handler를 client에서 떼어 낸다. 그다음 아래를 본다.

- 머리에서 close를 말했거나, 그 뒤 body 밖의 바이트가 왔거나, client가 이미 닫았으면: 지금처럼 queue를 비운 뒤 닫는다.
- 아니면: client queue가 비어 있으면 바로, 남아 있으면 client의 `drain`에서 queue가 빈 순간 상태를 되돌린다. 되돌리기 직전에 body 밖의 바이트가 왔는지 한 번 더 본다. 그사이에 온 바이트는 응답을 다 받기 전에 보낸 것이므로 pipelining이다.
- 되돌리는 상태: `phase = "head"`, 머리 buffer, body framer, `discarding`, `early`, upstream, 두 queue, stall timer. 읽기를 멈춘 client는 다시 읽는다. connection cap의 자리는 연결이 닫힐 때까지 그대로 쥔다(`counted`는 바꾸지 않는다).
- 쉬는 연결에는 머리 기한을 다시 건다. 기한이 될 때까지 한 바이트도 오지 않으면 408 없이 닫는다. 이어 쓰는 client는 그때 보낸 요청이 408을 자기 답으로 읽을 수 있기 때문이다. 머리를 보내다 만 경우는 지금처럼 408이다.

### 5.4 바뀌지 않는 것

- upstream 연결 하나에 forward 요청 하나. 요청마다 policy 판정과 이름 조회를 새로 한다. 앞 요청이 허용됐다고 다음 요청이 허용되지 않는다.
- proxy가 직접 만든 응답(`reply`)과 framing 실패(`refuseAnswer`), upstream 오류(`onError`)는 모두 연결을 닫는다. upstream이 body 도중에 닫혀 잘린 응답도 닫는다(`onClose` → `endClient`).
- CONNECT 터널: 한 번 터널이 되면 끝까지 터널이다. 다만 forward 교환 뒤에 이어 쓰는 연결에서 CONNECT가 올 수 있다. 새 연결의 CONNECT와 똑같이 다룬다.

## 6. 시험

기존 proxy 시험은 하나도 지우거나 느슨하게 하지 않는다. 아래는 새로 넣는다. 모두 `apps/egress-proxy/src/proxy.test.ts`에서 실제 소켓으로 확인한다.

| 사례 | 보내는 것 | 기대 |
|---|---|---|
| 이어 쓰기(기본) | keep-alive 요청 두 개를 한 연결에서 차례로. 두 번째는 다른 origin | 각자 자기 upstream의 답을 받고, 첫 응답 머리에 `connection: close`가 없다 |
| 요청마다 판정 | 허용된 요청 뒤 같은 연결에서 허용되지 않은 host | 두 번째는 403이고 연결이 닫힌다 |
| CL/TE 충돌 | 이어 쓰는 연결의 두 번째 요청이 `content-length`와 `transfer-encoding: chunked`를 함께 보냄 | 400, 연결이 닫히고, 어느 upstream에도 가지 않는다 |
| 중복 Content-Length | 두 번째 요청이 서로 다른 `content-length` 둘 | 400, 연결이 닫히고, 어느 upstream에도 가지 않는다 |
| 남는 body 바이트 | keep-alive 요청 + body + body 밖의 요청을 한 번에 씀 | 첫 응답 머리가 `connection: close`, 연결이 닫히고, body 밖의 요청은 아무 upstream에도 닿지 않는다 |
| pipelined 두 번째 요청 | 첫 요청 body를 다 보낸 뒤 응답이 오기 전에 두 번째 요청을 보냄(upstream이 답을 늦춤) | 첫 응답 뒤 연결이 닫히고, 두 번째 요청은 아무 upstream에도 닿지 않는다 |
| upstream 오류 뒤 재사용 | 응답 머리가 잘린 upstream(502), body가 Content-Length보다 짧게 끊긴 upstream | 둘 다 연결이 닫히고, 그 연결에 보낸 다음 요청은 처리되지 않는다 |
| close-delimited 응답 | 길이 없이 닫혀서 끝나는 응답 | 머리가 `connection: close`, 연결이 닫힌다 |
| keep-alive를 말하지 않은 client | `connection` 칸 없는 HTTP/1.1 요청, `connection: close` 요청 | 지금처럼 `connection: close` 뒤에 닫힌다(기존 시험 유지) |
| queue가 밀린 응답 | 큰 응답을 받은 뒤 같은 연결로 두 번째 요청 | 두 응답 모두 끝까지 온다(drain 뒤에 상태를 되돌리는 경로) |
| 쉬는 연결 | 짧은 머리 기한의 proxy에서 한 교환 뒤 아무것도 보내지 않음 | 408 없이 닫힌다 |
| Bun client | `testing/pooled-client.ts`로 non-2xx 뒤 fetch POST를 잇달아 | 모든 요청이 자기 답을 받는다 |

재현 확인은 1절과 같은 조건(worker 이미지, `keepalive` 지정 없음, 300번)으로 돌리고 실패 0을 PR에 적는다.

## 7. 남는 위험

- 쉬는 연결을 proxy가 닫는 순간 client가 그 연결로 요청을 보내면 같은 오류가 날 수 있다. 이것은 keep-alive를 쓰는 모든 서버의 경쟁 조건이고, 15초 동안 FIN을 처리하지 못한 client에서만 생긴다. 지금 실패는 응답 직후의 FIN이 원인이다.
- upload 도중에 upstream이 먼저 답한 경우와 proxy가 직접 만든 응답 뒤에는 지금처럼 닫는다. 그 뒤의 Bun 요청은 같은 이유로 실패할 수 있다. 앞의 요청이 이미 오류를 받은 경우라서 이번 범위에서 뺀다.
- e2e의 `keepalive: false`(PR #1681)는 이 변경 뒤에도 남긴다. 지울지는 이 변경이 main에서 돈 결과를 본 뒤 정한다.

## 8. Codex 리뷰

설계 리뷰 결과는 PR 본문에 적는다.
