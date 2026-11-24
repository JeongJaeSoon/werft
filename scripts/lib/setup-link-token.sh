# shellcheck shell=bash
# The address e2eOwnerBody (tests/e2e/client.ts) bootstraps the e2e, soak,
# d2-gate and kind stacks' first owner with.
# shellcheck disable=SC2034
E2E_OWNER_EMAIL=e2e-owner@example.test

# setup_link_token <email> <exec prefix...>: issue the first owner's setup link
# for <email> in the api container that the prefix runs commands in
# (`dc exec -T api`, `kubectl -n ns exec deploy/x-api --`), and print the token
# after #setup= from the 0600 file the command wrote there. The file is removed
# again; the command's own output (the file and the expiry) is dropped, and its
# audit line goes to the container's log. Prints nothing, and fails, once an
# owner exists: the command issues no link then.
setup_link_token() {
  local email="$1" file token status=0
  shift
  file="/tmp/werft-setup-link-$$.json"
  "$@" bun run apps/control-host/src/main.ts admin bootstrap-owner \
    --email "$email" --out "$file" </dev/null >/dev/null || return 1
  token="$("$@" sed -n '/"accept_path"/s/.*#setup=\([^"]*\)".*/\1/p' "$file" </dev/null)" || status=$?
  "$@" rm -f "$file" </dev/null || true
  [ "$status" = 0 ] && [ -n "$token" ] || return 1
  printf '%s' "$token"
}
