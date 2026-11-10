#!/usr/bin/env bash
# The local stack's lifecycle in one place: the compose project
# `werft` from compose.yaml, on the loopback ports docs/quickstart.md
# lists.
#
#   scripts/local.sh up [--fake-model]   check Docker and ports, build, start, wait for /readyz,
#                                        add the web console's demo accounts and, with --fake-model, their data
#   scripts/local.sh down                delete the stack AND ALL ITS DATA
#   scripts/local.sh down --keep-volumes stop the stack and delete its workers, keep its volumes
#   scripts/local.sh reset [--fake-model]
#                                        down, then up
#   scripts/local.sh status              containers and /readyz
#   scripts/local.sh key <owner> --scopes <scope>[,<scope>...]
#                                        print a new API key once (same CLI as `bun run keys create`)
#   scripts/local.sh forget-lost-checkpoints
#                                        after a Docker restart: give up the lost checkpoints, keep the rest
#   scripts/local.sh demo-accounts       add whichever demo account, agent or session is missing to a running stack
#   scripts/local.sh dev [--fake-model]  up with infra/compose.dev.yml: a saved control host file restarts
#                                        api, scheduler and reconciler in place, without an image build
#   scripts/local.sh web                 the web console's Vite dev server (hot module reload) against the running api
#
# The local S3 server keeps checkpoints and its encryption seed on a named
# volume, just as postgres keeps its rows. Container and Docker restarts, or
# `down --keep-volumes`, preserve both. Plain `down` and `reset` still
# delete the installation's data. The API refuses
# to start on a bucket emptied behind the database's back.
# `forget-lost-checkpoints` is the way on without a reset: it marks those
# checkpoints collected and holds their open sessions in recovery_required,
# prints them, and acts only on a bucket with no object version left; `up`
# follows.
#
# `up` runs the real Messages API: tests/fixtures/settings/real-model.json,
# which migrate imports, the caller's
# ANTHROPIC_API_KEY handed by name to the API alone when there is one, and the
# real-model e2e's cost limits (infra/compose.real-model.yml,
# docs/real-claude.md). The key is optional: it comes from the shell or,
# failing that, the repository's .env, and without it the stack still starts
# on this overlay with no model connection (no agent can be released) until
# the key is entered on the console's model connections screen. A
# malformed .env line stops `up` before anything is touched.
#
# --fake-model runs without a key instead (infra/compose.fake-model.yml):
# the compose fake Messages API answers from the script in each prompt
# (docs/quickstart.md). The project is the same either way, so `down`
# deletes whichever is up.
#
# `up` ends by adding the demo owner and member (docs/quickstart.md "웹 콘솔
# 데모 계정"), skipping any that exist; LOCAL_DEMO_ACCOUNTS=0 leaves them
# out. Only a stack on this machine's Docker whose api listens on loopback
# gets them: their password is in the repository. On a --fake-model stack
# the demo agents and sessions follow (LOCAL_DEMO_DATA=0 leaves them out);
# their CLI refuses any connection that would call a real provider.
#
# PLATFORM_SECRET_KEY comes from the shell or .env; failing both, `up` makes
# one per project under AGENT_PLATFORM_STATE_DIR (~/.local/state/werft)
# and keeps it, since what the console stores opens with no other key. With no
# key file but the project's postgres-data volume present it makes none and stops.
#
# COMPOSE_PROJECT_NAME, COMPOSE_FILE and EXECUTION_INSTALLATION_ID are
# compose's to resolve: the ports checked, the /readyz waited on
# and the worker label `down` deletes all come from the stack compose
# renders here, not from these defaults.
set -euo pipefail

cd "$(dirname "$0")/.."
. scripts/lib/real-model-key.sh

MIN_ENGINE_MAJOR=28
MIN_COMPOSE=2.24
# An overlay on compose.yaml's include; 2.24.0-2.24.5 reject it as a
# conflict with an imported resource.
MIN_COMPOSE_OVERLAY=2.24.6
READY_TIMEOUT_SEC=${LOCAL_READY_TIMEOUT_SEC:-180}

die() {
  echo "local.sh: $*" >&2
  exit 1
}

# The overlay `up` and `reset` add; empty for the commands that take no mode.
overlay=""
# Set by `dev`: infra/compose.dev.yml goes on top of the mode's overlay.
dev=""
compose() {
  local args=() file IFS=:
  if [ -n "$overlay" ]; then
    # -f replaces COMPOSE_FILE, so the overlay goes on top of its files.
    for file in ${COMPOSE_FILE:-compose.yaml}; do args+=(-f "$file"); done
    args+=(-f "$overlay")
    # Once only, for a COMPOSE_FILE that already names it (a verify run's).
    case ":${COMPOSE_FILE:-}:" in
      *[:/]infra/compose.dev.yml:*) ;;
      *) [ -z "$dev" ] || args+=(-f infra/compose.dev.yml) ;;
    esac
  else
    # status, down and key: the fake-model profile too, so they still see
    # the fake Messages API of a --fake-model stack.
    args+=(--profile fake-model)
  fi
  docker compose --profile apps "${args[@]}" "$@"
}

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

secret_key() {
  [ -z "${PLATFORM_SECRET_KEY:-}" ] || return 0
  if [ -f "${AGENT_PLATFORM_DOTENV:-.env}" ] &&
    grep -q '^PLATFORM_SECRET_KEY=' "${AGENT_PLATFORM_DOTENV:-.env}"; then
    return 0
  fi
  local dir="${AGENT_PLATFORM_STATE_DIR:-$HOME/.local/state/werft}"
  # The project as compose resolves it (-p, the environment, .env or `name:`).
  local project
  project=$(rendered | jq -r '.name // empty') && [ -n "$project" ] ||
    die "cannot read the compose project name; nothing was started"
  local file="$dir/${project}.secret-key"
  if [ ! -s "$file" ]; then
    # A new key cannot open what an earlier key sealed in this project's database.
    local volume existing
    volume="${project}_postgres-data"
    existing=$(docker volume ls -q --filter "name=^${volume}\$") ||
      die "cannot check for the volume $volume; nothing was started"
    if [ -n "$existing" ]; then
      die "no secret key at $file but the volume $volume exists; a new key would make its stored secrets unreadable. Put the project's key there, or set PLATFORM_SECRET_KEY; nothing was started"
    fi
    (umask 077 && mkdir -p "$dir" && openssl rand -hex 32 >"$file")
  fi
  PLATFORM_SECRET_KEY=$(cat "$file")
  export PLATFORM_SECRET_KEY
}

# The mode `up` and `reset` take, settled before either touches Docker.
mode() {
  local key_status
  case "$*" in
    "")
      key_status=0
      real_model_key_from_dotenv || key_status=$?
      if [ "$key_status" = 2 ]; then
        echo "local.sh: invalid ANTHROPIC_API_KEY quoting in ${AGENT_PLATFORM_DOTENV:-.env}; nothing was started" >&2
        exit 2
      elif [ "$key_status" != 0 ]; then
        # Never a quiet fallback to the fake: that stack would look fine. The
        # real-model stack starts with no model connection instead, and the
        # key goes in on the console.
        echo "local.sh: no ANTHROPIC_API_KEY in the shell or .env; the stack starts with no model connection (not the fake). Add the key in the console: 설정 > 에이전트 연결 > 모델 연결 > 연결 추가 (docs/real-claude.md)" >&2
      fi
      overlay=infra/compose.real-model.yml
      ;;
    --fake-model) overlay=infra/compose.fake-model.yml ;;
    *) usage ;;
  esac
}

# The stack as compose resolves it here.
rendered() {
  compose config --format json 2>/dev/null ||
    die "docker compose cannot render the stack; \`docker compose --profile apps config\` says why"
}

# Is version $1 (like 28.3.2 or v2.39.1-desktop.1) at least $2 (like 2.24
# or 2.24.6)? A missing part counts as 0.
version_at_least() {
  local have=${1#v} want=$2 h w _
  for _ in 1 2 3; do
    h=${have%%[!0-9]*}
    w=${want%%[!0-9]*}
    [ "${h:-0}" -eq "${w:-0}" ] || { [ "${h:-0}" -gt "${w:-0}" ]; return; }
    have=${have#"$h"}
    have=${have#.}
    want=${want#"$w"}
    want=${want#.}
  done
}

preflight() {
  local engine compose_version bindings binding ip bound port ours busy=""
  engine=$(docker version --format '{{.Server.Version}}' 2>/dev/null) ||
    die "cannot reach the Docker daemon"
  version_at_least "$engine" "$MIN_ENGINE_MAJOR.0" ||
    die "Docker Engine $engine is too old; worker networks need $MIN_ENGINE_MAJOR or newer (gateway_mode_ipv4=isolated)"
  compose_version=$(docker compose version --short 2>/dev/null) ||
    die "docker compose (v2) is not installed"
  version_at_least "$compose_version" "$MIN_COMPOSE" ||
    die "docker compose $compose_version is too old; compose.yaml needs $MIN_COMPOSE or newer (include, env_file required)"
  [ -z "$overlay" ] || version_at_least "$compose_version" "$MIN_COMPOSE_OVERLAY" ||
    die "docker compose $compose_version is too old; $overlay is an overlay on compose.yaml's include, which needs $MIN_COMPOSE_OVERLAY or newer"
  command -v jq >/dev/null || die "jq is not installed"
  bindings=$(rendered | jq -r '[.services[].ports[]? | select(.published and .protocol != "udp")
    | "\(.host_ip // "")|\(.published)"] | unique | .[]')
  # A port this stack already publishes is its own; any other listener is not.
  ours=$(compose ps --format '{{.Ports}}' 2>/dev/null || true)
  for binding in $bindings; do
    ip=${binding%|*}
    port=${binding##*|}
    # As `compose ps` prints it.
    case "$ip" in "") bound=0.0.0.0 ;; *:*) bound="[$ip]" ;; *) bound=$ip ;; esac
    case "$ours" in *"$bound:$port->"*) continue ;; esac
    case "$ip" in "" | 0.0.0.0) ip=127.0.0.1 ;; ::) ip=::1 ;; esac
    if (exec 3<>"/dev/tcp/$ip/$port") 2>/dev/null; then
      busy="$busy $ip:$port"
    fi
  done
  [ -z "$busy" ] ||
    die "port(s)$busy already in use; stop whatever holds them (another stack?) and retry"
  echo "Docker Engine $engine, compose $compose_version" >&2
}

# Where the host reaches the api; empty while it publishes nothing.
api_address() {
  local address
  address=$(compose port api 3000 2>/dev/null | head -n 1) || true
  case "$address" in 0.0.0.0:* | "[::]:"*) address=127.0.0.1:${address##*:} ;; esac
  echo "$address"
}

# Empty while the api publishes nothing.
readyz() {
  local address
  address=$(api_address)
  [ -z "$address" ] ||
    curl -sS --noproxy '*' --max-time 3 "http://$address/readyz" 2>/dev/null || true
}

up() {
  preflight
  secret_key
  if ! compose up -d --build; then
    echo "local.sh: the stack did not start; last API log lines:" >&2
    compose logs --no-color --tail 20 api >&2 || true
    exit 1
  fi
  local deadline=$((SECONDS + READY_TIMEOUT_SEC)) body
  while :; do
    body=$(readyz)
    case "$body" in
      *'"status":"ready"'*) break ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] ||
      die "API not ready after ${READY_TIMEOUT_SEC}s: ${body:-no answer from the api /readyz}"
    sleep 2
  done
  [ "${LOCAL_DEMO_ACCOUNTS:-1}" = 0 ] || demo_accounts
  echo "$body"
}

# The installation id the stack was started with, read off its egress proxy;
# the one compose would start it with only once no container is left.
installation_id() {
  local proxy
  # A failed lookup is not an empty one.
  proxy=$(compose ps -aq egress-proxy) || return 1
  proxy=${proxy%%$'\n'*}
  if [ -n "$proxy" ]; then
    docker inspect --format '{{index .Config.Labels "werft.egress-proxy"}}' "$proxy"
  else
    rendered | jq -r '.services.scheduler.environment.EXECUTION_INSTALLATION_ID // empty'
  fi
}

down() {
  # Whichever mode the stack was started in (reset's included).
  local id overlay="" keep="" volume_namespace
  case "$*" in
    "") ;;
    --keep-volumes) keep=1 ;;
    *) usage ;;
  esac
  command -v jq >/dev/null || die "jq is not installed"
  id=$(installation_id) || true
  [ -n "$id" ] || die "cannot tell the stack's EXECUTION_INSTALLATION_ID; nothing was deleted"
  if [ -z "$keep" ]; then
    # Read before compose goes down: the scheduler's setting, not this shell's.
    volume_namespace=$(rendered | jq -r '.services.scheduler.environment.EXECUTION_VOLUME_LABEL_NAMESPACE // empty') ||
      die "cannot read the scheduler's volume label namespace; nothing was deleted"
  fi
  if [ -n "$keep" ]; then
    echo "local.sh: stopping the local stack and deleting its workers; volumes and checkpoint objects kept" >&2
    compose down --remove-orphans
  else
    echo "local.sh: deleting the local stack and ALL its data: sessions, checkpoints, keys" >&2
    compose down -v --remove-orphans
  fi
  # What the scheduler created is not compose's: worker containers, their
  # networks and workspace volumes carry the installation label instead. The
  # volumes' label prefix is the scheduler's setting, so a volume made under
  # another prefix is only found (and only deleted) when the same value is set.
  local label=werft.installation=$id
  docker ps -aq --filter "label=$label" | xargs -r docker rm -f >/dev/null
  docker network ls -q --filter "label=$label" | xargs -r docker network rm >/dev/null
  if [ -n "$keep" ]; then
    echo "local.sh: stopped" >&2
    return
  fi
  docker volume ls -q --filter "label=${volume_namespace:-werft}.installation=$id" | xargs -r docker volume rm >/dev/null
  echo "local.sh: deleted" >&2
}

# Why this stack must not get the demo accounts, or nothing. The CLI checks
# its own side too (apps/control-host/src/api/demo-accounts.ts).
demo_accounts_refusal() {
  local endpoint api bindings ip
  # The endpoint the CLI resolves, DOCKER_HOST and DOCKER_CONTEXT included.
  endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null) || true
  case "$endpoint" in
    unix://* | npipe://*) ;;
    *) echo "Docker is not this machine's (${endpoint:-unknown endpoint})"; return ;;
  esac
  # The running api's bindings, not the render: a container started from
  # other compose files keeps what it was started with.
  api=$(compose ps -q api 2>/dev/null) || true
  [ -n "$api" ] || { echo "the api is not running"; return; }
  bindings=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$api" |
    jq -r '[.[]? | select(. != null) | .[] | .HostIp | if . == "" then "0.0.0.0" else . end] | unique | .[]') ||
    { echo "cannot read the api's port bindings"; return; }
  [ -n "$bindings" ] || { echo "the api publishes no port"; return; }
  for ip in $bindings; do
    case "$ip" in
      127.0.0.1 | ::1) ;;
      *) echo "the api listens on $ip, not loopback alone"; return ;;
    esac
  done
}

demo_accounts() {
  local refusal
  refusal=$(demo_accounts_refusal)
  if [ -n "$refusal" ]; then
    echo "local.sh: demo accounts not added: $refusal" >&2
    return
  fi
  compose exec -T -e DEMO_ACCOUNTS=local api bun run apps/control-host/src/api/demo-accounts.ts >&2 ||
    die "adding the demo accounts failed; the stack itself is up"
  [ "${LOCAL_DEMO_DATA:-1}" = 0 ] || demo_data
}

# Exit 2 is the CLI's refusal, a real-model stack's included: said, not fatal.
demo_data() {
  local code=0
  compose exec -T -e DEMO_ACCOUNTS=local api bun run apps/control-host/src/api/demo-data.ts >&2 || code=$?
  case "$code" in
    0) ;;
    2) echo "local.sh: demo data not added" >&2 ;;
    *) die "adding the demo data failed; the stack and the demo accounts are up" ;;
  esac
}

status() {
  compose ps
  echo "readyz: $(readyz)"
}

key() {
  [ "$#" -ge 1 ] || die "usage: scripts/local.sh key <owner> --scopes <scope>[,<scope>...]"
  compose exec -T api bun run apps/control-host/src/api/keys.ts create "$@"
}

# The API refuses to start in exactly the state this fixes, so a one-off
# api container runs it; `run` starts postgres, migrate and LocalStack first.
# Built first: an image from before this command has no CLI to run.
forget_lost_checkpoints() {
  compose run --rm -T --build api bun run apps/control-host/src/api/forget-lost-checkpoints.ts
}

# Vite reads the files on this machine, so `bun install` must have run here.
web() {
  local address
  address=$(api_address)
  [ -n "$address" ] || die "the api publishes no port; start the stack first (scripts/local.sh dev)"
  VITE_API_TARGET="http://$address" exec bun run --cwd apps/web dev
}

case "${1:-}" in
  up) shift; mode "$@"; up ;;
  dev) shift; mode "$@"; dev=1; up ;;
  web) web ;;
  down) shift; down "$@" ;;
  # Checked before down too, so a reset that cannot start deletes nothing.
  # Not `down && up`: errexit would not hold inside down.
  reset) shift; mode "$@"; preflight; secret_key; down; up ;;
  status) status ;;
  key) shift; key "$@" ;;
  forget-lost-checkpoints) forget_lost_checkpoints ;;
  demo-accounts) demo_accounts ;;
  *) usage ;;
esac
