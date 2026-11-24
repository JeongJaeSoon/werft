#!/usr/bin/env bash
# Marks one GitHub Release "Latest": `release-latest.sh`, with GH_REPO and
# GH_TOKEN set (contents: write).
#
# It takes no tag. It reads every published release and marks the highest
# stable version (release-versions.ts), whichever release the run was for, so
# a later hotfix on an older line leaves the mark where it is. Because every
# run computes the same answer from what exists, a run of this step that never
# starts is covered by the next one. A lookup that fails is never taken for
# "no release".
set -euo pipefail

repo="${GH_REPO:?}"
here="$(cd "$(dirname "$0")" && pwd)"

# A draft is not published yet, and GitHub refuses the mark on a prerelease.
releases="$(gh api --paginate "repos/${repo}/releases?per_page=100" \
  --jq '.[] | select(.draft == false and .prerelease == false) | "\(.tag_name) \(.id)"')" || {
  echo "::error::could not list the releases of ${repo}" >&2
  exit 1
}
want="$(printf '%s\n' "$releases" | cut -d' ' -f1 | bun "${here}/release-versions.ts" latest)"
if [ -z "$want" ]; then
  echo "no stable release is published: nothing is marked Latest"
  exit 0
fi
id="$(printf '%s\n' "$releases" | awk -v tag="$want" '$1 == tag { print $2 }')"
if [ "$(printf '%s' "$id" | grep -c .)" -ne 1 ]; then
  echo "::error::${want} does not name exactly one published release" >&2
  exit 1
fi

gh api -X PATCH "repos/${repo}/releases/${id}" -f make_latest=true >/dev/null
now="$(gh api "repos/${repo}/releases/latest" --jq .tag_name)"
if [ "$now" != "$want" ]; then
  echo "::error::Latest is ${now}, expected ${want}" >&2
  exit 1
fi
echo "Latest is ${want}"
