# 실제 Keycloak으로 로그인 공급자 몰기

로그인 공급자의 흐름 전체를 이 저장소가 쓰지 않은 서버로 확인한다. `keycloak-up.sh`가 띄운 run에는 realm `werft`를 가진 Keycloak이 API와 같은 네트워크 이름공간에 있어, API와 이 머신의 브라우저가 같은 issuer(`http://localhost:<KEYCLOAK_PORT>/realms/werft`)를 본다. owner가 화면으로 공급자를 더하고, Keycloak의 로그인 폼을 거쳐 테스트하고, 켜고, 사람들이 그 버튼으로 로그인·가입·연결하고, owner가 끄면 그 세션이 끝난다. mock IdP로 모는 같은 화면의 절차는 [web-settings.md](./web-settings.md) 1이고, 공급자별 모양의 차이는 계약 시험(`apps/control-host/src/api/provider-shapes.test.ts`)이 맡는다.

## Sub-features

- `kc-launch` `keycloak-up.sh`가 콘솔 포트와 Keycloak 포트를 고르고 realm의 client secret·사용자 비밀번호를 run마다 새로 만든다. 끝나면 discovery 문서가 호스트와 API 컨테이너 양쪽에서 `200`이다(`issuer`가 같은 주소, `authorization_response_iss_parameter_supported: true`, 서명 `ES256`).
- `kc-add` 설정 > 워크스페이스 > 로그인의 "공급자 추가"에 이름과 issuer를 넣으면 서버가 discovery를 읽고 상세 화면으로 간다. 화면의 redirect URI는 `<CONSOLE_ORIGIN>/auth/callback/<공급자 id>`다.
- `kc-test` client ID와 secret을 넣고 "테스트 로그인"을 누르면 브라우저가 Keycloak의 폼으로 갔다가 `iss`·`code`와 함께 돌아와 "테스트가 통과했습니다."와 받은 계정(sub·이메일·`email_verified`)을 보인다. 계정·세션·로그인 수단은 늘지 않는다.
- `kc-enable` "켜기" 뒤 `/login`에 "Keycloak 계정으로 로그인" 버튼이 나온다.
- `kc-link` 비밀번호로 로그인한 owner가 설정 > 로그인 수단에서 "Keycloak 연결"로 Keycloak 계정을 붙이고, 그 뒤 버튼으로 owner로 들어온다. 이메일 주소가 달라도 된다.
- `kc-first-signup` 허용 도메인과 "member로 가입"이 켜진 공급자에서, 계정이 없는 ana가 버튼으로 들어오면 비밀번호 없는 `member` 계정이 생긴다.
- `kc-unverified-refused` Keycloak이 주소를 검증하지 않은 uma는 `401`이고 계정이 생기지 않는다.
- `kc-disable-ends-sessions` owner가 공급자를 끄면 그 공급자로 만든 세션이 끊긴다(응답의 `sessions_revoked`, 그 사람의 `me`가 `401`). 비밀번호 세션은 남는다.
- `kc-pkce` werft가 만든 인가 요청의 code에 틀린 `code_verifier`를 내면 Keycloak이 `400 invalid_grant`로 거절한다(`keycloak-pkce.sh`).
- `kc-no-secret-in-logs` API 로그에 client secret과 사용자 비밀번호가 한 줄도 없다.

## How to get to it (user POV)

- owner: 설정 > 워크스페이스 > "로그인"(`/settings/workspace/login`) → "공급자 추가" → 상세 화면에서 client 값, "테스트 로그인", "켜기", "규칙 바꾸기", "끄기".
- 누구나: `/login`의 "Keycloak 계정으로 로그인", 설정 > "로그인 수단"(`/settings/login-methods`)에서 Keycloak 줄의 "연결"(접근성 이름 "Keycloak 연결").
- realm의 사람은 ana·bo(주소 검증됨)와 uma(검증 안 됨), 모두 `@acme.example`이고 비밀번호는 이 run의 한 값이다. Keycloak의 폼에는 `type '#username' <이름>`, `type-state '#password' KEYCLOAK_WERFT_USER_PASSWORD`, `click '#kc-login'`으로 들어간다.

## Driving it with lib.sh

Preconditions:

- `scripts/keycloak-up.sh`로 띄운 새 run이다(`up.sh` run에는 Keycloak이 없다). bootstrap 전이다.
- 브라우저는 `CONSOLE_ORIGIN`(`http://127.0.0.1:<port>`)으로 연다. `VERIFY_API`와 같은 주소다. Keycloak이 그 주소로 돌려보내고 cookie가 거기 묶인다.

```sh
. .claude/skills/verify-werft/scripts/lib.sh <run id>
RUN=<run id>
B=.claude/skills/verify-werft/scripts/browser.mjs
WU=.claude/skills/verify-werft/scripts/web-user.mjs
KC=http://localhost:$KEYCLOAK_PORT/realms/werft
PAGE=$CONSOLE_ORIGIN/settings/workspace/login
me() { node "$B" "$RUN" eval "fetch('/v1/auth/me').then(async (r) => r.status + (r.ok ? ' ' + (await r.json()).user.email : ''))"; }
werft_logout() { node "$B" "$RUN" eval "fetch('/v1/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'werft-web' } }).then((r) => r.status)"; }
keycloak_login() {
  node "$B" "$RUN" type '#username' "$1"
  node "$B" "$RUN" type-state '#password' KEYCLOAK_WERFT_USER_PASSWORD
  node "$B" "$RUN" click '#kc-login'
}
# Keycloak keeps a session of its own in the browser; without this the next
# sign-in is whoever signed in last.
keycloak_logout() {
  node "$B" "$RUN" open "$KC/protocol/openid-connect/logout"
  node "$B" "$RUN" click '#kc-logout'
}
```

1. **`kc-launch`.** 양쪽에서 같은 문서가 보이는지 확인하고 owner를 만든다.

   ```sh
   curl -fsS "$KC/.well-known/openid-configuration" | node -e 'const d = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log(d.issuer, d.authorization_response_iss_parameter_supported, d.code_challenge_methods_supported)'   # http://localhost:<port>/realms/werft true [ 'plain', 'S256' ]
   ap_compose exec -T api bun -e 'console.log((await fetch(process.argv.at(-1))).status)' "$KC/.well-known/openid-configuration"   # 200
   node "$WU" "$RUN" bootstrap owner && node "$WU" "$RUN" login owner
   node "$B" "$RUN" start && node "$B" "$RUN" login owner
   ```

2. **`kc-add`.** 만들기 뒤 주소의 마지막 조각이 공급자 id다.

   ```sh
   node "$B" "$RUN" open "$PAGE"
   node "$B" "$RUN" click "공급자 추가"
   node "$B" "$RUN" type '[name="display_name"]' Keycloak
   node "$B" "$RUN" type '[name="issuer"]' "$KC"
   node "$B" "$RUN" click "만들기"                        # -> /settings/workspace/login/<id>
   PID=$(node "$B" "$RUN" eval "location.pathname.split('/').pop()" | tr -d '"')
   ```

3. **`kc-test`.** secret은 run의 상태에서 칸으로 간다. 상태 표시는 "테스트 필요"가 된다.

   ```sh
   node "$B" "$RUN" click "바꾸기"
   node "$B" "$RUN" type '[name="client_id"]' werft-console
   node "$B" "$RUN" click "저장"
   node "$B" "$RUN" click "값 넣기"
   node "$B" "$RUN" type-state '[name="value"]' KEYCLOAK_WERFT_CLIENT_SECRET
   node "$B" "$RUN" click "저장"
   node "$B" "$RUN" click "테스트 로그인"                  # -> Keycloak의 /realms/werft/protocol/openid-connect/auth
   keycloak_login bo                                      # -> /auth/callback/<id>?…&iss=…&code=(hidden)
   node "$B" "$RUN" eval "document.querySelector('[role=status],[role=alert]')?.textContent"   # "테스트가 통과했습니다."
   node "$B" "$RUN" eval "[...document.querySelectorAll('dt')].map((dt) => dt.textContent + ': ' + dt.nextElementSibling.textContent).join(' | ')"
   ```

   기대: 이메일 `bo@acme.example`, `email_verified: 예`, "이 계정이 로그인하면: 이 주소로 온 초대가 있어야 들어옵니다."(규칙을 바꾸기 전이다).

4. **`kc-enable`**, 그리고 가입 규칙.

   ```sh
   node "$B" "$RUN" open "$PAGE/$PID"
   node "$B" "$RUN" click "켜기"                          # "켰습니다. 로그인 화면에 버튼이 나옵니다."
   node "$B" "$RUN" click "규칙 바꾸기"
   node "$B" "$RUN" type '[name="allowed_domains"]' acme.example
   node "$B" "$RUN" select '[name="jit_role"]' member
   node "$B" "$RUN" click "저장"
   ap_web GET /v1/auth/login-methods                      # providers: [{"id":"<id>","display_name":"Keycloak"}]
   ```

5. **`kc-link`.** 연결은 로그인한 지 10분 안에만 된다. 오래 걸렸으면 owner로 다시 로그인하고 시작한다. 3의 테스트가 Keycloak에 bo의 세션을 남겼으므로 폼 없이 돌아온다.

   ```sh
   node "$B" "$RUN" open "$CONSOLE_ORIGIN/settings/login-methods"
   node "$B" "$RUN" click '[aria-label="Keycloak 연결"]'  # 보이는 글자는 "연결"이다. -> /settings/login-methods, "연결했습니다. 이제 이 공급자 계정으로 로그인할 수 있습니다."
   werft_logout                                           # 204
   node "$B" "$RUN" open "$CONSOLE_ORIGIN/login"
   node "$B" "$RUN" click "Keycloak 계정으로 로그인"       # -> /
   me                                                     # 200, owner의 주소(bo의 주소가 아니다)
   ```

6. **`kc-first-signup`.**

   ```sh
   werft_logout; keycloak_logout
   node "$B" "$RUN" open "$CONSOLE_ORIGIN/login"
   node "$B" "$RUN" click "Keycloak 계정으로 로그인"
   keycloak_login ana                                     # -> /
   me                                                     # 200 ana@acme.example
   ap_compose exec -T postgres psql -U postgres -d sessions -Atc "select m.role, u.password_hash is null from users u join memberships m on m.user_id = u.id where u.email = 'ana@acme.example'"   # member|t
   ```

7. **`kc-unverified-refused`.**

   ```sh
   werft_logout; keycloak_logout
   node "$B" "$RUN" open "$CONSOLE_ORIGIN/login"
   node "$B" "$RUN" click "Keycloak 계정으로 로그인"
   keycloak_login uma                                     # ! failed request: POST /v1/auth/oidc/callback -> 401
   node "$B" "$RUN" eval "document.querySelector('[role=alert]')?.textContent"   # "이 계정으로 로그인하지 못했습니다 — …"
   ap_compose exec -T postgres psql -U postgres -d sessions -Atc "select count(*) from users where email = 'uma@acme.example'"   # 0
   ```

8. **`kc-disable-ends-sessions`.** 브라우저는 ana, 끄는 owner는 `web-user.mjs`가 받아 둔 비밀번호 세션이다.

   ```sh
   keycloak_logout
   node "$B" "$RUN" open "$CONSOLE_ORIGIN/login"
   node "$B" "$RUN" click "Keycloak 계정으로 로그인"
   keycloak_login ana
   me                                                     # 200 ana@acme.example
   ap_as owner
   ap_web POST "/v1/login-providers/$PID/disable"         # 200, sessions_revoked가 1 이상
   me                                                     # 401
   ap_web GET /v1/auth/me                                 # 200: owner의 비밀번호 세션은 남는다
   ap_web GET /v1/auth/login-methods                      # providers: []
   ```

9. **`kc-pkce`.** owner가 브라우저에 있어야 한다. 테스트 흐름 하나를 버리므로 끈 뒤에 돈다.

   ```sh
   node "$B" "$RUN" login owner
   .claude/skills/verify-werft/scripts/keycloak-pkce.sh "$RUN" "$PID"
   ```

   기대: `challenge S256, 43 chars`, `back at: /auth/callback/pkce-probe`, `code received: yes`, `token endpoint, wrong verifier: 400 invalid_grant | PKCE verification failed: Code mismatch | tokens: none`, exit 0. 다른 까닭의 `400`(쓰인 code, 맞지 않는 redirect URI, client 인증 실패)은 exit 1이다(`pkce-verdict.mjs`). 중간의 `! failed request: POST /v1/auth/oidc/callback -> 400`은 예상한 줄이다. 흐름이 속하지 않는 주소로 돌아온 콜백을 API가 본문 검증에서 거절해, code가 쓰이지 않은 채 남는다.

10. **`kc-no-secret-in-logs`.** 값은 pipe로 `grep`에 간다.

    ```sh
    ap_compose logs --no-color api | grep -c -F -f <(printf '%s\n' "$KEYCLOAK_WERFT_CLIENT_SECRET")   # 0
    ap_compose logs --no-color api | grep -c -F -f <(printf '%s\n' "$KEYCLOAK_WERFT_USER_PASSWORD")   # 0
    ```

캡처는 단계마다 `shot <이름>-1280 full`과 `W=390 … shot <이름>-390 full`로 남긴다. Keycloak의 폼도 같은 명령으로 찍힌다.

## Gotchas

- `localhost`와 `127.0.0.1`을 섞지 않는다. issuer는 `http://localhost:<port>`(Keycloak의 `--hostname`), 콘솔은 `http://127.0.0.1:<port>`(`CONSOLE_ORIGIN`)다. 콘솔을 `localhost`로 열면 cookie가 다른 host에 묶여 콜백이 `401`이다.
- overlay는 값 셋(`KEYCLOAK_WERFT_CLIENT_SECRET`, `KEYCLOAK_WERFT_USER_PASSWORD`, `CONSOLE_ORIGIN`)이 없으면 compose 호출을 모두 거절한다. `keycloak-up.sh`가 `VERIFY_STATE_VARS`로 run의 상태에 적어 두므로 `lib.sh`·`down.sh`는 그대로 돈다. 상태 파일은 셸이 source하고 `.mjs` helper가 따로 읽으므로, `up.sh`는 따옴표가 필요 없는 값(글자·숫자와 `_.:/@%+=,-`)만 받는다. `up.sh infra/compose.keycloak.yml`을 직접 부르지 않는다.
- Keycloak은 API의 네트워크 이름공간을 쓴다(`network_mode: "service:api"`). api 컨테이너를 다시 만들면(`ap_compose up -d api`) Keycloak도 다시 만들어야 하고, `start-dev`의 내장 DB는 volume이 없어 realm을 처음부터 다시 읽는다(사용자 id가 바뀌어 연결해 둔 계정은 다른 사람이 된다).
- 브라우저의 Keycloak 세션은 werft 로그아웃으로 끝나지 않는다. 사람을 바꿀 때는 `keycloak_logout`을 먼저 한다.
- `click`이 Keycloak으로 넘어가면 출력에 인가 요청의 주소가 찍힌다. `state`는 가려지고, 함께 보이는 `nonce`·`code_challenge`는 공급자에게 공개하는 값이다.
- 포트 둘은 `keycloak-up.sh`가 띄우기 직전에 고른다. 그 사이 다른 프로세스가 가져가면 `up.sh`가 실패하고 스스로 내린다. 다시 띄우면 된다.
