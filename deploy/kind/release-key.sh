# shellcheck shell=bash
# Sourced by smoke.sh, upgrade.sh and replicas.sh once their api forward
# answers: `kind_release_key <api url> <auth header file>` releases the
# checks' agent as the first owner (deploy/kind/release.ts), writes the
# owner's key to the 0600 header file, the owner's second key (which answers
# requests: a key never answers a session it started) to <file>.approve, and
# sets KIND_RELEASE_ID. The
# owner's password seed is read from the Secret up.sh made, a setup link
# from the api while no owner exists, and the key from the script's stdout:
# none reaches an argument or the log.
kind_release_key() {
  local api_url="$1" auth_file="$2" secret setup vars key approve
  { set +x; } 2>/dev/null
  secret="$(kubectl -n "$NAMESPACE" get secret werft -o 'go-template={{index .data "E2E_OWNER_SECRET" | base64decode}}')"
  [ -n "$secret" ] || { echo "the werft Secret holds no E2E_OWNER_SECRET (deploy/kind/up.sh writes it)" >&2; return 1; }
  setup="$(kind_setup_link_token "${fullname:?}")"
  vars="$(KIND_API_URL="$api_url" E2E_OWNER_SECRET="$secret" E2E_SETUP_TOKEN="$setup" bun "$(dirname "${BASH_SOURCE[0]}")/release.ts")" || return 1
  unset secret setup
  key="$(printf '%s\n' "$vars" | sed -n 's/^KIND_API_KEY=//p')"
  approve="$(printf '%s\n' "$vars" | sed -n 's/^KIND_APPROVE_KEY=//p')"
  KIND_RELEASE_ID="$(printf '%s\n' "$vars" | sed -n 's/^KIND_RELEASE_ID=//p')"
  unset vars
  [ -n "$key" ] && [ -n "$approve" ] && [ -n "$KIND_RELEASE_ID" ] || { echo "the checks' agent was not released" >&2; return 1; }
  (umask 077 && printf 'Authorization: Bearer %s\n' "$key" >"$auth_file" &&
    printf 'Authorization: Bearer %s\n' "$approve" >"${auth_file}.approve")
  unset key approve
  export KIND_RELEASE_ID
}

# shellcheck source=../../scripts/lib/setup-link-token.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib/setup-link-token.sh"

# kind_setup_link_token <fullname>: the token of a new setup link from one api
# Pod, or nothing once an owner exists (the command issues none then). The
# Pod is picked once: deploy/<name> picks again on every exec, and the file
# made in one Pod is not in another. It is a Ready Pod not being deleted: a
# Pod of a replaced ReplicaSet still reads Running while it terminates.
kind_setup_link_token() {
  local pod
  # shellcheck disable=SC2016 # $name is the template's variable, not the shell's
  pod="$(kubectl -n "$NAMESPACE" get pod -l app.kubernetes.io/component=api -o go-template='{{range .items}}{{$name := .metadata.name}}{{if not .metadata.deletionTimestamp}}{{range .status.conditions}}{{if and (eq .type "Ready") (eq .status "True")}}{{$name}}{{"\n"}}{{end}}{{end}}{{end}}{{end}}' \
    | grep -m 1 -E "^$1-api-[a-z0-9]+-[a-z0-9]+$")" || return 0
  setup_link_token "$E2E_OWNER_EMAIL" kubectl -n "$NAMESPACE" exec "pod/$pod" -c api -- 2>/dev/null || true
}
