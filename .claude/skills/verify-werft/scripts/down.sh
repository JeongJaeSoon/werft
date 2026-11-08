#!/usr/bin/env bash
# Tear down the stack up.sh started, and only that one: scripts/local.sh down
# under the run's own project, then a second compose down with --profile apps
# and the fake-model overlay (without both, app containers, fake-messages and
# the default network can survive), then the leftover check: no container
# and no network of the project or its installation.
# Then the run's own images, volumes (anonymous ones of its workers too) and
# networks, by exact name (teardown-lib.sh); the targets are printed first.
# Evidence in <run>/evidence stays. Any failure keeps ports.yml so the same
# run can be torn down again once Docker answers.
#
#   down.sh <run id | run dir>    the run id up.sh printed; no default run,
#                                  without one it lists the runs and deletes nothing
#   down.sh <run> --keep-volumes  the same, but the volumes stay and so does the
#                                  run; a later down.sh <run> deletes them
set -uo pipefail

keep=${2:-}
case "$#:$keep" in
  [01]: | 2:--keep-volumes) ;;
  *) echo "usage: down.sh <run id | run dir> [--keep-volumes]" >&2; exit 2 ;;
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
# A --keep-volumes pass already removed the containers, so the anonymous
# volumes it recorded come from its own list.
targets=$run/evidence/teardown-targets.txt
prior=
[ ! -f "$targets" ] || prior=$(sed -n 's/^  volume  \([0-9a-f]\{64\}\)$/\1/p' "$targets")
if ! teardown_snapshot "$COMPOSE_PROJECT_NAME"; then
  echo "down.sh: Docker could not list this run's resources; nothing was deleted, rerun down.sh $run${keep:+ $keep}" >&2
  exit 1
fi
TEARDOWN_VOLUMES=$(printf '%s\n%s\n' "$TEARDOWN_VOLUMES" "$prior" | sed '/^$/d' | sort -u)
teardown_print "$COMPOSE_PROJECT_NAME" | tee "$targets" >&2
# shellcheck disable=SC2086 # no argument when volumes go
"$VERIFY_REPO/scripts/local.sh" down $keep 2>&1 | tee "$run/evidence/down.log" >&2 || failed=1
down_args=(--remove-orphans --rmi local)
[ -n "$keep" ] || down_args+=(-v)
docker compose --profile apps --profile fake-model \
  -f compose.yaml -f "$run/ports.yml" -f infra/compose.fake-model.yml \
  down "${down_args[@]}" >>"$run/evidence/down.log" 2>&1 || failed=1
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
volumes=
if [ -z "$keep" ]; then
  # By the snapshot's names too: an anonymous volume whose container is gone
  # can only be found that way.
  labelled=$(teardown_volumes "$COMPOSE_PROJECT_NAME") || failed=1
  volumes=$(printf '%s\n%s\n' "$labelled" "$(teardown_volumes_left)" | sed '/^$/d' | sort -u)
fi
if [ "$failed" = 1 ]; then
  echo "down.sh: a teardown or leftover check failed (see $run/evidence/down.log); ports.yml kept, rerun down.sh $run${keep:+ $keep}" >&2
  exit 1
fi
{
  echo "\$ docker ps -a --filter label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"
  echo "${left:-(none)}"
  echo "\$ docker ps -a --filter label=werft.installation=$EXECUTION_INSTALLATION_ID"
  echo "${workers:-(none)}"
  echo "\$ docker network ls --filter label=com.docker.compose.project=$COMPOSE_PROJECT_NAME, then label=werft.installation=$EXECUTION_INSTALLATION_ID"
  echo "${networks:-(none)}"
  echo "\$ volumes labelled for the project or installation, and anonymous volumes of their containers${keep:+ (kept: --keep-volumes)}"
  echo "${volumes:-(none)}"
  echo "\$ docker images, this run's tags"
  echo "$(teardown_images "$COMPOSE_PROJECT_NAME")"
} | tee "$run/evidence/leftovers.txt"
if [ -n "$left$workers$networks$volumes" ]; then
  echo "down.sh: containers, networks or volumes left (above); ports.yml kept, rerun down.sh $run${keep:+ $keep}" >&2
  exit 1
fi
if [ -n "$keep" ]; then
  echo "down.sh: volumes kept; the run stays listed until down.sh $run deletes them" >&2
  exit 0
fi
rm -f "$run/ports.yml" "$run/cookie" "$run"/cookie.*
rm -rf "$run/users" "$run/keys"
