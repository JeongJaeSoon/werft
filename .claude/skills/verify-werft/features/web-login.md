# 웹 로그인

웹 사용자는 이메일·비밀번호로(켜진 로그인 공급자가 있으면 그 공급자로도) 로그인해 `__Host-werft_session` cookie를 받고, 웹 앱은 `GET /v1/auth/me`로 누가 어느 workspace에서 어떤 scope·권한(`permissions`)으로 로그인했는지 읽는다. 로그인 화면은 `GET /v1/auth/login-methods`로 고를 수 있는 수단을 읽는다. 설치 직후 첫 owner와 workspace는 일회용 설정 링크로 한 번만 만든다. 여기서는 브라우저가 보내는 요청을 그대로 보낸다. 화면으로 모는 절차는 [web-console.md](./web-console.md)다.

## Sub-features

- `bootstrap` 사용자가 0명일 때 설정 링크의 `setup_token`으로 첫 owner와 workspace를 만든다.
- `bootstrap-once` 쓴 링크는 바로 무효라 두 번째 bootstrap은 401.
- `bootstrap-bad-token` 모르는 링크는 401.
- `login` 맞는 비밀번호로 200, role·scopes·expires_at과 cookie.
- `login-csrf` `x-requested-with` 헤더가 없으면 403.
- `login-bad-password` 틀린 비밀번호는 401 `Invalid email or password`.
- `login-methods` `GET /v1/auth/login-methods` → `{"password":"on","providers":[]}`. 켜진 로그인 공급자(`login_providers` 행)가 있으면 `providers`에 `{"id","display_name"}`으로 나온다.
- `provider-off` 없는 공급자 id로 `POST /v1/auth/providers/<uuid>/start` → `404` `No such sign-in provider`(CSRF 헤더가 없으면 그 전에 `403`). 흐름 cookie 없이 `POST /v1/auth/oidc/callback` → `401` `Sign-in was not accepted`. 공급자 버튼을 띄우는 절차는 [web-settings.md](./web-settings.md) 1이다.
- `me` cookie로 principal·user·workspace(`settings` 포함)·scopes·`permissions`를 읽는다. cookie가 없으면 401.
- `logout` 204, 그 뒤 `me`는 401.

## How to get to it (user POV)

- 웹 콘솔의 `/bootstrap` 화면이 `POST /v1/auth/bootstrap`을 부른다.
- 웹 콘솔의 `/login` 화면이 `GET /v1/auth/login-methods`와 `POST /v1/auth/login`(공급자를 고르면 `POST /v1/auth/providers/{id}/start`, 돌아온 `/auth/callback/<공급자 id>`가 `POST /v1/auth/oidc/callback`)을, 앱 부팅이 `GET /v1/auth/me`를, 로그아웃이 `POST /v1/auth/logout`을 부른다.
- 자격 값이 본문에 드는 요청(bootstrap·login)은 `scripts/verify/web-user.mjs`가 보내고, 나머지는 `ap_web`으로 보낸다. API reference(`/docs`)에도 같은 경로가 있다.

## Driving it with lib.sh

Preconditions:

- 이 run에서 bootstrap을 아직 하지 않았다(새 `up.sh` 직후).
- `$VERIFY_SETUP_TOKEN`(up.sh가 `setup-link` 명령으로 받은 링크의 `#setup=` 뒤)이 `state.env`에 있다. 값은 출력하지 않는다.

비밀번호는 명령에 쓰지 않는다. 명령 텍스트에 비밀번호 JSON 리터럴이 있으면 agent-guard PreToolUse hook이 "secret-like value detected in shell command"로 그 호출을 거부한다. `web-user.mjs`가 처음 쓸 때 사람마다 무작위 비밀번호를 만들어 run 디렉터리의 `users/<who>`(0600)에 두고, 요청 본문을 스스로 만들어 응답 본문과 상태 코드만 출력한다. 이메일은 `<who>@example.test`다.

```sh
. scripts/verify/lib.sh <run id>
U=scripts/verify/web-user.mjs
```

- **로그인 전.** `ap_web GET /v1/auth/me` → `401`, `error.code` `UNAUTHORIZED`.
- **로그인 수단.** `ap_web GET /v1/auth/login-methods` → `200` `{"password":"on","providers":[]}`. `ap_web POST /v1/auth/providers/00000000-0000-4000-8000-000000000000/start` → `404` `No such sign-in provider`.
- **모르는 링크.** `node $U <run id> bootstrap-bad-token owner` → `401` `Setup link is unknown, expired or already used`.
- **bootstrap.** `node $U <run id> bootstrap owner` → `201`, `role: "owner"`, `workspace.slug: "verify"`. bootstrap은 cookie를 주지 않는다.
- **두 번째.** 같은 명령 → `401` `Setup link is unknown, expired or already used`(링크는 쓰는 순간 지워진다).
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
- 설정 링크는 로그와 화면에 찍히지 않는다. 오너가 없을 때만 `docker compose --profile apps exec -T api bun run apps/control-host/src/main.ts admin bootstrap-owner --email <address> --out <file>`이 컨테이너 안 새 0600 파일에 쓰고, stdout에는 파일 경로와 만료 시각만 낸다. 링크는 그 주소로만 bootstrap된다(다른 주소는 403, 링크는 남는다). 24시간 뒤 만료되며, 다시 실행하면 앞 링크는 무효가 된다. 오너가 있으면 링크를 만들지 않고 1로 끝난다. 실행마다 api 컨테이너 로그에 `setup_link_issued` 한 줄(토큰 없음)이 남는다. `up.sh`는 `scripts/lib/setup-link-token.sh`로 이 파일에서 토큰을 읽는다.
- member 초대·수락·역할 변경은 [access-control.md](./access-control.md) a, 화면은 [web-members-agents.md](./web-members-agents.md).
- `ap_web`은 `__Host-werft_session`만 저장한다. 공급자 로그인의 흐름 cookie(`__Host-werft_login_flow`)는 나르지 않으니 공급자 흐름은 브라우저로 몬다.
- zsh(Bash 도구의 셸)는 `$c` 같은 변수를 단어로 나누지 않는다. `for c in "login owner" …; do node $U <run> $c; done`은 인자 하나로 넘어가 사용법만 출력한다. 하위 명령과 사람을 따로 적는다.
