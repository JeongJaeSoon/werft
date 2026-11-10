#!/usr/bin/env bash
# The soak/campaign stack: the compose product stack built from this
# checkout, with the D2 gate overlay (scripts/d2-gate/compose.yml) and the
# soak overlay (scripts/soak/compose.yml), under a project and installation
# of its own so it never touches another card's stack.
#
#   scripts/soak/stack.sh up      build the images, start, create the fixture
#   scripts/soak/stack.sh reset   down (images kept) and up again: a clean
#                                 database and bucket for a campaign
#   scripts/soak/stack.sh down    remove this project's containers, networks,
#                                 volumes and workers; SOAK_RMI=1 also the images
#   scripts/soak/stack.sh logs    write every service's log to $SOAK_STATE/compose.log
#
# Host ports are ephemeral and loopback-only, so the stack cannot collide
# with another; `up` writes the ones it got, the API key and the image tags
# to $SOAK_STATE/vars.sh (mode 0600), which soak.ts and campaigns.ts read.
#
# The project and installation are always soak135; SOAK_STATE defaults to
# ${TMPDIR}/soak135-state. SOAK_SKIP_BUILD=1 reuses images already tagged.
# Removal is by this project's name and this installation's label only.
set -euo pipefail
umask 077

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

if [ -z "${DOCKER_HOST:-}" ] && [ -S "$HOME/.docker/run/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
fi

# Fixed, not configurable: `down` removes volumes and every resource with
# this installation label, so the names it acts on are the ones this script
# creates and no other stack's.
project=soak135
state="${SOAK_STATE:-${TMPDIR:-/tmp}/soak135-state}"
mkdir -p "$state"

export EXECUTION_INSTALLATION_ID=soak135
# One control-host image runs the api, scheduler and reconciler roles.
export API_IMAGE="werft-control-host:${project}"
export WORKER_IMAGE="werft-worker:${project}"
export EGRESS_PROXY_IMAGE="werft-egress-proxy:${project}"
# The first owner's token: the soak's agent is released as that owner
# (scripts/d2-gate/release.ts). Kept across runs on a kept stack.
export BOOTSTRAP_TOKEN="${SOAK_BOOTSTRAP_TOKEN:-soak-bootstrap-token-for-the-local-stack}"
compose_files=(-f infra/compose.yml -f scripts/d2-gate/compose.yml -f scripts/soak/compose.yml)
dc() { docker compose -p "$project" "${compose_files[@]}" --profile apps --profile worker "$@"; }

down() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  local label="werft.installation=${EXECUTION_INSTALLATION_ID}"
  local volume_label="${EXECUTION_VOLUME_LABEL_NAMESPACE:-werft}.installation=${EXECUTION_INSTALLATION_ID}"
  local ids
  ids="$(docker ps -aq --filter "label=${label}")"
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
  ids="$(docker network ls -q --filter "label=${label}")"
  [ -z "$ids" ] || docker network rm $ids >/dev/null 2>&1 || true
  ids="$(docker volume ls -q --filter "label=${volume_label}")"
  [ -z "$ids" ] || docker volume rm -f $ids >/dev/null 2>&1 || true
  if [ "${SOAK_RMI:-0}" = 1 ]; then
    # migrate's image, built under the project's default name.
    dc down --rmi local >/dev/null 2>&1 || true
    docker image rm "$API_IMAGE" "$WORKER_IMAGE" "$EGRESS_PROXY_IMAGE" >/dev/null 2>&1 || true
  fi
}

up() {
  if [ "${SOAK_SKIP_BUILD:-0}" != 1 ]; then
    echo "== build (${project})" >&2
    # migrate builds from the same Dockerfile under the project's own name;
    # left out, a kept stack runs an old image missing the newest migrations.
    # fake-git likewise, or `up` would build it from this checkout.
    # SOAK_BUILD_ROOT: another checkout to build the images from (rc.sh).
    (cd "${SOAK_BUILD_ROOT:-$root}" && dc build api migrate fake-git worker egress-proxy) >"$state/build.log" 2>&1
  fi
  echo "== stack (${project})" >&2
  dc up -d --wait postgres localstack secrets fake-git gate-chaos gate-messages egress-proxy vm-lag host-echo >"$state/up.log" 2>&1
  dc up -d --wait api >>"$state/up.log" 2>&1

  port() { dc port "$1" "$2" | sed 's/.*://'; }

  echo "== fixture" >&2
  # Every session runs an agent release: the first owner releases the gate's
  # agent on gate-messages and holds the key the soak uses.
  local key approve release vars
  vars="$(D2_GATE_API_URL="http://127.0.0.1:$(port api 3000)" bun scripts/d2-gate/release.ts)"
  key="$(printf '%s\n' "$vars" | sed -n 's/^D2_GATE_API_KEY=//p')"
  approve="$(printf '%s\n' "$vars" | sed -n 's/^D2_GATE_APPROVE_KEY=//p')"
  release="$(printf '%s\n' "$vars" | sed -n 's/^D2_GATE_RELEASE_ID=//p')"
  [ -n "$key" ] && [ -n "$approve" ] && [ -n "$release" ] || { echo "the soak agent was not released" >&2; return 1; }

  # The reconciler runs as the product runs it, on its own loop.
  dc up -d --wait scheduler reconciler >>"$state/up.log" 2>&1

  rm -f "$state/vars.sh"
  {
    echo "export SOAK_PROJECT='${project}'"
    echo "export SOAK_STATE='${state}'"
    echo "export SOAK_INSTALLATION='${EXECUTION_INSTALLATION_ID}'"
    # Campaigns recreate the scheduler through compose, which reads these.
    echo "export EXECUTION_INSTALLATION_ID='${EXECUTION_INSTALLATION_ID}'"
    echo "export SOAK_SCHEDULER_INTERVAL_SEC='${SOAK_SCHEDULER_INTERVAL_SEC:-5}'"
    echo "export SOAK_API_URL='http://127.0.0.1:$(port api 3000)'"
    echo "export SOAK_API_KEY='${key}'"
    echo "export SOAK_APPROVE_KEY='${approve}'"
    echo "export D2_GATE_RELEASE_ID='${release}'"
    echo "export SOAK_DATABASE_URL='postgres://postgres:dev@127.0.0.1:$(port postgres 5432)/sessions'"
    echo "export SOAK_S3_URL='http://127.0.0.1:$(port localstack 4566)'"
    echo "export SOAK_CHAOS_URL='http://127.0.0.1:$(port gate-chaos 8099)'"
    echo "export SOAK_MESSAGES_URL='http://127.0.0.1:$(port gate-messages 4011)'"
    echo "export SOAK_VM_LAG_URL='http://127.0.0.1:$(port vm-lag 8098)'"
    echo "export SOAK_HOST_ECHO_URL='http://127.0.0.1:$(port host-echo 8098)'"
    echo "export SOAK_NETWORK='${project}_default'"
    echo "export SOAK_COMPOSE_FILES='${compose_files[*]}'"
    echo "export API_IMAGE='${API_IMAGE}'"
    echo "export WORKER_IMAGE='${WORKER_IMAGE}'"
    echo "export EGRESS_PROXY_IMAGE='${EGRESS_PROXY_IMAGE}'"
    [ -z "${DOCKER_HOST:-}" ] || echo "export DOCKER_HOST='${DOCKER_HOST}'"
  } >"$state/vars.sh"
  echo "stack up: source $state/vars.sh" >&2
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  reset)
    down
    SOAK_SKIP_BUILD=1 up
    ;;
  logs) dc logs --no-color --timestamps >"${2:-$state/compose.log}" 2>&1 ;;
  compose)
    shift
    # Only this stack: no flag that would select another project or files.
    for arg in "$@"; do
      case "$arg" in
        -p | -p* | --project-name* | -f | -f* | --file* | --project-directory* | --env-file* | -c | --context*)
          echo "refusing: '$arg' would leave the soak135 stack" >&2
          exit 2
          ;;
      esac
    done
    dc "$@"
    ;;
  *)
    echo "usage: $0 up|reset|down|logs [file]|compose <args>" >&2
    exit 2
    ;;
esac
