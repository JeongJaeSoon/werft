#!/usr/bin/env bash
# Turns the staged digests of a main push into the staged digests of its
# release: `release-stage.sh <main staged dir> <release unverified dir> <out dir>`
# with RELEASE_REF=refs/tags/vX.
#
# The release carries the digests main already built, smoked, scanned and
# staged, so what was scanned is what ships. Only what a release must say
# differently changes: `ref` becomes the tag ref (release-manifest.ts requires
# an image to be published from the ref it releases), the original ref is kept
# as `buildRef`, and `unverifiedSources` is the strict list of this release,
# not the lenient one main allows.
set -euo pipefail

staged="$1"
unverified="$2"
out="$3"
release_ref="${RELEASE_REF:?}"
case "$release_ref" in refs/tags/v*) ;; *)
  echo "::error::RELEASE_REF must be a refs/tags/v* ref, not ${release_ref}" >&2
  exit 1
  ;;
esac

test "$(ls "$staged"/*.json | wc -l)" -eq 4
mkdir -p "$out"
for app in control-host worker worker-codex egress-proxy; do
  for file in "${staged}/${app}.json" "${unverified}/${app}.json"; do
    if [ ! -s "$file" ]; then
      echo "::error::${file} is missing" >&2
      exit 1
    fi
  done
  # Staged by main, not by a tag: a record that already names a tag is not ours.
  jq -e '.ref == "refs/heads/main" and (.digest | test("^sha256:[0-9a-f]{64}$"))' \
    "${staged}/${app}.json" >/dev/null \
    || { echo "::error::${app} was not staged by a main push" >&2; exit 1; }
  jq --arg ref "$release_ref" --slurpfile unverified "${unverified}/${app}.json" \
    '.buildRef = .ref | .ref = $ref | .unverifiedSources = $unverified[0]' \
    "${staged}/${app}.json" >"${out}/${app}.json"
done
