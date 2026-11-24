#!/usr/bin/env bash
# The volume step of a verify run's cleanup, separate from down.sh on purpose.
# Removes this run's volumes by exact name with `docker volume rm` (no -f, no
# prune), and only names that start with verify-ap-<run id>_, the compose
# volumes of this project, or with werft-ws-verify-ap-<run id>-, the session
# workspaces of this installation (the trailing "-" keeps a run id that is a
# prefix of another apart). A workspace a container still mounts is printed
# and left. An anonymous worker volume (64 hex characters) says nothing about
# its run by name, and Docker gives it no compose label either. It is removed
# only when the run's own labelled containers were seen mounting it (the mounts
# down.sh recorded in teardown-targets.txt, or a container that is still
# there), it exists, no container uses it now, it is marked anonymous, and it
# carries no label other than Docker's anonymous marker. Anything
# else is printed and left.
#
# Names come from down.sh's evidence/teardown-targets.txt and from the labels
# of the project, so it works after the containers are gone.
#
#   rm-volumes.sh [--dry-run] <run id | run dir>    run down.sh first; no default run
#
# --dry-run prints what would be removed and what would be left, runs no
# `docker volume rm`, and keeps everything else of the run.
set -uo pipefail

dry=
if [ "${1:-}" = "--dry-run" ]; then dry=1; shift; fi
[ "$#" = 1 ] || { echo "usage: rm-volumes.sh [--dry-run] <run id | run dir>" >&2; exit 2; }

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
# The long-lived 4620 demo stack: never a target, whatever its state file says.
if [ "$COMPOSE_PROJECT_NAME" = verify-ap-20261031-094644-90075 ]; then
  echo "rm-volumes.sh: $COMPOSE_PROJECT_NAME is the demo stack; nothing was removed" >&2
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

# The prefix is fixed: up.sh never sets EXECUTION_VOLUME_NAME_PREFIX, and this
# shell's value need not be the one the stack ran with. The candidates above
# are already scoped to this run's labels and targets file, which is what keeps
# a hand-started installation named verify-ap-<run id>-x out.
workspaces=werft-ws-${EXECUTION_INSTALLATION_ID}-
failed=0
out=$run/evidence/rm-volumes.txt

remove_volume() {
  if [ -n "$dry" ]; then
    echo "would remove: $1"
  else
    echo "\$ docker volume rm $1"
    docker volume rm "$1" 2>&1 || failed=1
  fi
}

# $1 is a candidate whose link to this run came from the labels of its
# containers. Re-check the volume itself before removing it.
rm_anonymous() {
  local name=$1 found users labels
  if ! found=$(docker volume ls -q --filter "name=^$name\$"); then
    echo "could not tell whether $name exists; left"
    failed=1
    return
  fi
  [ "$found" = "$name" ] || { echo "already gone: $name"; return; }
  if ! users=$(docker ps -aq --filter "volume=$name"); then
    echo "could not tell whether a container uses $name; left"
    failed=1
    return
  fi
  if [ -n "$users" ]; then
    echo "left (a container still uses it): $name"
    return
  fi
  if ! labels=$(docker volume inspect --format '{{json .Labels}}' "$name"); then
    echo "could not read the labels of $name; left"
    failed=1
    return
  fi
  # An anonymous volume carries that one label and nothing else. Any further
  # label (a compose project, an installation) makes it somebody's: left.
  if [ "$labels" != '{"com.docker.volume.anonymous":""}' ]; then
    echo "left (not an unlabelled anonymous volume): $name"
    return
  fi
  remove_volume "$name"
}
# Names come from a file: no glob expansion in the loop below.
set -f
{
  for name in $TEARDOWN_VOLUMES; do
    case "$name" in
      "$COMPOSE_PROJECT_NAME"_*)
                remove_volume "$name" ;;
      "$workspaces"*)
        if ! users=$(docker ps -aq --filter "volume=$name"); then
          echo "could not tell whether a container uses $name; left"
          failed=1
        elif [ -n "$users" ]; then
          echo "left (a container still uses it): $name"
        else
                    remove_volume "$name"
        fi ;;
      *)
        if printf '%s' "$name" | grep -Eq '^[0-9a-f]{64}$'; then
          rm_anonymous "$name"
        else
          echo "left (name starts with neither ${COMPOSE_PROJECT_NAME}_ nor $workspaces): $name"
        fi ;;
    esac
  done
  left=$(teardown_volumes_left) || failed=1
  echo "\$ volumes of the run that still exist"
  echo "${left:-(none)}"
} >"$out" 2>&1
set +f
cat "$out" >&2
if [ "$failed" = 1 ]; then
  echo "rm-volumes.sh: a volume could not be removed or listed (above); ports.yml kept" >&2
  exit 1
fi

[ -z "$dry" ] || { echo "rm-volumes.sh: dry run; nothing was removed" >&2; exit 0; }

rm -f "$run/ports.yml" "$run/cookie" "$run"/cookie.*
rm -rf "$run/users" "$run/keys"
