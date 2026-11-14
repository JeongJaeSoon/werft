#!/usr/bin/env bash
# The test-ops installation's lifecycle in one place (docs/operator/test-ops.md)
#
#   scripts/test-ops.sh preflight [<manifest>]  check host, checkout, env file, settings document, and on s3 the bucket
#                                              and S3 key (the deployed release when no manifest is named)
#   scripts/test-ops.sh deploy <manifest>       preflight, then start a release on an empty host
#   scripts/test-ops.sh upgrade <manifest> [--approve-sessions <file>]
#                                              preflight, then move to another release. A worker image
#                                              change is refused while any checkpoint is uncollected,
#                                              unless <file> lists exactly the affected sessions
#   scripts/test-ops.sh stop                    take the deployed release down; the volumes stay (never -v)
#   scripts/test-ops.sh start                   bring the deployed release back on the same volumes, after a
#                                              stop, a compose down, or a host restart that left it down
#   scripts/test-ops.sh status                  containers, release, /readyz, scheduler and reconciler health, disk
#   scripts/test-ops.sh key create <owner> --scopes <scope>[,<scope>...] | key revoke <key_id>
#   scripts/test-ops.sh bootstrap-token         print the first owner's bootstrap token once, when the
#                                              env file sets no BOOTSTRAP_TOKEN; a second run prints nothing
#   scripts/test-ops.sh backup [--stop]         stop admissions and writers, scripts/backup.sh, reopen
#                                              (--stop: leave them stopped, before a planned restart)
#   scripts/test-ops.sh restore-drill <backup-dir> [--bucket <new-empty-bucket>] [--port-base 25432] [--keep]
#                                              restore into a new project (and on s3 the new bucket), verify,
#                                              tear the project down
#   scripts/test-ops.sh reseed <backup-dir>     localstack: put a backup's objects back into an emptied
#                                              LocalStack (after a restart), then start
#   scripts/test-ops.sh reset --yes             delete the installation and ALL its data; deploy again after
#   scripts/test-ops.sh manifest <release-manifest.json> <settings-document>
#                                              print the deploy manifest of a GitHub Release's manifest
#
# From the release bundle (werft-test-ops-<tag>.tar.gz, no checkout, no host
# bun) preflight, deploy, start, stop, status, key, bootstrap-token, reset and manifest run; the
# helper runs in the release's own control-host image. upgrade, backup,
# reseed and restore-drill need the checkout at the release's source_commit.
#
# The object store is $TEST_OPS_OBJECT_STORE at deploy: localstack (the
# default; in memory, lost on any restart) or s3 (AWS S3). Deploy records it
# and every later command uses that.
#
# Settings come from one env file outside the checkout, $TEST_OPS_ENV_FILE
# (/etc/werft/test-ops.env, mode 0600), which compose reads through
# --env-file; this script never sources it. State — the deployed manifest,
# upgrade approvals, backups, drill logs — goes to $TEST_OPS_STATE_DIR
# (/var/lib/werft/test-ops). The compose project is
# $TEST_OPS_PROJECT (werft-test-ops).
#
# Exit codes: 2 usage, 3 upgrade refused, 1 anything else.
#
# LocalStack keeps S3 in memory: after a restart of its container, Docker or
# the host the API refuses to start until reseed or reset
# (docs/operator/test-ops.md).
set -euo pipefail

# A release bundle is a tree that carries BUNDLE and is not a git work tree of
# its own; a checkout never takes this path, whatever files it holds. The bundle
# must be what its SHA256SUMS lists and nothing else before any of it runs: the
# libraries sourced below and the helper image both come from the bundle.
# SHA256SUMS catches damage and stray files, not a forged bundle, so fetch it
# from the GitHub Release (docs/operator/test-ops.md).
check_bundle_files() {
  local root="$1" listed actual
  [ -r "${root}/release-manifest.json" ] && [ -r "${root}/SHA256SUMS" ] \
    || { echo "error: the bundle is incomplete: release-manifest.json or SHA256SUMS is missing" >&2; exit 1; }
  (cd "$root" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --quiet SHA256SUMS; else shasum -a 256 -c --quiet SHA256SUMS; fi) >&2 \
    || { echo "error: a bundle file differs from SHA256SUMS (above); download the bundle again" >&2; exit 1; }
  listed="$(awk '{print $2}' "${root}/SHA256SUMS" | sort)"
  actual="$(cd "$root" && find . ! -type d ! -path ./SHA256SUMS | sed 's|^\./||' | sort)"
  [ "$listed" = "$actual" ] \
    || { echo "error: the bundle holds files SHA256SUMS does not list, or lacks listed ones; download it again" >&2; exit 1; }
}
BUNDLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE=checkout
if [ -e "${BUNDLE_ROOT}/BUNDLE" ] \
  && [ "$(git -C "$BUNDLE_ROOT" rev-parse --show-toplevel 2>/dev/null || true)" != "$(cd "$BUNDLE_ROOT" && pwd -P)" ]; then
  MODE=bundle
  check_bundle_files "$BUNDLE_ROOT"
fi

source "$(dirname "${BASH_SOURCE[0]}")/lib/backup-lib.sh"

ENV_FILE="${TEST_OPS_ENV_FILE:-/etc/werft/test-ops.env}"
STATE_DIR="${TEST_OPS_STATE_DIR:-/var/lib/werft/test-ops}"
PROJECT="${TEST_OPS_PROJECT:-werft-test-ops}"
# A failed first deploy leaves no current.json, so `stop` has nothing to read. Compose
# finds a project by its labels, but some versions refuse to run with no compose file
# and, given a model, remove only the networks a service of it uses: one placeholder
# service puts core's `default` network in the model. Nothing is pulled or created.
DOWN_BY_NAME="echo '{\"services\":{\"x\":{\"image\":\"alpine:3\"}},\"networks\":{\"default\":{}}}' | docker compose --project-name ${PROJECT} -f - down --remove-orphans"
CURRENT="${STATE_DIR}/current.json"
# The manifest of an upgrade that stopped the installation and did not finish.
PENDING="${STATE_DIR}/pending.json"
# project=…, installation=… and object_store=… of what deploy started;
# every later command must name the same.
IDENTITY="${STATE_DIR}/installation"
LOCK="${STATE_DIR}/lock"
# The worker image the last worker change replaced: the scheduler resumes on
# it the sessions whose checkpoints the release's image cannot restore.
PREVIOUS_WORKER="${STATE_DIR}/previous-worker"
# Each worker image's runtime combination, by digest.
RUNTIMES_DIR="${STATE_DIR}/worker-runtimes"
HELPER="${REPO_ROOT}/scripts/lib/test-ops.ts"
RELEASE_MANIFEST="${REPO_ROOT}/release-manifest.json"
MIN_ENGINE_MAJOR=28
# 2.24.6: the restore drill's overlay over an include (compose.restore.yml).
MIN_COMPOSE=2.24.6
WAIT_TIMEOUT_SEC=600
EXIT_REFUSED=3

usage() {
  sed -n '2,49p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit "$EXIT_USAGE"
}

# --- arguments: all of them before anything touches the host ----------------
[ $# -ge 1 ] || usage
VERB="$1"
shift
MANIFEST=""
APPROVED=""
BACKUP_DIR=""
DRILL_BUCKET=""
PORT_BASE=25432
KEEP=0
STOP=0
case "$VERB" in
  preflight)
    [ $# -le 1 ] || usage
    MANIFEST="${1:-}"
    ;;
  deploy)
    [ $# -eq 1 ] || usage
    MANIFEST="$1"
    ;;
  upgrade)
    [ $# -ge 1 ] || usage
    MANIFEST="$1"
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        --approve-sessions) [ $# -ge 2 ] || usage; APPROVED="$2"; shift 2 ;;
        *) usage ;;
      esac
    done
    ;;
  status|start|stop|bootstrap-token)
    [ $# -eq 0 ] || usage
    ;;
  backup)
    case "$*" in "") ;; --stop) STOP=1 ;; *) usage ;; esac
    ;;
  reseed)
    [ $# -eq 1 ] || usage
    BACKUP_DIR="$1"
    ;;
  reset)
    [ "$*" = --yes ] || usage
    ;;
  key)
    [ $# -ge 1 ] || usage
    ;;
  restore-drill)
    while [ $# -gt 0 ]; do
      case "$1" in
        --bucket) [ $# -ge 2 ] || usage; DRILL_BUCKET="$2"; shift 2 ;;
        --port-base) [ $# -ge 2 ] || usage; PORT_BASE="$2"; shift 2 ;;
        --keep) KEEP=1; shift ;;
        -*) usage ;;
        *) [ -z "$BACKUP_DIR" ] || usage; BACKUP_DIR="$1"; shift ;;
      esac
    done
    [ -n "$BACKUP_DIR" ] || usage
    case "$PORT_BASE" in ''|*[!0-9]*) usage ;; esac
    ;;
  manifest)
    [ $# -eq 2 ] || usage
    MANIFEST="$1"
    SETTINGS_FILE="$2"
    ;;
  *) usage ;;
esac
if [ "$MODE" = bundle ]; then
  case "$VERB" in
    upgrade|backup|reseed|restore-drill)
      die "$VERB is not in the release bundle: its gate and restore tools need the checkout. git clone the repository, git checkout the release's source_commit, bun install --frozen-lockfile, and run scripts/test-ops.sh from there with the same env file and state directory (docs/operator/test-ops.md)" ;;
  esac
fi
[ -z "$APPROVED" ] || [ -r "$APPROVED" ] || die "approval file $APPROVED not found"
case "$PROJECT" in
  ""|[!a-z0-9]*|*[!a-z0-9_-]*) die "TEST_OPS_PROJECT must match [a-z0-9][a-z0-9_-]*: '$PROJECT'" ;;
  werft) die "TEST_OPS_PROJECT werft is the local stack's project" ;;
esac
umask 077

# EXIT runs these last registered first: a reopen or a drill teardown before
# the lock goes. Each in a subshell, so one that dies skips none of the rest,
# but the command then fails: a backup whose reopen failed left the
# installation stopped.
CLEANUPS=()
on_exit() {
  local status=$? i failed=0
  for ((i = ${#CLEANUPS[@]} - 1; i >= 0; i--)); do (eval "${CLEANUPS[i]}") || failed=1; done
  if [ "$failed" = 1 ] && [ "$status" = 0 ]; then
    log "a cleanup step failed (above)"
    exit 1
  fi
}
trap on_exit EXIT

# One lifecycle command at a time per installation: a second backup or an
# upgrade would reopen the writers under a running backup. A lock left by a
# killed run names its pid; remove the directory once that run is gone.
take_lock() {
  mkdir "$LOCK" 2>/dev/null \
    || die "another test-ops command holds $LOCK ($(cat "$LOCK/pid" 2>/dev/null || echo "pid unknown")); if none runs, remove it"
  echo "$$" > "$LOCK/pid"
  CLEANUPS+=('rm -rf "$LOCK"')
}

# --- settings ------------------------------------------------------------------
check_env_file() {
  [ -f "$ENV_FILE" ] || die "env file $ENV_FILE not found (set TEST_OPS_ENV_FILE; docs/operator/test-ops.md)"
  [ -r "$ENV_FILE" ] || die "env file $ENV_FILE is not readable by $(id -un)"
  [ -z "$(find "$ENV_FILE" -prune \( -perm -g=r -o -perm -g=w -o -perm -o=r -o -perm -o=w \))" ] \
    || die "env file $ENV_FILE is open to group or others; chmod 600 it"
  case "$(cd "$(dirname "$ENV_FILE")" && pwd -P)/" in
    "$(cd "$REPO_ROOT" && pwd -P)"/*) die "env file $ENV_FILE is inside the checkout; keep it outside" ;;
  esac
}

# Sets SOURCE_COMMIT, API_IMAGE, WORKER_IMAGE, EGRESS_PROXY_IMAGE and
# SETTINGS_DIGEST from a release manifest, refused unless every image is
# named by digest.
load_manifest() {
  local file="$1" out name value
  [ -r "$file" ] || die "manifest $file not found"
  out="$(run_helper manifest "$file" ${2:+"$2"})" || die "manifest $file refused (above)"
  while IFS='=' read -r name value; do
    case "$name" in
      SOURCE_COMMIT|API_IMAGE|WORKER_IMAGE|EGRESS_PROXY_IMAGE|SETTINGS_DIGEST) printf -v "$name" '%s' "$value" ;;
    esac
  done < <(printf '%s\n' "$out")
}

load_current() {
  [ -r "$CURRENT" ] || die "no release is deployed ($CURRENT); deploy one first"
  if [ -e "$PENDING" ] && [ "$VERB" != status ] && [ "$VERB" != reset ] \
    && ! { [ "$VERB" = upgrade ] && cmp -s "$MANIFEST" "$PENDING"; }; then
    die "an upgrade to $PENDING did not finish and the installation may be stopped; rerun upgrade with that manifest"
  fi
  load_manifest "$CURRENT" --deployed
}

# The rendered installation is the one deploy started: same project, same
# installation id, whose label is how its workers are found.
identity() {
  printf 'project=%s\ninstallation=%s\nobject_store=%s' "$PROJECT" "$(rendered scheduler EXECUTION_INSTALLATION_ID)" "$STORE"
}

check_identity() {
  [ -r "$IDENTITY" ] || die "$IDENTITY is missing; it is written by deploy"
  [ "$(identity)" = "$(cat "$IDENTITY")" ] \
    || die "$(identity | tr '\n' ' ') is not what was deployed ($(tr '\n' ' ' < "$IDENTITY")); TEST_OPS_PROJECT, EXECUTION_INSTALLATION_ID and the object store cannot change"
}

# The runtime combination a worker image prints, the value images.yml records
# beside its digest. Empty for an image too old to print one: the scheduler
# then launches every session on the release's image, as before.
worker_runtime() {
  local image="$1" cache
  cache="${RUNTIMES_DIR}/${image##*@}.json"
  if [ ! -s "$cache" ]; then
    mkdir -p "$RUNTIMES_DIR"
    if docker run --rm -i --network none --entrypoint bun "$image" run apps/worker/src/image-runtime.ts <<<'{}' 2>/dev/null \
      | jq -ce 'del(.profiles)' > "${cache}.new"; then
      mv "${cache}.new" "$cache"
    else
      rm -f "${cache}.new"
      return 0
    fi
  fi
  cat "$cache"
}

# Sets WORKER_IMAGE_RUNTIME and, when the image the last worker change
# replaced prints its own, WORKER_IMAGE_PREVIOUS and its runtime.
worker_images() {
  local previous=""
  WORKER_IMAGE_RUNTIME="$(worker_runtime "$WORKER_IMAGE")"
  WORKER_IMAGE_PREVIOUS=""
  WORKER_IMAGE_PREVIOUS_RUNTIME=""
  [ -n "$WORKER_IMAGE_RUNTIME" ] || return 0
  [ ! -r "$PREVIOUS_WORKER" ] || previous="$(cat "$PREVIOUS_WORKER")"
  [ -n "$previous" ] && [ "$previous" != "$WORKER_IMAGE" ] || return 0
  WORKER_IMAGE_PREVIOUS_RUNTIME="$(worker_runtime "$previous")"
  [ -z "$WORKER_IMAGE_PREVIOUS_RUNTIME" ] || WORKER_IMAGE_PREVIOUS="$previous"
}

# compose on the installation's settings: the env file through --env-file,
# the release's images, and nothing else from the caller's environment,
# which compose would otherwise prefer to the env file.
ops_compose() {
  local pass=(PATH="$PATH" HOME="$HOME") name
  for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_CERT_PATH DOCKER_TLS_VERIFY; do
    [ -z "${!name:-}" ] || pass+=("${name}=${!name}")
  done
  worker_images
  env -i "${pass[@]}" API_IMAGE="$API_IMAGE" WORKER_IMAGE="$WORKER_IMAGE" EGRESS_PROXY_IMAGE="$EGRESS_PROXY_IMAGE" \
    WORKER_IMAGE_RUNTIME="$WORKER_IMAGE_RUNTIME" WORKER_IMAGE_PREVIOUS="$WORKER_IMAGE_PREVIOUS" \
    WORKER_IMAGE_PREVIOUS_RUNTIME="$WORKER_IMAGE_PREVIOUS_RUNTIME" \
    docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" --profile apps \
    -f "${REPO_ROOT}/infra/compose.core.yml" -f "${REPO_ROOT}/infra/compose.test-ops.yml" \
    -f "${REPO_ROOT}/infra/compose.test-ops.${STORE}.yml" "$@"
}

# The installation as its containers get it. Held in memory only: it
# carries the secrets.
render() {
  local errors status=0
  errors="$(mktemp)"
  RENDER="$(ops_compose config --format json 2>"$errors")" || status=$?
  if [ "$status" != 0 ]; then
    run_helper render-refusal "$errors" >&2 || true
    rm -f "$errors"
    die "compose refused the installation's settings (above)"
  fi
  cat "$errors" >&2
  rm -f "$errors"
  API_URL="$(printf '%s' "$RENDER" | jq -r '.["x-test-ops-api-url"] // empty')"
}

check_render() {
  with_render check-render --store "$STORE" "$@" >/dev/null \
    || die "the settings are not a test-ops installation's (above)"
}

# One value a service gets, for the settings that are not secrets.
rendered() {
  printf '%s' "$RENDER" | jq -r --arg s "$1" --arg n "$2" '.services[$s].environment[$n] // empty'
}

# The released control-host image of the bundle's own release manifest. It
# holds the sources and dependencies scripts/lib/test-ops.ts imports, so the
# bundle needs no host bun. Only probe-store reaches the network (the bucket).
bundle_helper() {
  local network=none args=() mounts=() arg document image
  [ "${1:-}" != --net ] || { network=bridge; shift; }
  for arg in "$@"; do
    if [ -f "$arg" ]; then
      arg="$(cd "$(dirname "$arg")" && pwd -P)/$(basename "$arg")"
      mounts+=(-v "${arg}:${arg}:ro")
    fi
    args+=("$arg")
  done
  # check-render reads the settings document the render names.
  if [ -n "${RENDER:-}" ]; then
    document="$(printf '%s' "$RENDER" | jq -r '.services.migrate.volumes[]? | select(.target == "/settings/installation.json") | .source')"
    if [ -n "$document" ] && [ -f "$document" ]; then mounts+=(-v "${document}:${document}:ro"); fi
  fi
  image="$(jq -r '.images["control-host"] | "\(.image)@\(.digest)"' "$RELEASE_MANIFEST")"
  docker run --rm -i --network "$network" --user "$(id -u):$(id -g)" -e HOME=/tmp \
    --read-only --tmpfs /tmp -v "${HELPER}:/app/scripts/lib/test-ops.ts:ro" \
    ${mounts[@]+"${mounts[@]}"} --entrypoint bun "$image" run /app/scripts/lib/test-ops.ts "${args[@]}"
}

# `run_helper <command> [args]`: scripts/lib/test-ops.ts with no stdin.
run_helper() {
  if [ "$MODE" = bundle ]; then
    local out status=0
    out="$(mktemp)"
    bundle_helper "$@" </dev/null >"$out" 2> >(cat >&2) || status=$?
    cat "$out"
    rm -f "$out"
    return "$status"
  fi
  bun_script "$HELPER" "$@"
}

# `with_render <command> [args]`: scripts/lib/test-ops.ts with the render on
# stdin. stdout goes through a file, as bun_script explains.
with_render() {
  local out status=0
  out="$(mktemp)"
  if [ "$MODE" = bundle ]; then
    local net=""
    [ "$1" != probe-store ] || net=--net
    printf '%s' "$RENDER" | bundle_helper ${net:+"$net"} "$@" >"$out" 2> >(cat >&2) || status=$?
  else
    printf '%s' "$RENDER" | bun run "$HELPER" "$@" >"$out" 2> >(cat >&2) || status=$?
  fi
  cat "$out"
  rm -f "$out"
  return "$status"
}

# Runs a backup/restore script on the API's own S3 settings, AWS S3 itself:
# no endpoint, and no profile or session token of the caller's.
with_api_store() {
  local region key_id key
  region="$(rendered api AWS_REGION)"
  key_id="$(rendered api AWS_ACCESS_KEY_ID)"
  key="$(rendered api AWS_SECRET_ACCESS_KEY)"
  env -u AWS_ENDPOINT_URL -u AWS_SESSION_TOKEN -u AWS_PROFILE \
    AWS_REGION="$region" AWS_ACCESS_KEY_ID="$key_id" AWS_SECRET_ACCESS_KEY="$key" "$@"
}

# --- preflight -------------------------------------------------------------------
# Is version $1 (like 28.3.2, v2.39.1 or 2.24.6-desktop.1) at least $2 (x.y.z)?
version_at_least() {
  local IFS=. i have_part want_part
  # shellcheck disable=SC2206 # split on the dots
  local -a have=(${1#v}) want=($2)
  for i in 0 1 2; do
    have_part=${have[i]:-0}
    have_part=${have_part%%[!0-9]*}
    want_part=${want[i]:-0}
    [ "${have_part:-0}" -eq "$want_part" ] || { [ "${have_part:-0}" -gt "$want_part" ]; return; }
  done
}

# The loaded manifest names this release's commit and exactly its three images.
# A checkout has git for this.
check_bundle() {
  local image app name want
  [ "$(jq -r .commit "$RELEASE_MANIFEST")" = "$SOURCE_COMMIT" ] \
    || die "the manifest's source_commit is $SOURCE_COMMIT, this bundle is $(jq -r .commit "$RELEASE_MANIFEST")"
  for app in control-host:API_IMAGE worker:WORKER_IMAGE egress-proxy:EGRESS_PROXY_IMAGE; do
    want="$(jq -r --arg a "${app%%:*}" '.images[$a] | "\(.image)@\(.digest)"' "$RELEASE_MANIFEST")"
    name="${app#*:}"
    image="${!name}"
    [ "$image" = "$want" ] || die "the manifest's ${name} is $image, this bundle's release names $want"
  done
}

# Compose bind-mounts host files (the release's init SQL and LocalStack script,
# the settings document) into containers that run as their own users, so a
# checkout or bundle made under umask 077 or 027 otherwise surfaces only as an
# unhealthy postgres after deploy has created its volume.
check_mount_modes() {
  local source path closed=()
  while IFS= read -r source; do
    while IFS= read -r path; do closed+=("$path"); done \
      < <(find -H "$source" \( -type f ! -perm -004 \) -o \( -type d ! -perm -005 \) 2>/dev/null)
  done < <(printf '%s' "$RENDER" | jq -r '[.services[].volumes[]? | select(.type == "bind") | .source] | unique[]')
  [ "${#closed[@]}" = 0 ] && return
  printf '  %s\n' "${closed[@]:0:10}" >&2
  [ "${#closed[@]}" -le 10 ] || printf '  ... and %s more\n' "$(( ${#closed[@]} - 10 ))" >&2
  die "${#closed[@]} path(s) the containers mount are not readable by other users (above), and the containers do not run as you. Run chmod -R o+rX on the checkout or bundle directory and chmod o+r on the settings document, or make them again under umask 022"
}

# The loaded manifest against this host. The workspace quota itself is the
# scheduler's own probe at startup (deploy and upgrade wait for it).
preflight() {
  local head engine compose_version running_port=""
  if [ "$MODE" = bundle ]; then
    require_tools docker jq curl
    check_bundle
  else
    require_tools docker jq bun git curl
    head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  fi
  if [ "$MODE" = bundle ]; then
    :
  elif [ "$VERB" = start ]; then
    # Start recreates containers from the compose files, and those live in
    # infra/: another commit is fine while they are the release's own.
    [ "$head" = "$SOURCE_COMMIT" ] || git -C "$REPO_ROOT" diff --quiet "$SOURCE_COMMIT" "$head" -- infra 2>/dev/null \
      || die "the checkout is at $head and its infra/ differs from the manifest's source_commit $SOURCE_COMMIT (or that commit is not in this checkout); check that commit out first"
  else
    [ "$head" = "$SOURCE_COMMIT" ] \
      || die "the checkout is at $head, the manifest's source_commit is $SOURCE_COMMIT; check that commit out first"
  fi
  [ "$MODE" = bundle ] || [ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ] \
    || die "the checkout has local changes; the compose files must be the release's"
  engine="$(docker version --format '{{.Server.Version}}' 2>/dev/null)" || die "cannot reach the Docker daemon"
  version_at_least "$engine" "${MIN_ENGINE_MAJOR}.0.0" \
    || die "Docker Engine $engine is too old; worker networks need $MIN_ENGINE_MAJOR or newer (gateway_mode_ipv4=isolated)"
  compose_version="$(docker compose version --short 2>/dev/null)" || die "docker compose (v2) is not installed"
  version_at_least "$compose_version" "$MIN_COMPOSE" || die "docker compose $compose_version is too old; $MIN_COMPOSE or newer"
  render
  check_mount_modes
  # Before the bucket is touched with what may be another installation's settings.
  [ ! -e "$IDENTITY" ] || check_identity
  # Reseed alone moves a running LocalStack: it puts the objects back.
  if [ "$STORE" = localstack ]; then
    running_port="$(ops_compose ps -q localstack)" || die "cannot tell whether LocalStack runs"
    [ -z "$running_port" ] || running_port="$(ops_compose port localstack 4566)" \
      || die "cannot read the port of the running LocalStack"
  fi
  check_render ${SETTINGS_DIGEST:+--settings-digest "$SETTINGS_DIGEST"} ${running_port:+--localstack-port "${running_port##*:}"}
  if [ "$STORE" = s3 ]; then
    with_render probe-store || die "the bucket or the API's S3 key failed (above)"
  else
    # LocalStack starts with the installation; the API checks its bucket at
    # startup, and deploy and upgrade wait for that.
    log "preflight: object store is LocalStack on port $(printf '%s' "$RENDER" | jq -r '.services.localstack.ports[0].published'), in memory — a restart loses every checkpoint object (docs/operator/test-ops.md)"
  fi
  log "preflight: passed — Docker Engine $engine, compose $compose_version, store $STORE, source $SOURCE_COMMIT, settings $SETTINGS_DIGEST, api $API_URL, postgres port $(printf '%s' "$RENDER" | jq -r '.services.postgres.ports[0].published')"
}

# --- lifecycle -------------------------------------------------------------------
readyz() { curl -sS --max-time 3 "$API_URL/readyz" 2>/dev/null || true; }

# Starts what is not running and waits for every healthcheck, the
# scheduler's included: its first pass runs the network isolation and
# workspace quota probes.
start_apps() {
  if ! ops_compose up -d --wait --wait-timeout "$WAIT_TIMEOUT_SEC" "$@" api scheduler reconciler; then
    log "the installation did not become healthy; last log lines of the services that fail first:"
    ops_compose logs --no-color --tail 30 migrate egress-proxy scheduler api >&2 || true
    # A first deploy that fails leaves no current.json, so `stop` has nothing to take down.
    die "start failed (log lines above; for the scheduler, its quota or network preflight is the usual cause, docs/operator/test-ops.md). Containers that started stay up; take them down with: ${DOWN_BY_NAME} (never -v; the volumes stay)"
  fi
  log "readyz: $(readyz)"
}

# Admissions stop with the api, the only way in; the scheduler and the
# reconciler follow, then the workers the scheduler launched, which outlive
# it. backup.sh checks for itself that none is left.
stop_writers() {
  local installation workers
  installation="$(rendered scheduler EXECUTION_INSTALLATION_ID)"
  [ -n "$installation" ] || die "no EXECUTION_INSTALLATION_ID; cannot tell this installation's workers apart"
  log "stopping admissions and writers: api, scheduler, reconciler"
  ops_compose stop api scheduler reconciler
  workers="$(docker ps -q --filter "label=werft.installation=${installation}")" \
    || die "docker ps failed; cannot tell whether workers of installation $installation run"
  if [ -n "$workers" ]; then
    log "stopping $(printf '%s\n' "$workers" | grep -c .) worker container(s) of installation $installation"
    printf '%s\n' "$workers" | xargs docker stop >/dev/null
  fi
}

# stop_writers stops every worker carrying the installation id, so a new
# installation must not share one with anything already on the daemon.
in_use_by_others() {
  local installation found
  installation="$(rendered scheduler EXECUTION_INSTALLATION_ID)"
  found="$(docker ps -aq --filter "label=werft.installation=${installation}" \
    && docker ps -aq --filter "label=werft.egress-proxy=${installation}")" \
    || die "docker ps failed; cannot tell whether installation id $installation is in use"
  [ -z "$found" ] \
    || die "containers on this daemon already carry installation id $installation; pick another EXECUTION_INSTALLATION_ID"
}

# What stop_writers stopped, started again as it was: nothing is recreated.
reopen() {
  log "reopening"
  start_apps --no-recreate
}

# Back to the release current.json names, after an upgrade stopped short.
reopen_current() {
  reopen
  rm -f "$PENDING"
}

record_release() {
  local file="$1" verb="$2"
  cp "$file" "${CURRENT}.new" && mv "${CURRENT}.new" "$CURRENT"
  printf '%s %s by %s: source %s worker %s settings %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$verb" "$(id -un)" \
    "$SOURCE_COMMIT" "$WORKER_IMAGE" "$SETTINGS_DIGEST" >> "${STATE_DIR}/history.log"
}

settings_applied() {
  local notes
  notes="$(mktemp)"
  ops_compose run --rm --no-deps -T migrate bun run apps/control-host/src/api/settings.ts \
    import --document /settings/installation.json --dry-run </dev/null 2>"$notes" \
    | jq -e '.add == []' >/dev/null \
    || { cat "$notes" >&2; rm -f "${notes:?}"; die "the database does not hold the settings document the manifest names"; }
  # The import leaves out a repository without a GitHub App and says so only
  # here; `.add == []` alone would call that a settled document.
  if grep -q 'note: repository .* is not imported' "$notes"; then
    grep 'note: repository .* is not imported' "$notes" >&2
    rm -f "${notes:?}"
    die "the settings document names a repository the import leaves out (add \"auth\": {\"kind\": \"github_app\"}); the deployment would run with no repository"
  fi
  rm -f "${notes:?}"
}

# Sessions with a checkpoint no collection has ended, one id per line.
uncollected_sessions() {
  ops_compose exec -T postgres psql -v ON_ERROR_STOP=1 -X -q -At \
    -U "$(rendered postgres POSTGRES_USER)" -d "$(rendered postgres POSTGRES_DB)" \
    -c "SELECT DISTINCT session_id FROM checkpoints WHERE collected_at IS NULL ORDER BY 1" </dev/null
}

# Sessions whose current checkpoint the target worker image cannot restore.
# verify-restore's complete summary distinguishes an expected incompatible
# verdict from a broken/incomplete check; the helper falls back to every
# uncollected session for the latter.
upgrade_affected_sessions() {
  local previous_worker="$1" affected="$2" all output bucket status=0
  all="$(mktemp)"
  output="$(mktemp)"
  if ! uncollected_sessions > "$all"; then
    rm -f "$all" "$output"
    return 1
  fi
  if [ "$WORKER_IMAGE" = "$previous_worker" ]; then
    cp "$all" "$affected"
    rm -f "$all" "$output"
    return 0
  fi
  bucket="$(rendered api S3_BUCKET)"
  [ -n "$bucket" ] || status=1
  if [ "$status" = 0 ]; then
    if [ "$STORE" = s3 ]; then
      (with_api_store "${REPO_ROOT}/scripts/verify-restore.sh" --project "$PROJECT" \
        --object-store env --bucket "$bucket" --image "$WORKER_IMAGE") \
        > "$output" || status=$?
    else
      "${REPO_ROOT}/scripts/verify-restore.sh" --project "$PROJECT" \
        --object-store localstack --bucket "$bucket" --image "$WORKER_IMAGE" \
        > "$output" || status=$?
    fi
  fi
  if ! bun_script "$HELPER" upgrade-impact "$status" "$output" "$all" > "$affected"; then
    cp "$all" "$affected"
    log "upgrade: could not classify restore plans; fail-closed to every uncollected session"
  fi
  # The upgrade keeps the replaced image as the previous one, which the
  # scheduler uses only when both images print their runtime.
  if [ -n "$bucket" ] \
    && [ -n "$(worker_runtime "$WORKER_IMAGE")" ] && [ -n "$(worker_runtime "$previous_worker")" ]; then
    upgrade_previous_filter "$previous_worker" "$affected" "$all" "$bucket" "$status" "$output"
  fi
  rm -f "$all" "$output"
}

# Narrows $affected to the sessions the previous image cannot restore either.
# The helper keeps the list whole when either check failed closed, and a
# helper that cannot run leaves it as it was.
upgrade_previous_filter() {
  local previous_worker="$1" affected="$2" all="$3" bucket="$4" \
    target_status="$5" target_output="$6" output status=0
  output="$(mktemp)"
  if [ "$STORE" = s3 ]; then
    (with_api_store "${REPO_ROOT}/scripts/verify-restore.sh" --project "$PROJECT" \
      --object-store env --bucket "$bucket" --image "$previous_worker") \
      > "$output" || status=$?
  else
    "${REPO_ROOT}/scripts/verify-restore.sh" --project "$PROJECT" \
      --object-store localstack --bucket "$bucket" --image "$previous_worker" \
      > "$output" || status=$?
  fi
  if bun_script "$HELPER" upgrade-previous "$all" "$target_status" "$target_output" "$status" "$output" \
    > "${affected}.new"; then
    log "upgrade: $(grep -c . "$affected" || true) session(s) incompatible with the target, $(grep -c . "${affected}.new" || true) of them with the previous image $previous_worker too"
    mv "${affected}.new" "$affected"
  else
    rm -f "${affected}.new"
    log "upgrade: could not check the previous image; every session incompatible with the target stays affected"
  fi
  rm -f "$output"
}

deploy() {
  take_lock
  [ ! -e "$CURRENT" ] || die "a release is already deployed ($CURRENT); use upgrade"
  ! project_has_resources "$PROJECT" \
    || die "project '$PROJECT' already has containers, volumes or networks while $CURRENT names no release; its data is not touched. If this installation was deployed under other names, set TEST_OPS_PROJECT, TEST_OPS_STATE_DIR and TEST_OPS_ENV_FILE to them"
  load_manifest "$MANIFEST"
  preflight
  in_use_by_others
  identity > "$IDENTITY"
  start_apps
  settings_applied
  record_release "$MANIFEST" deploy
  log "deploy: done — the first owner's token (once; not needed when the env file sets BOOTSTRAP_TOKEN): scripts/test-ops.sh bootstrap-token"
  log "deploy: then issue a key with scripts/test-ops.sh key create <owner> --scopes sessions:read,sessions:write"
}

upgrade() {
  local from_worker from_settings affected approved_list="" status=0
  take_lock
  load_current
  from_worker="$WORKER_IMAGE"
  from_settings="$SETTINGS_DIGEST"
  load_manifest "$MANIFEST"
  [ -r "$IDENTITY" ] || die "$IDENTITY is missing; it is written by deploy"
  preflight
  affected="${STATE_DIR}/upgrade-$(date -u +%Y%m%dT%H%M%SZ).sessions"
  gate() {
    bun_script "$HELPER" upgrade-gate "$from_worker" "$WORKER_IMAGE" "$affected" ${APPROVED:+"$APPROVED"}
  }
  # First with the writers up, so a refusal costs no downtime.
  upgrade_affected_sessions "$from_worker" "$affected" || die "could not list the sessions with uncollected checkpoints"
  gate >/dev/null || status=$?
  if [ "$status" = "$EXIT_REFUSED" ]; then
    log "upgrade: affected sessions are in $affected; after review, rerun with --approve-sessions <a file of exactly those ids>"
    exit "$EXIT_REFUSED"
  fi
  [ "$status" = 0 ] || die "upgrade gate failed"
  # From here until the new release is up and recorded, every command but
  # status and this same upgrade refuses: what runs may be neither release.
  cp "$MANIFEST" "$PENDING"
  if [ "$WORKER_IMAGE" != "$from_worker" ]; then
    # Again with no writer left: a checkpoint committed meanwhile, or by a
    # worker of the old image still running, is either on the approved list
    # or stops the upgrade.
    stop_writers
    upgrade_affected_sessions "$from_worker" "$affected" || { reopen_current; die "could not list the sessions with uncollected checkpoints"; }
    status=0
    approved_list="$(gate)" || status=$?
    if [ "$status" != 0 ]; then
      log "upgrade: the affected sessions changed while writers stopped; reopening the current release"
      reopen_current
      exit "$EXIT_REFUSED"
    fi
  fi
  if [ -n "$approved_list" ]; then
    jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg operator "$(id -un)" \
      --arg from "$from_worker" --arg to "$WORKER_IMAGE" --arg file "$APPROVED" \
      --arg sessions "$approved_list" \
      '{at: $at, operator: $operator, from_worker: $from, to_worker: $to, approval_file: $file,
        sessions: ($sessions | split("\n"))}' \
      > "${STATE_DIR}/approvals/$(date -u +%Y%m%dT%H%M%SZ)-upgrade.json"
    log "upgrade: $(printf '%s\n' "$approved_list" | grep -c .) session(s) approved to become INCOMPATIBLE_CHECKPOINT; recorded in ${STATE_DIR}/approvals"
  fi
  # What the gate counted on: the replaced image stays as the previous one.
  if [ "$WORKER_IMAGE" != "$from_worker" ]; then
    { printf '%s\n' "$from_worker" > "${PREVIOUS_WORKER}.new" && mv "${PREVIOUS_WORKER}.new" "$PREVIOUS_WORKER"; } \
      || die "upgrade: could not record the previous worker in $PREVIOUS_WORKER; nothing was started"
  fi
  start_apps
  # A bind mount's new contents rerun nothing on their own.
  [ "$SETTINGS_DIGEST" = "$from_settings" ] \
    || ops_compose run --rm --no-deps -T migrate </dev/null \
    || die "migrate refused the new settings document; nothing it holds was written (above)"
  settings_applied
  record_release "$MANIFEST" upgrade
  rm -f "$PENDING"
  log "upgrade: done"
}

# The deployed release up again on the volumes it left. Refused where nothing
# was deployed and while an upgrade is unfinished (load_current): both need
# deploy or upgrade, not this.
start() {
  [ -r "$CURRENT" ] || die "no release is deployed ($CURRENT); deploy one first"
  take_lock
  load_current
  [ -r "$IDENTITY" ] || die "$IDENTITY is missing; it is written by deploy"
  preflight
  if [ "$STORE" = localstack ] && [ -z "$(ops_compose ps -q localstack)" ]; then
    log "start: LocalStack was down, so its in-memory bucket is empty; if the API refuses to start, restore the objects with reseed (docs/operator/test-ops.md)"
  fi
  start_apps
  printf '%s start by %s: source %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(id -un)" "$SOURCE_COMMIT" \
    >> "${STATE_DIR}/history.log"
  log "start: done"
}

# Containers and networks go, volumes stay: the compose down of the
# single-server page, without the env file and image variables typed by hand.
stop() {
  [ -r "$CURRENT" ] || die "no release is deployed ($CURRENT); there is nothing to stop"
  take_lock
  load_current
  render
  check_identity
  stop_writers
  ops_compose down --remove-orphans
  printf '%s stop by %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(id -un)" >> "${STATE_DIR}/history.log"
  log "stop: done; the volumes stay — bring it back with scripts/test-ops.sh start"
}

status_report() {
  local role root
  load_current
  render
  check_identity
  ops_compose ps
  echo "release: $(jq -c . "$CURRENT")"
  echo "object store: $STORE"
  [ ! -e "$PENDING" ] || echo "UNFINISHED upgrade to: $(jq -c . "$PENDING")"
  echo "readyz: $(readyz)"
  for role in scheduler reconciler; do
    if ops_compose exec -T "$role" bun run apps/control-host/src/main.ts "$role" --health </dev/null >/dev/null 2>&1; then
      echo "$role: healthy"
    else
      echo "$role: UNHEALTHY (docker compose logs $role)"
    fi
  done
  echo "sessions with uncollected checkpoints: $(uncollected_sessions | grep -c . || true)"
  root="$(docker info --format '{{.DockerRootDir}}')"
  df -h "$root"
}

key() {
  load_current
  render
  check_identity
  ops_compose exec -T api bun run apps/control-host/src/api/keys.ts "$@" </dev/null
}

# The token is read out of the API container and deleted there by the same
# command, so it reaches this terminal once and no log ever holds it.
bootstrap_token() {
  load_current
  render
  check_identity
  ops_compose exec -T api bun run apps/control-host/src/api/bootstrap-token-file.ts </dev/null
}

backup() {
  local bucket
  take_lock
  load_current
  render
  check_identity
  bucket="$(rendered api S3_BUCKET)"
  if [ "$STOP" = 1 ]; then
    log "backup: writers stay stopped (--stop); after the restart, run reseed with this backup"
  else
    CLEANUPS+=(reopen)
  fi
  stop_writers
  if [ "$STORE" = s3 ]; then
    with_api_store "${REPO_ROOT}/scripts/backup.sh" --project "$PROJECT" --out "${STATE_DIR}/backups" \
      --bucket "$bucket" --object-store env
  else
    "${REPO_ROOT}/scripts/backup.sh" --project "$PROJECT" --out "${STATE_DIR}/backups" \
      --bucket "$bucket" --object-store localstack
  fi
}

# The objects a LocalStack installation lost in a restart, put back from a
# backup the way scripts/restore.sh fills a new bucket: create-only upload,
# then every checkpoint re-pinned to its new version and held. The database
# is the installation's own and must not have moved on since the backup
# (backup --stop before a planned restart): the re-pin checks every
# uncollected checkpoint against the uploaded bytes before it writes, and
# refuses otherwise. A failure leaves the writers stopped; reset is then
# what is left.
reseed() {
  local bucket manifest_keys skip expected restored
  take_lock
  load_current
  render
  check_identity
  [ "$STORE" = localstack ] || die "reseed refills a LocalStack installation's bucket; this one is on $STORE"
  check_render
  [ -r "$BACKUP_DIR/manifest.json" ] || die "$BACKUP_DIR is not a backup (no manifest.json)"
  verify_checksums "$BACKUP_DIR" || die "SHA256SUMS mismatch in $BACKUP_DIR; the bundle is damaged or edited"
  schema_check "$BACKUP_DIR/manifest.json" || die "the backup's schema is not this release's"
  bucket="$(rendered api S3_BUCKET)"
  [ "$(jq -r '.source.project' "$BACKUP_DIR/manifest.json")" = "$PROJECT" ] \
    && [ "$(jq -r '.objects.bucket' "$BACKUP_DIR/manifest.json")" = "$bucket" ] \
    || die "$BACKUP_DIR is not a backup of project $PROJECT and bucket $bucket"
  stop_writers
  ops_compose up -d --wait --wait-timeout "$WAIT_TIMEOUT_SEC" postgres localstack
  # Empty, or this is not the restart it is meant for: the upload is
  # create-only and would stop at the first key anyway.
  object_store "$PROJECT" "$bucket" check-target \
    || die "bucket $bucket in LocalStack is not empty; reseed only refills it after a restart"
  object_store "$PROJECT" "$bucket" create-only-check \
    || die "bucket $bucket does not refuse a second create-only write"
  manifest_keys="$(ops_compose exec -T postgres psql -v ON_ERROR_STOP=1 -X -q -At \
    -U "$(rendered postgres POSTGRES_USER)" -d "$(rendered postgres POSTGRES_DB)" \
    -c "SELECT DISTINCT manifest_ref FROM checkpoints WHERE collected_at IS NULL ORDER BY 1" </dev/null)" \
    || die "could not list the checkpoint manifests"
  skip="$(mktemp)"
  CLEANUPS+=("rm -f '$skip'")
  printf '%s\n' "$manifest_keys" > "$skip"
  object_store "$PROJECT" "$bucket" upload "$BACKUP_DIR/objects" "$skip" >/dev/null \
    || die "the upload stopped; the installation stays stopped — reset it (docs/operator/test-ops.md)"
  checkpoint_pins "$PROJECT" "$bucket" repin "$BACKUP_DIR/objects" >/dev/null \
    || die "the re-pin refused, most likely because the database moved on since the backup; the installation stays stopped — reset it (docs/operator/test-ops.md)"
  expected="$(jq -r '.objects.count' "$BACKUP_DIR/manifest.json")"
  restored="$(object_store "$PROJECT" "$bucket" count)" || die "could not count the objects in $bucket"
  [ "$restored" = "$expected" ] \
    || die "$restored objects in $bucket after the re-pin, the backup has $expected; the installation stays stopped"
  start_apps
  printf '%s reseed by %s: %s objects from %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(id -un)" "$restored" "$BACKUP_DIR" \
    >> "${STATE_DIR}/history.log"
  log "reseed: $restored objects back in $bucket; the installation is up"
}

# Everything of this installation goes: containers, volumes (database, and in
# LocalStack whatever is left), the workers and workspace volumes the scheduler
# made, and the recorded release. Keys are gone with the database. A Gitea
# volume from an older release is not deleted: no backup of this checkout holds
# it, so it may be the last copy.
reset() {
  local installation volume_namespace old
  take_lock
  load_current
  render
  check_identity
  installation="$(rendered scheduler EXECUTION_INSTALLATION_ID)"
  volume_namespace="$(rendered scheduler EXECUTION_VOLUME_LABEL_NAMESPACE)"
  log "reset: deleting project $PROJECT (installation $installation) and ALL its data"
  ops_compose down -v --remove-orphans
  docker ps -aq --filter "label=werft.installation=${installation}" | xargs -r docker rm -f >/dev/null
  docker network ls -q --filter "label=werft.installation=${installation}" | xargs -r docker network rm >/dev/null
  docker volume ls -q --filter "label=${volume_namespace:-werft}.installation=${installation}" | xargs -r docker volume rm >/dev/null
  old="${STATE_DIR}/reset-$(date -u +%Y%m%dT%H%M%SZ).json"
  mv "$CURRENT" "$old"
  rm -f "$IDENTITY" "$PENDING"
  printf '%s reset by %s: project %s, release %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(id -un)" "$PROJECT" "$old" \
    >> "${STATE_DIR}/history.log"
  ! docker volume inspect "${PROJECT}_gitea-data" >/dev/null 2>&1 \
    || log "reset: warning — volume ${PROJECT}_gitea-data stays: no backup holds it. Copy what matters, then remove it, or deploy refuses this project"
  log "reset: done; deploy again with scripts/test-ops.sh deploy $old, then issue keys again"
}

restore_drill() {
  local log_file status=0
  if [ "$STORE" = s3 ]; then
    [ -n "$DRILL_BUCKET" ] || die "restore-drill on s3 needs --bucket, a new empty Object Lock bucket"
  else
    [ -z "$DRILL_BUCKET" ] || die "restore-drill on localstack restores into the drill's own LocalStack; drop --bucket"
  fi
  take_lock
  load_current
  render
  check_identity
  # Globals, not locals: the cleanup reads them at exit, and an empty
  # project name would make compose fall back to the local stack's.
  DRILL="${PROJECT}-drill-$(date -u +%Y%m%dt%H%M%Sz)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  ! project_has_resources "$DRILL" || die "project $DRILL already exists"
  log_file="${STATE_DIR}/restore-drills/${DRILL}.log"
  # restore.sh runs migrate from the local layer, which would build the
  # control-host image from this checkout. The released one, under the name
  # compose looks for first, is what this installation migrates with.
  MIGRATE_IMAGE="${DRILL}-migrate"
  docker tag "$API_IMAGE" "$MIGRATE_IMAGE"
  # With --keep the drill's containers still use it; the tag then stays.
  CLEANUPS+=('docker rmi "$MIGRATE_IMAGE" >/dev/null 2>&1 || true')
  [ "$KEEP" = 1 ] \
    || CLEANUPS+=('docker compose -p "$DRILL" -f "${REPO_ROOT}/infra/compose.yml" down -v >/dev/null 2>&1')
  if [ "$STORE" = s3 ]; then
    log "restore-drill: $BACKUP_DIR into project $DRILL and bucket $DRILL_BUCKET; log $log_file"
    {
      with_api_store "${REPO_ROOT}/scripts/restore.sh" "$BACKUP_DIR" --into "$DRILL" --object-store env \
        --bucket "$DRILL_BUCKET" --port-base "$PORT_BASE" \
        && with_api_store "${REPO_ROOT}/scripts/verify-restore.sh" --project "$DRILL" --object-store env \
          --bucket "$DRILL_BUCKET"
    } 2>&1 | tee "$log_file" || status=$?
  else
    # The drill's own LocalStack, under the backup's bucket name.
    DRILL_BUCKET="$(jq -r '.objects.bucket' "$BACKUP_DIR/manifest.json")" || die "$BACKUP_DIR has no readable manifest.json"
    log "restore-drill: $BACKUP_DIR into project $DRILL and its own LocalStack; log $log_file"
    {
      "${REPO_ROOT}/scripts/restore.sh" "$BACKUP_DIR" --into "$DRILL" --port-base "$PORT_BASE" \
        && "${REPO_ROOT}/scripts/verify-restore.sh" --project "$DRILL" --bucket "$DRILL_BUCKET"
    } 2>&1 | tee "$log_file" || status=$?
  fi
  if [ "$status" = 0 ]; then
    echo "restore-drill: PASSED" | tee -a "$log_file"
  else
    echo "restore-drill: FAILED (exit $status)" | tee -a "$log_file"
  fi
  printf '%s restore-drill by %s: %s from %s into %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(id -un)" \
    "$([ "$status" = 0 ] && echo passed || echo FAILED)" "$BACKUP_DIR" "$DRILL_BUCKET" "$log_file" \
    >> "${STATE_DIR}/history.log"
  [ "$KEEP" = 0 ] || log "restore-drill: kept project $DRILL; tear it down with docker compose -p $DRILL -f infra/compose.yml down -v"
  return "$status"
}

# The deploy manifest of a GitHub Release's release-manifest.json plus the
# digest of the settings document. Needs neither the env file nor a host.
make_manifest() {
  [ -r "$MANIFEST" ] || die "release manifest $MANIFEST not found"
  [ -f "$SETTINGS_FILE" ] || die "settings document $SETTINGS_FILE not found"
  jq -e --arg digest "sha256:$(sha256_file "$SETTINGS_FILE")" '{
    source_commit: .commit,
    images: {
      control_host: (.images["control-host"] | "\(.image)@\(.digest)"),
      worker: (.images.worker | "\(.image)@\(.digest)"),
      egress_proxy: (.images["egress-proxy"] | "\(.image)@\(.digest)")
    },
    settings_digest: $digest
  }' "$MANIFEST" || die "$MANIFEST is not a release manifest"
}
if [ "$VERB" = manifest ]; then
  require_tools jq
  make_manifest
  exit 0
fi

check_env_file
# Deploy takes TEST_OPS_OBJECT_STORE (localstack by default) and records it;
# after that, the recorded one is the installation's.
STORE="$(sed -n 's/^object_store=//p' "$IDENTITY" 2>/dev/null || true)"
if [ -z "$STORE" ]; then
  STORE="${TEST_OPS_OBJECT_STORE:-localstack}"
elif [ -n "${TEST_OPS_OBJECT_STORE:-}" ] && [ "$TEST_OPS_OBJECT_STORE" != "$STORE" ]; then
  die "the installation was deployed on $STORE; moving it to $TEST_OPS_OBJECT_STORE is a reset and a new deploy (docs/operator/test-ops.md)"
fi
case "$STORE" in
  localstack|s3) ;;
  *) die "TEST_OPS_OBJECT_STORE must be localstack or s3, not '$STORE'" ;;
esac
case "$VERB" in
  deploy|upgrade|backup|restore-drill|reseed|reset)
    mkdir -p "${STATE_DIR}/approvals" "${STATE_DIR}/backups" "${STATE_DIR}/restore-drills" \
      || die "cannot create the state directory $STATE_DIR (TEST_OPS_STATE_DIR)"
    ;;
esac
case "$VERB" in
  preflight)
    if [ -n "$MANIFEST" ]; then load_manifest "$MANIFEST"; else load_current; fi
    preflight
    ;;
  deploy) deploy ;;
  upgrade) upgrade ;;
  start) start ;;
  stop) stop ;;
  status) status_report ;;
  key) key "$@" ;;
  bootstrap-token) bootstrap_token ;;
  backup) backup ;;
  restore-drill) restore_drill ;;
  reseed) reseed ;;
  reset) reset ;;
esac
