#!/usr/bin/env bash
# The whole Keycloak sign-in walk of features/keycloak-login.md on a fresh
# keycloak-up.sh run, in the run's headless Chrome: add the provider, test
# it, enable it, link the owner, first sign-up, the unverified refusal,
# disabling ends the provider's sessions, the wrong PKCE verifier, and no
# secret in the API's log. Each step prints `ok <sub-feature>`; the first
# that does not hold prints `FAIL <sub-feature>: <what>`, leaves
# evidence/fail-<sub-feature>.png and exits 1. The CI workflow
# keycloak-login.yml runs this same script.
#
#   keycloak-login.sh <run id | run dir>
#
# The client secret and the users' password reach the browser through
# `type-state` and grep through a pipe; nothing here prints them.
set -uo pipefail
[ "$#" = 1 ] || { echo "usage: keycloak-login.sh <run id | run dir>" >&2; exit 2; }
scripts=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$scripts/lib.sh" "$1" || exit 2
[ -n "${KEYCLOAK_PORT:-}" ] || { echo "keycloak-login.sh: run $1 was not started by keycloak-up.sh" >&2; exit 2; }
RUN=$VERIFY_RUN
KC=http://localhost:$KEYCLOAK_PORT/realms/werft
PAGE=$CONSOLE_ORIGIN/settings/workspace/login
step=kc-launch

B() { node "$scripts/browser.mjs" "$RUN" "$@"; }
WU() { node "$scripts/web-user.mjs" "$RUN" "$@"; }
fail() {
  echo "FAIL $step: $*"
  B shot "fail-$step" full >/dev/null 2>&1 || true
  exit 1
}
ok() { echo "ok $step"; }
# eval prints JSON; a string comes back quoted.
value() { B eval "$1" 2>/dev/null | sed -e 's/^"//' -e 's/"$//'; }
# `click` exits 0 on "not found", so its first word is checked.
click() {
  local out
  out=$(B click "$1") || fail "click $1: browser.mjs failed"
  echo "  $out"
  case "$out" in clicked*) ;; *) fail "click $1: $out" ;; esac
}
type_in() { B type "$1" "$2" >/dev/null || fail "type into $1"; }
# Waits for the page to reach a path on the console that matches the
# extended regex, across the provider's redirects.
on_console() {
  local where=
  for _ in $(seq 1 40); do
    where=$(value 'location.origin + location.pathname')
    case "$where" in "$CONSOLE_ORIGIN"*) [[ "${where#"$CONSOLE_ORIGIN"}" =~ ^$1$ ]] && return 0 ;; esac
    sleep 0.5
  done
  fail "expected $CONSOLE_ORIGIN path ^$1\$, at ${where:-nothing}"
}
on_keycloak() {
  local where=
  for _ in $(seq 1 40); do
    where=$(value 'location.origin + location.pathname')
    case "$where" in "http://localhost:$KEYCLOAK_PORT/"*) return 0 ;; esac
    sleep 0.5
  done
  fail "expected Keycloak's sign-in form, at ${where:-nothing}"
}
text_of() { value "[...document.querySelectorAll('$1')].map((el) => el.textContent).join(' | ').replace(/\\s+/g, ' ')"; }
expect_text() {
  local got=
  for _ in $(seq 1 20); do
    got=$(text_of "$1")
    case "$got" in *"$2"*) echo "  $1: $got"; return 0 ;; esac
    sleep 0.5
  done
  fail "expected \"$2\" in $1, got \"$got\""
}
me() { value "fetch('/v1/auth/me').then(async (r) => r.status + (r.ok ? ' ' + (await r.json()).user.email : ''))"; }
expect_me() {
  local got
  got=$(me)
  [ "$got" = "$1" ] || fail "expected /v1/auth/me \"$1\", got \"$got\""
  echo "  me: $got"
}
werft_logout() {
  local got
  got=$(value "fetch('/v1/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'werft-web' } }).then((r) => r.status)")
  [ "$got" = 204 ] || fail "logout answered $got"
}
keycloak_login() {
  on_keycloak
  B type '#username' "$1" >/dev/null || fail "no username field on Keycloak's form"
  B type-state '#password' KEYCLOAK_WERFT_USER_PASSWORD >/dev/null || fail "no password field on Keycloak's form"
  click '#kc-login'
}
# Keycloak keeps a session of its own in the browser; without this the next
# sign-in is whoever signed in last.
keycloak_logout() {
  B open "$KC/protocol/openid-connect/logout" >/dev/null || fail "Keycloak's logout page"
  click '#kc-logout'
}
sign_in_with_keycloak() {
  B open "$CONSOLE_ORIGIN/login" >/dev/null || fail "open /login"
  click "Keycloak 계정으로 로그인"
}
# ap_web prints the body, then the status on the last line.
web() {
  local out
  out=$(ap_web "$@") || fail "$1 $2: curl failed"
  WEB_STATUS=$(printf '%s\n' "$out" | tail -n 1)
  WEB_BODY=$(printf '%s\n' "$out" | sed '$d')
}
sql() { ap_compose exec -T postgres psql -U postgres -d sessions -Atc "$1"; }
shot() { B shot "$step" full >/dev/null 2>&1 || true; }

# 1. The same discovery document from this host and from the API's container.
issuer=$(curl -fsS "$KC/.well-known/openid-configuration" | node -e '
  const d = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  console.log(d.issuer, d.authorization_response_iss_parameter_supported, d.code_challenge_methods_supported.includes("S256"));') ||
  fail "no discovery document at $KC"
[ "$issuer" = "$KC true true" ] || fail "discovery: $issuer"
from_api=$(ap_compose exec -T api bun -e 'console.log((await fetch(process.argv.at(-1))).status)' "$KC/.well-known/openid-configuration")
[ "$from_api" = 200 ] || fail "discovery from the api container: ${from_api:-no answer}"
WU bootstrap owner >/dev/null || fail "bootstrap owner"
WU login owner >/dev/null || fail "owner's password session for curl"
# The steps find buttons and notices by their Korean text, and the console
# follows the browser's language (a runner's Chrome is en-US).
mkdir -p "$RUN/browser" && mkdir -p -m 700 "$RUN/browser/profile" && mkdir -p "$RUN/browser/profile/Default"
[ -e "$RUN/browser/profile/Default/Preferences" ] ||
  printf '{"intl":{"accept_languages":"ko,en-US,en"}}\n' >"$RUN/browser/profile/Default/Preferences"
B start >/dev/null || fail "Chrome did not start"
lang=$(value 'navigator.language')
[ "$lang" = ko ] || fail "the browser's language is ${lang:-unknown}, not ko"
login=$(B login owner) || fail "browser login"
[ "$login" = "login owner -> /" ] || fail "browser login: $login"
ok

step=kc-add
B open "$PAGE" >/dev/null || fail "open $PAGE"
click "공급자 추가"
type_in '[name="display_name"]' Keycloak
type_in '[name="issuer"]' "$KC"
click "만들기"
on_console '/settings/workspace/login/[^/]+'
PID=$(value "location.pathname.split('/').pop()")
echo "  provider: $PID"
shot
ok

step=kc-test
click "바꾸기"
type_in '[name="client_id"]' werft-console
click "저장"
click "값 넣기"
B type-state '[name="value"]' KEYCLOAK_WERFT_CLIENT_SECRET >/dev/null || fail "no secret field"
click "저장"
click "테스트 로그인"
keycloak_login bo
on_console "/auth/callback/$PID"
expect_text main "테스트가 통과했습니다."
account=$(value "[...document.querySelectorAll('dt')].map((dt) => dt.textContent + ': ' + dt.nextElementSibling.textContent).join(' | ')")
echo "  $account"
case "$account" in *bo@acme.example*) ;; *) fail "the tested account is not bo@acme.example" ;; esac
shot
ok

step=kc-enable
B open "$PAGE/$PID" >/dev/null || fail "open the provider"
click "켜기"
expect_text main "켰습니다."
click "규칙 바꾸기"
type_in '[name="allowed_domains"]' acme.example
select=$(B select '[name="jit_role"]' member) || fail "select jit_role"
[ "$select" = "selected member" ] || fail "jit_role: $select"
click "저장"
# The later steps only sign in people from acme.example, so a rule that was
# dropped on the way would not show there.
ap_as owner 2>/dev/null || fail "no owner cookie"
rules=
for _ in $(seq 1 20); do
  web GET /v1/login-providers
  rules=$(printf '%s' "$WEB_BODY" | PID=$PID node -e '
    const p = JSON.parse(require("node:fs").readFileSync(0, "utf8")).providers?.find((p) => p.id === process.env.PID);
    console.log(p ? `${p.allowed_domains.join(",")} ${p.jit_role}` : "no provider");' 2>/dev/null)
  [ "$rules" = "acme.example member" ] && break
  sleep 0.5
done
[ "$rules" = "acme.example member" ] || fail "saved rules are \"${rules:-unreadable}\" (GET /v1/login-providers $WEB_STATUS), not acme.example and member"
echo "  rules: $rules"
web GET /v1/auth/login-methods
[ "$WEB_STATUS" = 200 ] || fail "login-methods answered $WEB_STATUS"
printf '%s' "$WEB_BODY" | PID=$PID node -e '
  const b = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  process.exit(b.providers?.some((p) => p.id === process.env.PID && p.display_name === "Keycloak") ? 0 : 1);' ||
  fail "login-methods lists no enabled Keycloak: $WEB_BODY"
shot
ok

# The owner's test sign-in left bo's Keycloak session in this browser, so the
# link comes back without the form.
step=kc-link
B open "$CONSOLE_ORIGIN/settings/login-methods" >/dev/null || fail "open login methods"
click '[aria-label="Keycloak 연결"]'
on_console /settings/login-methods
expect_text main "연결했습니다."
werft_logout
sign_in_with_keycloak
on_console /
expect_me "200 owner@example.test"
shot
ok

step=kc-first-signup
werft_logout
keycloak_logout
sign_in_with_keycloak
keycloak_login ana
on_console /
expect_me "200 ana@acme.example"
row=$(sql "select m.role, u.password_hash is null from users u join memberships m on m.user_id = u.id where u.email = 'ana@acme.example'")
[ "$row" = "member|t" ] || fail "ana's account: ${row:-none}"
shot
ok

step=kc-unverified-refused
werft_logout
keycloak_logout
sign_in_with_keycloak
keycloak_login uma
on_console '/(login|auth/callback/[^/]+)'
expect_text '[role=alert]' "이 계정으로 로그인하지 못했습니다"
count=$(sql "select count(*) from users where email = 'uma@acme.example'")
[ "$count" = 0 ] || fail "uma has an account ($count)"
shot
ok

step=kc-disable-ends-sessions
keycloak_logout
sign_in_with_keycloak
keycloak_login ana
on_console /
expect_me "200 ana@acme.example"
ap_as owner 2>/dev/null || fail "no owner cookie"
web POST "/v1/login-providers/$PID/disable"
[ "$WEB_STATUS" = 200 ] || fail "disable answered $WEB_STATUS: $WEB_BODY"
revoked=$(printf '%s' "$WEB_BODY" | node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0, "utf8")).sessions_revoked)')
[ "${revoked:-0}" -ge 1 ] 2>/dev/null || fail "sessions_revoked: ${revoked:-none}"
echo "  sessions_revoked: $revoked"
expect_me 401
web GET /v1/auth/me
[ "$WEB_STATUS" = 200 ] || fail "the owner's password session answered $WEB_STATUS"
web GET /v1/auth/login-methods
printf '%s' "$WEB_BODY" | node -e '
  const b = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  process.exit(Array.isArray(b.providers) && b.providers.length === 0 ? 0 : 1);' ||
  fail "login-methods still lists a provider: $WEB_BODY"
ok

# Throws one test flow away, so after the provider is off.
step=kc-pkce
login=$(B login owner) || fail "browser login"
[ "$login" = "login owner -> /" ] || fail "browser login: $login"
"$scripts/keycloak-pkce.sh" "$RUN" "$PID" || fail "keycloak-pkce.sh"
ok

step=kc-no-secret-in-logs
# A log that could not be read would match nothing.
api_log=$(ap_compose logs --no-color api) || fail "could not read the API's log"
[ -n "$api_log" ] || fail "the API's log is empty"
for name in KEYCLOAK_WERFT_CLIENT_SECRET KEYCLOAK_WERFT_USER_PASSWORD; do
  lines=$(printf '%s\n' "$api_log" | grep -c -F -f <(printf '%s\n' "${!name}"))
  [ "$lines" = 0 ] || fail "$name is on $lines line(s) of the API's log"
  echo "  $name in the API's log: 0 lines"
done
ok
echo "keycloak-login.sh: every step held"
