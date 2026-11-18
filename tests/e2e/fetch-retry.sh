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

FETCH_TRIES="${FETCH_TRIES:-3}"
FETCH_TRANSIENT='failed to copy|connection reset by peer|Client\.Timeout exceeded|TLS handshake timeout|i/o timeout|unexpected EOF|AuthenticationFailed|(500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)'

fetch_retried() {
  local log="$1" try status
  shift
  : >"$log"
  for ((try = 1; ; try++)); do
    status=0
    "$@" >"$log.try" 2>&1 || status=$?
    cat "$log.try" >>"$log"
    if [ "$status" = 0 ] || [ "$try" -ge "$FETCH_TRIES" ] ||
      ! grep -qE "$FETCH_TRANSIENT" "$log.try"; then
      rm -f "$log.try"
      return "$status"
    fi
    echo "== a registry or cache transfer failed; trying again (${try}/${FETCH_TRIES})" >&2
  done
}
