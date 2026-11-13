#!/usr/bin/env bash
# The D2 completion gate, as one command
#
#   scripts/d2-gate/run.sh
#
# Builds the control-host, worker and egress-proxy images from this
# checkout, starts the compose product stack under a project of its own with the gate overlay
# (scripts/d2-gate/compose.yml), releases the gate's agent and issues its key
# (scripts/d2-gate/release.ts),
# then runs tests/d2-gate/gate.e2e.test.ts, tests/d2-gate/reconciler-sweep.e2e.test.ts
# and tests/d2-gate/control-host-roles.e2e.test.ts against it and prints each
# test's result (.github/scripts/d2-gate-verdict.ts). The report (JSON and
# Markdown) and every log land in D2_GATE_OUT (default: a fresh temp dir).
#
# D2_GATE_COMPOSE_OVERRIDE: more compose files after the gate's, separated by
# colons as in COMPOSE_FILE; the nightly workflow (.github/workflows/d2-gate.yml)
# passes the CI mirror overlays. D2_GATE_BUILD_ROOT: another checkout to build
# the images from, while the gate itself runs from this one (scripts/soak/rc.sh).
#
# D2_GATE_UP_ONLY=1 stops before the test and keeps the stack, writing the
# variables the test reads to $D2_GATE_OUT/vars.sh: source it and run
# `bun test tests/d2-gate/gate.e2e.test.ts` to iterate against the same stack.
#
# Needs Docker Engine 28+ (the worker network's isolated gateway mode) and
# bun. Leaves nothing behind unless D2_GATE_KEEP=1: the compose project, the
# worker containers, networks and volumes the scheduler made for this run's
# installation id, and the three images are removed on exit.
set -euo pipefail
# vars.sh and the logs carry the run's API key.
umask 077

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

if [ -z "${DOCKER_HOST:-}" ] && [ -S "$HOME/.docker/run/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
fi

run_id="$(od -An -N5 -tx1 /dev/urandom | tr -d ' \n')"
project="d2gate-${run_id}"
out="${D2_GATE_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/d2-gate.XXXXXX")}"
mkdir -p "$out"

export EXECUTION_INSTALLATION_ID="d2g${run_id}"
export API_IMAGE="werft-control-host:${project}"
export WORKER_IMAGE="werft-worker:${project}"
export EGRESS_PROXY_IMAGE="werft-egress-proxy:${project}"
# The first owner's token: the gate's agent is released as that owner.
export BOOTSTRAP_TOKEN="$(openssl rand -hex 24)"
compose_files=(-f infra/compose.yml -f scripts/d2-gate/compose.yml)
overrides="${D2_GATE_COMPOSE_OVERRIDE:-}"
for file in ${overrides//:/ }; do
  compose_files+=(-f "$file")
done
dc() { docker compose -p "$project" "${compose_files[@]}" --profile apps --profile worker "$@"; }

cleanup() {
  local status=$?
  dc logs --no-color --timestamps >"$out/compose.log" 2>&1 || true
  if [ "${D2_GATE_KEEP:-0}" = 1 ]; then
    echo "kept: compose project ${project}, installation ${EXECUTION_INSTALLATION_ID}" >&2
  else
    # --rmi local: migrate's image, built under the project's default name.
    dc down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
    local label="werft.installation=${EXECUTION_INSTALLATION_ID}"
    local volume_label="${EXECUTION_VOLUME_LABEL_NAMESPACE:-werft}.installation=${EXECUTION_INSTALLATION_ID}"
    local ids
    ids="$(docker ps -aq --filter "label=${label}")"
    [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
    ids="$(docker network ls -q --filter "label=${label}")"
    [ -z "$ids" ] || docker network rm $ids >/dev/null 2>&1 || true
    ids="$(docker volume ls -q --filter "label=${volume_label}")"
    [ -z "$ids" ] || docker volume rm -f $ids >/dev/null 2>&1 || true
    docker image rm "$API_IMAGE" "$WORKER_IMAGE" "$EGRESS_PROXY_IMAGE" >/dev/null 2>&1 || true
  fi
  echo "report: $out" >&2
  exit "$status"
}
trap cleanup EXIT

echo "== build (${project})" >&2
# migrate and fake-git too, or `up` would build them from this checkout, not the
# build root.
(cd "${D2_GATE_BUILD_ROOT:-$root}" && dc build api migrate fake-git worker egress-proxy) >"$out/build.log" 2>&1

echo "== stack" >&2
dc up -d --wait postgres localstack secrets fake-git gate-chaos gate-messages egress-proxy >"$out/up.log" 2>&1
dc up -d --wait api >>"$out/up.log" 2>&1

port() { dc port "$1" "$2" | sed 's/.*://'; }

echo "== fixture" >&2
# Every session runs an agent release: the first owner releases the gate's
# agent on the gate-messages connection and holds the key the gate uses.
release_vars="$(D2_GATE_API_URL="http://127.0.0.1:$(port api 3000)" bun scripts/d2-gate/release.ts)"
api_key="$(printf '%s\n' "$release_vars" | sed -n 's/^D2_GATE_API_KEY=//p')"
approve_key="$(printf '%s\n' "$release_vars" | sed -n 's/^D2_GATE_APPROVE_KEY=//p')"
release_id="$(printf '%s\n' "$release_vars" | sed -n 's/^D2_GATE_RELEASE_ID=//p')"
[ -n "$api_key" ] && [ -n "$approve_key" ] && [ -n "$release_id" ] || { echo "the gate's agent was not released" >&2; exit 1; }

# The reconciler runs as the product runs it, on its own loop.
dc up -d --wait scheduler reconciler >>"$out/up.log" 2>&1

echo "== gate" >&2
export D2_GATE=1
export D2_GATE_OUT="$out"
export D2_GATE_PROJECT="$project"
export D2_GATE_COMMAND="scripts/d2-gate/run.sh"
export D2_GATE_API_URL="http://127.0.0.1:$(port api 3000)"
export D2_GATE_API_KEY="$api_key"
export D2_GATE_APPROVE_KEY="$approve_key"
export D2_GATE_RELEASE_ID="$release_id"
export D2_GATE_DATABASE_URL="postgres://postgres:dev@127.0.0.1:$(port postgres 5432)/sessions"
export D2_GATE_S3_URL="http://127.0.0.1:$(port localstack 4566)"
export D2_GATE_CHAOS_URL="http://127.0.0.1:$(port gate-chaos 8099)"
export D2_GATE_MESSAGES_URL="http://127.0.0.1:$(port gate-messages 4011)"
export D2_GATE_NETWORK="${project}_default"
# A fresh file, so a reused D2_GATE_OUT cannot hand the key an older mode.
rm -f "$out/vars.sh"
export -p | grep -E ' (D2_GATE(_[A-Z0-9_]*)?|DOCKER_HOST|EXECUTION_INSTALLATION_ID|[A-Z]+_IMAGE)=' |
  grep -vE ' D2_GATE_(UP_ONLY|KEEP)=' >"$out/vars.sh"
if [ "${D2_GATE_UP_ONLY:-0}" = 1 ]; then
  export D2_GATE_KEEP=1
  echo "stack up: source $out/vars.sh" >&2
  exit 0
fi
# The gate, then the recovery sweep on the same stack: nothing in
# the gate proves the reconciler service acts without a pass run by hand.
# Each file is a bun run of its own: bun runs the files of one run in
# directory order, which differs between runner images, not as given.
# The gate must come first: its A-05 expects the session's own token mint,
# and an earlier clone of gate-app leaves the token in the API's cache.
status=0
# Fresh, so a reused D2_GATE_OUT cannot pass on an older run's reports.
rm -f "$out/gate.junit.xml" "$out/sweep.junit.xml" "$out/roles.junit.xml"
bun test tests/d2-gate/gate.e2e.test.ts \
  --reporter=junit --reporter-outfile="$out/gate.junit.xml" \
  --timeout 1800000 2>&1 | tee "$out/test.log" || status=$?
bun test tests/d2-gate/reconciler-sweep.e2e.test.ts \
  --reporter=junit --reporter-outfile="$out/sweep.junit.xml" \
  --timeout 1800000 2>&1 | tee -a "$out/test.log" || status=$?
# Last, the role checks, which restart the services and stop
# PostgreSQL, so nothing may run after them on this stack.
bun test tests/d2-gate/control-host-roles.e2e.test.ts \
  --reporter=junit --reporter-outfile="$out/roles.junit.xml" \
  --timeout 1800000 2>&1 | tee -a "$out/test.log" || status=$?
# Every test by name and result; one that skipped or never ran fails too.
bun .github/scripts/d2-gate-verdict.ts "$out/gate.junit.xml" "$out/sweep.junit.xml" \
  "$out/roles.junit.xml" 2>&1 | tee "$out/verdict.txt" || status=$?
exit "$status"
