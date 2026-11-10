# shellcheck shell=bash
# Sourced by smoke.sh, upgrade.sh and replicas.sh once their api forward
# answers: `kind_release_key <api url> <auth header file>` releases the
# checks' agent as the first owner (deploy/kind/release.ts), writes the
# owner's key to the 0600 header file and sets KIND_RELEASE_ID. The
# bootstrap token is read from the Secret up.sh made and the key from the
# script's stdout: neither reaches an argument or the log.
kind_release_key() {
  local api_url="$1" auth_file="$2" token vars key
  { set +x; } 2>/dev/null
  token="$(kubectl -n "$NAMESPACE" get secret werft -o 'go-template={{index .data "BOOTSTRAP_TOKEN" | base64decode}}')"
  [ -n "$token" ] || { echo "the werft Secret holds no BOOTSTRAP_TOKEN (deploy/kind/up.sh writes it)" >&2; return 1; }
  vars="$(KIND_API_URL="$api_url" BOOTSTRAP_TOKEN="$token" bun "$(dirname "${BASH_SOURCE[0]}")/release.ts")" || return 1
  unset token
  key="$(printf '%s\n' "$vars" | sed -n 's/^KIND_API_KEY=//p')"
  KIND_RELEASE_ID="$(printf '%s\n' "$vars" | sed -n 's/^KIND_RELEASE_ID=//p')"
  unset vars
  [ -n "$key" ] && [ -n "$KIND_RELEASE_ID" ] || { echo "the checks' agent was not released" >&2; return 1; }
  (umask 077 && printf 'Authorization: Bearer %s\n' "$key" >"$auth_file")
  unset key
  export KIND_RELEASE_ID
}
