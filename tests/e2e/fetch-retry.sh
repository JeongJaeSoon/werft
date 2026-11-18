#!/usr/bin/env bash
# Sourced by tests/e2e/run.sh around the steps that pull images and build
# them from the CI build cache. A registry or the cache can fail mid-transfer:
# a reset connection, a 5xx, or a cache URL whose signature lapsed while
# another layer stalled. What already arrived stays in the daemon, so the
# same command again picks up from there. Only such transfer failures are
# tried again; anything else, a build error or a service that never gets
# healthy, fails on the first try as before.
#
#   fetch_retried <log> <command> [args...]
#
# Every try's output is appended to <log>. Returns the command's last status.
#
# The failure is read from the end of the try's output, where compose and
# BuildKit print the error that ended the command (the cache's 403 takes
# about twenty lines); a transfer warning earlier in a try that then failed
# for another reason is not a transfer failure.

FETCH_TRIES="${FETCH_TRIES:-3}"
FETCH_PAUSE="${FETCH_PAUSE:-5}"
FETCH_TAIL=40
FETCH_TRANSIENT='failed to copy|connection reset by peer|Client\.Timeout exceeded|TLS handshake timeout|i/o timeout|unexpected EOF|AuthenticationFailed|(500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)'

case "${FETCH_TRIES}${FETCH_PAUSE}" in
*[!0-9]*)
  echo "fetch-retry: FETCH_TRIES and FETCH_PAUSE must be whole numbers" >&2
  return 2
  ;;
esac

fetch_retried() {
  local log="$1" try status from last
  shift
  : >"$log"
  for ((try = 1; ; try++)); do
    from=$(($(wc -l <"$log") + 1))
    status=0
    "$@" >>"$log" 2>&1 || status=$?
    [ "$status" != 0 ] && [ "$try" -lt "$FETCH_TRIES" ] || return "$status"
    last="$(tail -n +"$from" "$log" | tail -n "$FETCH_TAIL")"
    grep -qE "$FETCH_TRANSIENT" <<<"$last" || return "$status"
    echo "== try ${try} of ${FETCH_TRIES}: a registry or cache transfer failed; trying again" >&2
    sleep $((FETCH_PAUSE * try))
  done
}
