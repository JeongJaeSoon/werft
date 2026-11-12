# 결정(설계): 범용 OIDC 로그인 공급자를 웹 관리 화면에서 설정한다

- 상태: 제안. Codex 설계 리뷰 승인 전이다. 승인 전에는 구현하지 않는다. 리뷰 기록은 [17절](#17-리뷰-기록), 진행 상태는 [16절](#16-진행-상태)에 남긴다.
- 티켓: 94S-1556.
- 기준 커밋: `origin/main` `325459761`. 아래 `파일` 인용은 이 커밋 기준이다.
- 오너 원문(2026-11-13):
  - "지금 직접 user id/pw 등을 관리하고 로그인 로직을 대응하고 있는데 이걸 - Google SSO (Single Sign-On) - onelogin oidc 인증을 사용하도록 하고 싶어 … 다른 회사에서도 onelogin 이나 혹은 다른 oidc 서비스를 잘 연동할수 있도록 모듈화하고 그리고 셀프호스팅 문서에도 정리해두고 싶어 (문서화는 나중에 opus 로 해도 될거같기도)"
  - "Google OIDC 나 onelogoin 모두 그냥 웹 설정으로 통일하는거 어때?"
  - "6가지 모두 괜찮아보여"
  - "어짜피 쓰는 사람없을거라서 GOOGLE_OIDC_ 호환성생각안해도될걸"
- 관련: [Musterrolle 모듈 경계](musterrolle-boundary.md), [패키지 구조화](package-structure.md), [파일 카탈로그를 설정으로](settings-replace-file-catalog.md).

## 요약

| 항목 | 결론 |
|---|---|
| 문제 | 로그인 수단이 비밀번호와 Google 전용 OIDC 둘뿐이다. Google 설정은 환경 변수 `GOOGLE_OIDC_*`다. 회사 IdP(OneLogin, Okta, Entra ID, Keycloak)로 로그인할 수 없다 |
| 공급자 | **데이터 한 행**이다. owner가 웹 관리 화면에서 issuer, client ID, client secret을 넣는다. 공급자를 더해도 코드를 고치지 않는다 |
| 코드 | OIDC 검증은 한 모듈(`apps/control-host/src/api/oidc/`)에 둔다. Google만의 차이(`hd`, 스킴 없는 `iss`)는 그 모듈 안의 issuer별 규칙 한 곳이다 |
| 식별 | 사용자는 `(issuer, subject)`로만 식별한다. 이메일로 기존 계정에 자동 연결하지 않는다 |
| 켜기 | 공급자는 꺼진 채로 만들어진다. owner의 테스트 로그인이 지금 설정으로 통과해야 켤 수 있다 |
| 끄기 | 공급자를 끄면 같은 트랜잭션에서 그 공급자로 만든 세션을 모두 끊는다. 세션에 로그인 수단을 적는 칸을 새로 둔다 |
| 복구 | 비밀번호 로그인을 꺼도 비상 관리자 1명은 비밀번호로 들어온다. 운영자 CLI가 공급자를 끄고, 비밀번호 로그인을 다시 켜고, 비상 관리자 비밀번호 재설정 링크를 낸다 |
| 환경 변수 | SSO 설정용 환경 변수는 없다. `GOOGLE_OIDC_*`와 읽기 코드를 지운다. 호환과 자동 이전은 없다 |
| 순서 | PR 여섯 개: OIDC 코어 → 저장·공개 경로·환경 변수 제거 → 관리자 화면 → 가입·계정 연결 → 비밀번호 끄기·복구 → 공급자별 계약 시험·Keycloak e2e |

## 1. 지금 (실측)

| 무엇 | 어디 | 사실 |
|---|---|---|
| Google 로그인 | `apps/control-host/src/api/google-login.ts` (357줄) | discovery, PKCE S256, state, nonce, `aud`·`azp`·`iss`·`exp` 검증이 이미 있다. Google 전용인 곳은 셋이다: 환경 변수 읽기(`googleLoginConfigFromEnv`), `iss` 별칭(`accounts.google.com`), `hd` 규칙(`domainAdmission`) |
| discovery·JWKS | 같은 파일 `createGoogleLogin` | discovery는 프로세스 수명 동안 한 번 캐시한다. JWKS는 로그인마다 새로 받는다. 서명 알고리즘은 `RS256`만 받는다. `iat`는 보지 않는다 |
| 흐름 cookie | `packages/contracts/src/musterrolle/auth.ts` `GOOGLE_LOGIN_COOKIE_NAME` | `__Host-` cookie에 `state.nonce.verifier.시작시각`을 평문으로 둔다. 10분 뒤 만료 |
| 공개 경로 | `apps/control-host/src/api/routes/auth.ts` | `GET /v1/auth/login-methods`(`["password"]` 또는 `["password","google"]`), `POST /v1/auth/google/start`, `POST /v1/auth/google/callback`. Google이 설정되지 않으면 뒤 둘은 `404` |
| redirect | `apps/web/src/routes/google-callback.tsx` | IdP가 브라우저를 웹 화면 `/auth/google/callback`으로 돌려보낸다. 화면이 `code`·`state`를 API에 POST한다. redirect URI는 환경 변수 `GOOGLE_OIDC_REDIRECT_URI`다 |
| 첫 로그인 규칙 | `packages/db/src/musterrolle/identity.ts` `signInWithExternalIdentity` | 연결된 `(kind, issuer, subject)`는 그 사용자로 로그인한다. 연결이 없고 그 주소의 계정이 이미 있으면 연결하지 않는다(`409 LOGIN_LINK_REQUIRED` 또는 `401`). 계정이 없으면 살아 있는 초대 또는 JIT만 계정을 만든다 |
| 연결 경로 | 없음 | `login_methods`에 행을 넣는 곳은 bootstrap, 초대 수락(비밀번호), 외부 로그인의 첫 가입 셋뿐이다. `409 LOGIN_LINK_REQUIRED`는 "설정에서 연결하라"고 안내하지만 그 화면과 경로는 없다 |
| `login_methods` | `packages/db/migrations/0138_login_methods.sql` | `kind`는 `password`·`google`만 허용한다. 유일 인덱스는 `(kind, issuer, subject)`다 |
| `users.password_hash` | 같은 마이그레이션 | NULL을 허용한다. 외부 로그인으로 만든 계정은 비밀번호가 없다 |
| 세션 | `web_sessions`, `resolveWebSession` | 어떤 로그인 수단으로 만든 세션인지 기록하지 않는다. 수명은 14일이고 쓰는 동안 계속 늘어난다(`WEB_SESSION_TTL_MS`) |
| 비밀 저장 | `packages/platform/src/ports/secret-store.ts`, `packages/db/src/secrets/secret-values.ts` | `secret_values`에 AES-256-GCM으로 봉인한다. 슬롯은 `(workspace, owner, purpose)`다. 설치 전체 설정(모델 연결 등)의 값은 기본 workspace 아래 `<kind>:<id>` owner로 둔다. `PLATFORM_SECRET_KEY`는 API 시작에 필수다(`loadSecretKey`) |
| 권한 | `packages/platform/src/musterrolle/policy.ts` `MANAGEMENT_ROLES` | `installation.settings.manage`는 owner만 가진다 |
| 공개 주소 | `apps/control-host/src/api/slack-config.ts` `consoleOriginFrom` | `CONSOLE_ORIGIN`이 공개 주소의 유일한 소스다. Slack·GitHub 계정 연결의 redirect를 여기서 계산한다. 없으면 그 연결을 시작할 수 없다 |
| 가짜 IdP | `packages/testkit/src/mock-oidc.ts` | id_token 클레임을 `login_hint`로 주입한다. 틀린 `aud`, 지난 `exp`, 미검증 이메일을 시험에서 만들 수 있다. 키는 하나이고 회전하지 않는다 |
| 운영자 CLI | `apps/control-host/src/api/keys.ts`, `slack-app.ts` | 파일 하나가 명령 하나다. API 컨테이너 안에서 `DATABASE_URL`과 `PLATFORM_SECRET_KEY`로 실행하고, 종료 코드가 계약이다 |

## 2. 받은 결정

오너가 승인한 여섯 가지와 그 뒤의 한 가지다. 이 문서는 이것들을 바꾸지 않는다.

1. 설정은 owner 전용 웹 관리 화면으로 통일한다. 복구 경로는 비상 관리자 비밀번호 로그인과 운영자 CLI다.
2. 비밀번호 로그인은 켜고 끌 수 있다. 비상 관리자 1명은 항상 남긴다.
3. 사용자는 `(issuer, subject)`로만 식별한다. 이메일로 기존 계정에 자동 연결하지 않는다. 연결은 로그인된 상태에서 하거나 초대로 한다.
4. 공급자를 끄면 그 공급자로 발급된 세션은 바로 끊는다.
5. IdP 그룹→역할 매핑, SCIM, SAML, RP-initiated logout, 이메일 도메인 기반 공급자 자동 선택은 범위 밖이다.
6. 셀프호스팅 문서는 마지막에 따로 쓴다.
7. `GOOGLE_OIDC_*`는 호환과 자동 이전 없이 지운다. SSO 설정용 환경 변수는 두지 않는다.

## 3. 모듈 구조

### 3.1 어디에 두나

OIDC 검증 코드는 `apps/control-host/src/api/oidc/`에 둔다.

| 파일 | 책임 | 바깥 호출 |
|---|---|---|
| `discovery.ts` | discovery 문서를 받아 검증하고 캐시한다 | HTTP GET |
| `jwks.ts` | JWKS를 받는다 | HTTP GET |
| `id-token.ts` | 서명과 클레임을 검증한다. 키와 시각을 인자로 받는 순수 함수다 | 없음 |
| `flow.ts` | 시작(authorization URL, state, nonce, PKCE)과 끝(code 교환), 흐름 cookie의 부호화 | HTTP POST |
| `issuer-rules.ts` | issuer별 차이: `iss` 별칭, 추가 요청 인자, 이메일 소유 판정 | 없음 |
| `admission.ts` | 허용 도메인, 이메일 신뢰, JIT를 판정한다 | 없음 |
| `errors.ts` | `OidcUnavailableError`(다시 시도할 만함), `OidcRejectedError`(거절, 이유 코드) | 없음 |
| `index.ts` | 공개면 | 없음 |

규칙: 이 디렉터리는 `@werft-ai/db`, 라우트, Hono `Context`를 import하지 않는다. 입력은 공급자 설정 값과 `fetch`·시각 함수이고, 출력은 검증된 신원(`issuer`, `subject`, `email`, 이메일 신뢰 여부, `name`)이다. `tests/architecture.test.ts`에 이 규칙을 넣는다.

저장은 기존 경계를 따른다. port는 `packages/platform/src/ports/login-provider-store.ts`, 구현은 `packages/db/src/musterrolle/login-providers.ts`, 계약은 `packages/contracts/src/musterrolle/login-providers.ts`다.

### 3.2 새 워크스페이스 패키지로 만들지 않는 이유

`packages/adapters/<kind>/<provider>`는 공급자마다 코드가 다를 때의 모양이다(Slack, GitHub, 실행 backend). OIDC 공급자는 코드가 아니라 설정 행이고, 코드 경로는 하나다. 소비자도 control-host 하나다. 같은 종류인 `google-login.ts`, `slack-link.ts`, `github-link.ts`가 이미 `apps/control-host/src/api/`에 있고 [Musterrolle 경계](musterrolle-boundary.md)가 이곳을 HTTP 경계로 적었다. 패키지를 새로 만들면 architecture 테스트 기준선, 이미지 빌드의 복사 목록, typecheck 참조가 늘지만 얻는 것은 import 규칙 하나다. 그 규칙은 3.1절의 architecture 테스트로 같은 값에 얻는다. SAML을 더할 때 옆에 `saml/`을 두고, 그때 소비자가 둘 이상이면 패키지로 올린다.

`slack-link.ts`(Sign in with Slack)도 OIDC를 쓴다. 이번에는 합치지 않는다. 그 흐름은 로그인이 아니라 계정 연결이고, Slack 앱 저장과 묶여 있다.

## 4. 로그인 흐름과 검증 항목

### 4.1 흐름

1. 브라우저가 `POST /v1/auth/providers/{provider_id}/start`를 부른다(CSRF 헤더 필수, 지금과 같다).
2. 서버가 공급자 행을 DB에서 읽는다. 꺼져 있으면 `404`다. discovery를 얻고, state·nonce·PKCE verifier를 만들어 흐름 cookie에 넣고, authorization URL을 돌려준다.
3. IdP가 브라우저를 `<CONSOLE_ORIGIN>/auth/callback/<provider_id>`(웹 화면)로 돌려보낸다.
4. 화면이 `POST /v1/auth/oidc/callback`에 `{provider_id, code, state, iss?}`를 보낸다. `iss`는 IdP가 응답에 붙였을 때만 있다.
5. 서버가 4.3절 순서로 검증하고 6절 규칙으로 세션을 만든다.

API가 콜백을 직접 받지 않는 이유는 지금과 같다. 콜백 GET이 API에 오면 CSRF 헤더 없이 cookie만으로 쓰기가 일어난다.

### 4.2 흐름 cookie

- 이름은 `__Host-werft_login_flow`로 바꾼다. `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 10분.
- 내용: `state`, `nonce`, PKCE `verifier`, 시작 시각, `provider_id`, 목적(`login`·`link`·`test`).
- 서명하지 않는다. cookie의 값은 그 브라우저 자신의 흐름 비밀이고, `__Host-` 접두가 다른 호스트의 주입을 막는다. 서버는 cookie의 `provider_id`와 목적을 **권한 근거로 쓰지 않는다**. 목적마다 서버가 따로 확인한다: `login`은 공급자가 켜져 있어야 하고, `link`는 지금 세션의 사용자에게만 연결하며, `test`는 owner 세션이어야 한다. 그래서 자기 cookie를 고쳐도 얻는 것이 없다.
- 콜백은 본문의 `provider_id`가 cookie의 `provider_id`와 같은지 본다. 다르면 거절한다(4.4절 mix-up).
- 탭 두 개에서 동시에 시작하면 뒤의 것이 앞의 cookie를 덮는다. 지금과 같다.

### 4.3 검증 순서

| 단계 | 검사 | 실패 |
|---|---|---|
| 1 | cookie가 있고, 본문 `state`가 cookie `state`와 같다(상수 시간 비교). 시작 뒤 10분 안이다. `provider_id`가 같다 | `401` |
| 2 | 공급자 행이 있고 목적에 맞는 상태다 | `404` 또는 `401` |
| 3 | discovery `issuer`가 설정한 issuer와 글자 그대로 같다. `authorization_endpoint`·`token_endpoint`·`jwks_uri`가 있다 | `503` |
| 4 | 응답에 `iss`가 있으면 issuer와 같다. discovery가 `authorization_response_iss_parameter_supported: true`이면 `iss`가 반드시 있어야 한다(RFC 9207) | `401` |
| 5 | token endpoint에 `code`, `redirect_uri`, `code_verifier`와 client 인증을 보낸다. `2xx`가 아니면 거절이다. PKCE verifier가 틀리면 IdP가 여기서 거절한다 | `401`, IdP `5xx`·시간 초과는 `503` |
| 6 | id_token 헤더 `alg`가 허용 목록(`RS256`, `ES256`)에 있다. `none`과 `HS*`는 받지 않는다. `kid`에 맞는 키로 서명이 맞다 | `401` |
| 7 | `iss`가 issuer와 같다. Google issuer만 스킴 없는 `accounts.google.com`도 받는다 | `401` |
| 8 | `aud`에 client ID가 있다. `aud`가 여러 값이면 `azp`가 있어야 한다. `azp`가 있으면 client ID와 같다 | `401` |
| 9 | `exp`가 숫자이고 지금보다 뒤다. `iat`가 숫자이고, 지금보다 60초 넘게 앞서지 않으며, 11분보다 오래되지 않았다. `nbf`가 있으면 지났다. 시계 오차는 60초까지 받는다 | `401` |
| 10 | `nonce`가 cookie `nonce`와 같다(상수 시간 비교) | `401` |
| 11 | `sub`가 비어 있지 않은 문자열이고 255자 이하다 | `401` |
| 12 | `email`이 있다. 이메일 신뢰 규칙(6.2절)을 통과한다 | `401` |
| 13 | 허용 도메인 규칙(6.3절)을 통과한다 | `403` |

`iat` 상한 11분은 흐름 cookie 수명 10분에 시계 오차를 더한 값이다. id_token은 code 교환 때 발급되므로 정상 흐름에서는 몇 초 전이다.

`401`의 응답 문구는 이유를 구분하지 않는다("Sign-in was not accepted"). 이유는 서버 로그에 이유 코드로만 남긴다. code, token, cookie, client secret은 로그에 남기지 않는다.

### 4.4 그 밖의 정한 것

| 주제 | 결정 | 이유 |
|---|---|---|
| discovery 캐시 | issuer별로 메모리에 1시간. 실패는 캐시하지 않는다. 테스트 로그인과 관리자 화면의 "discovery 확인"은 캐시를 쓰지 않고 새로 받아 캐시를 갈아 끼운다 | endpoint는 거의 바뀌지 않는다. IdP 설정을 고친 owner는 테스트 로그인으로 바로 반영한다 |
| JWKS 회전 | JWKS는 캐시하지 않는다. 로그인마다 받는다(지금과 같다) | IdP가 키를 돌리거나 지우면 다음 로그인부터 바로 따른다. 지운 키를 캐시 수명만큼 더 믿는 틈이 없다. 로그인은 드문 요청이고 JWKS 요청은 code 교환이 성공한 뒤에만 나가므로, 유효한 code 없이 이 요청을 유발할 수 없다 |
| redirect URI | 공급자마다 다르다: `<CONSOLE_ORIGIN>/auth/callback/<provider_id>` | 여러 IdP를 쓰는 client는 IdP마다 다른 redirect URI를 쓰라는 권고(RFC 9700)를 따른다. 한 IdP가 다른 IdP의 응답인 척하는 mix-up을 주소로 가른다 |
| `CONSOLE_ORIGIN` | redirect URI의 유일한 소스다. 없으면 공급자를 만들 수 없고 화면이 이유를 보여 준다 | Slack·GitHub 계정 연결과 같은 규칙이다. 요청의 `Host` 헤더로 redirect URI를 만들지 않는다. SSO 전용 설정이 아니므로 결정 7과 어긋나지 않는다 |
| client 인증 | 공급자 행의 `token_auth_method`: `client_secret_basic` 또는 `client_secret_post`. 만들 때 기본값은 discovery의 `token_endpoint_auth_methods_supported`에 `client_secret_basic`이 있거나 목록이 없으면 `basic`, 아니면 `post` | OIDC 기본은 `basic`이다. OneLogin은 앱 설정에서 하나만 고른다 |
| scope | `openid email profile` 고정 | 지금과 같다. 그룹 매핑이 `groups`를 더할 때 칸을 만든다 |
| client secret 없는 client | 지원하지 않는다 | 서버가 secret을 지킬 수 있다 |
| 바깥 요청 | 10초 시간 제한(지금 `providerFetch`). redirect를 따라가지 않는다. 응답 본문은 1 MiB까지만 읽는다 | owner가 넣은 주소로 서버가 요청한다. 응답 원문을 화면에 돌려주지 않고 해석한 필드와 오류 종류만 준다 |
| issuer 주소 | `https`만 받는다. `CONSOLE_ORIGIN`이 `http`인 설치(로컬·시험)에서만 `http` issuer를 받는다 | 운영 설치는 평문 IdP를 쓸 수 없다. 로컬 스택과 e2e는 새 환경 변수 없이 mock IdP와 Keycloak을 붙인다 |
| 동시 처리 | 콜백의 IdP 호출에 동시 실행 상한을 둔다(비밀번호 hash의 `WorkGate`와 같은 방식). 넘으면 `429` | 인증 없는 호출이 IdP로 나가는 요청을 무한히 만들지 못한다 |
| 다중 replica | 캐시는 replica마다 따로다. 공급자 행은 캐시하지 않고 요청마다 DB에서 읽는다 | 끄기와 설정 변경이 모든 replica에 바로 보인다 |

## 5. 데이터

### 5.1 `login_providers` (새 테이블)

| 칸 | 타입 | 뜻 |
|---|---|---|
| `id` | uuid, PK | redirect URI에 들어간다 |
| `display_name` | text, 1~64자 | 로그인 버튼 글자 |
| `issuer` | text, UNIQUE | discovery의 `issuer`와 글자 그대로 같아야 한다. 만든 뒤에는 바꿀 수 없다 |
| `client_id` | text, NULL 허용 | redirect URI를 IdP에 등록한 뒤에 넣는다 |
| `token_auth_method` | text | `client_secret_basic` 또는 `client_secret_post` |
| `allowed_domains` | text[], 기본 빈 배열 | 소문자. 비어 있으면 도메인을 제한하지 않는다 |
| `jit_role` | text, NULL 허용 | NULL 또는 `member` |
| `email_trust` | text | `verified_claim`(기본) 또는 `provider` (6.2절) |
| `enabled` | boolean, 기본 false | |
| `tested_at`, `tested_fingerprint` | timestamptz, text, NULL 허용 | 마지막으로 통과한 테스트 로그인과 그때의 설정 지문 (7.3절) |
| `revision` | integer | 수정 충돌 검사(`If-Match`). 다른 설정 화면과 같은 방식이다 |
| `created_at`, `updated_at`, `created_by` | | |

- 설치 전체에 하나다. workspace 칸을 두지 않는다. 사용자(`users`)와 `login_methods`가 설치 전체이기 때문이다.
- issuer가 같은 공급자는 하나만 둔다. `(issuer, subject)`가 사용자를 가리키므로, 같은 issuer의 두 공급자는 같은 사람을 두 번 가리킨다.
- client secret은 이 테이블에 없다. `secret_values`에 owner `login_provider:<id>`, purpose `login_client_secret`으로 둔다. 모델 연결 key와 같은 방식이고 기본 workspace 아래에 둔다. `SecretOwner`와 `SECRET_PURPOSE_VALUES`에 이 둘을 더한다. API는 값을 돌려주지 않고 `configured`, 끝 4자, 바꾼 시각만 준다.

### 5.2 `login_methods` 일반화

- `kind` 검사를 `('password', 'oidc')`로 바꾼다. 있던 `google` 행은 `oidc`로 바꾼다. `issuer`·`subject`는 그대로다.
- 유일 인덱스 `(kind, issuer, subject)`는 그대로 둔다. 외부 행의 `kind`가 모두 `oidc`이므로 `(issuer, subject)` 유일과 같다. SAML을 더하면 `kind = 'saml'`이 같은 인덱스로 갈린다.
- 새 유일 인덱스 `(user_id, issuer)`(`kind <> 'password'`)를 둔다. 한 사용자가 같은 issuer의 두 subject를 갖지 않는다. 지금은 외부 행을 첫 가입에서만 만들므로 기존 데이터가 이 인덱스를 어기지 않는다. 마이그레이션은 인덱스를 만들기 전에 어긴 행이 있는지 세고, 있으면 멈춘다.
- `login_methods`는 공급자 행을 참조하지 않는다. issuer 글자로 잇는다. 공급자를 지웠다가 같은 issuer로 다시 만들면 있던 연결이 그대로 산다.

### 5.3 `web_sessions.login_method_id` (새 칸)

- uuid, NULL 허용. 세션을 만든 로그인 수단을 적는다. 비밀번호 로그인은 그 사용자의 `password` 행, OIDC 로그인은 그 `oidc` 행이다.
- `web_sessions`는 커지는 테이블 목록(`packages/db/src/migration-safety.ts`)에 있다. 칸은 기본값 없이 더하고, 외래 키는 인라인으로 달지 않는다. 살아 있는 세션을 수단으로 찾는 부분 인덱스(`revoked_at IS NULL`)는 트랜잭션 밖에서 `CONCURRENTLY`로 만든다.
- 업그레이드 전에 만든 세션은 NULL이다. NULL은 비밀번호 세션으로 다룬다. 11.2절이 이 가정을 맞게 만든다.

### 5.4 `login_settings` (새 테이블, 한 행)

| 칸 | 뜻 |
|---|---|
| `password_login` | `on`(기본) 또는 `emergency_only` |
| `emergency_admin_user_id` | 비상 관리자. NULL이면 지정하지 않았다 |

한 행만 있게 한다(값이 고정된 PK와 검사). 5단계에서 더한다. 로그인 트랜잭션이 이 행을 잠가 읽으므로 설정 문서 저장소와 섞지 않는다.

## 6. 첫 로그인, 가입, 연결 규칙

### 6.1 판정 순서

`signInWithExternalIdentity`의 순서를 그대로 둔다. 먼저 맞는 규칙이 이긴다.

| 순서 | 조건 | 결과 |
|---|---|---|
| 0 | 공급자가 꺼져 있다 | 거절. 트랜잭션 안에서 공급자 행을 잠가 다시 읽는다(8절) |
| 1 | `(issuer, subject)`가 연결돼 있다 | 그 사용자로 로그인. 계정이나 멤버십이 꺼져 있으면 거절. 이메일은 보지 않는다 |
| 2 | 연결이 없고 그 이메일의 계정이 있다 | 연결하지 않는다. 이메일을 신뢰할 수 있으면 `409 LOGIN_LINK_REQUIRED`, 아니면 `401` |
| 3 | 계정이 없고, 그 이메일의 살아 있는 초대가 있고, 이메일을 신뢰할 수 있다 | 초대의 역할로 계정을 만들고 연결한다 |
| 4 | 계정이 없고 공급자의 JIT가 켜져 있고 6.3절을 통과한다 | `member`로 계정을 만들고 연결한다 |
| 5 | 그 밖 | `401` |

- 규칙 2가 결정 3이다. 다른 issuer에서 같은 이메일로 들어와도 기존 계정에 붙지 않는다. "같은 이메일·다른 issuer의 기존 계정 연결 시도"는 세션 없이 `409`로 끝난다.
- 규칙 3이 "초대로 연결"이다. 초대 화면은 비밀번호 칸 옆에 공급자 버튼을 보여 준다. 버튼은 보통의 로그인 흐름을 시작하고, 돌아오면 규칙 3이 초대를 받아들인다. IdP의 이메일이 초대 주소와 다르면 규칙 5로 거절하고, 화면이 "초대받은 주소의 계정으로 로그인해야 한다"고 안내한다. 초대 token을 흐름에 싣지 않는다.
- 규칙 1은 이메일을 보지 않으므로, IdP에서 주소가 바뀐 사람도 계속 같은 사용자다. `users.email`은 따라 바꾸지 않는다.

### 6.2 이메일 신뢰

이메일은 사용자를 식별하지 않는다. 계정이 있는지 알려 줘도 되는지(규칙 2)와 초대를 받아들일지(규칙 3), 새 계정의 주소로 쓸지(규칙 3·4)만 정한다.

| issuer | `email_trust` | 로그인을 받는 조건(4.3절 12) | 주소를 지금 소유한다고 보는 조건(규칙 2·3) |
|---|---|---|---|
| Google (`https://accounts.google.com`) | `verified_claim`만 | `email_verified === true` | 주소가 `gmail.com`이거나 `hd`가 주소의 도메인과 같다(지금과 같다) |
| 그 밖 | `verified_claim` | `email_verified === true` | 로그인을 받았으면 소유한다고 본다 |
| 그 밖 | `provider` | `email`이 있다 | 로그인을 받았으면 소유한다고 본다 |

- `provider`는 "이 IdP가 주는 주소는 IdP 관리자가 관리한다"는 owner의 선언이다. `email_verified`를 주지 않는 IdP(OneLogin, Entra ID)에 필요하다. 화면이 뜻과 위험을 적는다.
- Google에는 `provider`를 받지 않는다. Google 계정은 한 번 검증한 남의 도메인 주소를 계속 가질 수 있다.
- 미검증 이메일(`verified_claim`인데 `email_verified`가 없거나 false)은 `401`이다.

### 6.3 허용 도메인과 JIT

- `allowed_domains`가 비어 있지 않으면 주소의 도메인이 목록에 있어야 한다. Google은 여기에 더해 `hd`가 주소의 도메인과 같아야 한다(지금과 같다). 밖이면 `403`이다.
- JIT(`jit_role = member`)는 Google에서는 `allowed_domains`가 있어야 켤 수 있다(지금과 같다). 그 밖의 IdP는 목록 없이도 켤 수 있고, 화면이 "이 IdP가 인증한 모든 사람이 member로 들어온다"고 경고한다.

### 6.4 로그인된 상태의 연결

- 화면: 설정 > 내 계정의 "로그인 수단". 연결된 수단과, 켜져 있는 공급자마다 "연결" 버튼을 보여 준다.
- 시작: `POST /v1/auth/me/login-methods/{provider_id}/link/start`. 세션이 **만든 지 10분 안**이어야 한다. 아니면 `403`이고 화면이 다시 로그인하라고 안내한다. 비밀번호가 없는 사용자와 비밀번호 로그인이 꺼진 설치에서도 같은 규칙이 통한다.
- 끝: 콜백이 목적 `link`를 보면 세션의 사용자에게 `(issuer, subject)`를 연결한다. 그 `(issuer, subject)`가 이미 누군가에게 연결돼 있으면 `409`다. 그 사용자에게 같은 issuer의 다른 subject가 있으면 `409`다. 새 세션을 만들지 않는다.
- 끊기: `DELETE /v1/auth/me/login-methods/{id}`. 쓸 수 있는 수단이 하나도 남지 않으면 거절한다. 쓸 수 있는 수단은 켜진 공급자의 `oidc` 행, 또는 비밀번호 로그인이 그 사용자에게 열려 있을 때의 `password` 행이다. 끊으면 그 수단으로 만든 세션을 같은 트랜잭션에서 지운다.
- 연결과 끊기는 감사 receipt를 남긴다.

## 7. 관리자 화면과 API

### 7.1 화면

- 위치: 설정 > 워크스페이스 > 로그인(`/settings/workspace/login`). owner만 본다(`installation.settings.manage`).
- 목록: 공급자 이름, issuer, 상태(초안·테스트 필요·켤 수 있음·켜짐), 마지막 테스트 시각.
- 만들기: 이름과 issuer를 넣는다. 서버가 그 자리에서 discovery를 확인한다. 통과하면 꺼진 공급자가 만들어지고 화면이 redirect URI를 복사 버튼과 함께 보여 준다. owner가 그 주소를 IdP에 등록하고 client ID와 secret을 받아 넣는다.
- 상세: redirect URI, client ID, client secret(쓰기 전용: 설정됨·끝 4자·바꾼 시각), client 인증 방식, 허용 도메인, JIT, 이메일 신뢰, 테스트 로그인, 켜기·끄기, 삭제.
- `CONSOLE_ORIGIN`이 없으면 만들기 대신 이유를 보여 준다.
- ko·en·ja. 1280·390 폭.

### 7.2 API

모두 `installation.settings.manage`이고, 쓰기는 감사 receipt를 남긴다.

| 경로 | 뜻 |
|---|---|
| `GET /v1/login-providers` | 목록. 공급자마다 `redirect_uri`와 secret 요약. `console_origin_configured` |
| `POST /v1/login-providers/discover` `{issuer}` | discovery를 지금 확인한다. 결과: 통과 또는 오류 종류(`insecure_issuer`, `unreachable`, `issuer_mismatch`, `invalid_document`, `unsupported_algorithm`) |
| `POST /v1/login-providers` `{display_name, issuer}` | discovery를 확인하고 꺼진 공급자를 만든다 |
| `PATCH /v1/login-providers/{id}` | 이름, client ID, client 인증 방식, 허용 도메인, JIT, 이메일 신뢰. `If-Match` |
| `PUT /v1/login-providers/{id}/client-secret` `{value}` | secret을 넣거나 바꾼다 |
| `POST /v1/login-providers/{id}/test/start` | 테스트 로그인을 시작한다 |
| `POST /v1/login-providers/{id}/enable` | 켠다 (7.3절) |
| `POST /v1/login-providers/{id}/disable` | 끄고 세션을 끊는다 (8절) |
| `DELETE /v1/login-providers/{id}` | 꺼진 공급자만 지운다. secret도 지운다. `login_methods` 행은 남는다 |

공개·사용자 경로:

| 경로 | 뜻 |
|---|---|
| `GET /v1/auth/login-methods` | `{password: "on" \| "emergency_only", providers: [{id, display_name}]}`. 켜진 공급자만 |
| `POST /v1/auth/providers/{id}/start` | 로그인 시작 |
| `POST /v1/auth/oidc/callback` | 목적에 따라 `{outcome: "signed_in", …}`, `{outcome: "linked"}`, `{outcome: "tested", …}` |
| `GET /v1/auth/me/login-methods` | 내 로그인 수단 |
| `POST /v1/auth/me/login-methods/{provider_id}/link/start`, `DELETE /v1/auth/me/login-methods/{id}` | 6.4절 |

`/v1/auth/google/start`, `/v1/auth/google/callback`과 웹 경로 `/auth/google/callback`은 없앤다. `GET /v1/auth/login-methods`의 응답 모양이 바뀐다. 이 API의 소비자는 콘솔뿐이다.

### 7.3 테스트 로그인과 켜기

- 테스트 로그인은 꺼진 공급자에도 돈다. owner 세션에서만 시작하고, 콜백도 같은 owner 세션이어야 한다.
- 4.3절 검증을 처음부터 끝까지 그대로 돌린다. discovery는 캐시 없이 새로 받는다. 계정도 세션도 만들지 않는다.
- 통과하면 `tested_at`과 `tested_fingerprint`를 적는다. 지문은 `issuer`, `client_id`, secret 버전, `token_auth_method`의 SHA-256이다.
- 결과 화면은 받은 `sub`, `email`, `email_verified`, 도메인 판정, 그리고 "이 계정이 로그인하면 어떻게 되는지"(6.1절의 어느 규칙)를 보여 준다. 실패하면 이유 코드를 보여 준다. owner는 여기서 `email_verified`가 오지 않는 IdP를 알아본다.
- 켜기는 `tested_fingerprint`가 지금 설정의 지문과 같을 때만 된다. 아니면 `409`다.
- 켜진 공급자의 client ID, secret, client 인증 방식은 바꿀 수 있다. secret은 만료되므로 끄지 않고 돌릴 수 있어야 한다. 바꾸면 지문이 달라져 상태가 "테스트 필요"로 보이고 화면이 테스트 로그인을 권한다. 공급자는 켜진 채로 남는다. 설정이 틀렸으면 그 공급자의 새 로그인만 실패하고, 있는 세션과 다른 로그인 수단은 그대로다.
- issuer는 바꿀 수 없다. issuer가 바뀌면 모든 사용자의 신원이 바뀐다. 지우고 새로 만든다.

## 8. 공급자 끄기와 세션

- 끄기는 한 트랜잭션이다: 공급자 행을 `enabled = false`로 바꾸고, `login_methods.issuer`가 그 issuer인 수단으로 만든 살아 있는 세션을 모두 끊는다(`revoked_at`). receipt에 끊은 세션 수를 적는다.
- 경합: 로그인·연결 트랜잭션은 공급자 행을 `FOR SHARE`로 읽는다. 끄기의 `UPDATE`는 그 잠금이 풀릴 때까지 기다리므로, 먼저 끝난 로그인의 세션은 뒤따르는 세션 끊기 문장이 본다. 끄기가 먼저 끝나면 로그인은 꺼진 행을 보고 거절한다. 끈 뒤에 그 공급자의 세션이 남는 순서는 없다.
- 요청마다 세션을 확인하는 조회(`resolveWebSession`)는 바꾸지 않는다. 세션은 끌 때 끊긴다.
- 삭제는 꺼진 공급자에만 된다. 그래서 삭제에는 끊을 세션이 없다.
- owner가 자기가 로그인한 공급자를 끄면 자기 세션도 끊긴다. 화면이 끄기 전에 끊길 세션 수와 이 사실을 보여 준다.
- 알려 둘 한계: IdP에서 사람을 지워도 werft 세션은 남는다. 세션은 쓰는 동안 계속 늘어난다. 지금은 멤버를 끄는 것이 세션을 끊는 길이다. SCIM과 RP-initiated logout 후속 티켓이 이 틈을 다룬다.

## 9. 비밀번호 끄기, 비상 관리자, CLI 복구

### 9.1 비밀번호 로그인

- `login_settings.password_login`이 `emergency_only`이면 비상 관리자만 비밀번호로 로그인한다. 다른 사용자의 비밀번호 로그인은 틀린 비밀번호와 같은 `401`이다.
- `emergency_only`로 바꾸려면 셋이 모두 참이어야 한다: 켜진 공급자가 하나 이상 있다, 비상 관리자가 지정돼 있다, 바꾸는 owner 자신이 켜진 공급자의 로그인 수단을 갖고 있거나 비상 관리자다. 마지막 조건은 owner가 자기를 잠그지 않게 한다.
- 바꾸면 같은 트랜잭션에서 비상 관리자가 아닌 사용자의 비밀번호 세션(`login_method_id`가 `password` 행이거나 NULL)을 끊는다.
- `emergency_only` 동안에는 초대 수락의 비밀번호 설정, 비밀번호 재설정 링크 발급과 사용이 비상 관리자가 아닌 사용자에게 닫힌다. 초대 화면은 공급자 버튼만 보여 준다.
- 로그인 화면은 공급자 버튼을 보여 주고, 비밀번호 칸은 "비상 관리자 로그인" 링크 뒤에 둔다.
- 마지막으로 켜진 공급자를 끄려 하면, `emergency_only`인 동안에는 거절한다. 먼저 비밀번호 로그인을 켠다. CLI는 둘을 한 번에 한다.

### 9.2 비상 관리자

- 한 명이다. 계정과 멤버십이 켜져 있고 비밀번호가 있는 owner만 지정할 수 있다.
- 지정된 동안에는 그 사람을 끄거나, 내보내거나, owner가 아니게 바꾸거나, 그 비밀번호 수단을 끊을 수 없다. 먼저 다른 owner를 비상 관리자로 지정한다. 이 검사는 멤버 변경과 같은 트랜잭션에서 `login_settings` 행을 잠그고 한다.
- 지정을 지우는 것은 `password_login`이 `on`일 때만 된다.
- 비상 관리자의 비밀번호 로그인은 다른 사용자와 같은 잠금 창(`LoginLockout`)을 쓴다.

### 9.3 운영자 CLI

`apps/control-host/src/api/login-recovery.ts`. API 컨테이너 안에서 `DATABASE_URL`과 `PLATFORM_SECRET_KEY`로 실행한다. 출력은 JSON 한 줄이고 종료 코드가 계약이다. 비밀값은 출력하지 않는다. 쓰기마다 receipt를 남기고 actor는 운영자 CLI다.

| 명령 | 뜻 |
|---|---|
| `status` | 공급자(이름, issuer, 켜짐), `password_login`, 비상 관리자 주소 |
| `enable-password` | `password_login`을 `on`으로 |
| `disable-provider --id <id>` 또는 `--all` | 공급자를 끄고 세션을 끊는다. `emergency_only`였다면 먼저 `password_login`을 `on`으로 바꾼다 |
| `reset-password --email <주소>` | 켜진 owner에게 한 번 쓰는 비밀번호 재설정 링크를 낸다. 있던 `password_resets` 흐름을 쓴다. 비밀번호가 없던 owner에게는 `password` 수단을 만든다 |

`reset-password`가 내는 것은 링크의 token이다. 다른 secret과 달리 이 값은 출력해야 쓸 수 있다. owner가 내는 재설정 링크와 같이 60분 뒤 만료되고(`PASSWORD_RESET_TTL_MINUTES`) 한 번만 쓴다.

owner가 한 명도 없는 경우는 지금의 `BOOTSTRAP_TOKEN` 복구가 맡는다. 바꾸지 않는다.

## 10. 공급자별 차이

아래 표의 IdP 쪽 사실은 각 공급자의 공개 문서 기준이다. 6단계의 계약 시험이 이 모양을 mock IdP로 고정하고, Keycloak은 실제 서버로 확인한다. 실제 Google Workspace와 OneLogin 확인은 오너 몫 하위 티켓으로 남긴다.

| IdP | issuer 모양 | `email_verified` | 그 밖 | 필요한 설정 |
|---|---|---|---|---|
| Google | `https://accounts.google.com` | 온다 | id_token `iss`가 스킴 없이 올 수 있다. Workspace 계정은 `hd`가 온다 | 허용 도메인(권장). JIT는 허용 도메인 필수 |
| OneLogin | `https://<subdomain>.onelogin.com/oidc/2` | 오지 않는다 | client 인증 방식을 앱에서 하나만 고른다(기본 Basic) | `email_trust = provider` |
| Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | 오지 않는다 | `common`·`organizations` issuer는 discovery의 `issuer`가 `{tenantid}` 틀이라 4.3절 3에서 걸린다. 화면이 "tenant별 issuer를 쓰라"고 안내한다. `email` 클레임은 앱 등록에서 켜야 올 수 있다. `sub`는 앱마다 다르다 | `email_trust = provider`. tenant별 issuer |
| Okta | `https://<org>.okta.com` 또는 `…/oauth2/<server>` | 온다 | | 없음 |
| Keycloak | `https://<host>/realms/<realm>` | 온다(검증 안 한 사용자는 false) | `ES256`으로 서명하게 설정할 수 있다 | 미검증 사용자를 받으려면 `email_trust = provider` |

- `sub`가 앱마다 다른 IdP(Entra ID)에서는 client ID를 다른 앱 등록으로 바꾸면 모든 사용자의 `sub`가 바뀌어 연결이 끊긴다. 화면이 client ID를 바꿀 때 이 경고를 보여 준다.
- issuer 끝의 `/`는 고치지 않는다. discovery 주소를 만들 때만 뗀다.

## 11. `GOOGLE_OIDC_*` 제거와 마이그레이션

### 11.1 제거

- `googleLoginConfigFromEnv`와 `server.ts`의 호출, `infra/compose.core.yml`의 여섯 변수, 운영 문서의 표, verify 스킬의 설정 예를 지운다. 남은 값이 있어도 읽지 않고 경고도 내지 않는다.
- 확인: 저장소에서 `GOOGLE_OIDC` 검색 결과가 CHANGELOG 밖에서 0건이다.
- CHANGELOG "운영자가 할 일": "Google 로그인은 웹 관리 화면에서 공급자로 다시 등록한다. `CONSOLE_ORIGIN`이 있어야 한다. redirect URI가 `<CONSOLE_ORIGIN>/auth/callback/<provider_id>`로 바뀌므로 Google Cloud 콘솔의 승인된 리디렉션 URI도 바꾼다."
- 있던 Google 사용자의 `login_methods` 행은 남는다(`kind`만 `oidc`로). owner가 같은 issuer로 공급자를 다시 등록하고 켜면 그 사람들은 전과 같은 사용자로 로그인한다.

### 11.2 마이그레이션

| 변경 | 방식 | 되돌리기 |
|---|---|---|
| `login_providers`, `login_settings` 생성 | 새 테이블 | 지우면 된다 |
| `login_methods.kind` `google` → `oidc`, 검사 교체 | 작은 테이블의 `UPDATE`와 검사 교체 | 옛 코드는 `oidc` 행을 찾지 못한다. 옛 버전으로 되돌리려면 `kind`를 되돌리는 SQL이 필요하다. PR에 적는다 |
| `login_methods (user_id, issuer)` 유일 인덱스 | 어긴 행을 먼저 세고, 있으면 멈춘다 | 인덱스를 지우면 된다 |
| `web_sessions.login_method_id` | NULL 허용 칸, 기본값 없음, 인라인 외래 키 없음. 인덱스는 `CONCURRENTLY` | 칸을 지우면 된다 |
| 외부 로그인 수단을 가진 사용자의 살아 있는 세션 끊기 | `UPDATE … SET revoked_at` 한 번. 커지는 테이블 규칙에 맞는 방식(트랜잭션 밖 단계)으로 넣는다 | 되돌릴 수 없다. 그 사용자는 다시 로그인한다 |

마지막 줄의 이유: 업그레이드 전 세션은 어떤 수단으로 만들었는지 모른다. 업그레이드 뒤에는 공급자가 하나도 없으므로, 외부 로그인으로 만든 세션은 결정 4에 따라 끊겨 있어야 한다. 외부 수단을 가진 사용자의 세션을 한 번 끊으면, 남은 NULL 세션은 모두 비밀번호로 만든 것이다. 비밀번호만 쓰는 사용자의 세션은 건드리지 않는다.

### 11.3 영향

- Google만으로 로그인하던 사용자는 owner가 공급자를 다시 등록하고 켤 때까지 로그인할 수 없다. 결정 7의 결과다.
- 2단계가 환경 변수를 지우고, 3단계가 관리자 화면을, 5단계가 CLI 복구를 더한다. 2단계와 5단계 사이의 `main`은 SSO를 설정하거나 복구하는 길이 덜 갖춰져 있다. 릴리스는 5단계가 들어간 뒤에 자른다. 각 PR의 CHANGELOG에 이 순서를 적는다.

## 12. 단계별 PR

| 단계 | 내용 | 동작 변경 | 채우는 인수 조건 |
|---|---|---|---|
| 1 | `oidc/` 모듈. Google 로그인을 그 위로 옮긴다. `iat` 검사, `aud` 배열·`azp` 규칙, `ES256`, 응답 `iss` 검사를 더한다. JWKS 회전을 넣은 mock IdP | Google 로그인의 통과 경우는 같다. 더 거절하는 경우(`iat` 없음 등)를 PR에 적는다 | 검증 항목, 거절 경우(토큰) |
| 2 | 5절의 테이블·칸과 마이그레이션, 공급자 저장소, 공개 경로를 `providers/{id}`로, `GOOGLE_OIDC_*` 제거, 로그인 화면의 버튼을 공급자 목록으로, 세션에 수단 기록, 끄기와 세션 끊기(저장소) | Google 환경 변수 설정이 사라진다. 공개 경로와 `login-methods` 응답이 바뀐다 | 환경 변수 0건, `(issuer, subject)` 식별, 꺼진 공급자 거절, 세션 끊기(시험) |
| 3 | 관리자 API와 화면: 만들기, discovery 확인, redirect URI, secret, 테스트 로그인, 켜기·끄기·삭제, receipt | owner가 화면에서 공급자를 설정한다 | 관리자 화면 전체 |
| 4 | 초대 화면의 공급자 버튼, JIT·이메일 신뢰 설정의 화면, 로그인된 상태의 연결·끊기 | 계정 연결이 생긴다 | 연결 규칙, 첫 가입 |
| 5 | `login_settings`, 비밀번호 끄기, 비상 관리자, `login-recovery` CLI | 비밀번호 로그인을 끌 수 있다 | 비밀번호 끄기·복구 실행 |
| 6 | mock IdP의 공급자 모양(Google, OneLogin, Entra ID, Okta, Keycloak) 계약 시험, Keycloak을 붙인 스택의 브라우저 e2e, 복구 실행 기록 | 없음 | 공급자별 로그인·가입, e2e |

시험으로 고정하는 거절 경우: 서명 틀림, `alg` 허용 밖, 만료, `iat` 미래·오래됨, `aud` 불일치, `azp` 불일치, `iss` 불일치, 응답 `iss` 불일치, nonce 불일치, state 불일치, 흐름 만료, `provider_id` 불일치, PKCE verifier 틀림, 허용 도메인 밖, 미검증 이메일, 이메일 없음, 같은 이메일·다른 issuer, 이미 다른 사용자에게 연결된 `(issuer, subject)`의 연결 시도, 꺼진 공급자의 시작과 콜백, 끄기와 겹친 로그인, owner가 아닌 사용자의 관리 API, 테스트 통과 전 켜기, 오래된 세션의 연결 시작, 마지막 수단 끊기, 비상 관리자 끄기.

## 13. 위협과 대응

| 위협 | 대응 |
|---|---|
| 로그인 CSRF(공격자의 code를 피해자 브라우저에 넣음) | state를 `__Host-` cookie와 비교. CSRF 헤더 필수 |
| code 가로채기 | PKCE S256. client secret |
| id_token 재사용 | nonce. `iat` 상한 |
| 위조 token | JWKS 서명 검증. `alg` 허용 목록. `none`·`HS*` 거절 |
| 다른 client용 token | `aud`·`azp` |
| IdP mix-up | 공급자별 redirect URI, cookie의 `provider_id` 비교, 응답 `iss`, id_token `iss` |
| 이메일로 계정 탈취 | `(issuer, subject)` 식별. 자동 연결 없음. Google의 `hd` 규칙. `email_trust` |
| 계정 열거 | `401` 문구 하나. `409 LOGIN_LINK_REQUIRED`는 주소를 소유한 사람에게만 |
| 탈취한 세션으로 로그인 수단 추가 | 만든 지 10분 안의 세션만 연결을 시작한다 |
| owner가 넣은 issuer로 내부 주소 요청 | `https`만, redirect 안 따름, 크기·시간 제한, 응답 원문 미노출 |
| client secret 노출 | `secret_values`에 봉인. API는 돌려주지 않음. 로그에 남기지 않음 |
| 끈 공급자의 세션 잔존 | 한 트랜잭션에서 끄고 끊음. 행 잠금으로 경합을 막음 |
| SSO 고장으로 잠김 | 비상 관리자, CLI |
| 인증 없는 콜백으로 IdP 호출 남발 | 동시 실행 상한 |

## 14. 하지 않는 것과 확장 지점

| 후속 | 이 설계에서 쓸 곳 |
|---|---|
| IdP 그룹→역할 매핑 | `login_providers`에 scope 칸과 매핑 칸을 더한다. id_token의 `groups` 클레임을 `oidc/id-token.ts`가 신원에 싣고, 6.1절 규칙 1·3·4 뒤에 멤버십 역할을 정한다 |
| SCIM 프로비저닝 | 사용자를 `login_methods (issuer, subject)`로 찾는다. 비활성화는 멤버 끄기와 세션 끊기를 부른다. 공급자별 SCIM token은 `secret_values`의 `login_provider:<id>` owner에 purpose를 하나 더한다 |
| SAML | `login_methods.kind = 'saml'`, `issuer`에 entity ID, `subject`에 NameID. `login_providers`에 `protocol` 칸을 더한다. 6절 규칙과 8절 세션 끊기는 그대로 쓴다. 코드는 `apps/control-host/src/api/saml/` |
| RP-initiated logout | discovery의 `end_session_endpoint`. id_token을 보관해야 하므로 `web_sessions`에 봉인한 칸이 필요하다. `web_sessions.login_method_id`로 어느 공급자의 세션인지 안다 |
| 이메일 도메인 기반 공급자 자동 선택 | `login_providers.allowed_domains`를 도메인→공급자 표로 쓴다. `GET /v1/auth/login-methods`에 주소를 받아 공급자를 돌려주는 조회를 더한다 |

그 밖에 하지 않는 것: workspace별 공급자, client secret 없는 client, `private_key_jwt`, 세션 수명 상한, IdP의 이메일 변경을 `users.email`에 반영.

## 15. 정한 것 가운데 다시 볼 만한 것

오너에게 묻지 않고 이 문서가 정했다. 리뷰가 다르게 보면 바꾼다.

1. JWKS를 캐시하지 않는다(4.4절).
2. 흐름 cookie를 서명하지 않는다(4.2절).
3. 연결 시작의 조건을 "만든 지 10분 안의 세션"으로 둔다(6.4절).
4. 켜진 공급자의 client ID·secret 변경을 막지 않는다(7.3절).
5. 업그레이드 때 외부 로그인 수단을 가진 사용자의 세션을 한 번 끊는다(11.2절).
6. 모듈을 워크스페이스 패키지로 만들지 않는다(3.2절).
7. `http` issuer를 `CONSOLE_ORIGIN`이 `http`인 설치에서만 받는다(4.4절).

## 16. 진행 상태

| 단계 | 상태 | PR |
|---|---|---|
| 0 설계 | Codex 리뷰 대기 | 이 문서의 PR |
| 1~6 | 승인 뒤 시작 | — |

## 17. 리뷰 기록

Codex 설계 리뷰의 판정과 반영한 것을 여기에 적는다.
