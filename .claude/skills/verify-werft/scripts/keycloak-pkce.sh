#!/usr/bin/env bash
# The Keycloak of a keycloak-up.sh run refuses a wrong PKCE verifier for an
# authorization request werft built.
#
#   keycloak-pkce.sh <run id> <provider id>
#
# Needs the run's browser signed in as the owner, and the provider with its
# client ID and secret stored. The owner starts a test sign-in (werft's own
# S256 challenge); the browser goes to Keycloak with the redirect URI's last
# segment changed, so the console that receives the code is not the one the
# flow belongs to and does not spend it; the code is then offered to
# Keycloak's token endpoint with a verifier that is not werft's. Neither the
# code nor the client secret is printed; both reach curl through a file or a
# pipe.
set -uo pipefail
[ "$#" = 2 ] || { echo "usage: keycloak-pkce.sh <run id> <provider id>" >&2; exit 2; }
scripts=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$scripts/lib.sh" "$1" || exit 2
[ -n "${KEYCLOAK_PORT:-}" ] || { echo "keycloak-pkce.sh: run $1 was not started by keycloak-up.sh" >&2; exit 2; }
B() { node "$scripts/browser.mjs" "$VERIFY_RUN" "$@"; }
issuer=http://localhost:$KEYCLOAK_PORT/realms/werft
out=$VERIFY_RUN/pkce
trap 'rm -f "$out.code" "$out.redirect" "$out.token"' EXIT
umask 077

B open "$CONSOLE_ORIGIN/settings/workspace/login" >/dev/null
B eval "fetch('/v1/login-providers/$2/test/start', { method: 'POST', headers: { 'X-Requested-With': 'werft-web' } })
  .then(async (r) => {
    if (!r.ok) return 'test/start answered ' + r.status;
    const to = new URL((await r.json()).authorization_url);
    const back = to.searchParams.get('redirect_uri').replace(/[^/]+\$/, 'pkce-probe');
    to.searchParams.set('redirect_uri', back);
    setTimeout(() => location.assign(to), 0);
    return 'challenge ' + to.searchParams.get('code_challenge_method') + ', ' + to.searchParams.get('code_challenge').length + ' chars';
  })"
sleep 3
if [ "$(B eval 'location.origin' | tr -d '"')" != "$CONSOLE_ORIGIN" ]; then
  # Keycloak asks who: this browser holds no session of its own there.
  B type '#username' ana >/dev/null
  B type-state '#password' KEYCLOAK_WERFT_USER_PASSWORD >/dev/null
  B click '#kc-login' >/dev/null 2>&1
  sleep 2
fi
echo "back at: $(B eval 'location.origin + location.pathname' | tr -d '"' | sed "s|$CONSOLE_ORIGIN||")"
B eval "new URLSearchParams(location.search).get('code') ?? ''" | tr -d '"\n' >"$out.code"
B eval "location.origin + location.pathname" | tr -d '"\n' >"$out.redirect"
[ -s "$out.code" ] || { echo "keycloak-pkce.sh: no code came back" >&2; exit 1; }
echo "code received: yes"

http=$(curl -sS -o "$out.token" -w '%{http_code}' \
  --config <(printf 'user = "werft-console:%s"\n' "$KEYCLOAK_WERFT_CLIENT_SECRET") \
  --data-urlencode grant_type=authorization_code \
  --data-urlencode "code@$out.code" \
  --data-urlencode "redirect_uri@$out.redirect" \
  --data-urlencode "code_verifier=$(printf 'x%.0s' $(seq 1 64))" \
  "$issuer/protocol/openid-connect/token")
# Exit 0 only for Keycloak's own PKCE refusal; any other 400 is a failure.
verdict=$(node "$scripts/pkce-verdict.mjs" "$http" "$out.token")
refused=$?
echo "token endpoint, wrong verifier: $verdict"
exit "$refused"
