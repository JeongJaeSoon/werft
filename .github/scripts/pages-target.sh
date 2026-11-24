#!/usr/bin/env bash
# Picks the commit the Pages site is built from: `pages-target.sh`, in a full
# clone whose `origin` is the repository, with GH_REPO, GH_TOKEN (actions:
# read) and GITHUB_RUN_ID set. Writes `sha=` and `source=` to GITHUB_OUTPUT.
#
# There is one site, and the runs of pages.yml wait in one group where GitHub
# keeps a single waiting run and drops the rest. So a run does not deploy the
# ref it was started on. It deploys what the site should be now:
#   - the highest stable release tag on main (release-versions.ts), or
#   - the commit of the latest manual run on main, an urgent docs fix, while
#     that commit is newer on main than the release.
# Every run reads both from what exists (the tags, and the run list, which
# still holds a run that was dropped or cancelled), so whichever run survives
# ends in the same place: redeploying an old tag ends on the newest release, a
# tag pushed after a docs fix does not undo the fix, and a prerelease changes
# nothing.
set -euo pipefail

repo="${GH_REPO:?}"
here="$(cd "$(dirname "$0")" && pwd)"

fail() {
  echo "::error::$*" >&2
  exit 1
}

# 0 when commit $1 is $2 or an ancestor of it, 1 when not; any other answer
# from git is no answer.
is_ancestor() {
  local status=0
  git merge-base --is-ancestor "$1" "$2" 2>/dev/null || status=$?
  [ "$status" -le 1 ] || fail "could not compare $1 with $2"
  return "$status"
}

git fetch --quiet --force --tags origin "+refs/heads/main:refs/remotes/origin/main" \
  || fail "could not fetch main and the tags"

# A tag can point anywhere; only a commit on main was reviewed.
all="$(git tag --list 'v*')" || fail "could not list the tags"
tags=""
while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  commit="$(git rev-parse --verify --quiet "refs/tags/${tag}^{commit}")" \
    || fail "tag ${tag} names no commit"
  if is_ancestor "$commit" origin/main; then
    tags="${tags}${tag}"$'\n'
  else
    echo "${tag} is not on main: not a candidate"
  fi
done <<<"$all"

release="$(printf '%s' "$tags" | bun "${here}/release-versions.ts" latest)" \
  || fail "could not pick the highest release"
target=""
source=""
if [ -n "$release" ]; then
  target="$(git rev-parse --verify "refs/tags/${release}^{commit}")"
  source="$release"
fi

# The run list trails new runs by a moment. A docs fix this run replaced while
# both waited was started before this run, so the list is trusted only once it
# shows this run. (A run started after this one deploys for itself.)
run_id="${GITHUB_RUN_ID:?}"
[[ "$run_id" =~ ^[0-9]+$ ]] || fail "'${run_id}' is not a run id"
listed=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  listed="$(gh api "repos/${repo}/actions/workflows/pages.yml/runs?per_page=30" \
    --jq ".workflow_runs[] | select(.id == ${run_id}) | .id")" || fail "could not read the runs of pages.yml"
  [ -z "$listed" ] || break
  sleep "${PAGES_LIST_POLL_SECONDS:-5}"
done
[ -n "$listed" ] || fail "the run list does not show this run (${run_id}) yet, so it may not show a docs fix either"

# The newest manual run on main. Its commit is the docs fix someone asked for,
# whether or not that run got to deploy.
manual="$(gh api "repos/${repo}/actions/workflows/pages.yml/runs?event=workflow_dispatch&branch=main&per_page=1" \
  --jq '.workflow_runs[0].head_sha // ""')" || fail "could not read the manual runs of pages.yml"
own=""
# This run itself, should the list not show it yet.
if [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ] && [ "${GITHUB_REF:-}" = refs/heads/main ]; then
  own="${GITHUB_SHA:?}"
fi
for commit in $manual $own; do
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "'${commit}' is not a commit id"
  if ! git cat-file -e "${commit}^{commit}" 2>/dev/null || ! is_ancestor "$commit" origin/main; then
    echo "manual run commit ${commit} is not on main: not a candidate"
    continue
  fi
  # Newer on main than the choice so far. Two commits of which neither holds
  # the other leave the choice as it is.
  if [ -z "$target" ] || { [ "$commit" != "$target" ] && is_ancestor "$target" "$commit"; }; then
    target="$commit"
    source=main
  fi
done
[ -n "$target" ] || fail "no stable release tag on main and no manual run on main: nothing to deploy"

echo "the site is ${source} at ${target}; this run was started on ${GITHUB_REF:-an unknown ref}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "sha=${target}"
    echo "source=${source}"
  } >>"$GITHUB_OUTPUT"
fi
