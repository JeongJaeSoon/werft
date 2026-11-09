#!/usr/bin/env bash
# Tear down the stack up.sh started, and only that one: scripts/local.sh down
# under the run's own project, then a second compose down with --profile apps
# and the fake-model overlay (without both, app containers, fake-messages and
# the default network can survive), then the leftover check: no container
# and no network of the project or its installation.
# Then the run's own images and networks, by exact name (teardown-lib.sh); the
# targets, volumes included, are printed first.
# Volumes are never deleted here (no -v, no docker volume rm): rm-volumes.sh
# is the separate step that removes them by exact name. Evidence in
# <run>/evidence stays, and so does ports.yml until rm-volumes.sh runs. Any
# failure keeps ports.yml so the same run can be torn down again once Docker
# answers.
#
#   down.sh <run id | run dir>    the run id up.sh printed; no default run,
#                                  without one it lists the runs and deletes nothing
set -uo pipefail

keep=--keep-volumes
case "$#" in
  [01]) ;;
  *) echo "usage: down.sh <run id | run dir>   (volumes stay; rm-volumes.sh removes them)" >&2; exit 2 ;;
esac

# shellcheck disable=SC1091
. "$(dirname "$0")/run.sh" "${1:-}" || exit 2
run=$VERIFY_RUN_DIR
# shellcheck disable=SC1091
. "$run/state.env" || exit 1
case "${COMPOSE_PROJECT_NAME:-}" in
  verify-ap-*) ;;
  *) echo "down.sh: $run/state.env names no verify-ap-* project; nothing was deleted" >&2; exit 1 ;;
esac
cd "$VERIFY_REPO" || exit 1
# The project must be exactly verify-ap-<this run's id>. A prefix match would
# also hit a long-lived stack, whose project name starts the same way.
# shellcheck disable=SC1091
. "$(dirname "$0")/teardown-lib.sh"
if ! teardown_guard "$(basename "$run")" "$COMPOSE_PROJECT_NAME" "${EXECUTION_INSTALLATION_ID:-}"; then
  echo "down.sh: project '$COMPOSE_PROJECT_NAME' is not verify-ap-$(basename "$run"); nothing was deleted" >&2
  exit 1
fi

failed=0
if [ -f "$run/browser/pid" ]; then
  node "$VERIFY_REPO/.claude/skills/verify-werft/scripts/browser.mjs" "$run" stop >&2 || failed=1
fi
# Listed before anything goes: once the containers are gone, nothing links
# their anonymous volumes to this run.
# A rerun finds the containers already removed, so the anonymous volumes an
# earlier pass recorded come from its own list.
targets=$run/evidence/teardown-targets.txt
prior=
[ ! -f "$targets" ] || prior=$(sed -n 's/^  volume  \([0-9a-f]\{64\}\)$/\1/p' "$targets")
if ! teardown_snapshot "$COMPOSE_PROJECT_NAME"; then
  echo "down.sh: Docker could not list this run's resources; nothing was deleted, rerun down.sh $run" >&2
  exit 1
fi
TEARDOWN_VOLUMES=$(printf '%s\n%s\n' "$TEARDOWN_VOLUMES" "$prior" | sed '/^$/d' | sort -u)
teardown_print "$COMPOSE_PROJECT_NAME" | tee "$targets" >&2
"$VERIFY_REPO/scripts/local.sh" down "$keep" 2>&1 | tee "$run/evidence/down.log" >&2 || failed=1
docker compose --profile apps --profile fake-model \
  -f compose.yaml -f "$run/ports.yml" -f infra/compose.fake-model.yml \
  down --remove-orphans --rmi local >>"$run/evidence/down.log" 2>&1 || failed=1
# By the names listed above, without -f: what another run still uses refuses
# and stays. Images go here, not after the leftover check, so a failed check
# does not leave a finished run's images behind.
teardown_delete "$COMPOSE_PROJECT_NAME" "$keep" >>"$run/evidence/down.log" 2>&1

left=$(docker ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --format '{{.Names}}') || failed=1
workers=$(docker ps -a --filter "label=werft.installation=$EXECUTION_INSTALLATION_ID" --format '{{.Names}}') || failed=1
networks=$(
  docker network ls --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --format '{{.Name}}' &&
    docker network ls --filter "label=werft.installation=$EXECUTION_INSTALLATION_ID" --format '{{.Name}}'
) || failed=1
if [ "$failed" = 1 ]; then
  echo "down.sh: a teardown or leftover check failed (see $run/evidence/down.log); ports.yml kept, rerun down.sh $run" >&2
  exit 1
fi
{
  echo "\$ docker ps -a --filter label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"
  echo "${left:-(none)}"
  echo "\$ docker ps -a --filter label=werft.installation=$EXECUTION_INSTALLATION_ID"
  echo "${workers:-(none)}"
  echo "\$ docker network ls --filter label=com.docker.compose.project=$COMPOSE_PROJECT_NAME, then label=werft.installation=$EXECUTION_INSTALLATION_ID"
  echo "${networks:-(none)}"
  echo "\$ volumes of the run, kept on purpose (rm-volumes.sh removes them)"
  teardown_volumes "$COMPOSE_PROJECT_NAME" | sed 's/^/  /'
  echo "\$ docker images, this run's tags"
  echo "$(teardown_images "$COMPOSE_PROJECT_NAME")"
} | tee "$run/evidence/leftovers.txt"
if [ -n "$left$workers$networks" ]; then
  echo "down.sh: containers or networks left (above); ports.yml kept, rerun down.sh $run" >&2
  exit 1
fi
echo "down.sh: volumes kept; the run stays listed until rm-volumes.sh $run removes them" >&2
