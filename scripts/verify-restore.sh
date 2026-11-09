#!/usr/bin/env bash
# Checks that a (restored) installation's checkpoint pointers still name the
# bytes they were committed against.
#
# For every row of `checkpoints`: the manifest is downloaded at
# manifest_version and its sha256 compared with manifest_sha256; the manifest
# is then opened and every object it pins (workspace bundle, untracked files,
# transcript parts of root and subagents) is downloaded at the version it
# names and compared the same way; every one of those versions must carry a
# legal hold, and the row must say versions_held; the bundles are finally
# fetched into one empty repository, workspace.baseBundles oldest first and
# then workspace.bundle, and the last must offer workspace.gitCommit as a ref
# tip. Rows that are the session's current pointer (sessions.checkpoint_revision)
# are marked `pointer`. Last, the restored API's own path is asked: its
# `locked` startup bucket check and a restore plan for every pointer.
#
# --image <worker image> asks each plan as a worker of that image would: its
# engine, SDK and CLI versions, and the profile digest its own code computes
# from the claim the API would hand the session, built from the session row
# and the database's settings. A pointer sealed under another
# build, or under a digest the image no longer computes, fails as
# incompatible. Without --image each plan is asked with the checkpoint's own
# runtime, and the image check is printed as SKIP.
#
# --record (with --image) writes one checkpoint_restore_check row per live
# checkpoint of the image's engine build: ok, mismatch or error, bound to the
# manifest sha256 it read and the image's content id. A checkpoint a pointer
# names is judged by its restore plan; the others by whether their digest is
# one the image offers for the session. One sealed on another engine build is
# left for the image of that build, so run once per retained image.
# assert_checkpoint_restore_verified(retained) (migration 0255) then passes only
# when every live checkpoint's latest check by one of the retained images is ok;
# the migration that deletes the profile tables calls it with their content ids.
#
# Exit 0 when every row passes, 5 when any fails. A database with no
# checkpoints passes with a warning: there was nothing to disagree.
#
# --object-store localstack (default) reads the project's LocalStack; env
# reads the store the environment names, as scripts/restore.sh does.
#
# Usage: scripts/verify-restore.sh --project <project> [--bucket claude-sessions]
#                                  [--object-store localstack|env]
#                                  [--image <worker image> [--record]]

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/backup-lib.sh"

PROJECT=""
BUCKET=claude-sessions
IMAGE=""
RECORD=""

usage() {
  sed -n '2,42p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit "$EXIT_USAGE"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --object-store) set_object_store "$2"; shift 2 ;;
    --image) [ -n "${2:-}" ] || usage; IMAGE="$2"; shift 2 ;;
    --record) RECORD=1; shift ;;
    -h|--help) usage ;;
    *) log "unknown argument: $1"; usage ;;
  esac
done
[ -n "$PROJECT" ] || usage
require_tools docker jq git bun
[ -z "$RECORD" ] || [ -n "$IMAGE" ] || die "--record needs --image: only a worker image can say whether it restores a checkpoint"
PLANS_ARGS=()
if [ -n "$IMAGE" ]; then
  log "verify: plans asked for image $IMAGE with the database's settings"
  PLANS_ARGS=(--image "$IMAGE")
  [ -z "$RECORD" ] || PLANS_ARGS+=(--record)
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
PASSED=0
ROWS=0

fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL %s\n' "$*"
}

# One pinned object: named by version, that version exists, hashes to what
# the manifest says and, when the manifest states a size, is that many bytes,
# and is held.
check_ref() {
  local label="$1" key="$2" version="$3" expected="$4" out="$5" bytes="${6:-}"
  if [ -z "$version" ]; then
    fail "$label: $key is not pinned by version; the restore did not re-pin it"
    return 1
  fi
  # Presence is the read's exit status: a zero-byte object (an empty untracked
  # file, bytes: 0) is a valid artifact and still gets hashed. It prints the
  # version's legal hold, ON or OFF.
  local hold
  if ! hold="$(object_store "$PROJECT" "$BUCKET" read "$key" "$version" "$out")"; then
    fail "$label: object missing $key (version $version)"
    return 1
  fi
  local actual
  actual="$(sha256_file "$out")"
  if [ "$actual" != "$expected" ]; then
    fail "$label: sha256 $actual != $expected ($key)"
    return 1
  fi
  if [ -n "$bytes" ] && [ "$(wc -c < "$out" | tr -d ' ')" != "$bytes" ]; then
    fail "$label: $(wc -c < "$out" | tr -d ' ') bytes, manifest says $bytes ($key)"
    return 1
  fi
  if [ "$hold" != ON ]; then
    fail "$label: $key (version $version) has legal hold '${hold:-none}', not ON"
    return 1
  fi
  return 0
}

# Every session pointer first (left join, so a pointer whose checkpoints row
# is missing still comes out, with empty ref and hash), then the historical
# rows the pointer does not name.
QUERY="SELECT s.id, s.checkpoint_revision, coalesce(c.manifest_ref, ''), coalesce(c.manifest_sha256, ''),
              coalesce(c.manifest_version, ''), coalesce(c.versions_held, false), 1
       FROM sessions s LEFT JOIN checkpoints c
         ON c.session_id = s.id AND c.revision = s.checkpoint_revision
       WHERE s.checkpoint_revision IS NOT NULL
       UNION ALL
       SELECT c.session_id, c.revision, c.manifest_ref, c.manifest_sha256,
              coalesce(c.manifest_version, ''), c.versions_held, 0
       FROM checkpoints c JOIN sessions s ON s.id = c.session_id
       WHERE s.checkpoint_revision IS DISTINCT FROM c.revision AND c.collected_at IS NULL
       ORDER BY 1, 2"
# Read the rows up front: a query that fails inside a process substitution
# would look like an empty database and let the run exit 0.
ROWS_TEXT="$(psql_in "$PROJECT" -Atc "$QUERY")" || die "could not read checkpoints from project '$PROJECT'"
while IFS='|' read -r session revision ref expected manifest_version held is_pointer; do
  [ -n "$session" ] || continue
  ROWS=$((ROWS + 1))
  tag="$session@$revision"
  [ "$is_pointer" = 1 ] && tag="$tag pointer"
  manifest="$WORK/manifest-$ROWS.json"
  ok=1
  if [ -z "$ref" ]; then
    fail "$tag: sessions.checkpoint_revision names a revision with no checkpoints row"
    continue
  fi
  check_ref "$tag manifest" "$ref" "$manifest_version" "$expected" "$manifest" || ok=0
  # Only a re-pin that hashed and held every version may say so; a row that
  # does not makes the locked API re-hash on every restore.
  if [ "$held" != t ]; then
    fail "$tag: versions_held is false; the restore did not re-pin this row"
    ok=0
  fi
  if [ "$ok" = 1 ]; then
    # The production codec decides what a manifest is: schema, digest
    # formats and each transcript revision's part-list digest.
    if ! decode_error="$(bun run "$REPO_ROOT/scripts/lib/decode-manifest.ts" "$manifest" 2>&1)"; then
      fail "$tag manifest: codec rejected it: ${decode_error}"
      ok=0
    # The product restore path refuses a manifest sealed for another session or
    # revision even when every byte checks out, so the verifier must too.
    elif ! jq -e --arg s "$session" --argjson r "$revision" '.sessionId == $s and .revision == $r' "$manifest" >/dev/null 2>&1; then
      fail "$tag manifest: sealed for $(jq -r '"\(.sessionId)@\(.revision)"' "$manifest"), not this row"
      ok=0
    fi
  fi
  if [ "$ok" = 1 ]; then
    # Transcript parts of the root and every subagent, then the bundle.
    # NUL-delimited: an object key may itself contain whitespace. Listed to a
    # file first: a jq that failed halfway inside a process substitution
    # would just end the loop early, and the row would pass unchecked.
    refs="$WORK/refs-$ROWS"
    if ! jq -j '(([.transcripts.root] + (.transcripts.subagents | to_entries | map(.value))) | .[].parts[]), .workspace.untracked[], (.outputs // [])[] | select(has("omitted") | not) | "\(.key)\u0000\(.version // "")\u0000\(.sha256)\u0000\(.bytes)\u0000"' "$manifest" > "$refs"; then
      fail "$tag manifest: could not list its objects"
      ok=0
    fi
    while IFS= read -r -d '' key && IFS= read -r -d '' version && IFS= read -r -d '' sha && IFS= read -r -d '' bytes; do
      check_ref "$tag part" "$key" "$version" "$sha" "$WORK/part" "$bytes" || ok=0
    done < "$refs"
    # The chain oldest first, as a restore fetches it: an incremental bundle
    # verifies only on top of the ones before it.
    chain_ok=1
    chain="$WORK/chain-$ROWS"
    if ! jq -j '((.workspace.baseBundles // []) + [.workspace.bundle])[] | "\(.key)\u0000\(.version // "")\u0000\(.sha256)\u0000\(.bytes)\u0000"' "$manifest" > "$chain"; then
      fail "$tag manifest: could not list its bundles"
      chain_ok=0
    fi
    bundles=()
    while IFS= read -r -d '' key && IFS= read -r -d '' version && IFS= read -r -d '' sha && IFS= read -r -d '' bytes; do
      bundle="$WORK/bundle-$ROWS-${#bundles[@]}"
      check_ref "$tag bundle" "$key" "$version" "$sha" "$bundle" "$bytes" || chain_ok=0
      bundles+=("$bundle")
    done < "$chain"
    if [ "$chain_ok" = 1 ]; then
      commit="$(jq -r '.workspace.gitCommit' "$manifest")"
      repository="$WORK/verify-$ROWS.git"
      git init --quiet --bare "$repository"
      if ! refused="$(unbundle_chain "$repository" "$commit" "${bundles[@]}")"; then
        fail "$tag bundle: $refused ($(jq -r '.workspace.bundle.key' "$manifest"))"
        chain_ok=0
      fi
      rm -rf "$repository"
    fi
    [ "${#bundles[@]}" -eq 0 ] || rm -f "${bundles[@]}"
    [ "$chain_ok" = 1 ] || ok=0
  fi
  if [ "$ok" = 1 ]; then
    PASSED=$((PASSED + 1))
    printf 'PASS %s (%s)\n' "$tag" "$expected"
  fi
done <<< "$ROWS_TEXT"

# The restored store must still refuse to replace an object: a scratch key is
# written once, then again with If-None-Match, which has to fail with 412.
if object_store "$PROJECT" "$BUCKET" create-only-check; then
  echo "PASS create-only write refused on $BUCKET (If-None-Match)"
else
  fail "create-only write was not refused on $BUCKET"
fi

# The restored API's own answer, in `locked` mode: the bucket check it runs
# at startup, then a restore plan for every pointer, each plan's versions
# read back and found held (scripts/lib/checkpoint-pins-cli.ts).
PLAN_STATUS=0
PLAN_OUTPUT="$(checkpoint_pins "$PROJECT" "$BUCKET" plans ${PLANS_ARGS[@]+"${PLANS_ARGS[@]}"})" || PLAN_STATUS=$?
[ -z "$PLAN_OUTPUT" ] || printf '%s\n' "$PLAN_OUTPUT"
PLAN_FAILS="$(printf '%s\n' "$PLAN_OUTPUT" | grep -c '^FAIL' || true)"
FAILED=$((FAILED + PLAN_FAILS))
# 5 is the check's own verdict, already counted line by line; anything else
# nonzero means it stopped partway, whatever it printed before.
if [ "$PLAN_STATUS" -ne 0 ] && { [ "$PLAN_STATUS" -ne "$EXIT_VERIFY_FAILED" ] || [ "$PLAN_FAILS" -eq 0 ]; }; then
  fail "restore plan check exited $PLAN_STATUS before finishing"
fi

[ -n "$IMAGE" ] || echo "SKIP restore plans against the worker image that will resume them — pass --image"
# Both need a running stack, not just the restored stores; the e2e runs them.
echo "SKIP resume continues the same native session — tests/e2e/restore-resume.sh (94S-324)"
echo "SKIP worker image digest matches manifest.json images.worker — tests/e2e/restore-resume.sh (94S-324)"
echo "checkpoints=$ROWS passed=$PASSED failed=$FAILED"
[ "$ROWS" -gt 0 ] || log "verify: warning — no checkpoint rows in project '$PROJECT'; nothing was compared"
[ "$FAILED" -eq 0 ] || exit "$EXIT_VERIFY_FAILED"
