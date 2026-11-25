#!/usr/bin/env bash
# The release steps of a main Images run (a push, or a manual retry), one subcommand each, in the
# order the jobs run them: `release-auto.sh detect|ci|main-chain|conformance|free|tag`.
#
#   detect  EVENT push: BEFORE and AFTER (the push's two commits): the one
#           CHANGELOG.md heading `## vX.Y.Z` that AFTER has and BEFORE lacks is
#           the release to make; none means an ordinary merge. Anything that is
#           not one clean new heading fails.
#           EVENT workflow_dispatch (a retry of a release whose run failed):
#           AFTER's top `## vX.Y.Z` heading, unless its tag or its Release
#           already exists. Writes `tag=` to GITHUB_OUTPUT either way.
#   ci      waits for the ci.yml push run of GITHUB_SHA and requires success
#   main-chain  the Images push run of GITHUB_SHA got its main chain through
#           chart-publish-main (a retry promotes no main-<12> of its own)
#   conformance  a ci.yml push or manual run of GITHUB_SHA passed the
#           conformance suite on every engine (no pull request runs it)
#   free    TAG has no tag ref and no Release (also run again right before tagging)
#   tag     creates the annotated tag TAG at GITHUB_SHA and reads it back
#
# env: GH_REPO, GH_TOKEN, GITHUB_SHA; TAG for free/tag; EVENT, AFTER and (push)
# BEFORE for detect;
# GITHUB_RUN_ID for tag. CI_WAIT_SECONDS (default 5400) and CI_POLL_SECONDS
# (default 60) bound the wait in `ci`.
set -euo pipefail

repo="${GH_REPO:?}"

fail() {
  echo "::error::$*" >&2
  exit 1
}

# Semver less build metadata, as chart-package.ts reads a tag: no leading zeros
# in a numeric part, and `+` cannot go in the helm.sh/chart label.
number='(0|[1-9][0-9]*)'
prerelease="(${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
version_pattern="^v${number}\\.${number}\\.${number}(-${prerelease}(\\.${prerelease})*)?\$"

headings() {
  # A commit with no CHANGELOG.md has no headings; that is not an error.
  { git show "$1:CHANGELOG.md" 2>/dev/null || true; } | sed -n 's/^## \(v[^[:space:]]*\).*/\1/p'
}

# The checks a version heading passes before it is a release.
check_version() {
  local version="$1"
  [[ "$version" =~ $version_pattern ]] \
    || fail "'${version}' is not v<major>.<minor>.<patch>[-<prerelease>]"
  # Helm parses the numbers as uint64, and a label value must end in an
  # alphanumeric. Both fail only after the images are published, so refuse here.
  [[ ! "$version" =~ [0-9]{19} ]] || fail "'${version}' has a number of 19 or more digits"
  [[ "$version" =~ [0-9A-Za-z]$ ]] || fail "'${version}' must end in a letter or digit to be a chart label"
  # chart-package.ts rejects a helm.sh/chart label "werft-<version>" over 63
  # characters, and by then the images are published: refuse it here.
  [ "${#version}" -le 58 ] || fail "'${version}' is too long: the chart label werft-${version#v} would pass 63 characters"
}

detect() {
  case "${EVENT:?}" in
    push) detect_push ;;
    workflow_dispatch) detect_retry ;;
    *) fail "no release is read from a ${EVENT} run" ;;
  esac
  echo "release tag: ${tag:-none}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "tag=${tag}" >>"$GITHUB_OUTPUT"
  fi
}

# A manual run on main retries the top version heading when no run made it:
# a release whose checks failed has no tag, and the push that fixes it adds
# no heading. A version already tagged or released is not retried.
detect_retry() {
  local after="${AFTER:?}" top dup why
  [[ "$after" =~ ^[0-9a-f]{40}$ ]] || fail "'${after}' is not a commit"
  dup="$(headings "$after" | sort | uniq -d)"
  [ -z "$dup" ] || fail "CHANGELOG.md has more than one section for ${dup//$'\n'/, }"
  top="$(headings "$after" | head -n 1)"
  tag=""
  [ -n "$top" ] || return 0
  check_version "$top"
  why="$(taken "$top")"
  if [ -n "$why" ]; then
    echo "${top} is not retried: ${why}"
    return 0
  fi
  tag="$top"
}

detect_push() {
  local before="${BEFORE:?}" after="${AFTER:?}" old new gone dup
  [[ "$before" =~ ^[0-9a-f]{40}$ && "$after" =~ ^[0-9a-f]{40}$ ]] \
    || fail "the push range is not two commits: ${before}..${after}"
  [[ ! "$before" =~ ^0+$ ]] || fail "the push has no previous commit, so no release can be read from it"
  git cat-file -e "${before}^{commit}" 2>/dev/null || fail "commit ${before} is not in the checkout"
  # A rewritten history compares unrelated trees, and every old heading would look new.
  git merge-base --is-ancestor "$before" "$after" \
    || fail "${before} is not an ancestor of ${after}; the history was rewritten"

  old="$(headings "$before" | sort -u)"
  new="$(headings "$after" | sort -u)"
  dup="$(headings "$after" | sort | uniq -d)"
  [ -z "$dup" ] || fail "CHANGELOG.md has more than one section for ${dup//$'\n'/, }"
  added="$(comm -13 <(printf '%s\n' "$old") <(printf '%s\n' "$new") | sed '/^$/d')"
  gone="$(comm -23 <(printf '%s\n' "$old") <(printf '%s\n' "$new") | sed '/^$/d')"

  tag=""
  if [ -n "$added" ]; then
    [ "$(printf '%s\n' "$added" | wc -l)" -eq 1 ] \
      || fail "this push adds more than one version section: ${added//$'\n'/, }"
    [ -z "$gone" ] || fail "${added} appears where ${gone//$'\n'/, } was: a renamed section is not a release"
    check_version "$added"
    tag="$added"
    TAG="$tag" free
  fi
}

# Prints why the version $1 is taken, nothing when it is free. Only a
# confirmed 404 is an absent tag: a lookup that fails fails.
taken() {
  local tag="$1" out found
  if out="$(gh api "repos/${repo}/git/ref/tags/${tag}" 2>&1)"; then
    echo "tag ${tag} already exists; a version is never released twice"
    return 0
  fi
  case "$out" in
    *"HTTP 404"*) ;;
    *) fail "could not look up tag ${tag}: ${out}" ;;
  esac
  # A draft Release holds a tag name without a tag.
  found="$(gh api --paginate "repos/${repo}/releases?per_page=100" \
    --jq ".[] | select(.tag_name == \"${tag}\") | .id")" || fail "could not list releases"
  [ -z "$found" ] || echo "a Release for ${tag} already exists"
}

free() {
  local why
  why="$(taken "${TAG:?}")"
  [ -z "$why" ] || fail "$why"
}

ci() {
  local sha="${GITHUB_SHA:?}" deadline line status conclusion url
  deadline=$((SECONDS + ${CI_WAIT_SECONDS:-5400}))
  while :; do
    line="$(gh api "repos/${repo}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=1" \
      --jq '.workflow_runs[0] | "\(.status) \(.conclusion // "none") \(.html_url)"')" \
      || fail "could not read the ci.yml runs of ${sha}"
    read -r status conclusion url <<<"$line"
    if [ "$status" = completed ]; then
      [ "$conclusion" = success ] || fail "ci.yml on ${sha} concluded ${conclusion}: ${url}"
      echo "ci.yml: green (${url})"
      return 0
    fi
    [ "$SECONDS" -lt "$deadline" ] || fail "ci.yml on ${sha} is still ${status:-absent} after ${CI_WAIT_SECONDS:-5400}s"
    sleep "${CI_POLL_SECONDS:-60}"
  done
}

# A retry builds and stages its own images but promotes no main-<12>: that tag
# is the push run's, and a new build of it is refused (image-promote.sh). The
# push run's chain through chart-publish-main is what a release push waits for.
main_chain() {
  local sha="${GITHUB_SHA:?}" id conclusion
  id="$(gh api "repos/${repo}/actions/workflows/images.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=1" \
    --jq '.workflow_runs[0].id // empty')" || fail "could not read the Images push runs of ${sha}"
  [ -n "$id" ] || fail "no Images push run of ${sha}"
  conclusion="$(gh api --paginate "repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100" \
    --jq '.jobs[] | select(.name == "chart-publish-main") | .conclusion')" \
    || fail "could not read the jobs of Images run ${id}"
  [ "$conclusion" = success ] \
    || fail "chart-publish-main of the Images push run ${id} on ${sha} is ${conclusion:-absent}, not success"
  echo "main chain: chart-publish-main passed in Images run ${id}"
}

# The engines of ci.yml's conformance matrix; tests/release-auto.test.ts holds
# this list to it.
conformance_engines=(claude_agent_sdk codex_app_server two_engines)

conformance() {
  local sha="${GITHUB_SHA:?}" ids id passed engine missing
  # Not a pull_request run: it tests a merge of the head, not this commit.
  ids="$(gh api "repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=completed&per_page=100" \
    --jq "[.workflow_runs[] | select(.head_sha == \"${sha}\" and (.event == \"push\" or .event == \"workflow_dispatch\")) | .id] | sort | reverse | .[]")" \
    || fail "could not read the ci.yml runs of ${sha}"
  for id in $ids; do
    passed="$(gh api --paginate "repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100" \
      --jq '.jobs[] | select(.conclusion == "success") | .name')" \
      || fail "could not read the jobs of ci.yml run ${id}"
    missing=""
    for engine in "${conformance_engines[@]}"; do
      grep -qxF "conformance (${engine})" <<<"$passed" || missing="${missing:+${missing}, }${engine}"
    done
    if [ -z "$missing" ]; then
      echo "conformance: passed in ci.yml run ${id}"
      return 0
    fi
    echo "ci.yml run ${id} did not pass conformance on: ${missing}"
  done
  fail "no ci.yml push or manual run of ${sha} passed the conformance suite on every engine; run ci.yml by hand with only=conformance on it"
}

tag() {
  local tag="${TAG:?}" sha="${GITHUB_SHA:?}" run="${GITHUB_RUN_ID:?}" obj peeled message
  message="$(printf '%s\n\nCreated by the Images run %s after the release approval' "$tag" "$run")"
  if obj="$(gh api "repos/${repo}/git/ref/tags/${tag}" --jq .object.sha 2>/dev/null)"; then
    # Only this run's own earlier attempt counts as done; any other tag at the
    # same commit is a second release of the version.
    existing="$(gh api "repos/${repo}/git/tags/${obj}" --jq .message 2>/dev/null)" || existing=""
    [[ "$existing" == *"Images run ${run} "* ]] \
      || fail "tag ${tag} already exists and was not made by this run"
  else
    free
    obj="$(gh api -X POST "repos/${repo}/git/tags" \
      -f tag="$tag" -f message="$message" -f object="$sha" -f type=commit \
      -f "tagger[name]=github-actions[bot]" \
      -f "tagger[email]=41898282+github-actions[bot]@users.noreply.github.com" \
      --jq .sha)" || fail "could not create the tag object for ${tag}"
    # 422 means another run made the ref first: nothing is overwritten.
    gh api -X POST "repos/${repo}/git/refs" -f ref="refs/tags/${tag}" -f sha="$obj" >/dev/null \
      || fail "could not create refs/tags/${tag}"
  fi
  peeled="$(gh api "repos/${repo}/git/tags/${obj}" --jq .object.sha)" || fail "could not read tag ${tag} back"
  [ "$peeled" = "$sha" ] || fail "tag ${tag} points at ${peeled}, not the approved ${sha}"
  echo "tagged ${tag} at ${sha}"
}

case "${1:-}" in
  detect) detect ;;
  ci) ci ;;
  main-chain) main_chain ;;
  conformance) conformance ;;
  free) free ;;
  tag) tag ;;
  *)
    echo "usage: release-auto.sh detect|ci|main-chain|conformance|free|tag" >&2
    exit 2
    ;;
esac
