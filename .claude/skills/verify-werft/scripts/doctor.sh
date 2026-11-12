#!/usr/bin/env bash
# Read-only: is the given run's stack worth driving?
#   doctor.sh <run id | run dir>
set -uo pipefail
here=$(dirname "$0")
# shellcheck disable=SC1091
. "$here/lib.sh" "${1:-}" || exit 2
echo "run:      $VERIFY_RUN"
echo "project:  $COMPOSE_PROJECT_NAME"
head=$("$here/tree-id.sh" "$VERIFY_REPO") || exit 1
echo "built:    ${VERIFY_BUILT_FROM:-unknown}"
echo "checkout: $head"
# The images were built from VERIFY_BUILT_FROM; a moved HEAD or a new edit is not what runs.
[ "$head" = "${VERIFY_BUILT_FROM:-}" ] || { echo "doctor: checkout (HEAD or uncommitted changes) moved since up.sh; down.sh and up.sh again" >&2; exit 1; }
echo "api:      $API"
services=$(ap_compose ps --format '{{.Service}} {{.State}} {{.Health}}') || { echo "doctor: docker compose ps failed" >&2; exit 1; }
echo "$services" | sort
# /readyz covers the database, schema and config only; sessions also need
# these running (and healthy where they have a healthcheck).
# A Codex run's sessions call the fake Responses API; the overlay that builds
# the Codex worker is what defines it for the run.
codex=$(ap_compose config --services 2>/dev/null | grep -x fake-responses || true)
for service in api scheduler reconciler postgres localstack fake-git egress-proxy fake-messages secrets $codex; do
  line=$(echo "$services" | awk -v s="$service" '$1 == s')
  case "$line" in
    *" running unhealthy" | *" running starting") echo "doctor: $service is not healthy yet: $line" >&2; exit 1 ;;
    *" running"*) ;;
    *) echo "doctor: $service is not running${line:+: $line}" >&2; exit 1 ;;
  esac
done
ready=$(curl -sS --max-time 3 "$API/readyz" || true)
echo "readyz:   ${ready:-no answer}"
case "$ready" in *'"status":"ready"'*) ;; *) exit 1 ;; esac
