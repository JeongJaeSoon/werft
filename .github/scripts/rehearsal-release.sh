#!/usr/bin/env bash
# Reads a published release the way an outside operator does, with no login and
# no token: `rehearsal-release.sh <tag|latest> <out-dir> [control-host-digest]`.
# Writes <out-dir>/release-manifest.json and prints `tag=` and `commit=` lines.
#
# The optional digest replaces the control-host image's digest. The rehearsal's
# failure check uses it to name an image that does not exist, so the pull step
# has to fail.
set -euo pipefail

tag="$1"
out="$2"
override="${3:-}"
repo="${REHEARSAL_REPOSITORY:?REHEARSAL_REPOSITORY is owner/repo}"

[[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo "bad repository: $repo" >&2; exit 1; }
if [ "$tag" = latest ]; then
  # The redirect names the newest release; the REST API would need a token
  # to stay clear of its anonymous rate limit.
  final="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${repo}/releases/latest")"
  tag="${final##*/}"
fi
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "not a release tag: $tag" >&2; exit 1; }
if [ -n "$override" ]; then
  [[ "$override" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "not a digest: $override" >&2; exit 1; }
fi

mkdir -p "$out"
curl -fsSLo "$out/release-manifest.json" \
  "https://github.com/${repo}/releases/download/${tag}/release-manifest.json"

jq -e --arg tag "$tag" '.tag == $tag and (.commit | test("^[0-9a-f]{40}$")) and .chart.version and .images["control-host"].digest' \
  "$out/release-manifest.json" >/dev/null || { echo "release-manifest.json of $tag is not the expected shape" >&2; exit 1; }

if [ -n "$override" ]; then
  jq --arg d "$override" '.images["control-host"].digest = $d' "$out/release-manifest.json" >"$out/override.json"
  mv "$out/override.json" "$out/release-manifest.json"
  echo "control-host digest replaced by ${override}" >&2
fi

echo "tag=${tag}"
echo "commit=$(jq -r .commit "$out/release-manifest.json")"
