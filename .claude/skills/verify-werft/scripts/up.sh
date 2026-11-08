#!/usr/bin/env bash
# Start a verification stack of its own: scripts/local.sh up --fake-model
# under a fresh compose project, with every host port ephemeral (loopback)
# and a bootstrap token this run chose. Prints the run directory on stdout
# and the run id on stderr; every later step names that run.
#
#   up.sh                      new project verify-ap-<run id>
#   up.sh infra/compose.x.yml  the same, with opt-in overlays on top
#   VERIFY_DEMO_ACCOUNTS=1 up.sh  include the local demo accounts and data
#   VERIFY_SLOT_LIMIT=5 up.sh  worker slots other than the default: 3, or 7 with the demo data
#
# Each worker takes a network, and so an address pool entry, of its own, so
# the stack holds at most slots + 1 networks; up.sh stops before anything
# exists when Docker's pools cannot fit that.
set -euo pipefail

demo=${VERIFY_DEMO_ACCOUNTS:-0}
# The demo data ends with six sessions holding a worker and stops a seventh;
# with fewer slots its seed waits on a queued session until it times out.
default_slots=3
[ "$demo" = 0 ] || default_slots=7
slots=${VERIFY_SLOT_LIMIT:-$default_slots}
case "$slots" in
  '' | 0* | *[!0-9]* | ?????*) echo "up.sh: VERIFY_SLOT_LIMIT must be a positive integer below 10000 (got '$slots')" >&2; exit 1 ;;
esac
"$(dirname "$0")/address-pool.sh" "$((slots + 1))" || {
  if [ "$?" = 1 ]; then
    echo "up.sh: nothing was started; down a stack you started, or start with a smaller VERIFY_SLOT_LIMIT" >&2
  else
    echo "up.sh: nothing was started; check that Docker answers, then run up.sh again" >&2
  fi
  exit 1
}

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
root=${VERIFY_AP_ROOT:-$(t=${TMPDIR:-/tmp}; echo "${t%/}")/verify-werft}
run_id=$(date +%Y%m%d-%H%M%S)-$$
run="$root/$run_id"
project="verify-ap-$(echo "$run_id" | tr -cd 'a-z0-9-')"
mkdir -p "$run/evidence"
chmod 700 "$run"

# The same overrides as tests/e2e/compose.yml: ephemeral loopback ports, so
# this stack never fights another one (this machine's 3000 may be taken).
# The token is a throwaway for this run's empty database only.
token=$(openssl rand -hex 24)
umask 077
cat >"$run/ports.yml" <<EOF
services:
  postgres:
    ports: !override
      - "127.0.0.1::5432"
  localstack:
    ports: !override
      - "127.0.0.1::4566"
  secrets:
    ports: !override []
  fake-git:
    ports: !override
      - "127.0.0.1::3000"
  api:
    ports: !override
      - "127.0.0.1::3000"
    environment:
      BOOTSTRAP_TOKEN: "$token"
EOF

{
  printf 'VERIFY_RUN=%q\n' "$run"
  printf 'VERIFY_REPO=%q\n' "$repo"
  printf 'export COMPOSE_PROJECT_NAME=%q\n' "$project"
  printf 'export EXECUTION_INSTALLATION_ID=%q\n' "$project"
  printf 'export EXECUTION_SLOT_LIMIT=%q\n' "$slots"
  overlays=""
  for overlay in "$@"; do overlays="$overlays:$repo/$overlay"; done
  printf 'export COMPOSE_FILE=%q\n' "$repo/compose.yaml:$run/ports.yml$overlays"
  # Per-run tags, as tests/e2e/run.sh does: the scheduler starts workers from
  # WORKER_IMAGE, so a shared :dev tag would let another stack's build
  # change what this one runs (and the reverse).
  printf 'export API_IMAGE=%q\n' "werft-control-host:$project"
  printf 'export WORKER_IMAGE=%q\n' "werft-worker:$project"
  printf 'export EGRESS_PROXY_IMAGE=%q\n' "werft-egress-proxy:$project"
  printf 'VERIFY_BOOTSTRAP_TOKEN=%q\n' "$token"
  printf 'VERIFY_BUILT_FROM=%q\n' "$("$repo/.claude/skills/verify-werft/scripts/tree-id.sh" "$repo")"
} >"$run/state.env"
echo "run: $run (project $project)" >&2
echo "run id: $run_id  (record it; later: lib.sh $run_id, doctor.sh $run_id, down.sh $run_id)" >&2

# shellcheck disable=SC1091
. "$run/state.env"
# Bootstrap runs start empty; demo verification explicitly opts in.
if ! LOCAL_DEMO_ACCOUNTS=$demo "$repo/scripts/local.sh" up --fake-model 2>&1 | tee "$run/evidence/up.log" >&2; then
  # A half-built run has images, volumes and networks nobody will name again.
  echo "up.sh: the stack did not come up; tearing down this run (evidence/up.log stays)" >&2
  "$(dirname "$0")/down.sh" "$run_id" || true
  exit 1
fi

api=$(docker compose --profile apps port api 3000 | head -n 1)
echo "VERIFY_API=http://127.0.0.1:${api##*:}" >>"$run/state.env"
echo "run id: $run_id" >&2
echo "$run"
