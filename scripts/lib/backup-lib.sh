#!/usr/bin/env bash
# Shared by scripts/backup.sh, scripts/restore.sh and scripts/verify-restore.sh.
# PostgreSQL and git run inside the compose containers, so the host needs
# docker (compose v2.24.6+, for `!override` over an include), git, jq, a
# sha256 tool, and this checkout's bun: every S3 call goes through the
# production adapter on the host (`object_store`, `checkpoint_pins`), so the
# store can be the project's LocalStack or any S3-compatible one.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/infra/compose.yml"
RESTORE_OVERRIDE="${REPO_ROOT}/infra/compose.restore.yml"
MIGRATIONS_DIR="${REPO_ROOT}/packages/db/migrations"
BACKUP_MANIFEST_VERSION=1

# Exit codes shared by the three scripts so a caller can tell refusals apart.
EXIT_USAGE=2
EXIT_SCHEMA_MISMATCH=3
EXIT_TARGET_NOT_EMPTY=4
EXIT_VERIFY_FAILED=5

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "error: $*"; exit 1; }

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
  done
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

# `compose <project> args...`: the base file only, for a running installation.
compose() {
  local project="$1"
  shift
  docker compose -p "$project" -f "$COMPOSE_FILE" "$@"
}

# Same, with the restore override layered on. Port and network variables come
# from the caller's environment (restore.sh exports them).
compose_restore() {
  local project="$1"
  shift
  docker compose -p "$project" -f "$COMPOSE_FILE" -f "$RESTORE_OVERRIDE" "$@"
}

# The image each service ran, as manifest JSON. api/worker/scheduler are
# not_built until the installation runs them. Restore does not need them;
# tests/e2e/restore-resume.sh compares the worker's here with the image of the
# worker that produced the checkpoint.
manifest_images() {
  local project="$1" images='{}' service cid image image_id digests entry
  for service in postgres localstack egress-proxy api worker scheduler; do
    cid="$(compose "$project" ps -aq "$service" 2>/dev/null | head -n1 || true)"
    if [ -n "$cid" ]; then
      image="$(docker inspect -f '{{.Config.Image}}' "$cid")"
      image_id="$(docker inspect -f '{{.Image}}' "$cid")"
      digests="$(docker image inspect -f '{{join .RepoDigests ","}}' "$image_id" 2>/dev/null || true)"
      entry="$(jq -n --arg image "$image" --arg id "$image_id" --arg digests "$digests" \
        '{status: "present", image: $image, id: $id, repo_digests: ($digests | split(",") | map(select(. != "")))}')"
    else
      # Left explicit rather than omitted: a later image build must not be
      # written back here as if it had produced this backup.
      entry='{"status": "not_built", "image": null, "id": null, "repo_digests": []}'
    fi
    images="$(printf '%s' "$images" | jq --arg s "$service" --argjson e "$entry" '. + {($s): $e}')"
  done
  printf '%s' "$images"
}

# manifest.json from backup.sh's variables, on stdout.
backup_manifest() {
  jq -n \
    --argjson version "$BACKUP_MANIFEST_VERSION" \
    --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg source_project "$PROJECT" \
    --arg source_commit "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)" \
    --argjson source_dirty "$([ -z "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ] && echo false || echo true)" \
    --arg pg_version "$PG_VERSION" \
    --arg head_tag "$HEAD_TAG" \
    --argjson applied "$APPLIED_JSON" \
    --arg pg_db "$PG_DB" \
    --arg pg_user "$PG_USER" \
    --arg store "$OBJECT_STORE" \
    --arg bucket "$BUCKET" \
    --arg endpoint "$ENDPOINT" \
    --argjson object_count "$OBJECT_COUNT" \
    --argjson images "$IMAGES_JSON" \
    '{
      version: $version,
      created_at: $created_at,
      source: { project: $source_project, checkout_commit: $source_commit, checkout_dirty: $source_dirty },
      schema: { head_tag: $head_tag, applied: $applied },
      db: { name: $pg_db, user: $pg_user, file: "db.sql", server: $pg_version },
      objects: { store: $store, bucket: $bucket, endpoint: $endpoint, count: $object_count, dir: "objects" },
      images: $images
    }'
}

# The value of one environment variable inside a running service container,
# so scripts never guess POSTGRES_USER/POSTGRES_DB from the host environment.
container_env() {
  local project="$1" service="$2" name="$3"
  # `exec -T` forwards the caller's stdin; without the redirect this would
  # swallow the dump a caller is about to feed to psql.
  compose "$project" exec -T "$service" sh -c "printf '%s' \"\$$name\"" </dev/null
}

psql_in() {
  local project="$1"
  shift
  local user db
  user="$(container_env "$project" postgres POSTGRES_USER)"
  db="$(container_env "$project" postgres POSTGRES_DB)"
  compose "$project" exec -T postgres psql -v ON_ERROR_STOP=1 -X -q -U "$user" -d "$db" "$@"
}

# The published host port of one service's container port, as a number.
published_port() {
  local project="$1" service="$2" port="$3" found
  found="$(compose "$project" port "$service" "$port" </dev/null)" || return 1
  printf '%s' "${found##*:}"
}

# Where the checkpoint objects live, for `with_object_store`: `localstack`,
# the compose project's own LocalStack, or `env`, the store the caller's
# environment names. Each script sets it from --object-store.
OBJECT_STORE=localstack

# `set_object_store <mode>`: validates and sets OBJECT_STORE.
set_object_store() {
  case "$1" in
    localstack|env) OBJECT_STORE="$1" ;;
    *) die "--object-store must be localstack or env, not '$1'" ;;
  esac
}

# The value of one environment variable a service container was created
# with, read from the daemon rather than from inside the container. Fails
# when the service has no container.
inspect_env() {
  local project="$1" service="$2" name="$3" cid
  cid="$(compose "$project" ps -aq "$service" </dev/null | head -n1)"
  [ -n "$cid" ] || return 1
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$cid" | sed -n "s/^${name}=//p" | head -n1
}

# `with_object_store <project> <bucket> <command> [args]`: runs the command
# with S3_BUCKET and the AWS_* settings of $OBJECT_STORE. `localstack` is the
# project's LocalStack on its published port, with the credentials the
# container was started with. `env` is the caller's own AWS_REGION,
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_ENDPOINT_URL, the
# variables the API reads; no AWS_ENDPOINT_URL means AWS S3 itself.
with_object_store() {
  local project="$1" bucket="$2" name port region key_id key
  shift 2
  if [ "$OBJECT_STORE" = env ]; then
    for name in AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
      [ -n "${!name:-}" ] || die "--object-store env needs $name in the environment"
    done
    S3_BUCKET="$bucket" "$@"
    return
  fi
  port="$(published_port "$project" localstack 4566)" || die "localstack of '$project' publishes no port"
  region="$(inspect_env "$project" localstack AWS_DEFAULT_REGION)" || die "project '$project' has no localstack container"
  key_id="$(inspect_env "$project" localstack AWS_ACCESS_KEY_ID)" || die "project '$project' has no localstack container"
  key="$(inspect_env "$project" localstack AWS_SECRET_ACCESS_KEY)" || die "project '$project' has no localstack container"
  AWS_ENDPOINT_URL="http://127.0.0.1:${port}" AWS_REGION="$region" \
    AWS_ACCESS_KEY_ID="$key_id" AWS_SECRET_ACCESS_KEY="$key" \
    S3_BUCKET="$bucket" "$@"
}

# The endpoint `with_object_store` hands the CLIs, empty for AWS S3; recorded
# in the backup so a restore can refuse the source's own bucket.
object_store_endpoint() {
  with_object_store "$1" "$2" sh -c 'printf "%s" "${AWS_ENDPOINT_URL:-}"'
}

# `bun_script <script> [args]`: this checkout's bun on the host. bun leaves
# the pipes it wrote to non-blocking. Handed the caller's own stdout or
# stderr, and the caller merging them into one pipe (`2>&1 |`), the script's
# next write larger than the pipe has room for fails with EAGAIN and the
# whole run exits 1. So bun only ever gets descriptors of its own: a file for
# stdout, a pipe that cat drains for stderr.
bun_script() {
  local out status=0
  out="$(mktemp)"
  if bun run "$@" </dev/null >"$out" 2> >(cat >&2); then
    status=0
  else
    status=$?
  fi
  cat "$out"
  rm -f "$out"
  return "$status"
}

# `object_store <project> <bucket> <command> [args]`: one step of
# scripts/lib/object-store-cli.ts against the chosen store.
object_store() {
  local project="$1" bucket="$2"
  shift 2
  with_object_store "$project" "$bucket" bun_script "${REPO_ROOT}/scripts/lib/object-store-cli.ts" "$@"
}

# `checkpoint_pins <project> <bucket> <command> [args]`: runs
# scripts/lib/checkpoint-pins-cli.ts against the project's published
# postgres port, with the credentials that container was started with, and
# the chosen store. It is the one step that needs the production codec,
# which only this checkout's bun has.
checkpoint_pins() {
  local project="$1" bucket="$2"
  shift 2
  local pg_port pg_user pg_db pg_password
  pg_port="$(published_port "$project" postgres 5432)" || die "postgres of '$project' publishes no port"
  pg_user="$(container_env "$project" postgres POSTGRES_USER)"
  pg_db="$(container_env "$project" postgres POSTGRES_DB)"
  pg_password="$(container_env "$project" postgres POSTGRES_PASSWORD)"
  DATABASE_URL="postgresql://$(uri_escape "$pg_user"):$(uri_escape "$pg_password")@127.0.0.1:${pg_port}/$(uri_escape "$pg_db")" \
    with_object_store "$project" "$bucket" bun_script "${REPO_ROOT}/scripts/lib/checkpoint-pins-cli.ts" "$@"
}

uri_escape() {
  jq -rn --arg value "$1" '$value | @uri'
}

# The migrations this checkout expects, one `<hash> <when> <tag>` per line in
# journal order. The hash is sha256 of the whole SQL file, which is what
# Drizzle's migrator records in drizzle.__drizzle_migrations (see
# packages/db/src/migration-head.ts), so it compares directly with a dump.
expected_migrations() {
  local journal="${MIGRATIONS_DIR}/meta/_journal.json"
  [ -r "$journal" ] || die "migration journal not found: $journal"
  jq -r '.entries[] | "\(.when) \(.tag)"' "$journal" | while read -r when tag; do
    printf '%s %s %s\n' "$(sha256_file "${MIGRATIONS_DIR}/${tag}.sql")" "$when" "$tag"
  done
}

# Refuses a backup whose applied migration list is not exactly this checkout's.
# Older backups are refused too: restore is meant to reproduce a known state,
# and running migrations against restored data is a separate, deliberate step.
# Prints the verdict; returns EXIT_SCHEMA_MISMATCH.
schema_check() {
  local manifest="$1"
  [ -r "$manifest" ] || die "manifest not found: $manifest"
  local version
  version="$(jq -r '.version // empty' "$manifest")"
  if [ "$version" != "$BACKUP_MANIFEST_VERSION" ]; then
    log "schema: manifest version '${version:-missing}' is not ${BACKUP_MANIFEST_VERSION}"
    return "$EXIT_SCHEMA_MISMATCH"
  fi
  local applied expected
  applied="$(jq -r '.schema.applied[] | "\(.hash) \(.when)"' "$manifest")"
  expected="$(expected_migrations | cut -d' ' -f1,2)"
  if [ "$applied" = "$expected" ]; then
    log "schema: backup matches checkout head $(jq -r '.schema.head_tag' "$manifest")"
    return 0
  fi
  log "schema: backup applied migrations differ from this checkout"
  log "schema: backup head = $(jq -r '.schema.head_tag // "?"' "$manifest") ($(printf '%s\n' "$applied" | grep -c . || true) applied)"
  log "schema: checkout head = $(expected_migrations | tail -n1 | cut -d' ' -f3) ($(expected_migrations | wc -l | tr -d ' ') expected)"
  diff <(printf '%s\n' "$expected") <(printf '%s\n' "$applied") >&2 || true
  return "$EXIT_SCHEMA_MISMATCH"
}

# A backup taken from a Gitea (manifest `gitea` not null) holds repositories
# this checkout has nowhere to put. The commit it names is a candidate, not a
# promise: it can be `unknown`, and a dirty checkout's changes were not kept.
no_gitea_data() {
  local manifest="$1" commit
  [ "$(jq -r '.gitea != null' "$manifest")" = true ] || return 0
  commit="$(jq -r '.source.checkout_commit // "unknown"' "$manifest")"
  [ "$(jq -r '.source.checkout_dirty // false' "$manifest")" != true ] || commit="$commit (with local changes)"
  log "restore: this backup holds Gitea data (repos/ and gitea/), which this checkout cannot restore"
  log "restore: use a checkout from before Gitea's removal at schema head $(jq -r '.schema.head_tag // "?"' "$manifest"); the backup was taken at commit $commit"
  return "$EXIT_SCHEMA_MISMATCH"
}

# `unbundle_chain <bare-repository> <commit> <bundle>...`: a checkpoint's
# bundles, oldest first, fetched into one empty repository the way a restore
# stacks them. An incremental bundle needs commits only an earlier
# one carries, so none after the first verifies on its own. The last bundle's
# refs/checkpoint/worktree, peeled, must be <commit>: that is what a restore
# checks out. It may be an annotated tag over a commit an earlier bundle
# carries, when the capture changed nothing, so the bundle's header
# never lists <commit> itself. That is the worktree part of the rule finalize
# and a worker restore apply to the last bundle's refs, `checkpointBundleRefs`
# in packages/runtime-core/src/checkpoint-bundle.ts; a bundle that
# rule refuses never commits. Paths must be absolute. Says on stdout which
# bundle git refused and fails.
unbundle_chain() {
  local repository="$1" commit="$2"
  shift 2
  local count=$# index=0 bundle worktree
  if [ "$count" -eq 0 ]; then
    echo "no bundle to verify"
    return 1
  fi
  for bundle in "$@"; do
    index=$((index + 1))
    if ! git -C "$repository" bundle verify "$bundle" >/dev/null 2>&1; then
      echo "bundle $index of $count: git bundle verify rejected it after the $((index - 1)) before it"
      return 1
    fi
    # No auto maintenance: it runs detached after the fetch and can still be
    # writing into the repository when the caller removes it.
    if ! git -C "$repository" -c fetch.fsckObjects=true -c maintenance.auto=false -c gc.auto=0 \
      fetch --quiet --no-write-fetch-head \
      "$bundle" "refs/*:refs/chain/$index/*" >/dev/null 2>&1; then
      echo "bundle $index of $count: git fetch refused it"
      return 1
    fi
  done
  if ! worktree="$(git -C "$repository" rev-parse --verify --quiet "refs/chain/$count/checkpoint/worktree^{commit}")"; then
    echo "the last bundle has no refs/checkpoint/worktree"
    return 1
  fi
  if [ "$worktree" != "$commit" ]; then
    echo "the last bundle's refs/checkpoint/worktree is $worktree, not $commit"
    return 1
  fi
}

# True when the compose project already owns any container, volume or network.
# Restore never reuses one: an existing project means existing data. A daemon
# that cannot be asked is a failure, not an empty project.
project_has_resources() {
  local project="$1" found
  found="$(docker ps -aq --filter "label=com.docker.compose.project=${project}")" || die "docker ps failed; cannot tell whether project '$project' exists"
  [ -z "$found" ] || return 0
  found="$(docker volume ls -q --filter "label=com.docker.compose.project=${project}")" || die "docker volume ls failed; cannot tell whether project '$project' exists"
  [ -z "$found" ] || return 0
  found="$(docker network ls -q --filter "label=com.docker.compose.project=${project}")" || die "docker network ls failed; cannot tell whether project '$project' exists"
  [ -z "$found" ] || return 0
  return 1
}

# Every regular file under $1 except the root SHA256SUMS itself (an S3 key
# may well be named SHA256SUMS), relative paths, sorted.
bundle_inventory() {
  (cd "$1" && find . -type f ! -path ./SHA256SUMS -print | sed 's#^\./##' | LC_ALL=C sort)
}

# Writes SHA256SUMS over the inventory, so a bundle that was copied around
# can be checked before restore.
write_checksums() {
  local dir="$1"
  bundle_inventory "$dir" | while read -r file; do
    printf '%s  %s\n' "$(sha256_file "${dir}/${file}")" "$file"
  done > "${dir}/SHA256SUMS"
}

# Every listed file must hash as listed, and the inventory must be exactly
# the listed paths: a file added after the fact (a bundle restore would
# clone, say) is as much a modification as a changed byte.
verify_checksums() {
  local dir="$1"
  [ -r "${dir}/SHA256SUMS" ] || die "SHA256SUMS missing in $dir"
  (
    cd "$dir"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum --quiet -c SHA256SUMS
    else
      shasum -a 256 -s -c SHA256SUMS
    fi
  ) || return 1
  local listed
  listed="$(sed 's/^[0-9a-f]*  //' "${dir}/SHA256SUMS" | LC_ALL=C sort)"
  if [ "$listed" != "$(bundle_inventory "$dir")" ]; then
    log "checksums: files present differ from SHA256SUMS"
    diff <(printf '%s\n' "$listed") <(bundle_inventory "$dir") >&2 || true
    return 1
  fi
}
