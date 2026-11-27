#!/usr/bin/env bash
# Joins a run's per-arch digests into one index per image:
# `image-index.sh <arch dir> <unverified dir> <staged dir>`.
#
# <arch dir> holds <app>-<arch>.json from the publish jobs, <unverified dir> the
# <app>.json lists from image-sources.sh. <staged dir> gets one <app>.json for
# image-promote.sh, whose `digest` is the index. The index goes to a staging tag
# and its digest is settled here, before promote: a promotion rerun copies the
# same digest instead of building an index the tag it already wrote would
# refuse.
#
# ghcr can answer `not found` for a tag `create` has just written. Only that
# answer is asked again, twice, each after a pause; the index is not rebuilt.
set -euo pipefail

arches="$1"
unverified="$2"
staged="$3"
tag="staging-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"

test "$(ls "$arches"/*.json | wc -l)" -eq 8

errors="$(mktemp)"
trap 'rm -f "${errors:?}"' EXIT

# Prints the digest of the index a tag names.
digest_of_new_tag() {
  local out status attempt
  for attempt in 1 2 3; do
    status=0
    out="$(docker buildx imagetools inspect "$1" --format '{{json .Manifest.Digest}}' 2>"$errors")" || status=$?
    if [ "$status" -eq 0 ]; then
      cat "$errors" >&2
      printf '%s\n' "${out//\"/}"
      return 0
    fi
    grep -Fxq "ERROR: $1: not found" "$errors" || break
    [ "$attempt" != 3 ] || break
    echo "::warning::the registry did not find $1, which this run had just written; asking again (try ${attempt} of 3)" >&2
    sleep "${IMAGE_INDEX_RETRY_SECONDS:-10}"
  done
  cat "$errors" >&2
  return "$status"
}

mkdir -p "$staged"
for app in control-host worker worker-codex egress-proxy; do
  amd64="${arches}/${app}-amd64.json"
  arm64="${arches}/${app}-arm64.json"
  list="${unverified}/${app}.json"
  for file in "$amd64" "$arm64" "$list"; do
    if [ ! -s "$file" ]; then
      echo "::error::${file} is missing"
      exit 1
    fi
  done
  for field in app image base commit ref releasedAt runtime; do
    if [ "$(jq -cS ".${field}" "$amd64")" != "$(jq -cS ".${field}" "$arm64")" ]; then
      echo "::error::${app}: amd64 and arm64 differ in ${field}"
      exit 1
    fi
  done

  name="$(jq -r .image "$amd64")"
  amd64_digest="$(jq -r .digest "$amd64")"
  arm64_digest="$(jq -r .digest "$arm64")"
  docker buildx imagetools create -t "${name}:${tag}" \
    "${name}@${amd64_digest}" "${name}@${arm64_digest}"
  digest="$(digest_of_new_tag "${name}:${tag}")"

  expected="linux/amd64 ${amd64_digest}
linux/arm64 ${arm64_digest}"
  actual="$(docker buildx imagetools inspect --raw "${name}@${digest}" |
    jq -r '.manifests[] | "\(.platform.os)/\(.platform.architecture) \(.digest)"' | sort)"
  if [ "$actual" != "$expected" ]; then
    echo "::error::${name}@${digest} names '${actual}', expected '${expected}'"
    exit 1
  fi

  jq -n --slurpfile amd64 "$amd64" --slurpfile arm64 "$arm64" \
    --slurpfile unverified "$list" --arg digest "$digest" \
    '$amd64[0] | del(.arch, .imageId) | .digest = $digest
      | .platforms = {
          amd64: {digest: $amd64[0].digest, imageId: $amd64[0].imageId},
          arm64: {digest: $arm64[0].digest, imageId: $arm64[0].imageId}}
      | .unverifiedSources = $unverified[0]' \
    | tee "${staged}/${app}.json"
done
