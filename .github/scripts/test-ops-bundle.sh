#!/usr/bin/env bash
# The single-server release bundle: `test-ops-bundle.sh <tag> <release-manifest.json> <out dir>`
# writes werft-test-ops-<tag>.tar.gz and its .sha256 into <out dir>.
#
# The bundle carries the compose files, the scripts, the postgres init SQL the
# compose files mount and the release's own manifest, in the checkout's
# layout, so scripts/test-ops.sh runs from it unchanged. It holds no image:
# those are the digests the manifest names. Run from the repository root at
# the tag's commit. GNU tar and gzip make the archive byte-for-byte
# reproducible, which release-publish.sh relies on for a rerun.
set -euo pipefail

tag="$1"
manifest="$2"
out="$3"
name="werft-test-ops-${tag}"

# What a bundle holds beyond the migrations compose.core.yml mounts.
FILES=(
  scripts/test-ops.sh
  scripts/lib/backup-lib.sh
  scripts/lib/test-ops.ts
  infra/compose.core.yml
  infra/compose.localstack.yml
  infra/compose.test-ops.yml
  infra/compose.test-ops.localstack.yml
  infra/compose.test-ops.s3.yml
  infra/localstack/init/10-create-resources.sh
  infra/legacy-config/.gitkeep
  infra/test-ops.env.example
  infra/test-ops.release.example.json
)

tar --version 2>/dev/null | grep -q 'GNU tar' || { echo "::error::GNU tar is required" >&2; exit 1; }
jq -e '.tag and .commit and .images["control-host"].digest and .images.worker.digest and .images["worker-codex"].digest and .images["egress-proxy"].digest' "$manifest" >/dev/null \
  || { echo "::error::$manifest is not a release manifest" >&2; exit 1; }
test "$(jq -r .tag "$manifest")" = "$tag" || { echo "::error::$manifest is the manifest of $(jq -r .tag "$manifest"), not $tag" >&2; exit 1; }

# The migrations core mounts, read from core so the two cannot drift.
migrations=()
while IFS= read -r path; do migrations+=("$path"); done < <(
  sed -n 's|^ *- \.\./\(packages/db/migrations/[^:]*\):.*|\1|p' infra/compose.core.yml
)
test "${#migrations[@]}" -gt 0 || { echo "::error::compose.core.yml mounts no migration" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work:?}"' EXIT
stage="${work}/${name}"
for path in "${FILES[@]}" "${migrations[@]}"; do
  test -f "$path" || { echo "::error::$path is missing" >&2; exit 1; }
  mkdir -p "${stage}/$(dirname "$path")"
  cp "$path" "${stage}/${path}"
done
cp "$manifest" "${stage}/release-manifest.json"
jq -n --arg tag "$tag" --arg commit "$(jq -r .commit "$manifest")" '{tag: $tag, commit: $commit}' >"${stage}/BUNDLE"

(
  cd "$stage"
  find . -type f ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r file; do
    printf '%s  %s\n' "$(sha256sum "$file" | cut -d' ' -f1)" "$file"
  done >SHA256SUMS
)

mkdir -p "$out"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode='u=rwX,go=rX' \
  -C "$work" -cf - "$name" | gzip -n -9 >"${out}/${name}.tar.gz"
(cd "$out" && sha256sum "${name}.tar.gz" >"${name}.tar.gz.sha256")
echo "${out}/${name}.tar.gz"
