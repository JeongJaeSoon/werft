#!/usr/bin/env bash
# Picks the commit the Pages site is built from: `pages-target.sh`, in a full
# clone whose `origin` is the repository, with GH_REPO, GH_TOKEN (actions:
# read), GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT set. Writes `sha=` and
# `source=` to GITHUB_OUTPUT.
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

# The runs of pages.yml, newest first, as "<id> <attempt> <event> <branch>
# <commit>". The list trails new runs by a moment. A docs fix this run replaced
# while both waited was started before this attempt, so the list is trusted
# only once it shows this attempt. (A run started after it deploys for itself.)
run_id="${GITHUB_RUN_ID:?}"
attempt="${GITHUB_RUN_ATTEMPT:?}"
[[ "$run_id" =~ ^[0-9]+$ && "$attempt" =~ ^[0-9]+$ ]] || fail "'${run_id}' attempt '${attempt}' is not a run"
runs=""
listed=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  runs="$(gh api --paginate "repos/${repo}/actions/workflows/pages.yml/runs?per_page=100" \
    --jq '.workflow_runs[] | "\(.id) \(.run_attempt) \(.event) \(.head_branch) \(.head_sha)"')" \
    || fail "could not read the runs of pages.yml"
  # Here-strings, not pipes: a reader that stops early would fail the pipe.
  listed="$(awk -v id="$run_id" -v attempt="$attempt" '$1 == id && $2 >= attempt { print $1 }' <<<"$runs")"
  [ -z "$listed" ] || break
  sleep "${PAGES_LIST_POLL_SECONDS:-5}"
done
[ -n "$listed" ] || fail "the run list does not show this run (${run_id}, attempt ${attempt}) yet, so it may not show a docs fix either"
# The newest manual run on main, from the same answer. Its commit is the docs
# fix someone asked for, whether or not that run got to deploy.
manual="$(awk '$3 == "workflow_dispatch" && $4 == "main" && !seen { print $5; seen = 1 }' <<<"$runs")"

# After the list: main only moves forward, so every commit the list names on
# main is in this fetch.
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

if [ -n "$manual" ]; then
  [[ "$manual" =~ ^[0-9a-f]{40}$ ]] || fail "'${manual}' is not a commit id"
  if ! git cat-file -e "${manual}^{commit}" 2>/dev/null || ! is_ancestor "$manual" origin/main; then
    echo "manual run commit ${manual} is not on main: not a candidate"
  # Newer on main than the release. Two commits of which neither holds the
  # other leave the release.
  elif [ -z "$target" ] || { [ "$manual" != "$target" ] && is_ancestor "$target" "$manual"; }; then
    target="$manual"
    source=main
  fi
fi
[ -n "$target" ] || fail "no stable release tag on main and no manual run on main: nothing to deploy"

echo "the site is ${source} at ${target}; this run was started on ${GITHUB_REF:-an unknown ref}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "sha=${target}"
    echo "source=${source}"
  } >>"$GITHUB_OUTPUT"
fi
