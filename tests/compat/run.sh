#!/usr/bin/env bash
# A new control-host against an old release's worker, the way an upgrade
# meets it (docs/contributing/decisions/worker-compat.md § 4.1):
#
#   1  the old release, from its own checkout and its own images
#   2  this checkout's migrate (the new schema) under the old control-host
#   3  this checkout's control-host in every role, the old worker and proxy
#
# One compose project lives through all three, so the database, object
# store, installation id and secrets stay. tests/compat/upgrade.compat.ts
# drives one stage at a time; the pass is completed turns, not the absence
# of a 400.
#
#   COMPAT_ENGINE              claude_agent_sdk | codex_app_server
#   COMPAT_OLD_DIR             the old release's checkout, installed
#   COMPAT_OLD_CONTROL_HOST    the old release's images, pulled
#   COMPAT_OLD_WORKER          (the engine's worker image)
#   COMPAT_OLD_EGRESS_PROXY
#   COMPAT_NEW_CONTROL_HOST    the control-host under test, pulled; empty
#                              builds it from this checkout
#   COMPAT_OUT                 logs and records (default: a fresh temp dir)
#   COMPAT_MIRROR=1            CI: each checkout's tests/e2e/compose.ci-mirror.yml
#                              over its own stack, so nothing comes from Docker Hub
#
# Stage 1 runs the old checkout's own tests/e2e/run.sh (E2E_UP_ONLY=1) with
# an overlay that swaps its builds for the release images and points the
# fake model, fake MCP and fake git at this checkout, whose driver scripts
# them. Everything the run started is removed on exit.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

: "${COMPAT_ENGINE:?}" "${COMPAT_OLD_DIR:?}" "${COMPAT_OLD_CONTROL_HOST:?}"
: "${COMPAT_OLD_WORKER:?}" "${COMPAT_OLD_EGRESS_PROXY:?}"
new_control_host="${COMPAT_NEW_CONTROL_HOST:-}"
old="$(cd "$COMPAT_OLD_DIR" && pwd)"
out="${COMPAT_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/compat.XXXXXX")}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

case "$COMPAT_ENGINE" in
  claude_agent_sdk)
    engine_files=()
    model_overlay=infra/compose.fake-model.yml ;;
  codex_app_server)
    engine_files=(-f infra/compose.codex-worker.yml)
    model_overlay=tests/conformance/compose.codex.yml ;;
  *) echo "COMPAT_ENGINE is claude_agent_sdk or codex_app_server" >&2; exit 2 ;;
esac
files=(-f infra/compose.yml -f tests/e2e/compose.yml
  ${engine_files[@]+"${engine_files[@]}"} -f tests/conformance/compose.yml -f "$model_overlay")
old_mirror=""
if [ "${COMPAT_MIRROR:-0}" = 1 ]; then
  old_mirror="$old/tests/e2e/compose.ci-mirror.yml"
  files+=(-f tests/e2e/compose.ci-mirror.yml)
fi
for file in "${files[@]}"; do
  [ "$file" = -f ] || [ -f "$old/$file" ] || {
    echo "compat: the old release has no ${file}; it predates this engine's conformance stack" >&2
    exit 2
  }
done

# The services of a checkout's stack that run each app image, read from its
# own compose files: a role the release has and this checkout lacks (or the
# reverse) is named only where it exists.
roles() {
  local dir="$1"
  (cd "$dir" && API_IMAGE=compat-control-host WORKER_IMAGE=compat-worker \
    EGRESS_PROXY_IMAGE=compat-egress-proxy \
    docker compose "${files[@]}" --profile apps config --format json) |
    jq -r '.services | to_entries[]
      | (.value.build.dockerfile // "") as $file
      | if .key == "fake-git" then "fake \(.key)"
        elif .value.image == "compat-control-host" or ($file | endswith("apps/control-host/Dockerfile")) then "control-host \(.key)"
        elif .value.image == "compat-worker" or ($file | endswith("apps/worker/Dockerfile")) then "worker \(.key)"
        elif .value.image == "compat-egress-proxy" or ($file | endswith("apps/egress-proxy/Dockerfile")) then "egress-proxy \(.key)"
        elif ((.value.volumes // []) | any(.target == "/app")) then "fake \(.key)"
        else empty end'
}

# An overlay naming `image` for every service of an app role, without its
# build; the fakes run from this checkout.
overlay() {
  local dir="$1" control_host="$2" path="$3"
  {
    echo "services:"
    roles "$dir" | while read -r role service; do
      local image=""
      case "$role" in
        control-host) image="$control_host" ;;
        worker) image="$COMPAT_OLD_WORKER" ;;
        egress-proxy) image="$COMPAT_OLD_EGRESS_PROXY" ;;
      esac
      echo "  ${service}:"
      if [ "$role" = fake ]; then
        if [ "$service" = fake-git ]; then
          printf '    build:\n      context: %s\n' "$root"
        else
          printf '    volumes: !override\n      - %s:/app:ro\n' "$root"
        fi
        continue
      fi
      if [ -n "$image" ]; then
        printf '    image: %s\n    build: !reset null\n' "$image"
      fi
      if [ "$service" = scheduler ]; then
        printf '    environment:\n      WORKER_IMAGE: %s\n      WORKER_IMAGE_PREVIOUS: %s\n' \
          "$COMPAT_OLD_WORKER" "$COMPAT_OLD_WORKER"
      fi
    done
  } >"$path"
}

project=""
cleanup() {
  local status=$?
  if [ -n "$project" ]; then
    # Either overlay names every service; only the images differ.
    local overlays=(-f "$out/overlay-old.yml")
    [ ! -f "$out/overlay-new.yml" ] || overlays=(-f "$out/overlay-new.yml")
    docker compose -p "$project" "${files[@]}" "${overlays[@]}" --profile apps \
      logs --no-color --timestamps >"$out/compose.log" 2>&1 || true
    mkdir -p "$out/workers"
    for id in $(docker ps -aq --filter "label=werft.installation=${EXECUTION_INSTALLATION_ID}"); do
      docker logs --timestamps "$id" >"$out/workers/${id}.log" 2>&1 || true
    done
    docker compose -p "$project" "${files[@]}" "${overlays[@]}" --profile apps \
      down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
    # Named, so --rmi local keeps it: this checkout's control-host build.
    [ -n "$new_control_host" ] || docker image rm -f "werft-control-host:${project}-new" >/dev/null 2>&1 || true
    ids="$(docker ps -aq --filter "label=werft.installation=${EXECUTION_INSTALLATION_ID}")"
    [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
    ids="$(docker network ls -q --filter "label=werft.installation=${EXECUTION_INSTALLATION_ID}")"
    [ -z "$ids" ] || docker network rm $ids >/dev/null 2>&1 || true
    ids="$(docker volume ls -q --filter "label=${EXECUTION_VOLUME_LABEL_NAMESPACE:-werft}.installation=${EXECUTION_INSTALLATION_ID}")"
    [ -z "$ids" ] || docker volume rm -f $ids >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

drive() {
  echo "== stage $1" >&2
  COMPAT_STAGE="$1" COMPAT_STATE="$out/state.json" COMPAT_OLD_WORKER="$COMPAT_OLD_WORKER" \
    env -u ANTHROPIC_API_KEY bun test ./tests/compat/upgrade.compat.ts --timeout 900000 \
    2>&1 | tee "$out/stage-$1.log"
  return "${PIPESTATUS[0]}"
}

started=$SECONDS
echo "== stage 1: ${COMPAT_OLD_CONTROL_HOST}" >&2
overlay "$old" "$COMPAT_OLD_CONTROL_HOST" "$out/overlay-old.yml"
# run.sh lays E2E_COMPOSE_OVERRIDE, then E2E_COMPOSE_CACHE, over its stack.
if [ -n "$old_mirror" ]; then
  overlays_old=(E2E_COMPOSE_OVERRIDE="$old_mirror" E2E_COMPOSE_CACHE="$out/overlay-old.yml")
else
  overlays_old=(E2E_COMPOSE_OVERRIDE="$out/overlay-old.yml")
fi
(cd "$old" && env E2E_UP_ONLY=1 E2E_OUT="$out/old" "${overlays_old[@]}" \
  tests/e2e/run.sh --conformance "$COMPAT_ENGINE")
# shellcheck disable=SC1091
. "$out/old/vars.sh"
project="${E2E_COMPOSE_PROJECT:?the old run.sh names its compose project}"
export BOOTSTRAP_TOKEN="${E2E_BOOTSTRAP_TOKEN:-}"
# What stage 3 brings up, and the cleanup's view of the stack until then.
if [ -n "$new_control_host" ]; then
  overlay "$root" "$new_control_host" "$out/overlay-new.yml"
else
  # This checkout's control-host, built by its own compose files.
  export API_IMAGE="werft-control-host:${project}-new"
  overlay "$root" "" "$out/overlay-new.yml"
fi
dc() {
  docker compose -p "$project" "${files[@]}" -f "$out/overlay-new.yml" --profile apps "$@"
}
drive 1

echo "== stage 2: migrate of ${new_control_host:-this checkout}" >&2
[ -n "$new_control_host" ] || dc build migrate api >"$out/build.log" 2>&1 ||
  { tail -50 "$out/build.log" >&2; exit 1; }
dc run --rm --no-deps migrate >"$out/migrate.log" 2>&1 ||
  { tail -50 "$out/migrate.log" >&2; exit 1; }
drive 2

echo "== stage 3: every control-host role of ${new_control_host:-this checkout}" >&2
control_roles=()
while read -r service; do
  control_roles+=("$service")
done < <(roles "$root" | sed -n 's/^control-host //p' | grep -vx migrate)
dc up -d --no-deps --wait "${control_roles[@]}" >"$out/up-new.log" 2>&1 ||
  { tail -50 "$out/up-new.log" >&2; exit 1; }
# The recreated api has a new ephemeral port.
export E2E_API_URL="http://127.0.0.1:$(dc port api 3000 | sed 's/.*://')"
drive 3

echo "compat: passed in $((SECONDS - started))s" >&2
