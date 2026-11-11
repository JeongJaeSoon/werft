# 웹 로그인

웹 사용자는 이메일·비밀번호로(설정했으면 Google로도) 로그인해 `__Host-werft_session` cookie를 받고, 웹 앱은 `GET /v1/auth/me`로 누가 어느 workspace에서 어떤 scope·권한(`permissions`)으로 로그인했는지 읽는다. 로그인 화면은 `GET /v1/auth/login-methods`로 고를 수 있는 수단을 읽는다. 설치 직후 첫 owner와 workspace는 bootstrap token으로 한 번만 만든다. 여기서는 브라우저가 보내는 요청을 그대로 보낸다. 화면으로 모는 절차는 [web-console.md](./web-console.md)다.

## Sub-features

- `bootstrap` 사용자가 0명일 때 token으로 첫 owner와 workspace를 만든다.
- `bootstrap-once` 두 번째 bootstrap은 409 `BOOTSTRAP_DONE`.
- `bootstrap-bad-token` 틀린 token은 401.
- `login` 맞는 비밀번호로 200, role·scopes·expires_at과 cookie.
- `login-csrf` `x-requested-with` 헤더가 없으면 403.
- `login-bad-password` 틀린 비밀번호는 401 `Invalid email or password`.
- `login-methods` `GET /v1/auth/login-methods` → `{"methods":["password"]}`. Google env(`GOOGLE_OIDC_CLIENT_ID`·`SECRET`·`REDIRECT_URI`)가 있으면 `["password","google"]`.
- `google-off` Google을 설정하지 않은 스택에서 `POST /v1/auth/google/start`·`/callback` → `404` `Google sign-in is not configured`(CSRF 헤더가 없으면 그 전에 `403`). Google로 실제 로그인하는 절차는 [web-settings.md](./web-settings.md)의 mock IdP다.
- `me` cookie로 principal·user·workspace(`settings` 포함)·scopes·`permissions`를 읽는다. cookie가 없으면 401.
- `logout` 204, 그 뒤 `me`는 401.

## How to get to it (user POV)

- 웹 콘솔의 `/bootstrap` 화면이 `POST /v1/auth/bootstrap`을 부른다.
- 웹 콘솔의 `/login` 화면이 `GET /v1/auth/login-methods`와 `POST /v1/auth/login`(Google을 고르면 `POST /v1/auth/google/start`, 돌아온 `/auth/google/callback`이 `POST /v1/auth/google/callback`)을, 앱 부팅이 `GET /v1/auth/me`를, 로그아웃이 `POST /v1/auth/logout`을 부른다.
- 자격 값이 본문에 드는 요청(bootstrap·login)은 `scripts/web-user.mjs`가 보내고, 나머지는 `ap_web`으로 보낸다. API reference(`/docs`)에도 같은 경로가 있다.

## Driving it with lib.sh

Preconditions:

- 이 run에서 bootstrap을 아직 하지 않았다(새 `up.sh` 직후).
- `$VERIFY_BOOTSTRAP_TOKEN`이 `state.env`에 있다. 값은 출력하지 않는다.

비밀번호는 명령에 쓰지 않는다. 명령 텍스트에 비밀번호 JSON 리터럴이 있으면 agent-guard PreToolUse hook이 "secret-like value detected in shell command"로 그 호출을 거부한다. `web-user.mjs`가 처음 쓸 때 사람마다 무작위 비밀번호를 만들어 run 디렉터리의 `users/<who>`(0600)에 두고, 요청 본문을 스스로 만들어 응답 본문과 상태 코드만 출력한다. 이메일은 `<who>@example.test`다.

```sh
. .claude/skills/verify-werft/scripts/lib.sh <run id>
U=.claude/skills/verify-werft/scripts/web-user.mjs
```

- **로그인 전.** `ap_web GET /v1/auth/me` → `401`, `error.code` `UNAUTHORIZED`.
- **로그인 수단.** `ap_web GET /v1/auth/login-methods` → `200` `{"methods":["password"]}`. `ap_web POST /v1/auth/google/start` → `404` `Google sign-in is not configured`.
- **틀린 token.** `node $U <run id> bootstrap-bad-token owner` → `401` `Bootstrap token is invalid`.
- **bootstrap.** `node $U <run id> bootstrap owner` → `201`, `role: "owner"`, `workspace.slug: "verify"`. bootstrap은 cookie를 주지 않는다.
- **두 번째.** 같은 명령 → `409` `BOOTSTRAP_DONE`.
- **CSRF.** `node $U <run id> login-no-csrf owner` → `403` `Refused: x-requested-with header is required`.
- **틀린 비밀번호.** `node $U <run id> login-wrong owner` → `401` `Invalid email or password`.
- **로그인.** `node $U <run id> login owner` → `200`, `role: "owner"`, scopes 다섯 개(`sessions:read`·`write`·`approve`·`control`·`recover`). `# cookie saved for owner (cookie.owner, cookie)`: 이후 `ap_web`은 owner로 부른다. 다른 사람으로 바꾼 뒤 돌아오려면 `ap_as owner`.
- **me.** `ap_web GET /v1/auth/me` → `200`, `principal.kind: "user"`, `user.email: "owner@example.test"`, `workspace.slug: "verify"`, `workspace.settings`(`audit_retention_days: 90`, `slack_guest_enabled: false` 등), owner의 `permissions`에 `member.manage`·`api_key.manage`·`usage.installation_read` 등이 있다(고정 개수를 기대하지 않는다).
- **로그아웃.** `ap_web POST /v1/auth/logout` → `204`. 이어서 `ap_web GET /v1/auth/me` → `401`.
- **증거.** 위 블록을 `{ …; } 2>&1 | tee "$EVIDENCE/web-login.txt"`로 감싼다. cookie·비밀번호 값은 출력되지 않는다.

## Gotchas

- `__Host-` cookie는 `Secure`라 curl의 cookie jar(`-c`/`-b`)가 http에서 저장하지 않는다. `ap_web`과 `web-user.mjs`가 직접 나른다.
- 로그인 실패가 쌓이면 잠긴다(429 `RATE_LIMITED`). 틀린 비밀번호는 한 번만 시험한다.
- 비밀번호는 12자 이상이다. 짧으면 400. `web-user.mjs`는 32자를 만든다.
- bootstrap token 없이 띄운 스택(기본 `local.sh up`)은 token을 api 로그(stderr)에 한 번 찍는다. 이 스킬은 run마다 token을 정해 넣으므로 로그를 읽지 않는다.
- member 초대·수락·역할 변경은 [musterrolle.md](./musterrolle.md) a, 화면은 [web-members-agents.md](./web-members-agents.md).
- `ap_web`은 `__Host-werft_session`만 저장한다. Google 시작 cookie(`__Host-werft_google_login`)는 나르지 않으니 Google 흐름은 브라우저로 몬다.
- zsh(Bash 도구의 셸)는 `$c` 같은 변수를 단어로 나누지 않는다. `for c in "login owner" …; do node $U <run> $c; done`은 인자 하나로 넘어가 사용법만 출력한다. 하위 명령과 사람을 따로 적는다.
