#!/usr/bin/env bash
# The volume step of a verify run's cleanup, separate from down.sh on purpose.
# Removes this run's volumes by exact name with `docker volume rm` (no -f, no
# prune), and only names that start with verify-ap-<run id>_, the compose
# volumes of this project. Other volumes of the run (anonymous worker volumes,
# werft-ws-*) are printed and left.
#
# Names come from down.sh's evidence/teardown-targets.txt and from the labels
# of the project, so it works after the containers are gone.
#
#   rm-volumes.sh <run id | run dir>    run down.sh first; no default run
set -uo pipefail

[ "$#" = 1 ] || { echo "usage: rm-volumes.sh <run id | run dir>" >&2; exit 2; }

# shellcheck disable=SC1091
. "$(dirname "$0")/run.sh" "$1" || exit 2
run=$VERIFY_RUN_DIR
# shellcheck disable=SC1091
. "$run/state.env" || exit 1
cd "${VERIFY_REPO:?}" || exit 1
# shellcheck disable=SC1091
. "$(dirname "$0")/teardown-lib.sh"
if ! teardown_guard "$(basename "$run")" "${COMPOSE_PROJECT_NAME:-}" "${EXECUTION_INSTALLATION_ID:-}"; then
  echo "rm-volumes.sh: project '${COMPOSE_PROJECT_NAME:-}' is not verify-ap-$(basename "$run"); nothing was removed" >&2
  exit 1
fi
if [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ]; then
  echo "rm-volumes.sh: containers of $COMPOSE_PROJECT_NAME are still running; run down.sh $run first" >&2
  exit 1
fi

targets=$run/evidence/teardown-targets.txt
prior=
[ ! -f "$targets" ] || prior=$(sed -n 's/^  volume  \(.*\)$/\1/p' "$targets")
labelled=$(teardown_volumes "$COMPOSE_PROJECT_NAME") || { echo "rm-volumes.sh: Docker could not list volumes; nothing was removed" >&2; exit 1; }
TEARDOWN_VOLUMES=$(printf '%s\n%s\n' "$labelled" "$prior" | sed '/^$/d' | sort -u)

failed=0
out=$run/evidence/rm-volumes.txt
# Names come from a file: no glob expansion in the loop below.
set -f
{
  for name in $TEARDOWN_VOLUMES; do
    case "$name" in
      "$COMPOSE_PROJECT_NAME"_*)
        echo "\$ docker volume rm $name"
        docker volume rm "$name" 2>&1 || failed=1 ;;
      *) echo "left (name does not start with ${COMPOSE_PROJECT_NAME}_): $name" ;;
    esac
  done
  left=$(teardown_volumes_left) || failed=1
  echo "\$ volumes of the run that still exist"
  echo "${left:-(none)}"
} >"$out" 2>&1
cat "$out" >&2
if [ "$failed" = 1 ]; then
  echo "rm-volumes.sh: a volume could not be removed or listed (above); ports.yml kept" >&2
  exit 1
fi

rm -f "$run/ports.yml" "$run/cookie" "$run"/cookie.*
rm -rf "$run/users" "$run/keys"
