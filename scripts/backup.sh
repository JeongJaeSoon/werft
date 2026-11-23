#!/usr/bin/env bash
# Bundles one compose installation into backup-<ts>/:
#
#   db.sql          pg_dump of the sessions database (schema + data + journal)
#   objects/        every object in the bucket, key = path; a key a
#                   checkpoint pins holds the bytes of the pinned version
#   manifest.json   schema version (applied migrations), image digests,
#                   object inventory
#   SHA256SUMS      over all of the above
#
# The source installation is only read. The writers — api, scheduler,
# reconciler, the worker service and every worker container the scheduler
# launched — must be stopped: a checkpoint committed between pg_dump and the
# object copy has a pointer without its objects. The backup refuses to start
# while one runs; --allow-running-writers only warns instead.
#
# It is written to backup-<ts>.partial and renamed to backup-<ts> only once
# complete; a run that fails leaves backup-<ts>.failed.
#
# --object-store localstack (default) reads the project's LocalStack; env
# reads the store the environment names (AWS_REGION, AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, and AWS_ENDPOINT_URL unless it is AWS S3).
#
# Usage: scripts/backup.sh [--project werft] [--out backups] [--bucket claude-sessions]
#                          [--object-store localstack|env] [--allow-running-writers]

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/backup-lib.sh"

PROJECT=werft
OUT="${REPO_ROOT}/backups"
BUCKET=claude-sessions
ALLOW_RUNNING_WRITERS=0

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit "$EXIT_USAGE"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --object-store) set_object_store "$2"; shift 2 ;;
    --allow-running-writers) ALLOW_RUNNING_WRITERS=1; shift ;;
    -h|--help) usage ;;
    *) log "unknown argument: $1"; usage ;;
  esac
done

require_tools docker jq bun

STORES=(postgres)
[ "$OBJECT_STORE" = env ] || STORES+=(localstack)
for service in "${STORES[@]}"; do
  [ -n "$(compose "$PROJECT" ps -q --status running "$service")" ] \
    || die "service '$service' of project '$PROJECT' is not running"
done
# pg_dump is consistent on its own; the objects are copied afterwards, so a
# checkpoint committed in between has a pointer without its object. api, scheduler, reconciler, maintenance and worker are found by compose's own
# labels, so a container outside the active profiles still counts. The
# scheduler's workers carry its installation label. With no scheduler
# container left, the installation cannot be named, so a running container
# of any installation counts.
service_containers() {
  local service="$1"
  shift
  docker ps -q "$@" --filter "label=com.docker.compose.project=${PROJECT}" \
    --filter "label=com.docker.compose.service=${service}"
}
WRITERS=""
for service in api scheduler reconciler maintenance worker; do
  running="$(service_containers "$service")" \
    || die "docker ps failed; cannot tell whether '$service' of project '$PROJECT' runs"
  [ -z "$running" ] || WRITERS="$WRITERS $service"
done
SCHEDULER="$(service_containers scheduler -a | head -n1)" || die "docker ps failed; cannot find the scheduler of project '$PROJECT'"
INSTALLATION=""
if [ -n "$SCHEDULER" ]; then
  INSTALLATION="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SCHEDULER" \
    | sed -n 's/^EXECUTION_INSTALLATION_ID=//p' | head -n1)" \
    || die "cannot read the installation id of the scheduler of project '$PROJECT'"
fi
if [ -n "$INSTALLATION" ]; then
  LABEL="werft.installation=${INSTALLATION}"
  WORKERS_OF="installation ${INSTALLATION}"
else
  LABEL="werft.installation"
  WORKERS_OF="any installation (project '$PROJECT' names none)"
fi
WORKERS="$(docker ps -q --filter "label=${LABEL}")" \
  || die "docker ps failed; cannot tell whether workers of ${WORKERS_OF} run"
[ -z "$WORKERS" ] || WRITERS="$WRITERS $(printf '%s\n' "$WORKERS" | grep -c .) worker container(s) of ${WORKERS_OF}"
if [ -n "$WRITERS" ]; then
  [ "$ALLOW_RUNNING_WRITERS" = 1 ] \
    || die "writers are running:${WRITERS}; stop them first (https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/backup-and-restore/) or pass --allow-running-writers"
  log "backup: warning — writers are running:${WRITERS}; a checkpoint committed during the backup may be missing its objects"
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="${OUT}/backup-${TS}"
DEST="${FINAL}.partial"
umask 077
mkdir -p "$OUT"
[ ! -e "$FINAL" ] || die "refusing to overwrite existing $FINAL"
# A plain mkdir is the reservation: two backups started in the same second
# get the same name, and the one that loses the mkdir stops here instead of
# interleaving its files with the winner's.
mkdir "$DEST" 2>/dev/null || die "refusing to overwrite existing $DEST"
# Only a complete backup gets the plain name; whatever else ends this run
# leaves a name nobody can take for one.
trap 'status=$?
if [ "$status" -ne 0 ] && [ -d "$DEST" ] && [ ! -e "${FINAL}.failed" ]; then
  mv "$DEST" "${FINAL}.failed" && log "backup: failed; what it wrote is in ${FINAL}.failed"
fi' EXIT
mkdir "$DEST/objects"
log "backup: project=$PROJECT store=$OBJECT_STORE -> $FINAL"

# --- database -------------------------------------------------------------
PG_USER="$(container_env "$PROJECT" postgres POSTGRES_USER)"
PG_DB="$(container_env "$PROJECT" postgres POSTGRES_DB)"
DUMP_AT="$(psql_in "$PROJECT" -Atc "SELECT clock_timestamp()")"
compose "$PROJECT" exec -T postgres pg_dump --no-owner --no-privileges -U "$PG_USER" "$PG_DB" > "$DEST/db.sql"
log "backup: db.sql $(wc -c < "$DEST/db.sql" | tr -d ' ') bytes"

# Applied migrations as the journal recorded them, for the schema check.
APPLIED_JSON="$(psql_in "$PROJECT" -Atc \
  "SELECT json_agg(json_build_object('hash', hash, 'when', created_at) ORDER BY created_at) FROM drizzle.__drizzle_migrations")"
[ -n "$APPLIED_JSON" ] && [ "$APPLIED_JSON" != "null" ] || die "drizzle.__drizzle_migrations is empty; this database was never migrated"
HEAD_WHEN="$(printf '%s' "$APPLIED_JSON" | jq -r '.[-1].when')"
HEAD_TAG="$(expected_migrations | awk -v w="$HEAD_WHEN" '$2 == w { print $3 }')"
CHECKOUT_HEAD="$(expected_migrations | tail -n1 | cut -d' ' -f3)"
if [ -z "$HEAD_TAG" ]; then
  log "backup: warning — applied head $HEAD_WHEN is not a migration this checkout knows; restore will refuse this bundle"
  HEAD_TAG="unknown-${HEAD_WHEN}"
elif [ "$HEAD_TAG" != "$CHECKOUT_HEAD" ]; then
  log "backup: warning — database head $HEAD_TAG is behind checkout head $CHECKOUT_HEAD; restore from this checkout will refuse it"
fi

# --- objects ---------------------------------------------------------------
object_store "$PROJECT" "$BUCKET" download "$DEST/objects" >/dev/null \
  || die "objects of bucket ${BUCKET} could not be downloaded"
ENDPOINT="$(object_store_endpoint "$PROJECT" "$BUCKET")"
# The download copied what each key holds now. A checkpoint names a version, and
# the key may have moved on (overwritten, delete-marked) since it committed;
# the backup must carry the bytes the checkpoint pinned, or refuse.
checkpoint_pins "$PROJECT" "$BUCKET" capture "$DEST/objects" >/dev/null \
  || die "checkpoint objects could not be backed up at the versions their checkpoints pin"
# Checkpoint GC marks a row collected_at, then deletes its objects. A row it
# marked after pg_dump's snapshot is unmarked in db.sql while its objects are
# missing from objects/, and restore's repin fails on it. The mark is one
# statement, so the minute before the dump started covers every mark the
# dump can have missed; checked after the copy, because each purge follows
# its mark.
COLLECTED="$(psql_in "$PROJECT" -Atc \
  "SELECT count(*) FROM checkpoints WHERE collected_at > timestamptz '$DUMP_AT' - interval '1 minute'")"
[ "$COLLECTED" = 0 ] \
  || die "checkpoint GC collected $COLLECTED checkpoint(s) while this backup ran, so db.sql names objects the backup lacks; back up again with checkpoint GC stopped"
OBJECT_COUNT="$(find "$DEST/objects" -type f | wc -l | tr -d ' ')"
log "backup: objects/ $OBJECT_COUNT objects from ${BUCKET} at ${ENDPOINT:-AWS S3}"

# --- manifest --------------------------------------------------------------
IMAGES_JSON="$(manifest_images "$PROJECT")"
PG_VERSION="$(compose "$PROJECT" exec -T postgres postgres --version | tr -d '\n')"
backup_manifest > "$DEST/manifest.json"

write_checksums "$DEST"
mv "$DEST" "$FINAL"
DEST="$FINAL"
log "backup: done -> $FINAL (schema head $HEAD_TAG, $OBJECT_COUNT objects)"
printf '%s\n' "$FINAL"
