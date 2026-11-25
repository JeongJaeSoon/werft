#!/usr/bin/env bash
# The alpha e2e, as one command
#
#   tests/e2e/run.sh
#
# Builds the api, scheduler and worker images from this checkout, starts the
# product compose stack (`apps` profile) on the fake Messages API
# (infra/compose.fake-model.yml — the stack docs/quickstart.md starts with
# `--fake-model`) under a project of its own with ephemeral loopback ports
# (tests/e2e/compose.yml), issues an API key with the key CLI, stores the
# imported settings' keys as the first owner (scripts/lib/seed-credentials.sh), then runs
# tests/e2e against the public HTTP API. The run record (command, tested
# SHA, image ids, SDK and Claude Code versions), the test output with its
# pass/skip list, compose logs and every worker container's log land in
# E2E_OUT (default: a fresh temp dir).
#
# E2E_UP_ONLY=1 stops before the tests and keeps the stack, writing the
# variables the suite reads to $E2E_OUT/vars.sh: source it and run
# `bun test ./tests/e2e/alpha-path.e2e.ts` to iterate against the same
# stack. The file is named outside Bun's `*.test.ts` rule so `bun run test`
# never collects it: without a stack it has nothing to talk to.
#
# Needs Docker Engine 28+ (the worker network's isolated gateway mode) and
# bun. Leaves nothing behind unless E2E_KEEP=1: the compose project, the
# worker containers, networks and volumes the scheduler made for this run's
# installation id, and the four images are removed on exit.
#
#   tests/e2e/run.sh --real-model
#
# The same stack against the real Messages API: no fake overlay, so the API
# migrate imports tests/fixtures/settings/real-model.json and the run stores
# ANTHROPIC_API_KEY as its connection's key, on stdin to the seed step and in
# no argument; infra/compose.real-model.yml caps what the run can
# spend (`scripts/local.sh up` starts the same overlay), and
# tests/e2e/real-model.e2e.ts runs in place of the scripted suites. The key
# comes from the shell or, failing that, the repository's .env. Without
# a key it stops before touching Docker, and it fails if the key's value
# turns up anywhere in E2E_OUT. Paid calls, so no CI job runs it.
#
#   tests/e2e/run.sh --local-model
#
# The same suite against the Ollama on this machine instead: migrate imports
# tests/fixtures/settings/local-model.json, whose two connections call Ollama
# directly and through a LiteLLM proxy (infra/compose.local-model.yml), and the suite runs once on
# each. Needs Ollama on localhost:11434 with gemma4:26b-mlx pulled; nothing
# is paid.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
. scripts/lib/real-model-key.sh
. scripts/lib/seed-credentials.sh
. scripts/lib/setup-link-token.sh
. tests/e2e/fetch-retry.sh

settings_values() {
  sed -n "s/^ *\"$1\": \"\(.*\)\",\{0,1\}\$/\1/p" "$2" | sort -u
}
# Every model the settings document's connections offer, one per line.
# (each connection's "models" list sits on one line in the fixtures).
settings_models() {
  sed -n 's/^ *"models": \[\(.*\)\],\{0,1\}$/\1/p' "$1" | tr ',' '\n' |
    sed 's/^ *"//; s/" *$//' | grep -v '^$' | sort -u
}

real_model=""
model_overlay=infra/compose.fake-model.yml
local_model=""
# E2E_MODEL_MODE is set here alone, over whatever the shell (say, a sourced
# vars.sh of another run) left: tests/e2e/real-model.e2e.ts picks its
# connections from it. A model run sets the session cost limit itself, the same
# default its overlay or compose.core.yml has, so the suite compares the
# session's limit with what the stack was given rather than a default.
conformance=""
conf_files=()
case "$*" in
  "") unset E2E_MODEL_MODE ;;
  "--conformance claude_agent_sdk"|"--conformance codex_app_server"|"--conformance two_engines")
    # The engine-parametrized suite (tests/conformance) on the same stack
    # lifecycle: one engine's worker image, its fake provider, the scripted
    # prompts. The engine's overlay names the provider the connections call.
    # two_engines runs tests/conformance/two-engines.e2e.ts alone, on a stack
    # with both engines' images and both fake providers.
    unset E2E_MODEL_MODE
    conformance="${2}"
    conf_files=(-f tests/conformance/compose.yml)
    # Low enough that one scripted reply with a large usage spends it
    # (tests/conformance/budget.conformance.ts), high enough that the other
    # scenarios' replies never do, and above what one call reserves at its
    # open: its whole cap of output, about a dollar on either engine.
    export SESSION_COST_LIMIT_USD="${SESSION_COST_LIMIT_USD:-5}"
    if [ "$conformance" = codex_app_server ]; then
      conf_files=(-f infra/compose.codex-worker.yml "${conf_files[@]}")
      model_overlay=tests/conformance/compose.codex.yml
    elif [ "$conformance" = two_engines ]; then
      conf_files+=(-f infra/compose.fake-model.yml -f infra/compose.two-engines.yml)
      model_overlay=tests/conformance/compose.two-engines.yml
    fi ;;
  --real-model) real_model=1; model_overlay=infra/compose.real-model.yml; export E2E_MODEL_MODE=real
    export SESSION_COST_LIMIT_USD="${SESSION_COST_LIMIT_USD:-3}" ;;
  --local-model) local_model=1; model_overlay=infra/compose.local-model.yml; export E2E_MODEL_MODE=local
    export SESSION_COST_LIMIT_USD="${SESSION_COST_LIMIT_USD:-25}" ;;
  *) echo "usage: tests/e2e/run.sh [--real-model | --local-model | --conformance <runtime_kind> | --conformance two_engines]" >&2; exit 2 ;;
esac
if [ -n "$local_model" ]; then
  tags_status=0
  tags="$(curl -sf -m 5 http://127.0.0.1:11434/api/tags)" || tags_status=$?
  if [ "$tags_status" = 7 ]; then
    echo "e2e --local-model: no Ollama on 127.0.0.1:11434; nothing was started" >&2
    exit 2
  elif [ "$tags_status" != 0 ]; then
    echo "e2e --local-model: Ollama on 127.0.0.1:11434 did not answer /api/tags (curl exit ${tags_status}); nothing was started" >&2
    exit 2
  fi
  # Every Ollama model the two routes call: the settings' models less the
  # names LiteLLM serves, and what LiteLLM maps those to.
  litellm_names="$(sed -n 's/^ *- model_name: //p' infra/local-model/litellm.yaml)"
  for model in $(
    {
      settings_models tests/fixtures/settings/local-model.json | grep -vxF "$litellm_names"
      sed -n 's/^ *model: ollama_chat\///p' infra/local-model/litellm.yaml
    } | sort -u
  ); do
    case "$model" in *:*) pulled="$model" ;; *) pulled="$model:latest" ;; esac
    case "$tags" in *"\"name\":\"$pulled\""*) ;; *)
      echo "e2e --local-model: $model is not pulled in Ollama; run \`ollama pull $model\`; nothing was started" >&2
      exit 2 ;;
    esac
  done
  # Ollama takes any key; LiteLLM's master key only has to match between the
  # proxy and the API, so a fresh one per run unless the caller set one.
  export LOCAL_OLLAMA_API_KEY="${LOCAL_OLLAMA_API_KEY:-ollama-local}"
  if [ -z "${LITELLM_MASTER_KEY:-}" ]; then
    master_key="$(openssl rand -hex 16 2>/dev/null)" || master_key=""
    if [ -z "$master_key" ]; then
      echo "e2e --local-model: could not generate LITELLM_MASTER_KEY with openssl; nothing was started" >&2
      exit 2
    fi
    export LITELLM_MASTER_KEY="sk-local-${master_key}"
  fi
fi
if [ -n "$real_model" ]; then
  key_status=0
  real_model_key_from_dotenv || key_status=$?
  if [ "$key_status" = 2 ]; then
    echo "e2e --real-model: invalid ANTHROPIC_API_KEY quoting in ${AGENT_PLATFORM_DOTENV:-.env}; nothing was started" >&2
    exit 2
  elif [ "$key_status" != 0 ]; then
    # Never a quiet fallback to the scripted fake: that run would pass and
    # prove nothing about the real model.
    echo "e2e --real-model: ANTHROPIC_API_KEY is unset or empty in the shell and .env; nothing was started" >&2
    exit 2
  fi
fi

if [ -z "${DOCKER_HOST:-}" ] && [ -S "$HOME/.docker/run/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
fi

run_id="$(date +%s | tail -c 7)$((RANDOM % 1000))"
project="e2e-${run_id}"
out="${E2E_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/e2e.XXXXXX")}"
mkdir -p "$out/workers"

export EXECUTION_INSTALLATION_ID="e2e${run_id}"
export API_IMAGE="werft-control-host:${project}"
export WORKER_IMAGE="werft-worker:${project}"
# Both engines: Codex is the current image and Claude the previous one
# (infra/compose.two-engines.yml). Named here alone, never taken from the
# shell, so the cleanup removes only an image this run built.
previous_image=""
if [ "$conformance" = two_engines ]; then
  previous_image="$WORKER_IMAGE"
  export WORKER_IMAGE="werft-worker-codex:${project}" WORKER_IMAGE_PREVIOUS="$previous_image"
fi
export EGRESS_PROXY_IMAGE="werft-egress-proxy:${project}"
# The seed of the first owner's password, for tests/e2e/client.ts; no
# container sees it.
export E2E_OWNER_SECRET="$(openssl rand -hex 24)"
label="werft.installation=${EXECUTION_INSTALLATION_ID}"
volume_label="${EXECUTION_VOLUME_LABEL_NAMESPACE:-werft}.installation=${EXECUTION_INSTALLATION_ID}"
# E2E_COMPOSE_OVERRIDE: one more overlay after ours; CI passes
# tests/e2e/compose.ci-mirror.yml to pull from its image mirror.
# E2E_COMPOSE_CACHE: one more after that; CI passes
# tests/e2e/compose.ci-cache.yml to read main's image build cache.
dc() {
  docker compose -p "$project" -f infra/compose.yml -f tests/e2e/compose.yml \
    ${conf_files[@]+"${conf_files[@]}"} -f "$model_overlay" \
    ${E2E_COMPOSE_OVERRIDE:+-f "$E2E_COMPOSE_OVERRIDE"} \
    ${E2E_COMPOSE_CACHE:+-f "$E2E_COMPOSE_CACHE"} --profile apps "$@"
}
# two_engines builds its Codex image under infra/compose.codex-worker.yml's
# build argument, apart from the stack, whose overlays build the Claude one.
dc_codex() {
  docker compose -p "$project" -f infra/compose.yml -f tests/e2e/compose.yml \
    -f infra/compose.codex-worker.yml \
    ${E2E_COMPOSE_OVERRIDE:+-f "$E2E_COMPOSE_OVERRIDE"} \
    ${E2E_COMPOSE_CACHE:+-f "$E2E_COMPOSE_CACHE"} --profile worker "$@"
}

events_pid=""
cleanup() {
  local status=$?
  dc logs --no-color --timestamps >"$out/compose.log" 2>&1 || true
  if [ "${E2E_KEEP:-0}" = 1 ]; then
    echo "kept: compose project ${project}, installation ${EXECUTION_INSTALLATION_ID}" >&2
  else
    dc down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
    local ids
    ids="$(docker ps -aq --filter "label=${label}")"
    [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
    ids="$(docker network ls -q --filter "label=${label}")"
    [ -z "$ids" ] || docker network rm $ids >/dev/null 2>&1 || true
    ids="$(docker volume ls -q --filter "label=${volume_label}")"
    [ -z "$ids" ] || docker volume rm -f $ids >/dev/null 2>&1 || true
    docker image rm "$API_IMAGE" "$WORKER_IMAGE" "$EGRESS_PROXY_IMAGE" \
      ${previous_image:+"$previous_image"} >/dev/null 2>&1 || true
  fi
  # Stopping the event stream ends the loop; each `docker logs -f` ends with
  # its container, which is gone by now unless the stack is kept.
  [ -z "$events_pid" ] || kill "$events_pid" 2>/dev/null || true
  [ "${E2E_KEEP:-0}" = 1 ] || wait 2>/dev/null || true
  if [ -n "$real_model" ]; then
    # The pattern goes in through a builtin and a pipe, never an argument,
    # and only file names come out.
    local leaked restore_xtrace=""
    case $- in *x*) restore_xtrace=1; set +x ;; esac
    leaked="$(grep -rlF -D skip -f <(printf '%s\n' "$ANTHROPIC_API_KEY") "$out" || true)"
    [ -z "$restore_xtrace" ] || set -x
    if [ -n "$leaked" ]; then
      echo "e2e --real-model: ANTHROPIC_API_KEY's value is in the record:" >&2
      echo "$leaked" >&2
      [ "$status" != 0 ] || status=1
    fi
  fi
  # What the fake MCP server issues carries a prefix
  # (packages/testkit/src/fake-oauth.ts). The record, logs of removed worker
  # containers included, holds none; only file names come out.
  local issued
  issued="$(grep -rlE -D skip 'fm[ocrs]_[A-Za-z0-9_-]{16,}' "$out" || true)"
  if [ -n "$issued" ]; then
    echo "e2e: a value the fake MCP server issued is in the record:" >&2
    echo "$issued" >&2
    [ "$status" != 0 ] || status=1
  fi
  echo "e2e record: $out" >&2
  exit "$status"
}
trap cleanup EXIT

docker_version="$(docker version --format '{{.Server.Version}}')"
echo "== docker engine ${docker_version} (28+ required)" >&2

# The scheduler removes a worker container when it exits, so its log goes
# with it; follow each one from the moment it starts (docs/quickstart.md
# shows the same for a local stack).
# Through a fifo so that killing `docker events` alone ends the loop too.
mkfifo "$out/.events"
docker events --filter "label=${label}" --filter type=container --filter event=start \
  --format '{{.Actor.ID}} {{index .Actor.Attributes "name"}}' >"$out/.events" &
events_pid=$!
while read -r id name; do
  docker logs -f --timestamps "$id" >"$out/workers/${name}.log" 2>&1 &
done <"$out/.events" &

if [ "$conformance" = two_engines ]; then
  echo "== build both worker images" >&2
  fetch_retried "$out/build.log" dc_codex build worker &&
    fetch_retried "$out/build-claude.log" dc build worker ||
    { tail -50 "$out"/build*.log >&2; exit 1; }
  # Read from each built image as .github/workflows/images.yml does, before
  # the stack starts: the scheduler, api and slack take them at start.
  image_runtime() {
    docker run --rm -i --network none --entrypoint bun "$1" \
      run apps/worker/src/image-runtime.ts <<<'{}' | jq -c 'del(.profiles)'
  }
  WORKER_IMAGE_RUNTIME="$(image_runtime "$WORKER_IMAGE")"
  WORKER_IMAGE_PREVIOUS_RUNTIME="$(image_runtime "$WORKER_IMAGE_PREVIOUS")"
  export WORKER_IMAGE_RUNTIME WORKER_IMAGE_PREVIOUS_RUNTIME
  if [ "$(jq -r .engine <<<"$WORKER_IMAGE_RUNTIME")" != codex ] ||
    [ "$(jq -r .engine <<<"$WORKER_IMAGE_PREVIOUS_RUNTIME")" != claude ]; then
    echo "e2e two_engines: the images hold ${WORKER_IMAGE_RUNTIME} and ${WORKER_IMAGE_PREVIOUS_RUNTIME}, not codex and claude" >&2
    exit 1
  fi
fi

echo "== build + up (${project})" >&2
# docs/quickstart.md's `up -d --build`, plus the overlay and project above,
# in its two halves: the transfers may be tried again, the start never is.
# Pulled are the services whose image nothing here builds; the scheduler and
# the others that run the api's image are left to `up`, which finds it built
# (`pull --ignore-buildable` would look for that image in a registry).
registry_services=()
while IFS= read -r service; do
  registry_services+=("$service")
done < <(dc config --format json | jq -r '
  [.services[] | select(.build) | .image] as $built
  | .services | to_entries[]
  | select((.value.build | not) and (.value.image as $i | $built | index($i) | not))
  | .key')
fetch_retried "$out/build-stack.log" dc build &&
  { [ "${#registry_services[@]}" = 0 ] ||
    fetch_retried "$out/pull.log" dc pull "${registry_services[@]}"; } ||
  { tail -50 "$out/build-stack.log" "$out/pull.log" >&2 2>/dev/null; exit 1; }
dc up -d >"$out/up.log" 2>&1 || { tail -50 "$out/up.log" >&2; exit 1; }

echo "== key" >&2
api_key="$(dc exec -T api bun run apps/control-host/src/api/keys.ts create e2e-owner \
  --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover)"

image_id() { docker image inspect --format '{{.Id}}' "$1"; }
sha="$(git rev-parse HEAD)"
dirty="$(git status --porcelain | wc -l | tr -d ' ')"
claude_version="$(dc logs --no-color worker 2>/dev/null | sed -n 's/.*| //p' | tail -1)"
sdk_version="$(sed -n 's/.*"@anthropic-ai\/claude-agent-sdk": "\([^"]*\)".*/\1/p' \
  packages/adapters/runtimes/claude/package.json)"
{
  echo "command: tests/e2e/run.sh${real_model:+ --real-model}${local_model:+ --local-model}${conformance:+ --conformance ${conformance}}"
  echo "tested_sha: ${sha} (uncommitted paths: ${dirty})"
  echo "docker_engine: ${docker_version}"
  echo "api_image: ${API_IMAGE} $(image_id "$API_IMAGE")"
  echo "worker_image: ${WORKER_IMAGE} $(image_id "$WORKER_IMAGE")"
  if [ -n "$previous_image" ]; then
    echo "worker_image_runtime: ${WORKER_IMAGE_RUNTIME}"
    echo "worker_image_previous: ${previous_image} $(image_id "$previous_image")"
    echo "worker_image_previous_runtime: ${WORKER_IMAGE_PREVIOUS_RUNTIME}"
  fi
  echo "egress_proxy_image: ${EGRESS_PROXY_IMAGE} $(image_id "$EGRESS_PROXY_IMAGE")"
  echo "claude_agent_sdk: ${sdk_version}"
  echo "claude_code: ${claude_version}"
  if [ -n "$real_model" ]; then
    echo "model: $(settings_models tests/fixtures/settings/real-model.json)"
    echo "provider_endpoint: $(settings_values endpoint tests/fixtures/settings/real-model.json)"
  fi
  if [ -n "$real_model$local_model" ]; then
    echo "session_cost_limit_usd: ${SESSION_COST_LIMIT_USD}"
  fi
  if [ -n "$local_model" ]; then
    echo "ollama: $(curl -s http://127.0.0.1:11434/api/version)"
    echo "models: $(settings_models tests/fixtures/settings/local-model.json | paste -sd, -)"
    echo "provider_endpoints: $(settings_values endpoint tests/fixtures/settings/local-model.json | paste -sd, -)"
  fi
} | tee "$out/record.txt" >&2

export E2E_API_URL="http://127.0.0.1:$(dc port api 3000 | sed 's/.*://')"
export E2E_API_KEY="$api_key"
# Every suite signs in as the first owner to release its agent on the
# stack's connection (tests/e2e/client.ts e2eStack): a session runs a release.
# The owner comes from the one setup link this fresh stack issues.
E2E_SETUP_TOKEN="$(setup_link_token "$E2E_OWNER_EMAIL" dc exec -T api)" ||
  { echo "e2e: the API issued no setup link" >&2; exit 1; }
export E2E_SETUP_TOKEN="${E2E_SETUP_TOKEN##*#setup=}"
if [ "$conformance" = codex_app_server ] || [ "$conformance" = two_engines ]; then
  export E2E_RESPONSES_URL="http://127.0.0.1:$(dc port fake-responses 4031 | sed 's/.*://')"
fi
if [ -z "$real_model$local_model" ] && [ "$conformance" != codex_app_server ]; then
  export E2E_MESSAGES_URL="http://127.0.0.1:$(dc port fake-messages 4011 | sed 's/.*://')"
  export E2E_FAKE_MCP_URL="http://127.0.0.1:$(dc port fake-mcp 4021 | sed 's/.*://')"
fi

echo "== stored keys" >&2
# The imported settings mark every key `"stored": true`: set them as the
# first owner, through the console's routes, before any suite runs.
e2e_owner_cookie() { env -u ANTHROPIC_API_KEY bun run tests/e2e/owner-cookie.ts; }
seeds=(repositories:sample-app)
if [ -n "$real_model" ]; then
  seeds+=(connections:anthropic=ANTHROPIC_API_KEY)
elif [ -n "$local_model" ]; then
  seeds+=(connections:ollama=LOCAL_OLLAMA_API_KEY connections:litellm=LITELLM_MASTER_KEY)
else
  # The fake providers take any key.
  placeholder_key=local-placeholder-key
  case "$conformance" in
    codex_app_server) seeds+=(connections:fake-responses=placeholder_key) ;;
    two_engines) seeds+=(connections:fake-messages=placeholder_key connections:fake-responses=placeholder_key) ;;
    *) seeds+=(connections:fake-messages=placeholder_key) ;;
  esac
fi
seed_credentials e2e_owner_cookie "${seeds[@]}" -- \
  dc exec -T -e SEED_COOKIE fake-git bun run packages/testkit/src/seed-credentials-main.ts \
  >"$out/seed.log" 2>&1 || { cat "$out/seed.log" >&2; exit 1; }
export CONFORMANCE_RUNTIME_KIND="$conformance"
# Lets a scenario read this stack's container logs and no other stack's.
export E2E_COMPOSE_PROJECT="$project"
if [ "${E2E_UP_ONLY:-0}" = 1 ]; then
  export E2E_KEEP=1
  # Holds the API key, so only here and never in a CI artifact.
  export -p | grep -E ' (E2E_[A-Z_]*|CONFORMANCE_RUNTIME_KIND|DOCKER_HOST|EXECUTION_INSTALLATION_ID|SESSION_COST_LIMIT_USD|[A-Z_]+_IMAGE|WORKER_IMAGE_PREVIOUS)=' >"$out/vars.sh"
  echo "stack up: source $out/vars.sh" >&2
  exit 0
fi

echo "== tests/e2e" >&2
set +e
if [ "$conformance" = two_engines ]; then
  # Not the engine suite: its fixture selector names one engine per stack.
  suites=(./tests/conformance/two-engines.e2e.ts)
elif [ -n "$conformance" ]; then
  suites=(./tests/conformance/*.conformance.ts)
elif [ -n "$real_model$local_model" ]; then
  suites=(./tests/e2e/real-model.e2e.ts)
else
  # The MCP suites first: the other suites leave their sessions holding
  # every execution slot.
  suites=(./tests/e2e/workspace-mcp.e2e.ts./tests/e2e/alpha-path.e2e.ts ./tests/e2e/db-outage.e2e.ts ./tests/e2e/pause-coverage.e2e.ts ./tests/e2e/workspace-loss.e2e.ts)
fi
# The suites drive the public API and never need the provider key.
env -u ANTHROPIC_API_KEY bun test "${suites[@]}" --timeout 900000 \
  --reporter=junit --reporter-outfile="$out/junit.xml" 2>&1 | tee "$out/test.log"
status="${PIPESTATUS[0]}"
set -e
# Bun exits 0 when every test skipped, which is what a missing variable
# looks like; so the run passes on the counts, not on the exit code alone.
count() { sed -n "s/^ *\([0-9][0-9]*\) $1\$/\1/p" "$out/test.log" | tail -1; }
pass="$(count pass)"
skip="$(count skip)"
fail="$(count fail)"
{
  echo "tests: pass=${pass:-?} skip=${skip:-0} fail=${fail:-?}"
  echo "skipped:"
  grep -E '^\(skip\)' "$out/test.log" || echo "  (none)"
  # Bun prints only failures when not on a terminal; the junit file names
  # every test that ran, with its time in seconds.
  echo "ran:"
  sed -n 's/.*<testcase name="\([^"]*\)" classname="\([^"]*\)" time="\([^"]*\)".*/  \2 > \1 (\3s)/p' \
    "$out/junit.xml" 2>/dev/null || true
} | tee -a "$out/record.txt" >&2
[ "$status" = 0 ] || exit "$status"
# The conformance suite skips a scenario an engine lacks the capability for,
# under a name that says so (tests/conformance/engine.ts `scenario`); any
# other skip is a missing variable or a disabled test.
declared=0
if [ -n "$conformance" ]; then
  # Bun prints no `(skip)` line off a terminal; the junit file marks each
  # skipped testcase with a <skipped> child. A declared name on a test that ran
  # is as wrong as a skip without the name, so both are counted apart.
  declared="$(awk '
    /<testcase / { marked = ($0 ~ /\[declared skip: /) }
    /<skipped/ && marked { n++ }
    END { print n + 0 }
  ' "$out/junit.xml")"
  grep -o '<testcase name="[^"]*\[declared skip: [^"]*"' "$out/junit.xml" |
    sed 's/<testcase name=/declared skip: /' | tee -a "$out/record.txt" >&2 || true
  marked="$(grep -c '<testcase name="[^"]*\[declared skip: ' "$out/junit.xml" || true)"
  [ "$marked" = "$declared" ] || { echo "e2e: ${marked} test(s) named as a declared skip, ${declared} skipped" >&2; exit 1; }
fi
[ "${skip:-0}" = "$declared" ] || { echo "e2e: ${skip} test(s) skipped, ${declared} declared" >&2; exit 1; }
[ "${pass:-0}" -gt 0 ] || { echo "e2e: nothing passed" >&2; exit 1; }
