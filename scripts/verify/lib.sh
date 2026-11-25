# Source this in every Bash call that drives the stack:
#   . scripts/verify/lib.sh <run id | run dir>
# It loads the run's state (project, ports, setup link) and defines the
# drive helpers. Each Bash call is a fresh shell, so source it every time.

# Without a loaded run every helper would fall through to the default
# project, so refuse to define them at all.
unset VERIFY_RUN VERIFY_REPO VERIFY_API VERIFY_BUILT_FROM VERIFY_SETUP_TOKEN API EVIDENCE \
  COMPOSE_PROJECT_NAME COMPOSE_FILE EXECUTION_INSTALLATION_ID API_IMAGE WORKER_IMAGE EGRESS_PROXY_IMAGE
unset -f ap_compose ap_urls ap_key ap_revoke ap_curl _ap_cookie_header ap_get ap_post ap_web ap_as 2>/dev/null
# bash names a sourced file in BASH_SOURCE, zsh in $0.
. "$(dirname "${BASH_SOURCE[0]:-$0}")/run.sh" "${1:-}" || return 1
_verify_run=$VERIFY_RUN_DIR
if ! . "$_verify_run/state.env" ||
  [ -z "${VERIFY_REPO:-}" ] || [ -z "${VERIFY_API:-}" ] ||
  case "${COMPOSE_PROJECT_NAME:-}" in verify-ap-*) false ;; *) true ;; esac; then
  echo "lib.sh: no verification run state at '${_verify_run}'; run up.sh first" >&2
  return 1
fi
EVIDENCE=$VERIFY_RUN/evidence
API=$VERIFY_API

# Compose against this run's project only. A service that up, restart or
# start (re)creates can get a new ephemeral host port, so those refresh the
# run's addresses (state.json, VERIFY_API and $API) afterwards. In a pipeline
# (`ap_compose restart api | tail`) the function runs in a subshell: the files
# follow, this shell's $API does not, hence the notice.
ap_compose() {
  (cd "$VERIFY_REPO" && docker compose --profile apps --profile fake-model "$@")
  local compose_rc=$? api_before=${API:-}
  case "${1:-}" in
    up | restart | start)
      # A port that may have moved and could not be read is a failure too.
      ap_urls >/dev/null || { [ "$compose_rc" != 0 ] || compose_rc=1; }
      [ "${API:-}" = "$api_before" ] || echo "ap_compose: the API moved to $API (state.json updated; in a pipeline, run ap_urls or source lib.sh again)" >&2
      ;;
  esac
  return "$compose_rc"
}

# The run's non-secret addresses as JSON (web_url, api_url, host ports by
# service), read from compose now and written to $VERIFY_RUN/state.json.
ap_urls() {
  local urls
  urls=$(node "$VERIFY_REPO/scripts/verify/run-urls.mjs" "$VERIFY_RUN") || return 1
  API=$(printf '%s\n' "$urls" | sed -n 's/^  "api_url": "\(.*\)",$/\1/p')
  VERIFY_API=$API
  printf '%s\n' "$urls"
}

# Issue an API key; prints it (stdout) once. key id goes to stderr.
ap_key() { (cd "$VERIFY_REPO" && scripts/local.sh key "$@"); }
ap_revoke() { ap_compose exec -T api bun run apps/control-host/src/api/keys.ts revoke "$1"; }
# The settings' `"stored": true` keys (fake model, fake MCP, fake GitHub App)
# start unset; the owner web-user.mjs logged in stores them, cookie on stdin.
ap_store_keys() {
  [ -s "$VERIFY_RUN/cookie.owner" ] || { echo "ap_store_keys: no cookie for 'owner'; web-user.mjs bootstrap and login owner first" >&2; return 1; }
  (cd "$VERIFY_REPO" && scripts/local.sh store-keys <"$VERIFY_RUN/cookie.owner")
}

# Every secret (key, cookie, a body that may carry a token or OAuth code)
# reaches curl through a <(…) pipe, never argv, where `ps` would show it.
# `ap_curl key …` sends $KEY as a bearer token. `ap_curl cookie …` sends the
# web client's CSRF header and $VERIFY_RUN/cookie, plus $AP_COOKIE_EXTRA when
# set (assign it on its own line: a VAR=… prefix would export it to curl).
# Works under bash and zsh (the Bash tool's shell), hence no variable named
# `path` (zsh ties it to PATH) or `status` (read-only in zsh) and no unquoted ${x:+…} word splitting.
_ap_cookie_header() {
  local c=
  [ -s "$VERIFY_RUN/cookie" ] && c=$(cat "$VERIFY_RUN/cookie")
  [ -n "${AP_COOKIE_EXTRA:-}" ] && c="${c:+$c; }$AP_COOKIE_EXTRA"
  [ -z "$c" ] || printf 'Cookie: %s\n' "$c"
}
ap_curl() {
  local auth=$1
  shift
  case $auth in
    key) curl -sS -H @<(printf 'Authorization: Bearer %s\n' "$KEY") "$@" ;;
    cookie) curl -sS -H 'x-requested-with: werft-web' -H @<(_ap_cookie_header) "$@" ;;
    *) echo "ap_curl: first argument is key or cookie" >&2; return 2 ;;
  esac
}

# ap_get, ap_post and ap_web leave the last response's headers in
# $VERIFY_RUN/headers (X-Request-Id, Set-Cookie). Session POSTs need an
# Idempotency-Key, so every POST gets a fresh one; other routes ignore it.
ap_get() { ap_curl key -w '\n%{http_code}\n' -D "$VERIFY_RUN/headers" "$API$1"; }
ap_post() {
  ap_curl key -w '\n%{http_code}\n' -D "$VERIFY_RUN/headers" "$API$1" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" --data-binary @<(printf '%s' "$2")
}

# Browser-style calls. curl will not store a __Host- cookie over http, so the
# session cookie is carried by hand in $VERIFY_RUN/cookie.
ap_web() {
  local method=$1 route=$2 extra=(-w '\n%{http_code}\n' -D "$VERIFY_RUN/headers" -H 'Content-Type: application/json')
  [ "$method" = POST ] && extra+=(-H "Idempotency-Key: $(uuidgen)")
  # A <(…) stored in an array is closed before curl runs, so the body is inline.
  if [ -n "${3:-}" ]; then
    ap_curl cookie -X "$method" "$API$route" "${extra[@]}" --data-binary @<(printf '%s' "$3")
  else
    ap_curl cookie -X "$method" "$API$route" "${extra[@]}"
  fi
  local curl_rc=$?
  sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-werft_session=[^;]*\).*/\1/p' "$VERIFY_RUN/headers" |
    tr -d '\r' | while read -r c; do printf '%s' "$c" >"$VERIFY_RUN/cookie"; done
  return "$curl_rc"
}

# Act as a web user web-user.mjs signed in: their cookie for ap_web, and
# their key (if web-user.mjs issued one) as $KEY for ap_get/ap_post.
ap_as() {
  [ -s "$VERIFY_RUN/cookie.$1" ] || { echo "ap_as: no cookie for '$1'; web-user.mjs login or accept first" >&2; return 1; }
  cp "$VERIFY_RUN/cookie.$1" "$VERIFY_RUN/cookie"
  if [ -s "$VERIFY_RUN/keys/$1" ]; then
    KEY=$(cat "$VERIFY_RUN/keys/$1")
    echo "acting as $1 (cookie, key of ${#KEY} chars)" >&2
  else
    unset KEY
    echo "acting as $1 (cookie, no key)" >&2
  fi
}
