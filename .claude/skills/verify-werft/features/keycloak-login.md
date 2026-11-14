# 실제 Keycloak으로 로그인 공급자 몰기

로그인 공급자의 흐름 전체를 이 저장소가 쓰지 않은 서버로 확인한다. `keycloak-up.sh`가 띄운 run에는 realm `werft`를 가진 Keycloak이 API와 같은 네트워크 이름공간에 있어, API와 이 머신의 브라우저가 같은 issuer(`http://localhost:<KEYCLOAK_PORT>/realms/werft`)를 본다. owner가 화면으로 공급자를 더하고, Keycloak의 로그인 폼을 거쳐 테스트하고, 켜고, 사람들이 그 버튼으로 로그인·가입·연결하고, owner가 끄면 그 세션이 끝난다. mock IdP로 모는 같은 화면의 절차는 [web-settings.md](./web-settings.md) 1이고, 공급자별 모양의 차이는 계약 시험(`apps/control-host/src/api/provider-shapes.test.ts`)이 맡는다.

이 절차는 `scripts/keycloak-login.sh`가 처음부터 끝까지 돈다. CI의 `Keycloak login` workflow(`.github/workflows/keycloak-login.yml`)도 같은 스크립트를 부른다. 단계마다 무엇을 누르고 무엇을 기대하는지는 그 스크립트가 유일한 기록이다.

## Sub-features

- `kc-launch` `keycloak-up.sh`가 콘솔 포트와 Keycloak 포트를 고르고 realm의 client secret·사용자 비밀번호를 run마다 새로 만든다. 끝나면 discovery 문서가 호스트와 API 컨테이너 양쪽에서 `200`이다(`issuer`가 같은 주소, `authorization_response_iss_parameter_supported: true`, `S256`). owner를 bootstrap하고 브라우저와 curl 양쪽에서 로그인한다.
- `kc-add` 설정 > 워크스페이스 > 로그인의 "공급자 추가"에 이름과 issuer를 넣으면 서버가 discovery를 읽고 상세 화면으로 간다. 화면의 redirect URI는 `<CONSOLE_ORIGIN>/auth/callback/<공급자 id>`다.
- `kc-test` client ID와 secret을 넣고 "테스트 로그인"을 누르면 브라우저가 Keycloak의 폼으로 갔다가 `iss`·`code`와 함께 돌아와 "테스트가 통과했습니다."와 받은 계정(sub·이메일·`email_verified`)을 보인다. 계정은 bo다.
- `kc-enable` "켜기" 뒤 `GET /v1/auth/login-methods`에 그 공급자가 나온다. 가입 규칙은 허용 도메인 `acme.example`, "member로 가입"이다.
- `kc-link` 비밀번호로 로그인한 owner가 설정 > 로그인 수단에서 "Keycloak 연결"로 Keycloak 계정(bo)을 붙이고, 그 뒤 버튼으로 owner로 들어온다. 이메일 주소가 달라도 된다.
- `kc-first-signup` 계정이 없는 ana가 버튼으로 들어오면 비밀번호 없는 `member` 계정이 생긴다.
- `kc-unverified-refused` Keycloak이 주소를 검증하지 않은 uma는 거절되고("이 계정으로 로그인하지 못했습니다") 계정이 생기지 않는다.
- `kc-disable-ends-sessions` owner가 공급자를 끄면 그 공급자로 만든 세션이 끊긴다(응답의 `sessions_revoked` 1 이상, ana의 `me`가 `401`). owner의 비밀번호 세션은 남고, `login-methods`의 공급자 목록은 빈다.
- `kc-pkce` werft가 만든 인가 요청의 code에 틀린 `code_verifier`를 내면 Keycloak이 `400 invalid_grant`로 거절한다(`keycloak-pkce.sh`).
- `kc-no-secret-in-logs` API 로그에 client secret과 사용자 비밀번호가 한 줄도 없다.

## How to get to it (user POV)

- owner: 설정 > 워크스페이스 > "로그인"(`/settings/workspace/login`) → "공급자 추가" → 상세 화면에서 client 값, "테스트 로그인", "켜기", "규칙 바꾸기", "끄기".
- 누구나: `/login`의 "Keycloak 계정으로 로그인", 설정 > "로그인 수단"(`/settings/login-methods`)에서 Keycloak 줄의 "연결"(접근성 이름 "Keycloak 연결").
- realm의 사람은 ana·bo(주소 검증됨)와 uma(검증 안 됨), 모두 `@acme.example`이고 비밀번호는 이 run의 한 값이다. Keycloak의 폼에는 `type '#username' <이름>`, `type-state '#password' KEYCLOAK_WERFT_USER_PASSWORD`, `click '#kc-login'`으로 들어간다.

## Driving it with lib.sh

Preconditions: `scripts/keycloak-up.sh`로 띄운 새 run이다(`up.sh` run에는 Keycloak이 없다). bootstrap 전이다. 스크립트가 bootstrap부터 하므로 한 run에서 한 번만 돈다. 다시 돌리려면 run을 내리고 새로 띄운다.

```sh
run=$(.claude/skills/verify-werft/scripts/keycloak-up.sh)
.claude/skills/verify-werft/scripts/keycloak-login.sh "$run"
```

단계마다 `ok <sub-feature>`를 찍고 끝에 `keycloak-login.sh: every step held`로 exit 0이다. 처음 어긋난 단계에서 `FAIL <sub-feature>: <무엇>`을 찍고 `evidence/fail-<sub-feature>.png`를 남기고 exit 1이다. 통과한 단계의 화면은 `evidence/<sub-feature>.png`다(1280px). 다른 폭이나 테마의 캡처가 필요하면 스크립트가 끝난 run에서 `W=390 browser.mjs <run> shot <이름> full`로 더 찍는다. `kc-pkce` 단계 중간의 `! failed request: POST /v1/auth/oidc/callback -> 400`은 예상한 줄이다. 흐름이 속하지 않는 주소로 돌아온 콜백을 API가 본문 검증에서 거절해, code가 쓰이지 않은 채 남는다.

한 단계만 손으로 다시 보고 싶으면 `lib.sh <run>`을 source하고 스크립트의 그 단계 줄을 따라 `browser.mjs`·`ap_web`을 부른다.

## Gotchas

- 절차는 비밀번호 로그인이 열려 있는 설치를 전제한다(새 run은 그렇다). 도중에 닫으면 끄기가 `409`(`last_provider`)로 거절되고 ana의 세션이 남는다. 닫힌 설치에서 마지막 공급자는 끌 수 없다.
- `localhost`와 `127.0.0.1`을 섞지 않는다. issuer는 `http://localhost:<port>`(Keycloak의 `--hostname`), 콘솔은 `http://127.0.0.1:<port>`(`CONSOLE_ORIGIN`)다. 콘솔을 `localhost`로 열면 cookie가 다른 host에 묶여 콜백이 `401`이다.
- overlay는 값 셋(`KEYCLOAK_WERFT_CLIENT_SECRET`, `KEYCLOAK_WERFT_USER_PASSWORD`, `CONSOLE_ORIGIN`)이 없으면 compose 호출을 모두 거절한다. `keycloak-up.sh`가 `VERIFY_STATE_VARS`로 run의 상태에 적어 두므로 `lib.sh`·`down.sh`는 그대로 돈다. 상태 파일은 셸이 source하고 `.mjs` helper가 따로 읽으므로, `up.sh`는 따옴표가 필요 없는 값(글자·숫자와 `_.:/@%+=,-`)만 받는다. `up.sh infra/compose.keycloak.yml`을 직접 부르지 않는다.
- Keycloak은 API의 네트워크 이름공간을 쓴다(`network_mode: "service:api"`). api 컨테이너를 다시 만들면(`ap_compose up -d api`) Keycloak도 다시 만들어야 하고, `start-dev`의 내장 DB는 volume이 없어 realm을 처음부터 다시 읽는다(사용자 id가 바뀌어 연결해 둔 계정은 다른 사람이 된다).
- 브라우저의 Keycloak 세션은 werft 로그아웃으로 끝나지 않는다. 스크립트는 사람을 바꿀 때 Keycloak의 로그아웃을 먼저 한다.
- 연결은 로그인한 지 10분 안에만 된다. 스크립트는 그 안에 끝난다(로컬 약 80초).
- `click`이 Keycloak으로 넘어가면 출력에 인가 요청의 주소가 찍힌다. `state`는 가려지고, 함께 보이는 `nonce`·`code_challenge`는 공급자에게 공개하는 값이다.
- 화면 문구로 버튼과 안내를 찾으므로 그 문구(`apps/web/src/i18n/`)가 바뀌면 스크립트도 바꾼다. 콘솔은 브라우저 언어를 따르므로, 스크립트는 Chrome을 띄우기 전에 run의 profile에 `intl.accept_languages`를 `ko`로 적고 `navigator.language`가 `ko`인지 본다(CI runner의 Chrome은 en-US다). CI workflow의 경로 필터가 그 파일을 바꾼 PR에서 스크립트를 돌린다.
- 포트 둘은 `keycloak-up.sh`가 띄우기 직전에 고른다. 그 사이 다른 프로세스가 가져가면 `up.sh`가 실패하고 스스로 내린다. 다시 띄우면 된다.
