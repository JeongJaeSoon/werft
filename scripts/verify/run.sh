# Sourced by lib.sh, doctor.sh and down.sh: turn the run argument into a run
# directory. There is no default run: several sessions on one machine share
# the root, so "the last run" may be someone else's stack.
#   . run.sh <run id | verify-ap-<run id> | run dir>  → sets VERIFY_RUN_DIR

verify_root=${VERIFY_AP_ROOT:-$(t=${TMPDIR:-/tmp}; echo "${t%/}")/verify-werft}

# Read-only: runs not yet torn down (rm-volumes.sh removes ports.yml) or with containers up.
verify_list_runs() {
  local state project up
  echo "live runs under $verify_root (run id, project, running containers):"
  # find, not a glob: lib.sh is also sourced from zsh, where an unmatched glob is an error.
  find "$verify_root" -mindepth 2 -maxdepth 2 -name state.env 2>/dev/null | sort | while read -r state; do
    project=$(sed -n 's/^export COMPOSE_PROJECT_NAME=//p' "$state")
    up=$(docker ps -q --filter "label=com.docker.compose.project=$project" 2>/dev/null | wc -l | tr -d ' ')
    [ "$up" != 0 ] || [ -f "$(dirname "$state")/ports.yml" ] || continue
    echo "  $(basename "$(dirname "$state")")  $project  $up"
  done
}

VERIFY_RUN_DIR=
case "${1:-}" in
  "") ;;
  */*) VERIFY_RUN_DIR=${1%/} ;;
  verify-ap-*) VERIFY_RUN_DIR=$verify_root/${1#verify-ap-} ;;
  *) VERIFY_RUN_DIR=$verify_root/$1 ;;
esac
if [ -z "$VERIFY_RUN_DIR" ] || [ ! -f "$VERIFY_RUN_DIR/state.env" ]; then
  echo "usage: lib.sh | doctor.sh | down.sh <run id | run dir>  (the run id up.sh printed; there is no default run)" >&2
  [ -n "${1:-}" ] && echo "no run state at '$VERIFY_RUN_DIR/state.env'" >&2
  verify_list_runs >&2
  VERIFY_RUN_DIR=
  return 2
fi
