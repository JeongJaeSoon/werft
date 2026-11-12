# 결정(설계): 범용 OIDC 로그인 공급자를 웹 관리 화면에서 설정한다

- 상태: 채택. Codex 설계 리뷰 3회차에서 승인받았다(2026-11-13). 리뷰 기록은 [17절](#17-리뷰-기록), 진행 상태는 [16절](#16-진행-상태)에 남긴다.
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
| 이메일 | IdP가 사람을 인증한 것과 그 사람이 주소를 소유한 것은 다른 사실이다. 증명되지 않은 주소는 어떤 판정에도 쓰지 않는다. 초대는 초대 token으로 받는다 |
| endpoint | discovery는 owner가 확인할 때만 받고, 그때의 endpoint를 공급자 행에 고정한다. 로그인 중에는 discovery를 받지 않는다 |
| 켜기 | 공급자는 꺼진 채로 만들어진다. owner의 테스트 로그인이 지금 설정으로 통과해야 켤 수 있다 |
| 끄기 | 공급자를 끄면 같은 트랜잭션에서 그 공급자로 만든 세션을 모두 끊는다. 세션에 로그인 수단을 적는 칸을 새로 둔다 |
| 복구 | 비밀번호 로그인을 꺼도 비상 관리자 1명은 비밀번호로 들어온다. 운영자 CLI가 공급자를 끄고, 비밀번호 로그인을 다시 켜고, owner에게 비밀번호 재설정 링크를 낸다. 그 링크로 비밀번호를 정한 owner가 비상 관리자가 된다 |
| 환경 변수 | SSO 설정용 환경 변수는 없다. `GOOGLE_OIDC_*`와 읽기 코드를 지운다. 호환과 자동 이전은 없다 |
| 순서 | PR 여섯 개: OIDC 코어 → 저장·공개 경로·환경 변수 제거 → 관리자 화면 → 가입·계정 연결 → 비밀번호 끄기·복구 → 공급자별 계약 시험·Keycloak e2e |

## 1. 지금 (실측)

| 무엇 | 어디 | 사실 |
|---|---|---|
| Google 로그인 | `apps/control-host/src/api/google-login.ts` (357줄) | discovery, PKCE S256, state, nonce, `aud`·`azp`·`iss`·`exp` 검증이 이미 있다. Google 전용인 곳은 셋이다: 환경 변수 읽기(`googleLoginConfigFromEnv`), `iss` 별칭(`accounts.google.com`), `hd` 규칙(`domainAdmission`) |
| discovery·JWKS | 같은 파일 `createGoogleLogin` | discovery는 프로세스 수명 동안 한 번 캐시한다. JWKS는 로그인마다 새로 받는다. 서명 알고리즘은 `RS256`만 받는다. `iat`는 보지 않는다. discovery가 준 endpoint는 문자열인지만 본다 |
| 바깥 요청 | `apps/control-host/src/api/provider-fetch.ts` | 10초 시간 제한만 있다. 목적지 제한은 없다 |
| 흐름 cookie | `packages/contracts/src/musterrolle/auth.ts` `GOOGLE_LOGIN_COOKIE_NAME` | `__Host-` cookie에 `state.nonce.verifier.시작시각`을 평문으로 둔다. 10분 뒤 만료 |
| 공개 경로 | `apps/control-host/src/api/routes/auth.ts` | `GET /v1/auth/login-methods`(`["password"]` 또는 `["password","google"]`), `POST /v1/auth/google/start`, `POST /v1/auth/google/callback`. Google이 설정되지 않으면 뒤 둘은 `404` |
| redirect | `apps/web/src/routes/google-callback.tsx` | IdP가 브라우저를 웹 화면 `/auth/google/callback`으로 돌려보낸다. 화면이 `code`·`state`를 API에 POST한다. redirect URI는 환경 변수 `GOOGLE_OIDC_REDIRECT_URI`다 |
| 첫 로그인 규칙 | `packages/db/src/musterrolle/identity.ts` `signInWithExternalIdentity` | 연결된 `(kind, issuer, subject)`는 그 사용자로 로그인한다. 연결이 없고 그 주소의 계정이 이미 있으면 연결하지 않는다(`409 LOGIN_LINK_REQUIRED` 또는 `401`). 계정이 없으면 살아 있는 초대(주소로 찾는다) 또는 JIT만 계정을 만든다. 연결을 먼저 읽고 그 뒤에 사용자 행을 잠근다 |
| 비밀번호 초대 수락 | `packages/db/src/musterrolle/invites.ts` `acceptInvite` | 초대 token으로 초대를 찾는다. 초대 주소로 계정을 만든다. 그 주소의 계정이 이미 있으면 그 계정의 비밀번호를 요구한다 |
| 연결 경로 | 없음 | `login_methods`에 행을 넣는 곳은 bootstrap, 초대 수락(비밀번호), 외부 로그인의 첫 가입 셋뿐이다. `409 LOGIN_LINK_REQUIRED`는 "설정에서 연결하라"고 안내하지만 그 화면과 경로는 없다 |
| `login_methods` | `packages/db/migrations/0138_login_methods.sql` | `kind`는 `password`·`google`만 허용한다. 유일 인덱스는 `(kind, issuer, subject)`다 |
| 비밀번호 | `users.password_hash` | NULL을 허용한다. 비밀번호 로그인은 `login_methods` 행이 아니라 이 hash를 본다(`routes/auth.ts` `login`). 재설정 링크의 발급과 사용은 대상의 hash가 NULL이 아니어야 하고, 발급은 비밀번호로 다시 인증한 owner를 actor로 받는다(`identity.ts` `issuePasswordReset`·`consumePasswordReset`) |
| 세션 | `web_sessions`, `resolveWebSession` | 어떤 로그인 수단으로 만든 세션인지 기록하지 않는다. 조회 결과(`ResolvedWebSession`)에 만든 시각이 없다. 수명은 14일이고 쓰는 동안 계속 늘어난다(`WEB_SESSION_TTL_MS`) |
| 비밀 저장 | `packages/platform/src/ports/secret-store.ts`, `packages/db/src/secrets/secret-values.ts` | `secret_values`에 AES-256-GCM으로 봉인한다. 슬롯은 `(workspace, owner, purpose)`다. 설치 전체 설정(모델 연결 등)의 값은 기본 workspace 아래 `<kind>:<id>` owner로 두고, workspace용 경로는 이 owner를 거절한다(`isSettingsSecretOwner`). `PLATFORM_SECRET_KEY`는 API 시작에 필수다(`loadSecretKey`) |
| 권한 | `packages/platform/src/musterrolle/policy.ts` `MANAGEMENT_ROLES` | `installation.settings.manage`는 owner만 가진다 |
| 공개 주소 | `apps/control-host/src/api/slack-config.ts` `consoleOriginFrom` | `CONSOLE_ORIGIN`에서 공개 주소를 얻는다. 없으면 옛 `SLACK_OIDC_REDIRECT_URI`의 origin을 이번 릴리스에 한해 쓴다. 둘 다 없으면 Slack·GitHub 계정 연결을 시작할 수 없다 |
| 마이그레이션 검사 | `packages/db/src/migration-safety.ts` | `web_sessions`는 커지는 테이블이다. 이 테이블의 `UPDATE`·`DELETE`는 트랜잭션 밖 단계여도 거절한다. 인라인 외래 키도 거절한다. `CREATE INDEX CONCURRENTLY` 앞에는 `DROP INDEX CONCURRENTLY IF EXISTS`가 있어야 한다 |
| 가짜 IdP | `packages/testkit/src/mock-oidc.ts` | id_token 클레임을 `login_hint`로 주입한다. 틀린 `aud`, 지난 `exp`, 미검증 이메일을 시험에서 만들 수 있다. 키는 하나이고 회전하지 않는다. PKCE verifier를 항상 검사한다 |
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
| `provider-http.ts` | 4.5절의 주소 검사와 네트워크 정책을 지키는 요청 함수. 이 모듈의 모든 바깥 요청이 이것만 쓴다 | DNS, HTTP |
| `discovery.ts` | discovery 문서를 받아 검증하고 endpoint 묶음을 돌려준다 | HTTP GET |
| `jwks.ts` | JWKS를 받고 token에 맞는 키를 고른다 | HTTP GET |
| `id-token.ts` | 서명과 클레임을 검증한다. 키와 시각을 인자로 받는 순수 함수다 | 없음 |
| `flow.ts` | 시작(authorization URL, state, nonce, PKCE)과 끝(code 교환, UserInfo 보완), 흐름 cookie의 봉인과 열기 | HTTP POST·GET |
| `issuer-rules.ts` | issuer별 차이: `iss` 별칭, 추가 요청 인자, 이메일 증명 판정 | 없음 |
| `admission.ts` | 허용 도메인과 JIT를 판정한다 | 없음 |
| `errors.ts` | `OidcUnavailableError`(다시 시도할 만함), `OidcRejectedError`(거절, 이유 코드) | 없음 |
| `index.ts` | 공개면 | 없음 |

규칙: 이 디렉터리는 `@werft-ai/db`, 라우트, Hono `Context`를 import하지 않는다. 입력은 공급자 설정 값과 시각 함수이고, 출력은 검증된 신원(`issuer`, `subject`, 증명된 `email` 또는 없음, `name`)이다. `tests/architecture.test.ts`에 이 규칙을 넣는다.

저장은 기존 경계를 따른다. port는 `packages/platform/src/ports/login-provider-store.ts`, 구현은 `packages/db/src/musterrolle/login-providers.ts`, 계약은 `packages/contracts/src/musterrolle/login-providers.ts`다.

### 3.2 새 워크스페이스 패키지로 만들지 않는 이유

`packages/adapters/<kind>/<provider>`는 공급자마다 코드가 다를 때의 모양이다(Slack, GitHub, 실행 backend). OIDC 공급자는 코드가 아니라 설정 행이고, 코드 경로는 하나다. 소비자도 control-host 하나다. 같은 종류인 `google-login.ts`, `slack-link.ts`, `github-link.ts`가 이미 `apps/control-host/src/api/`에 있고 [Musterrolle 경계](musterrolle-boundary.md)가 이곳을 HTTP 경계로 적었다. 패키지를 새로 만들면 architecture 테스트 기준선, 이미지 빌드의 복사 목록, typecheck 참조가 늘지만 얻는 것은 import 규칙 하나다. 그 규칙은 3.1절의 architecture 테스트로 같은 값에 얻는다. SAML을 더할 때 옆에 `saml/`을 두고, 그때 소비자가 둘 이상이면 패키지로 올린다.

`slack-link.ts`(Sign in with Slack)도 OIDC를 쓴다. 이번에는 합치지 않는다. 그 흐름은 로그인이 아니라 계정 연결이고, Slack 앱 저장과 묶여 있다.

## 4. 로그인 흐름과 검증 항목

### 4.1 흐름

1. 브라우저가 `POST /v1/auth/providers/{provider_id}/start`를 부른다(CSRF 헤더 필수, 지금과 같다). 초대 화면에서 시작하면 본문에 `invite_token`을 싣는다.
2. 서버가 공급자 행을 DB에서 읽는다. 꺼져 있으면 `404`다. state·nonce·PKCE verifier를 만들어 흐름 cookie에 봉인하고, 행에 고정된 `authorization_endpoint`로 authorization URL을 만들어 돌려준다.
3. IdP가 브라우저를 `<CONSOLE_ORIGIN>/auth/callback/<provider_id>`(웹 화면)로 돌려보낸다.
4. 화면이 `POST /v1/auth/oidc/callback`에 `{provider_id, code, state, iss?}`를 보낸다. `provider_id`는 화면이 받은 주소의 경로에서 얻는다. `iss`는 IdP가 응답에 붙였을 때만 있다.
5. 서버가 4.3절 순서로 검증하고 6절 규칙으로 세션을 만든다.

API가 콜백을 직접 받지 않는 이유는 지금과 같다. 콜백 GET이 API에 오면 CSRF 헤더 없이 cookie만으로 쓰기가 일어난다.

### 4.2 흐름 cookie

- 이름은 `__Host-werft_login_flow`다. `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 10분.
- **봉인한다.** AES-256-GCM이고, 키는 `PLATFORM_SECRET_KEY`에서 HKDF-SHA256으로 뽑은 이 용도 전용 키다. 연관 데이터에 cookie 이름과 형식 버전을 넣는다. 열리지 않는 cookie는 흐름이 없는 것과 같다.
- 내용:

| 값 | 쓰임 |
|---|---|
| `state`, `nonce`, PKCE `verifier` | 4.3절 |
| 시작 시각 | 10분 수명. 지금보다 앞선 시각(시계 오차 60초 밖)은 거절한다 |
| `provider_id` | 콜백 본문의 `provider_id`와 같아야 한다 |
| `config_revision` | 콜백 때 공급자 행의 값과 같아야 한다. 흐름 도중 설정이 바뀌면 거절한다 |
| 목적 | `login`, `invite`, `link`, `test` |
| `user_id`, `session_id` | 목적이 `link`·`test`일 때. 시작한 사용자와 그 세션 |
| `invite_id` | 목적이 `invite`일 때 |
| secret 슬롯과 버전 | 목적이 `test`일 때. 어느 secret을 시험하는지 (7.3절) |

- 봉인만으로 끝내지 않는다. 콜백이 목적마다 다시 확인한다.
  - `login`·`invite`: 공급자가 켜져 있다.
  - `link`: 지금 요청의 세션이 살아 있고, 그 세션 ID와 사용자가 cookie의 것과 같다. 공급자가 켜져 있다.
  - `test`: 지금 요청의 세션이 살아 있고 cookie의 세션과 같으며, 그 사용자가 지금도 owner다.
- 콜백은 성공이든 실패든 cookie를 지운다. 같은 code를 다시 내면 IdP가 거절한다.
- 탭 두 개에서 동시에 시작하면 뒤의 것이 앞의 cookie를 덮는다. 지금과 같다.

서버 저장 흐름(테이블)을 쓰지 않는 이유: 인증 없는 시작 요청마다 행이 생기고, 만료된 행을 치우는 일이 따로 필요하다. 봉인한 cookie는 같은 결합(목적, 사용자, 세션, 공급자, 설정 revision)을 저장 없이 준다.

### 4.3 검증 순서

| 단계 | 검사 | 실패 |
|---|---|---|
| 1 | cookie가 열린다. 본문 `state`가 cookie `state`와 같다(상수 시간 비교). 시작 뒤 10분 안이다. 본문 `provider_id`가 cookie의 것과 같다 | `401` |
| 2 | 공급자 행이 있고, `config_revision`이 cookie의 것과 같고, 목적의 조건(4.2절)을 채운다 | `404` 또는 `401` |
| 3 | 응답에 `iss`가 있으면 issuer와 같다. 공급자 행이 "응답 `iss` 필수"(discovery의 `authorization_response_iss_parameter_supported: true`)이면 `iss`가 반드시 있어야 한다(RFC 9207) | `401` |
| 4 | 고정된 `token_endpoint`에 `code`, `redirect_uri`, `code_verifier`와 client 인증을 보낸다. `2xx`가 아니면 거절이다 | `401`, IdP `5xx`·시간 초과는 `503` |
| 5 | id_token 헤더 `alg`가 이 공급자의 허용 목록(5.1절 `signing_algs`)에 있다. `none`과 `HS*`는 어떤 공급자에서도 받지 않는다 | `401` |
| 6 | 고정된 `jwks_uri`에서 키를 받아 고른다: `kid`가 같고, `kty`가 `alg`에 맞고(`RS256`은 2048비트 이상 RSA, `ES256`은 P-256), `use`가 없거나 `sig`이고, 키의 `alg`가 없거나 token의 `alg`와 같다. token에 `kid`가 없으면 조건에 맞는 키가 정확히 하나여야 한다. 서명이 맞다 | `401`, JWKS `5xx`·시간 초과는 `503` |
| 7 | `iss`가 issuer와 같다. Google issuer만 스킴 없는 `accounts.google.com`도 받는다 | `401` |
| 8 | `aud`가 client ID 하나다(문자열이거나 원소가 하나인 배열). 다른 audience가 함께 있으면 거절한다. 믿는 audience를 따로 설정하는 칸은 두지 않는다. `azp`가 있으면 client ID와 같다 | `401` |
| 9 | `exp`·`iat`가 유한한 숫자다. `exp`가 지금보다 뒤다. `iat`가 지금보다 60초 넘게 앞서지 않고 11분보다 오래되지 않았다. `nbf`가 있으면 유한한 숫자이고 지났다. 시계 오차 60초는 공급자 시계가 앞선 쪽(`iat`, `nbf`)에만 준다. `exp`에는 주지 않는다 | `401` |
| 10 | `nonce`가 cookie `nonce`와 같다(상수 시간 비교) | `401` |
| 11 | `sub`가 비어 있지 않은 문자열이고 255자 이하다 | `401` |
| 12 | 이메일을 정한다(6.2절). id_token에 `email`이 없고 공급자 행에 `userinfo_endpoint`가 있으면 access token으로 UserInfo를 한 번 부른다. 응답의 `sub`가 id_token의 `sub`와 같아야 하고, 거기서 `email`·`email_verified`만 가져온다 | `401`, UserInfo `5xx`·시간 초과는 `503` |
| 13 | 허용 도메인 규칙(6.3절)을 통과한다 | `403` |

- PKCE: werft는 모든 흐름에 S256 challenge와 verifier를 보낸다. 생략하는 설정은 없다. verifier가 틀린 요청을 거절하는 것은 IdP다(단계 4). 인수 조건은 틀린 verifier의 거절을 요구하므로, 이를 거절하지 않는 IdP는 그 조건을 채우지 못한 것이다. 공급자별 확인은 10절에 적는다.
- `iat` 상한 11분은 흐름 cookie 수명 10분에 시계 오차를 더한 값이다. id_token은 code 교환 때 발급되므로 정상 흐름에서는 몇 초 전이다.
- `401`의 응답 문구는 이유를 구분하지 않는다("Sign-in was not accepted"). 이유는 서버 로그에 이유 코드로만 남긴다. code, token, cookie, client secret, UserInfo 응답은 로그에 남기지 않는다.

### 4.4 discovery와 endpoint 고정

discovery는 owner의 행동으로만 받는다: 공급자를 만들 때, "discovery 다시 확인"을 누를 때. 로그인·연결·테스트 흐름은 discovery를 받지 않고 공급자 행에 고정된 endpoint를 쓴다.

discovery 문서는 다음을 모두 채워야 한다. 하나라도 어기면 오류 종류와 함께 거절하고 아무것도 저장하지 않는다.

| 검사 | 오류 종류 |
|---|---|
| `issuer`가 넣은 issuer와 글자 그대로 같다 | `issuer_mismatch` |
| `authorization_endpoint`·`token_endpoint`·`jwks_uri`가 있고, `userinfo_endpoint`는 있으면, 모두 4.5절의 주소 검사를 통과한다 | `invalid_document`, `insecure_endpoint` |
| `response_types_supported`에 `code`가 있다 | `unsupported_flow` |
| `id_token_signing_alg_values_supported`와 `{RS256, ES256}`의 교집합이 비어 있지 않다. 교집합을 `signing_algs`로 저장한다 | `unsupported_algorithm` |
| `token_endpoint_auth_methods_supported`(없으면 `client_secret_basic`으로 본다)와 `{client_secret_basic, client_secret_post}`의 교집합이 비어 있지 않다 | `unsupported_client_auth` |
| `code_challenge_methods_supported`가 있으면 `S256`이 있다. 없으면 통과시키고 "IdP가 PKCE 지원을 알리지 않음"을 기록해 화면에 보여 준다 | `pkce_s256_unsupported` |

- client 인증 기본값: 교집합에 `client_secret_basic`이 있으면 그것, 아니면 `client_secret_post`. owner가 교집합 안에서 바꿀 수 있다.
- endpoint가 바뀐 IdP는 owner가 "discovery 다시 확인"을 눌러야 따라간다. 이것은 연결 설정의 변경이다(7.3절).
- 로그인 중에 discovery를 받지 않으므로, IdP나 그 DNS를 쥔 쪽이 token·JWKS 요청의 목적지 URL을 바꿀 수 없다. replica마다 다른 캐시도 없다.

### 4.5 주소 검사와 네트워크 정책

이 모듈의 바깥 요청은 다섯 가지다: discovery, token, JWKS, UserInfo(서버가 보낸다), authorization(브라우저가 간다). 서버가 보내는 넷은 `provider-http.ts`만 쓴다.

주소 검사(issuer와 discovery가 준 모든 endpoint):

- 절대 URL이다. 사용자 정보(`user:pass@`)와 fragment가 없다.
- scheme은 `https`다. `http`는 host가 loopback(`localhost`, `127.0.0.1`, `[::1]`)이고 **`CONSOLE_ORIGIN`의 host도 loopback일 때만** 받는다. 운영 설치(콘솔이 공개 주소)는 평문 IdP를 쓸 수 없다. 로컬 스택과 e2e는 새 환경 변수 없이 mock IdP와 Keycloak을 붙인다(12절).

네트워크 정책(요청마다):

1. host를 직접 푼다. 답이 없으면 `503`이다.
2. 풀린 주소를 분류한다. link-local(`169.254.0.0/16`, `fe80::/10`), multicast, 예약, 미지정 주소가 하나라도 있으면 보내지 않는다. loopback은 위의 로컬 예외일 때만 받는다. 사설 주소(RFC 1918, ULA)는 받는다. 사내망의 IdP가 셀프호스팅의 주된 경우이고, 그 host는 owner가 넣거나 확인한 것이다.
3. **판정한 주소로 연결한다.** URL의 host를 그 주소로 바꿔 요청하고, `Host` 헤더와 TLS 서버 이름에 원래 host를 넣는다. 인증서는 원래 host로 검증된다. 이름을 다시 풀지 않으므로, 검사와 연결 사이에 DNS 답을 바꿔 정책을 우회할 수 없다. 기준 Bun(`1.3.14`)에서 주소로 직접 연결하며 `tls.serverName`을 주는 요청이 성공하고, 이름 없이 주소만으로는 인증서 검사에 실패함을 확인했다.
4. redirect를 따라가지 않는다. 시간 제한 10초, 응답 본문은 1 MiB까지만 읽는다.

이것으로 막는 것과 남는 것:

- 막는다: 평문 endpoint로 secret·code가 나가는 것, discovery가 가리킨 link-local·metadata 주소, DNS 재해석.
- 남는다: owner가 일부러 넣은 사설 주소로의 요청. owner는 설치의 최고 권한이고, 응답 원문은 화면에 돌려주지 않는다(해석한 필드와 오류 종류만). 사설망의 IdP를 지원하려면 이 요청은 허용해야 한다.

### 4.6 그 밖의 정한 것

| 주제 | 결정 | 이유 |
|---|---|---|
| JWKS 회전 | JWKS는 캐시하지 않는다. 로그인마다 받는다(지금과 같다) | IdP가 키를 돌리거나 지우면 다음 로그인부터 바로 따른다. 지운 키를 캐시 수명만큼 더 믿는 틈이 없다. 값은 로그인마다 JWKS endpoint가 살아 있어야 한다는 것이다. JWKS 요청은 code 교환이 성공한 뒤에만 나간다 |
| redirect URI | 공급자마다 다르다: `<CONSOLE_ORIGIN>/auth/callback/<provider_id>` | 여러 IdP를 쓰는 client는 IdP마다 다른 redirect URI를 쓰라는 권고(RFC 9700 4.4.2)를 따른다 |
| `CONSOLE_ORIGIN` | redirect URI의 유일한 소스다. 이 코드는 `CONSOLE_ORIGIN`만 직접 읽고, `consoleOriginFrom`의 옛 Slack 폴백은 쓰지 않는다. 없으면 공급자를 만들 수 없고 화면이 이유를 보여 준다 | 요청의 `Host` 헤더로 redirect URI를 만들지 않는다. SSO 전용 설정이 아니므로 결정 7과 어긋나지 않는다 |
| scope | `openid email profile` 고정 | 지금과 같다. 그룹 매핑이 `groups`를 더할 때 칸을 만든다 |
| client secret 없는 client | 지원하지 않는다 | 서버가 secret을 지킬 수 있다 |
| 동시 처리 | 콜백의 IdP 호출에 동시 실행 상한을 둔다(비밀번호 hash의 `WorkGate`와 같은 방식). 넘으면 `429` | 인증 없는 호출이 IdP로 나가는 요청을 무한히 만들지 못한다 |
| 다중 replica | 공급자 행은 캐시하지 않고 요청마다 DB에서 읽는다 | 끄기와 설정 변경이 모든 replica에 바로 보인다 |

## 5. 데이터

### 5.1 `login_providers` (새 테이블)

| 칸 | 타입 | 뜻 |
|---|---|---|
| `id` | uuid, PK | redirect URI에 들어간다 |
| `display_name` | text, 1~64자 | 로그인 버튼 글자 |
| `issuer` | text, UNIQUE | discovery의 `issuer`와 글자 그대로 같아야 한다. 만든 뒤에는 바꿀 수 없다 |
| `authorization_endpoint`, `token_endpoint`, `jwks_uri` | text | 고정한 endpoint (4.4절) |
| `userinfo_endpoint` | text, NULL 허용 | |
| `signing_algs` | text[] | `RS256`·`ES256` 가운데 IdP가 지원하는 것 |
| `iss_parameter_required` | boolean | 응답 `iss` 필수 여부 |
| `pkce_advertised` | boolean | discovery가 S256을 알렸는지. 표시용 |
| `discovery_checked_at` | timestamptz | |
| `client_id` | text, NULL 허용 | redirect URI를 IdP에 등록한 뒤에 넣는다 |
| `token_auth_method` | text | `client_secret_basic` 또는 `client_secret_post` |
| `allowed_domains` | text[], 기본 빈 배열 | 소문자. 비어 있으면 도메인을 제한하지 않는다 |
| `jit_role` | text, NULL 허용 | NULL 또는 `member` |
| `require_verified_email` | boolean, 기본 true | 6.2절 |
| `enabled` | boolean, 기본 false | |
| `config_revision` | integer | 연결·정책 설정이 바뀔 때마다 오른다. `display_name`은 올리지 않는다 |
| `tested_config_revision` | integer, NULL 허용 | 테스트 로그인이 통과한 `config_revision` |
| `tested_at` | timestamptz, NULL 허용 | |
| `revision` | integer | 수정 충돌 검사(`If-Match`). 모든 변경에 오른다 |
| `created_at`, `updated_at`, `created_by` | | |

- 설치 전체에 하나다. workspace 칸을 두지 않는다. 사용자(`users`)와 `login_methods`가 설치 전체이기 때문이다.
- issuer가 같은 공급자는 하나만 둔다. `(issuer, subject)`가 사용자를 가리키므로, 같은 issuer의 두 공급자는 같은 사람을 두 번 가리킨다.

### 5.2 client secret

- 이 테이블에 없다. `secret_values`에 owner `login_provider:<id>`로 둔다. purpose는 둘이다: 쓰고 있는 값 `login_client_secret`, 켜진 공급자의 교체 후보 `login_client_secret_next`(7.3절).
- `login_provider`는 설치 전용 owner다. `isSettingsSecretOwner`가 참이 되게 분류해 workspace용 secret 경로가 거절한다.
- 일반 `SecretStore`를 쓰지 않는다. 공급자 저장소(`login-providers.ts`)가 `SecretKey`를 받아, 공급자 행·secret 값과 버전·테스트 상태·receipt를 **한 트랜잭션**에서 바꾼다. 모델 연결 저장소(`createPostgresInstallationSettingsStore(db, secretKey)`)와 같은 방식이다.
- API는 값을 돌려주지 않고 `configured`, 끝 4자, 바꾼 시각만 준다.

### 5.3 `login_methods` 일반화

- `kind` 검사를 `('password', 'oidc')`로 바꾼다. 있던 `google` 행은 `oidc`로 바꾼다. `issuer`·`subject`는 그대로다.
- 유일 인덱스 `(kind, issuer, subject)`는 그대로 둔다. 외부 행의 `kind`가 모두 `oidc`이므로 `(issuer, subject)` 유일과 같다. SAML을 더하면 `kind = 'saml'`이 같은 인덱스로 갈린다.
- 새 유일 인덱스 `(user_id, issuer)`(`kind <> 'password'`)를 둔다. 한 사용자가 같은 issuer의 두 subject를 갖지 않는다. 지금은 외부 행을 첫 가입에서만 만들므로 기존 데이터가 이 인덱스를 어기지 않는다. 마이그레이션은 인덱스를 만들기 전에 어긴 행이 있는지 세고, 있으면 멈춘다.
- `login_methods`는 공급자 행을 참조하지 않는다. issuer 글자로 잇는다. 공급자를 지웠다가 같은 issuer로 다시 만들면 있던 연결이 그대로 산다.

### 5.4 `web_sessions.login_method_id` (새 칸)

- uuid, NULL 허용. 세션을 만든 로그인 수단을 적는다. 비밀번호 로그인은 그 사용자의 `password` 행, OIDC 로그인은 그 `oidc` 행이다. 새 코드가 만드는 세션은 항상 값이 있다.
- 칸은 기본값 없이 더하고, 외래 키는 달지 않는다. 살아 있는 세션을 수단으로 찾는 부분 인덱스(`revoked_at IS NULL`)는 `DROP INDEX CONCURRENTLY IF EXISTS` 뒤에 `CREATE INDEX CONCURRENTLY`로 만든다.
- **NULL 세션의 뜻.** NULL은 이 칸이 생기기 전의 코드가 만든 세션이다. 세션 조회(`resolveWebSession`)에 조건을 하나 더한다: `login_method_id`가 NULL인 세션은 그 사용자에게 외부 로그인 수단(`kind <> 'password'`)이 하나도 없을 때만 유효하다. 그래서 새 코드가 유효하다고 보는 NULL 세션은 모두 비밀번호로 만든 것이다. 이 조건은 새 코드가 처리하는 요청에만 선다. 11.2절이 이유와 배포 중의 범위를 적는다.
- `ResolvedWebSession`에 세션을 만든 시각을 더한다(6.4절).

### 5.5 `login_settings` (새 테이블, 한 행)

| 칸 | 뜻 |
|---|---|
| `password_login` | `on`(기본) 또는 `emergency_only` |
| `emergency_admin_user_id` | 비상 관리자 (9.2절) |

한 행만 있게 한다(값이 고정된 PK와 검사). 5단계에서 더한다.

### 5.6 잠금 순서

로그인 수단과 설정을 건드리는 모든 트랜잭션은 이 순서로 잠근다. 필요 없는 단계는 건너뛰되 거꾸로 가지 않는다.

1. advisory `login:<issuer>:<subject>` (지금 있다)
2. `login_settings` 행 (읽는 쪽은 `FOR SHARE`, 바꾸는 쪽은 `FOR UPDATE`)
3. `login_providers` 행 (읽는 쪽은 `FOR SHARE`, 바꾸는 쪽은 `FOR UPDATE`)
4. advisory `login-email:<email>` (지금 있다)
5. 초대 행
6. 사용자 행
7. 멤버십 행
8. `login_methods` 행
9. `web_sessions`

지금 코드의 순서(초대 → 사용자 → 세션, 멤버 변경의 사용자 → 멤버십)와 맞는다. 비상 관리자 검사가 필요한 멤버 변경은 사용자 행보다 먼저 `login_settings`를 `FOR SHARE`로 잠근다. 비밀번호 초대 수락, 비밀번호 로그인, 재설정 링크 사용처럼 지금 있는 트랜잭션도 `login_settings`를 읽게 되는 단계에서 트랜잭션의 첫 잠금으로 이 순서를 따른다.

## 6. 첫 로그인, 가입, 연결 규칙

### 6.1 판정 순서

목적이 `login`인 흐름의 순서다. `signInWithExternalIdentity`의 순서를 잇는다. 먼저 맞는 규칙이 이긴다. 목적이 `invite`인 흐름은 규칙 0만 함께 쓰고 나머지는 이 표가 아니라 6.5절을 탄다. 초대 흐름이 초대를 확인하지 않은 채 일반 로그인으로 끝나지 않는다.

| 순서 | 조건 | 결과 |
|---|---|---|
| 0 | 공급자가 꺼져 있다 | 거절. 트랜잭션 안에서 공급자 행을 잠가 다시 읽는다(8절) |
| 1 | `(issuer, subject)`가 연결돼 있다 | 그 사용자로 로그인. 계정이나 멤버십이 꺼져 있으면 거절. 이메일은 보지 않는다. 사용자 행을 잠근 뒤 연결 행이 아직 있는지 다시 읽는다 |
| 2 | 연결이 없고, 증명된 주소가 있고, 그 주소의 계정이 있다 | 연결하지 않는다. `409 LOGIN_LINK_REQUIRED` |
| 3 | 계정이 없고, 증명된 주소가 있고, 그 주소의 살아 있는 초대가 있다 | 초대의 역할로 계정을 만들고 연결한다(지금과 같다) |
| 4 | 계정이 없고, 증명된 주소가 있고, 공급자의 JIT가 켜져 있고 6.3절을 통과한다 | `member`로 계정을 만들고 연결한다 |
| 5 | 그 밖 | `401` |

- 규칙 2가 결정 3이다. 다른 issuer에서 같은 이메일로 들어와도 기존 계정에 붙지 않는다. "같은 이메일·다른 issuer의 기존 계정 연결 시도"는 세션 없이 `409`로 끝난다.
- 증명되지 않은 주소로는 규칙 2·3·4 가운데 어느 것도 맞지 않는다. 계정이 있는지도 알려 주지 않는다(`401`).
- 규칙 1은 이메일을 보지 않으므로, IdP에서 주소가 바뀐 사람도 계속 같은 사용자다. `users.email`은 따라 바꾸지 않는다.

### 6.2 이메일: 인증과 주소 소유는 다르다

IdP가 사람을 인증했다는 것은 `(issuer, subject)`를 증명한다. 그 사람이 `email` 클레임의 주소를 소유한다는 것은 따로 증명돼야 한다. Entra ID는 `email`이 정확하다고 보장하지 않으며, Keycloak과 OneLogin은 사용자의 주소와 검증 여부를 따로 관리한다.

**증명된 주소**의 정의:

| issuer | 조건 |
|---|---|
| Google (`https://accounts.google.com`) | `email_verified === true`이고, 주소가 `gmail.com`이거나 `hd`가 주소의 도메인과 같다(지금의 `ownsEmail`과 같다) |
| 그 밖 | `email_verified === true` |

로그인을 받는 조건(4.3절 12):

| 받은 것 | `require_verified_email = true`(기본) | `require_verified_email = false` |
|---|---|---|
| `email_verified === true` | 받는다 | 받는다 |
| `email_verified === false` | `401` | `401` |
| `email_verified`가 없다 | `401` | 받는다. 주소는 증명되지 않은 것이다 |
| `email`이 없다 | `401` | 받는다. 주소가 없다 |

- `require_verified_email = false`는 `email_verified`를 주지 않는 IdP(기본 설정의 OneLogin, Entra ID)를 위한 것이다. 이 설정은 **주소를 믿게 하지 않는다.** 그 로그인의 주소는 초대 찾기, 계정 존재 알림, JIT, 새 계정의 주소 어디에도 쓰이지 않는다. 그런 사람은 규칙 1(이미 연결됨), 초대 token(6.5절), 로그인된 상태의 연결(6.4절)로만 들어온다.
- IdP가 명시적으로 `false`라고 한 주소는 어느 설정에서도 받지 않는다.
- Google에는 `require_verified_email = false`를 받지 않는다.
- Google의 지금 동작 가운데 하나가 그대로 남는다: `email_verified`는 참이지만 `hd` 규칙을 채우지 못한 주소(Google 계정에 붙인 남의 도메인 주소)는 로그인은 받되 증명된 주소로 보지 않는다.

### 6.3 허용 도메인과 JIT

- `allowed_domains`가 비어 있지 않으면, 증명된 주소의 도메인이 목록에 있어야 한다. 증명된 주소가 없는 로그인은 목록이 있는 공급자에서 `403`이다. 밖이면 `403`이다.
- JIT(`jit_role = member`)는 증명된 주소가 있어야 한다. Google에서는 여기에 더해 `allowed_domains`가 있어야 켤 수 있다(지금과 같다). 그 밖의 IdP는 목록 없이도 켤 수 있고, 화면이 "이 IdP가 인증하고 주소를 검증한 모든 사람이 member로 들어온다"고 경고한다.
- 결과: `email_verified`를 주지 않는 IdP에서는 JIT가 되지 않는다. 그 IdP의 사람은 초대로 들어온다. OneLogin은 관리자가 `email_verified`를 사용자 정의 속성으로 더하면 JIT를 쓸 수 있다. 테스트 로그인 결과 화면이 이 상태를 보여 준다(7.3절).

### 6.4 로그인된 상태의 연결

- 화면: 설정 > 내 계정의 "로그인 수단". 연결된 수단과, 켜져 있는 공급자마다 "연결" 버튼을 보여 준다.
- 시작: `POST /v1/auth/me/login-methods/{provider_id}/link/start`. 세션이 **만든 지 10분 안**이어야 한다. 아니면 `403`이고 화면이 다시 로그인하라고 안내한다. 비밀번호가 없는 사용자와 비밀번호 로그인이 꺼진 설치에서도 같은 규칙이 통한다. 흐름 cookie에 목적 `link`, 사용자, 세션 ID를 봉인한다.
- 끝: 콜백이 4.2절의 `link` 조건을 다시 확인한다. 로그인으로 시작한 흐름을 `link`로 바꿀 수 없고, 다른 세션에서 끝낼 수 없다. 세션의 사용자에게 `(issuer, subject)`를 연결한다. 그 `(issuer, subject)`가 이미 누군가에게 연결돼 있으면 `409`다. 그 사용자에게 같은 issuer의 다른 subject가 있으면 `409`다. 새 세션을 만들지 않는다. IdP의 주소는 보지 않는다.
- 끊기: `DELETE /v1/auth/me/login-methods/{id}`. 사용자 행을 잠근 뒤에 판정한다. 쓸 수 있는 수단이 하나도 남지 않으면 거절한다. 쓸 수 있는 수단은 켜진 공급자의 `oidc` 행, 또는 비밀번호 로그인이 그 사용자에게 열려 있을 때의 `password` 행이다. 비상 관리자의 `password` 행은 끊을 수 없다. 끊으면 같은 트랜잭션에서 그 수단으로 만든 세션을 지우고, `password` 행이면 `users.password_hash`도 NULL로 바꾼다. 비밀번호 로그인은 hash를 보므로 행만 지워서는 막히지 않는다.
- 로그인과 끊기의 경합: 로그인(규칙 1)은 사용자 행을 잠근 뒤 연결 행을 다시 읽는다. 끊기는 사용자 행을 잠근 뒤 연결과 세션을 지운다. 둘은 사용자 행에서 한 줄로 선다. 끊기가 먼저면 로그인은 연결을 찾지 못하고, 로그인이 먼저면 끊기가 그 세션을 지운다.
- 연결과 끊기는 감사 receipt를 남긴다.

### 6.5 초대 token으로 가입

- 초대 화면은 비밀번호 칸 옆에 켜진 공급자의 버튼을 보여 준다. 버튼은 `invite_token`을 실어 흐름을 시작한다. 서버는 token으로 초대를 찾아 살아 있는지 보고, 목적 `invite`와 초대 ID를 흐름 cookie에 봉인한다.
- 콜백: 봉인된 초대 **한 건만** 본다. 초대 행을 잠가 아직 살아 있는지 다시 읽는다. 아래 표의 순서로 판정하고, 6.1절의 규칙 1~5는 타지 않는다.

| 경우 | 결과 |
|---|---|
| 초대가 만료·사용·취소됐다 | `401`. `(issuer, subject)`가 이미 연결돼 있어도 로그인시키지 않는다 |
| `(issuer, subject)`가 이미 누군가에게 연결돼 있다 | `409`. 세션을 만들지 않고 초대를 쓰지 않는다. 그 사람은 로그인 화면에서 로그인한다 |
| 초대 주소의 계정이 이미 있다 | 연결하지 않는다. `409 LOGIN_LINK_REQUIRED`. 그 사람은 있던 수단으로 로그인해 연결한다. 초대 token을 쥔 사람은 초대 주소를 이미 안다 |
| 계정이 없다 | 초대 주소로 계정을 만들고, 초대의 역할로 멤버십을 만들고, `(issuer, subject)`를 연결하고, 그 초대를 수락 처리한다. 한 트랜잭션이다. 비밀번호 수락과 같은 `accept_invite` receipt를 남긴다 |

- 권한의 근거는 주소가 아니라 초대 token이다. 비밀번호 수락과 같다. IdP가 준 주소는 증명됐든 아니든 보지 않는다.
- 이것이 "초대로 연결"이다. `email_verified`를 주지 않는 IdP의 사람도 이 길로 가입한다.

## 7. 관리자 화면과 API

### 7.1 화면

- 위치: 설정 > 워크스페이스 > 로그인(`/settings/workspace/login`). owner만 본다(`installation.settings.manage`).
- 목록: 공급자 이름, issuer, 상태(초안·테스트 필요·켤 수 있음·켜짐·켜짐과 새 secret 대기), 마지막 테스트 시각.
- 만들기: 이름과 issuer를 넣는다. 서버가 그 자리에서 discovery를 확인한다(4.4절). 통과하면 꺼진 공급자가 만들어지고, 화면이 redirect URI를 복사 버튼과 함께 보여 주고, 서버가 요청을 보낼 endpoint의 host들을 보여 준다. owner가 redirect URI를 IdP에 등록하고 client ID와 secret을 받아 넣는다.
- 상세: redirect URI, endpoint, client ID, client secret(쓰기 전용: 설정됨·끝 4자·바꾼 시각), client 인증 방식, 허용 도메인, JIT, 검증된 이메일 요구, 테스트 로그인, 켜기·끄기, 삭제.
- `CONSOLE_ORIGIN`이 없으면 만들기 대신 이유를 보여 준다.
- ko·en·ja. 1280·390 폭.

### 7.2 API

모두 `installation.settings.manage`이고, 쓰기는 감사 receipt를 남긴다.

| 경로 | 뜻 |
|---|---|
| `GET /v1/login-providers` | 목록. 공급자마다 `redirect_uri`, endpoint, secret 요약, 상태. `console_origin_configured` |
| `POST /v1/login-providers/discover` `{issuer}` | discovery를 지금 확인한다. 저장하지 않는다. 결과: 통과(endpoint host, 지원 알고리즘, client 인증 방식) 또는 4.4절의 오류 종류, `unreachable`, `address_not_allowed` |
| `POST /v1/login-providers` `{display_name, issuer}` | discovery를 확인하고 꺼진 공급자를 만든다 |
| `PATCH /v1/login-providers/{id}` | 이름, client ID, client 인증 방식, 허용 도메인, JIT, 검증된 이메일 요구. `If-Match`. 켜진 공급자에서는 7.3절의 제한을 따른다 |
| `POST /v1/login-providers/{id}/refresh-discovery` | discovery를 다시 받아 endpoint를 갈아 끼운다. 꺼진 공급자만 |
| `PUT /v1/login-providers/{id}/client-secret` `{value}` | secret을 넣는다. 켜진 공급자에서는 교체 후보로 들어간다 |
| `POST /v1/login-providers/{id}/test/start` | 테스트 로그인을 시작한다 |
| `POST /v1/login-providers/{id}/enable` | 켠다 (7.3절) |
| `POST /v1/login-providers/{id}/disable` | 끄고 세션을 끊는다 (8절) |
| `DELETE /v1/login-providers/{id}` | 꺼진 공급자만 지운다. secret도 지운다. `login_methods` 행은 남는다 |

공개·사용자 경로:

| 경로 | 뜻 |
|---|---|
| `GET /v1/auth/login-methods` | `{password: "on" \| "emergency_only", providers: [{id, display_name}]}`. 켜진 공급자만 |
| `POST /v1/auth/providers/{id}/start` `{invite_token?}` | 로그인 또는 초대 가입 시작 |
| `POST /v1/auth/oidc/callback` | 목적에 따라 `{outcome: "signed_in", …}`, `{outcome: "linked"}`, `{outcome: "tested", …}` |
| `GET /v1/auth/me/login-methods` | 내 로그인 수단 |
| `POST /v1/auth/me/login-methods/{provider_id}/link/start`, `DELETE /v1/auth/me/login-methods/{id}` | 6.4절 |

`/v1/auth/google/start`, `/v1/auth/google/callback`과 웹 경로 `/auth/google/callback`은 없앤다. `GET /v1/auth/login-methods`의 응답 모양이 바뀐다. 이 API의 소비자는 콘솔뿐이다.

### 7.3 테스트 로그인, 켜기, 켜진 공급자의 변경

원칙: **로그인에 쓰이는 연결 설정은 언제나 테스트 로그인을 통과한 설정이다.**

테스트 로그인:

- 꺼진 공급자에도 돈다. owner 세션에서만 시작하고, 콜백은 4.2절의 `test` 조건을 다시 확인한다.
- 흐름 cookie에 시작 때의 `config_revision`과, 시험하는 secret의 슬롯·버전을 봉인한다.
- 4.3절 검증을 처음부터 끝까지 그대로 돌린다. 계정도 세션도 만들지 않는다.
- 통과 기록은 조건부 갱신 한 문장이다: 공급자 행의 `config_revision`과 secret 버전이 cookie의 것과 같을 때만 `tested_config_revision`을 적는다. 흐름 도중 설정이 바뀌었으면 기록하지 않고 "설정이 바뀌었으니 다시 테스트하라"고 답한다.
- 결과 화면은 받은 `sub`, `email`, `email_verified`, 주소가 증명됐는지, 도메인 판정, 그리고 "이 계정이 로그인하면 어떻게 되는지"(6.1절의 어느 규칙)를 보여 준다. 실패하면 이유 코드를 보여 준다. owner는 여기서 `email_verified`가 오지 않는 IdP와 그 결과(JIT 불가, 초대로 가입)를 알아본다.

켜기:

- 조건부 갱신 한 문장이다: `tested_config_revision = config_revision`이고 client ID와 secret이 있을 때만 `enabled = true`가 된다. 아니면 `409`다.
- 꺼진 공급자의 연결·정책 설정을 바꾸면 `config_revision`이 올라 다시 테스트해야 켤 수 있다.

켜진 공급자에서 바꿀 수 있는 것:

| 무엇 | 방식 |
|---|---|
| 이름 | 바로 적용 |
| 허용 도메인, JIT, 검증된 이메일 요구 | 바로 적용. receipt를 남긴다 |
| client secret | 교체 후보(`login_client_secret_next`)로 들어간다. 로그인은 있던 secret을 계속 쓴다. 테스트 로그인이 후보로 통과하면 같은 트랜잭션에서 후보가 쓰는 값이 된다. 통과하지 못한 후보는 로그인에 쓰이지 않는다 |
| issuer | 바꿀 수 없다. issuer가 바뀌면 모든 사용자의 신원이 바뀐다. 지우고 새로 만든다 |
| client ID, client 인증 방식, endpoint | 켜진 채로는 바꿀 수 없다(`409`). 끄고, 바꾸고, 테스트하고, 켠다 |

- secret만 교체 후보를 두는 이유: secret은 만료된다(Entra ID는 수명을 강제한다). 끄면 세션이 끊기므로, 정기 교체가 모든 사용자를 로그아웃시키면 안 된다. client ID와 endpoint의 변경은 드물고, 끄고 바꾸는 값을 치를 만하다.
- 정책(허용 도메인, JIT, 검증된 이메일 요구)을 테스트 상태에 묶지 않는 이유: 테스트 로그인은 한 계정으로 IdP 연결이 되는지를 증명한다. 정책은 누구를 받을지의 규칙이고, 한 번의 로그인으로 증명되지 않는다. 묶으면 owner 자신의 계정이 새 정책을 통과해야만 정책을 바꿀 수 있게 되고, 통과했다는 사실이 정책이 맞다는 뜻도 아니다. 정책 변경은 멤버 역할 변경과 같이 receipt가 남는 owner의 행동이다. 꺼진 공급자에서는 정책 변경도 `config_revision`을 올리므로, 켜는 순간의 설정 전체는 테스트를 거친 것이다.

## 8. 공급자 끄기와 세션

- 끄기는 한 트랜잭션이다: 공급자 행을 `enabled = false`로 바꾸고, 그 뒤의 별도 문장으로 `login_methods.issuer`가 그 issuer인 수단으로 만든 살아 있는 세션을 모두 끊는다(`revoked_at`). 교체 후보 secret이 있으면 지운다. receipt에 끊은 세션 수를 적는다.
- 경합: 로그인·초대 가입·연결 트랜잭션은 공급자 행을 `FOR SHARE`로 읽고 세션을 만들 때까지 그 잠금을 쥔다. 끄기의 `UPDATE`는 그 잠금이 풀릴 때까지 기다리므로, 먼저 끝난 로그인의 세션은 뒤따르는 세션 끊기 문장이 본다(READ COMMITTED에서 문장마다 새 스냅샷). 끄기가 먼저 끝나면 로그인은 꺼진 행을 보고 거절한다. 끈 뒤에 그 공급자의 세션이 남는 순서는 없다.
- 요청마다 세션을 확인하는 조회는 공급자 상태를 보지 않는다. 세션은 끌 때 끊긴다.
- 끄기가 끊는 것은 수단이 기록된 세션이다. 수단이 기록되지 않은 옛 세션(NULL)은 5.4절의 조회 조건이 무효로 본다. 둘 다 새 코드의 보장이다. 옛 버전 프로세스가 인증 요청을 받고 있는 동안에는 설치 전체의 보장이 아니다(11.2절).
- 삭제는 꺼진 공급자에만 된다. 그래서 삭제에는 끊을 세션이 없다.
- owner가 자기가 로그인한 공급자를 끄면 자기 세션도 끊긴다. 화면이 끄기 전에 끊길 세션 수와 이 사실을 보여 준다.
- 알려 둘 한계: IdP에서 사람을 지워도 werft 세션은 남는다. 세션은 쓰는 동안 계속 늘어난다. 지금은 멤버를 끄는 것이 세션을 끊는 길이다. SCIM과 RP-initiated logout 후속 티켓이 이 틈을 다룬다.

## 9. 비밀번호 끄기, 비상 관리자, CLI 복구

### 9.1 비밀번호 로그인

- `login_settings.password_login`이 `emergency_only`이면 비상 관리자만 비밀번호로 로그인한다. 다른 사용자의 비밀번호 로그인은 틀린 비밀번호와 같은 `401`이다. 비밀번호 로그인 트랜잭션은 `login_settings`를 `FOR SHARE`로 읽는다.
- `emergency_only`로 바꾸려면 셋이 모두 참이어야 한다: 켜진 공급자가 하나 이상 있다, 비상 관리자가 지정돼 있고 9.2절의 자격을 지금도 채운다, 바꾸는 owner 자신이 켜진 공급자의 로그인 수단을 갖고 있거나 비상 관리자다. 마지막 조건은 owner가 자기를 잠그지 않게 한다.
- 바꾸면 같은 트랜잭션에서 비상 관리자가 아닌 사용자의 비밀번호 세션(`login_method_id`가 `password` 행이거나 NULL)을 끊는다.
- `emergency_only` 동안에는 초대 수락의 비밀번호 설정, owner가 내는 비밀번호 재설정 링크의 발급과 사용이 비상 관리자가 아닌 사용자에게 닫힌다. 운영자 CLI가 낸 링크는 따로다(9.3절). 초대 화면은 공급자 버튼만 보여 준다.
- 로그인 화면은 공급자 버튼을 보여 주고, 비밀번호 칸은 "비상 관리자 로그인" 링크 뒤에 둔다.
- 마지막으로 켜진 공급자를 끄려 하면, `emergency_only`인 동안에는 거절한다. 먼저 비밀번호 로그인을 켠다. CLI는 둘을 한 번에 한다.
- 비밀번호 전환, 비상 관리자 교체, 마지막 공급자 끄기는 모두 `login_settings` 행을 `FOR UPDATE`로 잠그고 한다. 그래서 서로 한 줄로 선다.

### 9.2 비상 관리자

- 한 명이다. 자격: 계정과 멤버십이 켜져 있고 비밀번호가 있는 owner.
- **지정은 지우지 않고 바꾸기만 한다.** 다른 자격 있는 owner로 바꾸는 것은 한 트랜잭션이다. 한 번 지정되면 비상 관리자가 없는 상태로 돌아가지 않는다.
- 처음 지정:
  - 새 설치: bootstrap이 만든 owner가 비상 관리자다. bootstrap은 항상 비밀번호를 받는다.
  - 업그레이드: `login_settings`를 만드는 마이그레이션이 자격 있는 owner 가운데 멤버십이 가장 오래된 사람을 지정한다. 화면이 누구인지 보여 주고 owner가 바꿀 수 있다.
  - 자격 있는 owner가 한 명도 없는 설치(모든 owner가 외부 로그인만 쓴다)는 지정이 비어 있다. 이 상태에서는 `emergency_only`로 바꿀 수 없다. 화면과 CLI `status`가 이것을 알린다. CLI `reset-password`로 낸 링크를 owner가 써서 비밀번호를 정하는 그 트랜잭션이 그 owner를 지정한다(9.3절). 링크를 내는 것만으로는 지정되지 않는다.
  - owner가 한 명도 없을 때의 `BOOTSTRAP_TOKEN` 복구는 새 owner를 비상 관리자로 지정한다.
- 지정된 동안에는 그 사람을 끄거나, 내보내거나, owner가 아니게 바꾸거나, 그 비밀번호 수단을 끊을 수 없다. 먼저 다른 owner를 비상 관리자로 바꾼다. 이 검사는 멤버 변경 트랜잭션이 `login_settings`를 먼저 `FOR SHARE`로 잠그고 한다(5.6절).
- 비상 관리자의 비밀번호 로그인은 다른 사용자와 같은 잠금 창(`LoginLockout`)을 쓴다.

### 9.3 운영자 CLI

`apps/control-host/src/api/login-recovery.ts`. API 컨테이너 안에서 `DATABASE_URL`과 `PLATFORM_SECRET_KEY`로 실행한다. 출력은 JSON 한 줄이고 종료 코드가 계약이다. 쓰기마다 receipt를 남기고 actor는 운영자 CLI다.

| 명령 | 뜻 |
|---|---|
| `status` | 공급자(이름, issuer, 켜짐), `password_login`, 비상 관리자 주소 |
| `enable-password` | `password_login`을 `on`으로 |
| `disable-provider --id <id>` 또는 `--all` | 공급자를 끄고 세션을 끊는다. `emergency_only`였다면 같은 트랜잭션에서 먼저 `password_login`을 `on`으로 바꾼다 |
| `reset-password --email <주소>` | 그 owner에게 한 번 쓰는 비밀번호 재설정 링크를 낸다. 링크를 써서 비밀번호를 정하면 그 owner가 비상 관리자가 된다 |

`reset-password`는 있던 재설정 흐름을 그대로 쓰지 못한다. 그 흐름은 대상에게 비밀번호가 이미 있어야 하고, 발급자를 비밀번호로 다시 인증한 owner로 받는다. 그래서 운영자 전용 계약을 둔다.

- 발급: 대상은 계정과 멤버십이 켜진 owner여야 한다. 비밀번호가 없어도 된다. 발급자는 사용자가 아니라 운영자 CLI이고, `password_resets` 행이 그것을 구분한다. **발급은 비상 관리자 지정을 바꾸지 않는다.** 쓰지 않은 링크는 비밀번호가 아니다. 지금의 비상 관리자는 링크가 쓰일 때까지 그대로 비밀번호로 들어온다.
- 사용: 한 트랜잭션에서 `login_settings`를 `FOR UPDATE`로 잠그고, 대상이 지금도 계정과 멤버십이 켜진 owner인지, 링크가 만료·사용·취소되지 않았는지 본다. 통과하면 hash를 적고, `password` 수단이 없으면 만들고, 그 사용자의 모든 세션을 끊고, **같은 트랜잭션에서** 그 owner를 비상 관리자로 지정한다(이미 그 사람이면 그대로 둔다). 지정이 바뀌는 순간 새 비상 관리자에게는 실제 비밀번호가 있다. 링크가 쓰이지 않거나 만료되면 아무것도 바뀌지 않는다.
- 운영자가 낸 링크의 사용은 `emergency_only`에서도 그 대상에게 열려 있다. 운영자는 DB와 `PLATFORM_SECRET_KEY`를 쥔 사람이고, 이것이 잠긴 설치로 들어오는 길이다.
- 지정이 비어 있는 설치(9.2절)에서도 같다. 링크를 내는 것은 자격을 채우지 않고, 링크를 써서 비밀번호를 정하는 트랜잭션이 지정한다.
- 링크는 owner가 내는 재설정 링크와 같이 60분 뒤 만료되고(`PASSWORD_RESET_TTL_MINUTES`) 한 번만 쓴다. 다른 secret과 달리 이 token은 출력해야 쓸 수 있다.

## 10. 공급자별 차이

아래 표의 IdP 쪽 사실은 각 공급자의 공개 문서 기준이다(2026-11-13 확인). 6단계의 계약 시험이 이 모양을 mock IdP로 고정하고, Keycloak은 실제 서버로 확인한다. 실제 Google Workspace와 OneLogin 확인은 오너 몫 하위 티켓으로 남긴다.

| IdP | issuer 모양 | 주소 증명 | 그 밖 | 결과 |
|---|---|---|---|---|
| Google | `https://accounts.google.com` | `email_verified`가 온다. Workspace 계정은 `hd`가 온다 | id_token `iss`가 스킴 없이 올 수 있다 | 로그인, 초대(주소·token), JIT(허용 도메인 필수) |
| OneLogin | `https://<subdomain>.onelogin.com/oidc/2` | 기본으로는 `email_verified`가 오지 않는다. 관리자가 사용자 정의 속성으로 더할 수 있다 | client 인증 방식을 앱에서 하나만 고른다 | 기본 설정: `require_verified_email = false`로 로그인, 초대 token으로 가입, JIT 불가. `email_verified`를 더하면 JIT 가능 |
| Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | `email_verified`가 오지 않는다. `email`은 정확하다고 보장되지 않고, 앱 등록에서 켜야 온다 | `common`·`organizations` issuer는 discovery의 `issuer`가 `{tenantid}` 틀이라 `issuer_mismatch`다. 화면이 "tenant별 issuer를 쓰라"고 안내한다. `sub`는 앱마다 다르다 | `require_verified_email = false`로 로그인, 초대 token으로 가입, JIT 불가 |
| Okta | `https://<org>.okta.com` 또는 `…/oauth2/<server>` | `email_verified`가 온다 | code 흐름의 id_token은 얇을 수 있다. scope의 클레임 전체는 UserInfo가 준다 | UserInfo 보완(4.3절 12)으로 로그인, 초대, JIT |
| Keycloak | `https://<host>/realms/<realm>` | `email_verified`가 온다. 검증 안 한 사용자는 `false`다 | `ES256`으로 서명하게 설정할 수 있다 | 검증된 사용자: 로그인, 초대, JIT. `false`인 사용자: 거절. Keycloak에서 검증한다 |

PKCE 강제:

- werft는 언제나 S256을 보낸다. IdP가 verifier를 검사하는지는 IdP의 성질이다. Keycloak은 실제 서버로, 틀린 verifier의 거절을 e2e에서 확인한다.
- OneLogin의 문서는 PKCE를 client 인증 방식 "None (PKCE)"와 묶어 설명하고, Basic·POST에 PKCE 인자를 함께 보냈을 때의 동작은 적지 않았다. werft는 secret이 있는 client만 지원한다. 그래서 OneLogin에서 확인할 것은 둘이다: Basic 또는 POST에 PKCE 인자를 함께 보낸 로그인이 되는가, 틀린 verifier가 거절되는가. 이 둘을 오너의 OneLogin 확인 티켓의 절차로 적고, 그 티켓은 설계 승인 직후에 만든다.
- 실제 OneLogin 확인은 구현과 나란히 간다. OneLogin 테넌트가 없다는 것은 구현을 시작하지 못할 이유가 아니다.
- 첫째가 실패하면(OneLogin이 그 조합을 거절하면) OneLogin 지원에 secret 없는 client가 필요하다는 뜻이고, 그것은 이 문서의 결정을 바꾸는 일이라 그때 새로 정한다. PKCE를 빼는 것으로 풀지 않는다.
- 둘째가 "거절되지 않는다"이면 **OneLogin은 "PKCE verifier 틀림" 인수 조건을 채우지 못한 것이다.** 그 경우 OneLogin 지원은 확정하지 않고 오너에게 올린다. 선택지는 OneLogin 지원을 미루는 것과 secret 없는 client("None (PKCE)")를 새 결정으로 더하는 것이다. 이 문서는 그 상태를 "지원한다"로 적지 않는다.
- mock IdP에 "secret 인증일 때 PKCE를 검사하지 않는" 모양을 더한다. 이것은 그런 IdP를 만났을 때 나머지 거절 경우(state, nonce, client 인증, 서명, 클레임)가 그대로 막히는지를 고정하는 시험이다. PKCE 인수 조건의 증거가 아니다. 그 증거는 verifier를 검사하는 mock과 실제 Keycloak의 거절, 그리고 실제 OneLogin의 확인이다.

그 밖:

- `sub`가 앱마다 다른 IdP(Entra ID)에서는 client ID를 다른 앱 등록으로 바꾸면 모든 사용자의 `sub`가 바뀌어 연결이 끊긴다. 화면이 client ID를 바꿀 때 이 경고를 보여 준다.
- issuer 끝의 `/`는 고치지 않는다. discovery 주소를 만들 때만 뗀다.

## 11. `GOOGLE_OIDC_*` 제거와 마이그레이션

### 11.1 제거

- `googleLoginConfigFromEnv`와 `server.ts`의 호출, `infra/compose.core.yml`의 여섯 변수, 운영 문서의 표, verify 스킬의 설정 예를 지운다. 남은 값이 있어도 읽지 않고 경고도 내지 않는다.
- 확인: 저장소에서 `GOOGLE_OIDC` 검색 결과가 CHANGELOG와 이 문서 밖에서 0건이다.
- CHANGELOG "운영자가 할 일": "Google 로그인은 웹 관리 화면에서 공급자로 다시 등록한다. `CONSOLE_ORIGIN`이 있어야 한다. redirect URI가 `<CONSOLE_ORIGIN>/auth/callback/<provider_id>`로 바뀌므로 Google Cloud 콘솔의 승인된 리디렉션 URI도 바꾼다."
- 있던 Google 사용자의 `login_methods` 행은 남는다(`kind`만 `oidc`로). owner가 같은 issuer로 공급자를 다시 등록하고 켜면 그 사람들은 전과 같은 사용자로 로그인한다.

### 11.2 마이그레이션

| 변경 | 방식 | 되돌리기 |
|---|---|---|
| `login_providers`, `login_settings` 생성 | 새 테이블. `login_settings`의 한 행은 9.2절대로 채운다 | 지우면 된다 |
| `login_methods.kind` `google` → `oidc`, 검사 교체 | 작은 테이블의 `UPDATE`와 검사 교체(`login_methods`는 커지는 테이블 목록에 없다) | 옛 코드는 `oidc` 행을 찾지 못한다. 옛 버전으로 되돌리려면 `kind`를 되돌리는 SQL이 필요하다. PR에 적는다 |
| `login_methods (user_id, issuer)` 유일 인덱스 | 어긴 행을 먼저 세고, 있으면 멈춘다 | 인덱스를 지우면 된다 |
| `web_sessions.login_method_id` | NULL 허용 칸, 기본값 없음, 외래 키 없음. 인덱스는 `DROP INDEX CONCURRENTLY IF EXISTS` 뒤 `CREATE INDEX CONCURRENTLY` | 칸을 지우면 된다 |

`web_sessions`의 행은 마이그레이션에서 고치지 않는다. 안전 검사가 이 테이블의 `UPDATE`를 거절한다.

옛 세션의 처리: 업그레이드 전 세션은 어떤 수단으로 만들었는지 모른다. 업그레이드 뒤에는 공급자가 하나도 없으므로, 외부 로그인으로 만든 세션은 결정 4에 따라 끊겨 있어야 한다. 5.4절의 조회 조건이 이것을 데이터 수정 없이 한다. 외부 로그인 수단을 가진 사용자의 NULL 세션은 새 코드가 유효하다고 보지 않는다. 그 사용자는 다시 로그인한다. 비밀번호만 쓰는 사용자의 NULL 세션은 그대로 유효하다.

- 이 조건은 **새 코드가 처리하는 요청**의 보장이다. 옛 버전 프로세스는 이 조건을 모르고, 수단을 적지 않은 세션을 계속 만들고 받는다. 옛 프로세스가 인증 요청을 받는 동안에는 외부 로그인으로 만든 옛 세션이 그 프로세스에서 유효하다.
- 그래서 "업그레이드가 끝났다"와 "공급자를 끄면 그 세션이 끊긴다"는 설치 전체의 보장은 옛 버전 프로세스가 모두 내려간 뒤부터 선다. 옛 프로세스가 배포 중에 만든 NULL 세션도 새 코드에서는 같은 조건으로 판정된다. 2단계 PR의 CHANGELOG "운영자가 할 일"에 "옛 버전 API 프로세스를 모두 내린 뒤에 공급자를 등록한다"를 적는다. 구체적인 절차(compose는 컨테이너 교체로 끝나고, replica가 여럿인 배포는 교체가 끝나기를 기다린다)는 2단계 PR에서 정한다.
- 비밀번호만 쓰던 사용자가 나중에 공급자를 연결하면 그 사람의 옛 NULL 세션은 그때 무효가 된다. 연결은 만든 지 10분 안의 세션에서만 시작하므로(6.4절), 연결하는 그 세션은 새 코드가 만든 것이고 영향을 받지 않는다.
- 값: 요청마다 도는 세션 조회에 `login_methods`의 인덱스 조회가 하나 는다. NULL 세션일 때만 평가된다.

### 11.3 영향

- Google만으로 로그인하던 사용자는 owner가 공급자를 다시 등록하고 켤 때까지 로그인할 수 없다. 결정 7의 결과다.
- 2단계가 환경 변수를 지우고, 3단계가 관리자 화면을, 5단계가 CLI 복구를 더한다. 2단계와 5단계 사이의 `main`은 SSO를 설정하거나 복구하는 길이 덜 갖춰져 있다. 릴리스는 5단계가 들어간 뒤에 자른다. 각 PR의 CHANGELOG에 이 순서를 적는다.

## 12. 단계별 PR

| 단계 | 내용 | 동작 변경 | 채우는 인수 조건 |
|---|---|---|---|
| 1 | `oidc/` 모듈: 주소 검사와 네트워크 정책, discovery 검증, 키 선택, `iat`·`aud` 배열·`azp` 규칙, `ES256`, 응답 `iss`, UserInfo 보완. Google 로그인을 그 위로 옮긴다(환경 변수 설정은 이 단계까지 남는다). mock IdP에 키 회전을 더한다 | Google 로그인의 통과 경우는 같다. 더 거절하는 경우(`iat` 없음, 평문 endpoint 등)를 PR에 적는다 | 검증 항목, 거절 경우(토큰) |
| 2 | 5절의 테이블·칸과 마이그레이션, 공급자 저장소, 봉인한 흐름 cookie, 공개 경로를 `providers/{id}`로, `GOOGLE_OIDC_*` 제거, 로그인 화면의 버튼을 공급자 목록으로, 세션에 수단 기록, 끄기와 세션 끊기(저장소), 잠금 순서 | Google 환경 변수 설정이 사라진다. 공개 경로와 `login-methods` 응답이 바뀐다. 외부 수단을 가진 사용자의 옛 세션이 무효가 된다 | 환경 변수 0건, `(issuer, subject)` 식별, 꺼진 공급자 거절, 세션 끊기(시험) |
| 3 | 관리자 API와 화면: 만들기, discovery 확인, redirect URI, secret과 교체 후보, 테스트 로그인, 켜기·끄기·삭제, receipt | owner가 화면에서 공급자를 설정한다 | 관리자 화면 전체 |
| 4 | 초대 token 가입, JIT·검증된 이메일 요구 설정의 화면, 로그인된 상태의 연결·끊기 | 계정 연결이 생긴다 | 연결 규칙, 첫 가입 |
| 5 | `login_settings`, 비밀번호 끄기, 비상 관리자, `login-recovery` CLI와 운영자 재설정 | 비밀번호 로그인을 끌 수 있다 | 비밀번호 끄기·복구 실행 |
| 6 | mock IdP의 공급자 모양(Google, OneLogin, Entra ID, Okta, Keycloak) 계약 시험, Keycloak을 붙인 스택의 브라우저 e2e, 복구 실행 기록 | 없음 | 공급자별 로그인·가입, e2e |

e2e의 Keycloak은 API 컨테이너와 네트워크 이름공간을 함께 쓰는 compose overlay로 붙인다. API와 브라우저가 같은 `http://localhost:<port>` issuer로 Keycloak에 닿으므로 4.5절의 로컬 예외 안에 있다.

시험으로 고정하는 거절 경우: 서명 틀림, `alg` 허용 밖, 키 부적합(`use`, `kty`, 짧은 RSA), 만료, `iat` 미래·오래됨·숫자 아님, `aud` 불일치, 추가 audience, `azp` 불일치, `iss` 불일치, 응답 `iss` 불일치·누락, nonce 불일치, state 불일치, 흐름 만료, 열리지 않는 cookie, 목적을 바꾼 cookie, `provider_id` 불일치, 흐름 도중 설정 변경, PKCE verifier 틀림, UserInfo `sub` 불일치, 허용 도메인 밖, `email_verified: false`, 미검증 이메일, 이메일 없음, 증명되지 않은 주소로 초대 찾기·JIT·계정 존재 확인, 같은 이메일·다른 issuer, 남의 초대 token 없이 주소만 같은 가입, 만료된 초대 token, 만료된 초대 흐름에서 이미 연결된 `(issuer, subject)`, 살아 있는 초대 흐름에서 이미 연결된 `(issuer, subject)`, 이미 다른 사용자에게 연결된 `(issuer, subject)`의 연결 시도, 오래된 세션의 연결 시작, 다른 세션에서 끝낸 연결, 꺼진 공급자의 시작과 콜백, 끄기와 겹친 로그인, 끊기와 겹친 로그인, 마지막 수단 끊기, owner가 아닌 사용자의 관리 API, 테스트 통과 전 켜기, 테스트 도중 바뀐 설정, 통과하지 못한 교체 후보 secret, 평문 endpoint, link-local로 풀리는 host, 비상 관리자 끄기·내보내기, 비상 관리자 없는 `emergency_only` 전환, 운영자 링크를 내기만 하고 쓰지 않았을 때 있던 비상 관리자의 로그인(통과해야 한다), 만료된 운영자 링크.

## 13. 위협과 대응

| 위협 | 대응 |
|---|---|
| 로그인 CSRF(공격자의 code를 피해자 브라우저에 넣음) | state를 봉인한 `__Host-` cookie와 비교. CSRF 헤더 필수 |
| code 가로채기 | client secret. PKCE S256(IdP가 강제하는 만큼) |
| id_token 재사용 | nonce. `iat` 상한 |
| 위조 token | JWKS 서명 검증. `alg` 허용 목록. 키 적합성. `none`·`HS*` 거절 |
| 다른 client용 token | `aud`·`azp` |
| IdP mix-up | 공급자별 redirect URI, 화면이 받은 경로의 `provider_id`와 봉인된 `provider_id`의 일치, 응답 `iss`, id_token `iss` |
| 이메일로 계정 탈취·초대 가로채기 | `(issuer, subject)` 식별. 자동 연결 없음. 증명된 주소만 판정에 쓴다. 초대는 token으로 받는다 |
| 계정 열거 | `401` 문구 하나. `409 LOGIN_LINK_REQUIRED`는 주소가 증명됐거나 초대 token을 쥔 사람에게만 |
| 탈취한 세션으로 로그인 수단 추가 | 만든 지 10분 안의 세션만 연결을 시작한다. 목적과 세션을 cookie에 봉인하고 콜백에서 다시 확인한다 |
| 서버를 내부 주소로 보내기 | `https`만, 주소 분류, 판정한 주소로 연결, redirect 안 따름, 크기·시간 제한, endpoint 고정, 응답 원문 미노출 |
| client secret 노출 | `secret_values`에 봉인. API는 돌려주지 않음. 로그에 남기지 않음. 평문 endpoint 거절 |
| 시험하지 않은 연결 설정의 사용 | `config_revision` 조건부 갱신. 켜진 공급자의 연결 설정은 고정, secret은 후보로 시험 |
| 끈 공급자의 세션 잔존 | 한 트랜잭션에서 끄고 끊음. 행 잠금으로 경합을 막음 |
| 끊은 수단으로 로그인 | 사용자 행 잠금 뒤 연결을 다시 읽음. 비밀번호 수단은 hash도 지움 |
| SSO 고장으로 잠김 | 비상 관리자(지우지 않고 바꾸기만), CLI |
| 인증 없는 콜백으로 IdP 호출 남발 | 동시 실행 상한 |

## 14. 하지 않는 것과 확장 지점

| 후속 | 이 설계에서 쓸 곳 |
|---|---|
| IdP 그룹→역할 매핑 | `login_providers`에 scope 칸과 매핑 칸을 더한다. id_token의 `groups` 클레임을 `oidc/id-token.ts`가 신원에 싣고, 6.1절 규칙 1·3·4와 6.5절의 가입 뒤에 멤버십 역할을 정한다 |
| SCIM 프로비저닝 | 사용자를 `login_methods (issuer, subject)`로 찾는다. 비활성화는 멤버 끄기와 세션 끊기를 부른다. 공급자별 SCIM token은 `secret_values`의 `login_provider:<id>` owner에 purpose를 하나 더한다 |
| SAML | `login_methods.kind = 'saml'`, `issuer`에 entity ID, `subject`에 NameID. `login_providers`에 `protocol` 칸을 더한다. 6절 규칙과 8절 세션 끊기는 그대로 쓴다. 코드는 `apps/control-host/src/api/saml/` |
| RP-initiated logout | discovery의 `end_session_endpoint`를 `login_providers`에 고정한다. id_token을 보관해야 하므로 `web_sessions`에 봉인한 칸이 필요하다. `web_sessions.login_method_id`로 어느 공급자의 세션인지 안다 |
| 이메일 도메인 기반 공급자 자동 선택 | `login_providers.allowed_domains`를 도메인→공급자 표로 쓴다. `GET /v1/auth/login-methods`에 주소를 받아 공급자를 돌려주는 조회를 더한다 |

그 밖에 하지 않는 것: workspace별 공급자, client secret 없는 client, `private_key_jwt`, 세션 수명 상한, IdP의 이메일 변경을 `users.email`에 반영, 증명되지 않은 주소의 JIT.

## 15. 정한 것 가운데 다시 볼 만한 것

오너에게 묻지 않고 이 문서가 정했다. 리뷰가 다르게 보면 바꾼다.

1. JWKS를 캐시하지 않는다(4.6절).
2. 흐름을 서버에 저장하지 않고 봉인한 cookie에 둔다(4.2절).
3. 연결 시작의 조건을 "만든 지 10분 안의 세션"으로 둔다(6.4절).
4. 켜진 공급자에서 secret은 교체 후보로 바꾸고, 정책은 바로 바꾸고, 나머지 연결 설정은 끄고 바꾼다(7.3절).
5. 옛 세션을 마이그레이션으로 끊지 않고 조회 조건으로 무효로 본다. 설치 전체의 보장은 옛 버전 프로세스가 내려간 뒤부터다(5.4절, 11.2절).
6. 모듈을 워크스페이스 패키지로 만들지 않는다(3.2절).
7. `http` issuer를 loopback host이고 `CONSOLE_ORIGIN`도 loopback일 때만 받는다(4.5절).
8. discovery를 로그인 중에 받지 않고 endpoint를 공급자 행에 고정한다(4.4절).
9. 증명되지 않은 주소로는 JIT를 하지 않는다. `email_verified`를 주지 않는 IdP의 사람은 초대로 들어온다(6.3절).
10. 사설 주소의 IdP를 허용한다(4.5절).

## 16. 진행 상태

| 단계 | 상태 | PR |
|---|---|---|
| 0 설계 | 머지 | JeongJaeSoon/werft#1660 |
| 1 OIDC 코어 | PR | JeongJaeSoon/werft#1662 |
| 2~6 | 시작 전 | — |

1단계는 3.1절의 표에서 `provider-http.ts`, `discovery.ts`, `jwks.ts`, `id-token.ts`, `flow.ts`(시작과 끝), `issuer-rules.ts`, `errors.ts`를 넣고 환경 변수로 설정한 Google 로그인을 그 위로 옮긴다. 흐름 cookie의 봉인, 응답 `iss`를 라우트에서 넘기는 일, `admission.ts`는 공급자 행이 생기는 2단계에 넣는다. 1단계의 네트워크 정책에는 `http` issuer를 그대로 받는 값이 하나 더 있다. 환경 변수 Google 로그인의 mock IdP만 쓰고, 2단계에서 환경 변수와 함께 없앤다.

## 17. 리뷰 기록

### 1회차 (2026-11-13, Codex, 판정: 변경 요청)

| # | 심각도 | 지적 | 반영 |
|---|---|---|---|
| 1 | BLOCKER | `email_trust = provider`가 검증되지 않은 주소를 초대 수락의 소유 증명으로 올린다 | 받았다. `email_trust`를 없앴다. 인증과 주소 소유를 가르고(6.2절), 증명되지 않은 주소는 판정에 쓰지 않으며, 초대는 token으로 받는다(6.5절). 명시적 `false`는 거절한다 |
| 2 | MAJOR | `https` issuer만 봐서는 discovery가 가리킨 평문·내부 endpoint를 막지 못한다 | 받았다. 모든 endpoint의 주소 검사, 풀린 주소의 분류, 판정한 주소로 연결(4.5절), endpoint 고정(4.4절). `http` 예외를 loopback으로 좁혔다. 사설 주소의 IdP는 허용으로 남기고 이유를 적었다 |
| 3 | MAJOR | 서명 없는 cookie의 목적으로 분기하면 연결 시작의 10분 제한을 우회한다 | 받았다. cookie를 봉인하고 목적·사용자·세션 ID·공급자·설정 revision을 묶었다. 콜백이 다시 확인한다(4.2절). 서버 저장 대신 봉인을 고른 이유를 적었다 |
| 4 | MAJOR | 테스트 지문과 켜진 설정의 연결이 불완전하다 | 대부분 받았다. `config_revision` 조건부 갱신, 흐름에 revision과 secret 버전 봉인, 켜진 공급자의 연결 설정 고정, secret 교체 후보(7.3절). 정책을 테스트 상태에 묶으라는 부분은 꺼진 공급자에만 받았고, 켜진 공급자에서 바로 적용하는 이유를 7.3절에 적었다 |
| 5 | MAJOR | 로그인과 수단 끊기의 경합 | 받았다. 잠금 순서(5.6절), 사용자 잠금 뒤 연결 다시 읽기, 끊기의 직렬화, 비밀번호 수단은 hash도 지움(6.4절) |
| 6 | MAJOR | 비상 관리자 지정을 지울 수 있다 | 받았다. 지우지 않고 바꾸기만 한다. 처음 지정(bootstrap, 업그레이드)과 잠금 순서를 정했다(9.2절) |
| 7 | MAJOR | 비밀번호 없는 owner의 CLI 복구는 있던 재설정 흐름으로 되지 않는다 | 받았다. 운영자 전용 발급·사용 계약을 정했다(9.3절) |
| 8 | MAJOR | id_token에 이메일이 항상 있다는 전제는 Okta에서 깨진다 | 받았다. UserInfo 보완과 `sub` 일치 검사(4.3절 12) |
| 9 | MAJOR | OneLogin에서 secret 인증과 S256을 함께 강제할 수 있는지 확인되지 않았다 | 일부 받았다. 공개 문서를 다시 읽어 "문서에 없다"를 확인했고, 틀린 verifier의 거절을 IdP의 성질로 고쳐 적었다(4.3절, 10절). 실제 OneLogin 확인은 오너만 할 수 있어 구현의 선행 조건으로 두지 못한다. 대신 확인 티켓을 승인 직후에 만들고, 실패할 때의 처리(PKCE를 빼지 않고 새로 결정)를 정했으며, PKCE를 검사하지 않는 IdP 모양을 시험에 더했다 |
| 10 | MAJOR | `web_sessions`의 `UPDATE` 마이그레이션은 안전 검사에 걸리고, 옛 프로세스가 NULL 세션을 더할 수 있다 | 받았다. 마이그레이션에서 세션을 고치지 않는다. 조회 조건으로 무효로 본다(5.4절, 11.2절). 인덱스 앞의 `DROP … IF EXISTS`를 적었다 |
| 11 | MINOR | discovery 검증과 client 인증 기본값 | 받았다(4.4절, 4.3절 6·9) |
| 12 | MINOR | secret owner의 접근 경계와 저장 경로 | 받았다(5.2절) |
| 13 | MINOR | `CONSOLE_ORIGIN` 설명이 지금 코드와 다르다 | 받았다. 1절을 고치고, 새 코드는 `CONSOLE_ORIGIN`만 읽는다고 적었다(4.6절) |

### 2회차 (2026-11-13, Codex, 판정: 변경 요청)

1회차 13건 가운데 1·2·3·4·5·8·11·12·13은 해결로, 6·7·9·10은 부분 해결로 판정받았다. 켜진 공급자의 정책을 바로 적용한다는 반론(4번)은 받아들여졌다. 실제 OneLogin 확인을 구현과 나란히 하는 것(9번)도 받아들여졌다. 15절의 열 가지는 5번의 배포 범위를 고치는 조건으로 모두 수용됐다.

| # | 심각도 | 지적 | 반영 |
|---|---|---|---|
| 1 | MAJOR | 비밀번호 없는 owner에게 링크를 내는 것만으로 비상 관리자를 바꾸면, 링크가 쓰이지 않는 동안 쓸 수 있는 비상 관리자가 없다 | 받았다. 발급은 지정을 바꾸지 않는다. 링크를 써서 비밀번호를 정하는 트랜잭션이 지정을 바꾼다. 쓰지 않은 링크를 자격으로 보지 않는다(9.2절, 9.3절) |
| 2 | MAJOR | OneLogin이 틀린 verifier를 받아들여도 지원한다는 결론은 인수 조건을 낮춘다 | 받았다. 그 경우 OneLogin은 인수 조건을 채우지 못한 것이고 오너에게 올린다. PKCE를 검사하지 않는 mock은 나머지 방어의 시험이며 PKCE 조건의 증거가 아니라고 적었다(4.3절, 10절) |
| 3 | MAJOR | NULL 세션 조건은 옛 replica에서 돌지 않는다. 옛 프로세스를 기다릴 필요가 없다는 설명은 틀렸다 | 받았다. 조건은 새 코드가 처리하는 요청의 보장이라고 고쳤고, 설치 전체의 보장은 옛 프로세스가 내려간 뒤부터라고 적었다(5.4절, 8절, 11.2절) |
| 4 | MINOR | `invite` 목적보다 연결 규칙이 먼저라 초대 흐름이 초대 확인 없이 일반 로그인으로 끝날 수 있다 | 받았다. `invite` 흐름은 6.1절의 규칙 1~5를 타지 않는다. 이미 연결된 `(issuer, subject)`는 `409`로 거절한다(6.1절, 6.5절) |
| 5 | MINOR | 여러 값의 `aud`에서 믿지 않는 audience를 허용한다 | 받았다. client ID 말고 다른 audience가 있으면 거절한다(4.3절 8) |

### 3회차 (2026-11-13, Codex, 판정: 승인)

2회차의 다섯 건이 모두 해결로 판정받았다. 새 지적은 없다. 구체적인 옛 프로세스 종료 절차와 회귀 시험의 구현은 단계별 PR의 리뷰에서 본다.
