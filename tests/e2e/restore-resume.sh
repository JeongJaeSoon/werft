#!/usr/bin/env bash
# Backup → restore into a new compose project → resume on a new worker, on
# the product stack
#
#   tests/e2e/restore-resume.sh
#
# 1. Starts the `apps` stack (tests/e2e/run.sh's images and overlay) as the
#    source project and runs two turns that each write to the workspace
#    through a real Claude Code, then pauses: the worker checkpoints and goes.
# 2. Stops the writers, takes scripts/backup.sh, and removes the source
#    project and every container, network and volume its scheduler made, so
#    nothing but the backup carries the session over.
# 3. scripts/restore.sh into a new project, scripts/verify-restore.sh, then
#    starts the same apps on it (restore override on top, same images) and
#    resumes the session through the public API with the key issued on the
#    source — the key is in the restored database too.
# 4. The new worker must restore the checkpoint and continue the same Claude
#    session: the resumed turn reads back what turns 1 and 2 wrote, exactly
#    once; the fake Messages API sees only the new prompt asked, with the two
#    earlier ones as history; and a second pause commits a checkpoint whose
#    engine session id, transcript parts (as a prefix), workspace commit and
#    untracked files match the source's.
#
# Everything lands in RR_OUT (default: a fresh temp dir): record.txt (tested
# SHA, image ids, versions, the comparison table), each step's JSON, both
# projects' checkpoint rows and manifests, restore and verify logs, compose
# logs, and every worker's log. The backup itself holds the API key hashes,
# so only its manifest.json is kept.
#
# Knobs: RR_PROJECT (source project; the restored one is <it>r),
# RR_INSTALLATION_ID (EXECUTION_INSTALLATION_ID for both), RR_PORT_BASE
# (the restored project's three loopback ports, default 24320), RR_KEEP=1
# leaves both projects' images and the backup behind. RR_IMAGES_FROM=<p>
# builds nothing and runs the images project <p> already has (a stack from
# scripts/soak/stack.sh or scripts/d2-gate/run.sh), retagged for both projects:
# a release candidate is tested on its own images, not on this checkout's.
#
# Needs what tests/e2e/run.sh and scripts/restore.sh need: Docker Engine 28+,
# compose v2.24.6+, bun, jq. On macOS put /bin ahead of Homebrew's bash 5.3,
# which hangs on long heredocs.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
source scripts/lib/backup-lib.sh

if [ -z "${DOCKER_HOST:-}" ] && [ -S "$HOME/.docker/run/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
fi

run_id="$(date +%s | tail -c 7)$((RANDOM % 1000))"
project="${RR_PROJECT:-rr${run_id}}"
restored="${project}r"
port_base="${RR_PORT_BASE:-24320}"
out="${RR_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/restore-resume.XXXXXX")}"
# Cleanup deletes $out/backup, so the directory must be this run's alone.
if [ -d "$out" ] && [ -n "$(ls -A "$out")" ]; then
  echo "RR_OUT ${out} is not empty" >&2
  exit 2
fi
mkdir -p "$out/workers"
record="$out/record.txt"

export EXECUTION_INSTALLATION_ID="${RR_INSTALLATION_ID:-$project}"
export API_IMAGE="werft-control-host:${project}"
export WORKER_IMAGE="werft-worker:${project}"
export EGRESS_PROXY_IMAGE="werft-egress-proxy:${project}"
export RESTORE_POSTGRES_PORT="$port_base"
export RESTORE_LOCALSTACK_PORT="$((port_base + 1))"
export RESTORE_GIT_HOST_PORT="$((port_base + 2))"
label="werft.installation=${EXECUTION_INSTALLATION_ID}"
volume_label="${EXECUTION_VOLUME_LABEL_NAMESPACE:-werft}.installation=${EXECUTION_INSTALLATION_ID}"
src_files=(-f infra/compose.yml -f infra/compose.fake-model.yml -f tests/e2e/compose.yml)
dst_files=("${src_files[@]}" -f infra/compose.restore.yml)
src() { docker compose -p "$project" "${src_files[@]}" --profile apps "$@"; }
dst() { docker compose -p "$restored" "${dst_files[@]}" --profile apps "$@"; }

note() { printf '%s\n' "$*" | tee -a "$record" >&2; }
fail() { note "FAIL $*"; exit 1; }
pass() { note "PASS $*"; }

# Every resource this run's scheduler made carries the installation label.
remove_installation() {
  local ids
  ids="$(docker ps -aq --filter "label=${label}")"
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
  ids="$(docker network ls -q --filter "label=${label}")"
  [ -z "$ids" ] || docker network rm $ids >/dev/null 2>&1 || true
  ids="$(docker volume ls -q --filter "label=${volume_label}")"
  [ -z "$ids" ] || docker volume rm -f $ids >/dev/null 2>&1 || true
}

events_pid=""
cleanup() {
  local status=$?
  src logs --no-color --timestamps >"$out/compose-source.log" 2>&1 || true
  dst logs --no-color --timestamps >"$out/compose-restored.log" 2>&1 || true
  if [ "${RR_KEEP:-0}" = 1 ]; then
    echo "kept: projects ${project} ${restored}, installation ${EXECUTION_INSTALLATION_ID}" >&2
  else
    src down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
    dst down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
    remove_installation
    docker image rm "$API_IMAGE" "$WORKER_IMAGE" "$EGRESS_PROXY_IMAGE" \
      "${project}-migrate:latest" "${restored}-migrate:latest" \
      "${project}-fake-git:latest" "${restored}-fake-git:latest" >/dev/null 2>&1 || true
    rm -rf "$out/backup"
  fi
  [ -z "$events_pid" ] || kill "$events_pid" 2>/dev/null || true
  [ "${RR_KEEP:-0}" = 1 ] || wait 2>/dev/null || true
  echo "restore-resume record: $out" >&2
  exit "$status"
}
# Cleanup removes both projects and everything the installation label names,
# so it is armed only once none of that exists yet.
for name in "$project" "$restored"; do
  ! project_has_resources "$name" || fail "project ${name} already exists"
done
[ -z "$(docker ps -aq --filter "label=${label}")$(docker network ls -q --filter "label=${label}")$(docker volume ls -q --filter "label=${volume_label}")" ] \
  || fail "installation ${EXECUTION_INSTALLATION_ID} already has containers, networks or volumes"
trap cleanup EXIT

# Worker containers are removed when they exit; follow each from its start.
# The phase file says which stack started it.
echo source >"$out/phase"
mkfifo "$out/.events"
docker events --filter "label=${label}" --filter type=container --filter event=start \
  --format '{{.Actor.ID}} {{index .Actor.Attributes "name"}}' >"$out/.events" &
events_pid=$!
while read -r id name; do
  docker logs -f --timestamps "$id" >"$out/workers/$(cat "$out/phase")-${name}.log" 2>&1 &
done <"$out/.events" &

# `api_env <compose fn>`: the public endpoints tests/e2e/restore-resume.ts reads.
api_env() {
  export E2E_API_URL="http://127.0.0.1:$("$1" port api 3000 | sed 's/.*://')"
  export E2E_MESSAGES_URL="http://127.0.0.1:$("$1" port fake-messages 4011 | sed 's/.*://')"
}
step() { bun run tests/e2e/restore-resume.ts "$@"; }

# `checkpoint_rows <project> <session>`: every checkpoint of the session.
checkpoint_rows() {
  psql_in "$1" -Atc "select revision, manifest_ref, manifest_sha256,
    coalesce(manifest_version, ''), versions_held, coalesce(parent_revision::text, '')
    from checkpoints where session_id = '$2' order by revision" </dev/null
}

# `session_row <project> <session>`: the columns a resume depends on.
session_row() {
  psql_in "$1" -Atc "select admission_state, status, checkpoint_revision,
    revision from sessions where id = '$2'" </dev/null
}

# `manifest <project> <session> <revision>`: that checkpoint's manifest,
# read at the version its row pins.
manifest() {
  local ref version
  IFS='|' read -r ref version < <(psql_in "$1" -Atc \
    "select manifest_ref, manifest_version from checkpoints
     where session_id = '$2' and revision = $3" </dev/null)
  local out status=0
  out="$(mktemp)"
  object_store "$1" claude-sessions read "$ref" "$version" "$out" >/dev/null || status=$?
  [ "$status" != 0 ] || cat "$out"
  rm -f "$out"
  return "$status"
}

# The image the session's running worker container was started from.
session_image() {
  local id
  id="$(docker ps -q --filter "label=${label}" --filter "label=werft.session-id=$1" \
    --filter "name=ap-worker-" | head -n1)"
  [ -n "$id" ] || return 1
  docker inspect -f '{{.Image}}' "$id"
}

# --- 1. source: two turns, then pause ----------------------------------------
note "== source project ${project} (installation ${EXECUTION_INSTALLATION_ID})"
build=--build
if [ -n "${RR_IMAGES_FROM:-}" ]; then
  from="$RR_IMAGES_FROM"
  # Cleanup removes this run's tags; on the source's own names it would take
  # the source's images with it.
  [ "$from" != "$project" ] && [ "$from" != "$restored" ] \
    || fail "RR_IMAGES_FROM must name another project than ${project} and ${restored}"
  # A tag gone missing must fail the run, not be rebuilt from this checkout.
  build=--no-build
  for repo in control-host worker egress-proxy; do
    docker tag "werft-${repo}:${from}" "werft-${repo}:${project}" \
      || fail "project ${from} has no werft-${repo} image"
  done
  # restore.sh runs migrate on the restored project, under its default name.
  for name in "$project" "$restored"; do
    docker tag "${from}-migrate:latest" "${name}-migrate:latest" \
      || fail "project ${from} has no migrate image"
  done
  docker tag "${from}-fake-git:latest" "${project}-fake-git:latest" \
    || fail "project ${from} has no fake-git image"
fi
src up -d "$build" >"$out/up-source.log" 2>&1 || { tail -50 "$out/up-source.log" >&2; exit 1; }
# restore.sh leaves the git host down; the restored apps start it --no-build.
docker tag "${project}-fake-git:latest" "${restored}-fake-git:latest" || fail "project ${project} has no fake-git image"
api_key="$(COMPOSE_PROJECT_NAME="$project" COMPOSE_FILE="infra/compose.yml:infra/compose.fake-model.yml:tests/e2e/compose.yml" \
  bun run --silent keys create rr-owner \
  --scopes sessions:read,sessions:write,sessions:approve,sessions:control)"
export E2E_API_KEY="$api_key"

image_id() { docker image inspect --format '{{.Id}}' "$1"; }
{
  echo "command: tests/e2e/restore-resume.sh"
  echo "tested_sha: $(git rev-parse HEAD) (uncommitted paths: $(git status --porcelain | wc -l | tr -d ' '))"
  [ -z "${RR_IMAGES_FROM:-}" ] || echo "images_from: ${RR_IMAGES_FROM} (tested_sha is the tools checkout)"
  echo "docker_engine: $(docker version --format '{{.Server.Version}}')"
  echo "compose: $(docker compose version --short)"
  for image in "$API_IMAGE" "$WORKER_IMAGE" "$EGRESS_PROXY_IMAGE"; do
    echo "image: ${image} $(image_id "$image")"
  done
  echo "claude_agent_sdk: $(jq -r '.dependencies["@anthropic-ai/claude-agent-sdk"]' \
    packages/adapters/runtimes/claude/package.json)"
  echo "claude_code: $(src logs --no-color worker 2>/dev/null | sed -n 's/.*| //p' | tail -1)"
} | tee -a "$record" >&2

api_env src
step turns >"$out/turns.json"
session="$(jq -r .session_id "$out/turns.json")"
note "session: ${session}"
note "source turns: $(jq -c '[.turns[] | {turn_id, status}]' "$out/turns.json")"
source_worker_image="$(session_image "$session")" || fail "no worker container for ${session} on the source"
step pause "$session" >"$out/pause-source.json"
revision="$(jq -r .paused.checkpoint_revision "$out/pause-source.json")"
note "source checkpoint revision: ${revision}"
session_row "$project" "$session" >"$out/session-source.txt"
checkpoint_rows "$project" "$session" >"$out/checkpoints-source.txt"
manifest "$project" "$session" "$revision" >"$out/manifest-source.json"
jq -e . "$out/manifest-source.json" >/dev/null || fail "source manifest is not JSON"

# --- 2. backup, then remove the source --------------------------------------
src stop api scheduler reconciler maintenance >/dev/null 2>&1
# `paused` commits while the worker is still releasing; give it time to exit.
for _ in $(seq 60); do
  [ -n "$(docker ps -q --filter "label=${label}" --filter "name=ap-worker-")" ] || break
  sleep 1
done
[ -z "$(docker ps -q --filter "label=${label}" --filter "name=ap-worker-")" ] \
  || fail "a worker still runs 60s after pause and stop"
backup_dir="$(bash scripts/backup.sh --project "$project" --out "$out/backup" 2>"$out/backup.log")" \
  || { cat "$out/backup.log" >&2; fail "backup"; }
cp "$backup_dir/manifest.json" "$out/backup-manifest.json"
note "backup: $(jq -c '{objects, worker: .images.worker.id}' "$out/backup-manifest.json")"
jq -e 'has("gitea") or has("repos") or (.images | has("gitea")) | not' "$out/backup-manifest.json" >/dev/null \
  || fail "the backup manifest names a git host"
src down -v --remove-orphans >/dev/null 2>&1
remove_installation
! project_has_resources "$project" || fail "source project ${project} still has resources"
[ -z "$(docker ps -aq --filter "label=${label}")$(docker network ls -q --filter "label=${label}")$(docker volume ls -q --filter "label=${volume_label}")" ] \
  || fail "installation ${EXECUTION_INSTALLATION_ID} still has containers, networks or volumes"
pass "source ${project} removed: no container, volume or network left"

# --- 3. restore into a new project, verify, start the apps -------------------
note "== restored project ${restored} (ports ${port_base}..$((port_base + 3)))"
bash scripts/restore.sh "$backup_dir" --into "$restored" --port-base "$port_base" \
  >"$out/restore.log" 2>&1 || { tail -40 "$out/restore.log" >&2; fail "restore"; }
bash scripts/verify-restore.sh --project "$restored" >"$out/verify.log" 2>&1 \
  || { tail -40 "$out/verify.log" >&2; fail "verify-restore"; }
grep -E '^(PASS|FAIL|SKIP|checkpoints=)' "$out/verify.log" | tee -a "$record" >&2 || true
session_row "$restored" "$session" >"$out/session-restored.txt"
checkpoint_rows "$restored" "$session" >"$out/checkpoints-restored.txt"
manifest "$restored" "$session" "$revision" >"$out/manifest-restored.json"

echo restored >"$out/phase"
store_before="$(dst ps -q localstack)"
dst up -d --no-build >"$out/up-restored.log" 2>&1 || { tail -50 "$out/up-restored.log" >&2; exit 1; }
# Keep app startup from needlessly recreating the restored object store.
# Its objects and encryption key persist in the named volume.
[ "$(dst ps -q localstack)" = "$store_before" ] || fail "starting the apps recreated the restored localstack"

# --- 4. resume on a new worker ------------------------------------------------
api_env dst
step resume "$session" >"$out/resume.json"
note "resumed turn: $(jq -c '.turn | {turn_id, status, checkpoint_revision}' "$out/resume.json"), cat: $(jq -r .cat_output "$out/resume.json")"
note "restored model calls: $(jq -c '[.model_calls[] | {spec_id, step, history}]' "$out/resume.json")"
restored_worker_image="$(session_image "$session")" || fail "no worker container for ${session} on the restored project"
step pause "$session" >"$out/pause-restored.json"
next="$(jq -r .paused.checkpoint_revision "$out/pause-restored.json")"
session_row "$restored" "$session" >"$out/session-resumed.txt"
checkpoint_rows "$restored" "$session" >"$out/checkpoints-resumed.txt"
manifest "$restored" "$session" "$next" >"$out/manifest-resumed.json"
grep -h -E 'worker\.(claimed|checkpoint\.restored|resume\.ready|checkpoint\.published)' \
  "$out"/workers/restored-*.log >"$out/worker-restored-events.log" || true

# --- 5. comparison ------------------------------------------------------------
note "== comparison (source r${revision} / restored r${revision} / resumed r${next})"
m_src="$out/manifest-source.json"
m_rst="$out/manifest-restored.json"
m_new="$out/manifest-resumed.json"
field() { jq -c "$1" "$2"; }
same() { # <label> <a> <b>
  if [ "$2" = "$3" ]; then pass "$1: $2"; else fail "$1: $2 != $3"; fi
}

[ "$next" -gt "$revision" ] || fail "no new checkpoint after the resumed turn (r${next})"
# The engine's own session id lives in the manifest (`resume`), not in a
# column: the worker hands it back to the SDK as `resume`.
engine_session="$(jq -r .resume "$m_src")"
same "engine session id (source = restored)" "$engine_session" "$(jq -r .resume "$m_rst")"
same "engine session id (source = resumed)" "$engine_session" "$(jq -r .resume "$m_new")"
same "every resumed transcript part is under that engine session" "true" \
  "$(jq --arg id "$engine_session" '[.transcripts.root.parts[] | .["key"] | contains("/" + $id + "/")] | all' "$m_new")"
same "transcript parts sha256 (source = restored)" \
  "$(field '[.transcripts.root.parts[].sha256]' "$m_src")" "$(field '[.transcripts.root.parts[].sha256]' "$m_rst")"
same "transcript part-list digest (source = restored)" \
  "$(field .transcripts.root.sha256 "$m_src")" "$(field .transcripts.root.sha256 "$m_rst")"
parts="$(field '[.transcripts.root.parts[] | {key, sha256}]' "$m_src")"
same "resumed transcript starts with the source's parts" \
  "$parts" "$(jq -c --argjson n "$(jq length <<<"$parts")" '[.transcripts.root.parts[] | {key, sha256}][0:$n]' "$m_new")"
note "transcript parts: source $(jq length <<<"$parts"), resumed $(field '.transcripts.root.parts | length' "$m_new"); entries: source $(field .transcripts.root.entryCount "$m_src"), resumed $(field .transcripts.root.entryCount "$m_new")"
same "object versions re-pinned on restore (source ≠ restored)" \
  "true" "$(jq -n --slurpfile a "$m_src" --slurpfile b "$m_rst" \
    '[$a[0].transcripts.root.parts[].version] != [$b[0].transcripts.root.parts[].version]')"
same "workspace commit (source = restored)" "$(field .workspace.gitCommit "$m_src")" "$(field .workspace.gitCommit "$m_rst")"
same "workspace commit (source = resumed)" "$(field .workspace.gitCommit "$m_src")" "$(field .workspace.gitCommit "$m_new")"
untracked='[.workspace.untracked[] | {path, sha256}] | sort_by(.path)'
same "untracked files (source = resumed)" "$(field "$untracked" "$m_src")" "$(field "$untracked" "$m_new")"
jq -e '.workspace.untracked | any(.path == "hello.txt")' "$m_src" >/dev/null \
  || fail "hello.txt is not in the source checkpoint"
restored_line="$(grep 'worker.checkpoint.restored' "$out/worker-restored-events.log" | head -n1)"
[ -n "$restored_line" ] || fail "the restored worker logged no worker.checkpoint.restored"
note "restored worker: ${restored_line#* }"
grep -q "\"revision\":${revision}[,}]" <<<"$restored_line" || fail "the new worker restored another revision"
grep -q "$(jq -r .workspace.gitCommit "$m_src")" <<<"$restored_line" || fail "the new worker restored another commit"
grep -q "worker.resume.ready" "$out/worker-restored-events.log" || fail "the new worker never reported ready"
pass "new worker restored r${revision} at the source commit and reported ready"
same "worker image (backup manifest = source worker)" "$(jq -r .images.worker.id "$out/backup-manifest.json")" "$source_worker_image"
same "worker image (source worker = restored worker)" "$source_worker_image" "$restored_worker_image"
note "== restore-resume: every check passed"
