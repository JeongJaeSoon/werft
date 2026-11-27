#!/usr/bin/env bash
# The release steps of a main Images run (a push, or a manual retry), one subcommand each, in the
# order the jobs run them: `release-auto.sh detect|ci|main-chain|conformance|k8s-smoke|free|tag`.
#
#   detect  EVENT push: BEFORE and AFTER (the push's two commits): the one
#           CHANGELOG.md heading `## vX.Y.Z` that AFTER has and BEFORE lacks is
#           the release to make; none means an ordinary merge. Anything that is
#           not one clean new heading fails, and so does a release commit that
#           still holds changelog fragments (changelog.d/*.md other than
#           README.md): changelog-release.ts collects them into the heading.
#           EVENT workflow_dispatch (a retry of a release whose run failed):
#           AFTER's top `## vX.Y.Z` heading, unless its tag or its Release
#           already exists. Writes `tag=` to GITHUB_OUTPUT either way.
#   ci      waits for the ci.yml push run of GITHUB_SHA and requires success
#   main-chain  main's chain of GITHUB_SHA got through chart-publish-main:
#           EVENT push waits for this run's (GITHUB_RUN_ID), a retry reads the
#           push run of the commit (it promotes no main-<12> of its own)
#   conformance  a ci.yml push or manual run of GITHUB_SHA passed the
#           conformance suite on every engine (no pull request runs it)
#   k8s-smoke  a ci.yml push or manual run of GITHUB_SHA passed k8s-smoke, or
#           is the main push that skipped it for the PR run of its tree that
#           passed it. A main push plans it only for some commits (ci-plan.sh),
#           so a pushed v* tag and an sdk-v release hold their commit to it
#           here; none found stops the release, it is not run in its place
#   free    TAG has no tag ref and no Release (also run again right before tagging)
#   tag     creates the annotated tag TAG at GITHUB_SHA and reads it back
#
# env: GH_REPO, GH_TOKEN, GITHUB_SHA; TAG for free/tag; EVENT, AFTER and (push)
# BEFORE for detect;
# GITHUB_RUN_ID for tag and (push) main-chain; EVENT for main-chain.
# CI_WAIT_SECONDS (default 5400) bounds the wait in `ci`, MAIN_CHAIN_WAIT_SECONDS
# (default 3600) the one in `main-chain`; CI_POLL_SECONDS (default 60) is the
# poll interval of both. release-gate's timeout-minutes covers the two.
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
  local after="${AFTER:?}" top dup why intro
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
  # The oldest commit whose CHANGELOG.md diff has the heading line added it.
  intro="$(git log --format=%H --reverse -G "^## ${top//./\\.}\$" "$after" -- CHANGELOG.md | awk 'NR == 1')"
  [ -n "$intro" ] || fail "no commit before ${after} adds the ${top} heading"
  fragments_collected "$intro" "$after" "$top"
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
    fragments_collected "$after" "$after" "$added"
    tag="$added"
    TAG="$tag" free
  fi
}

fragment_names() {
  { git ls-tree --name-only "$1:changelog.d" 2>/dev/null || true; } | { grep -vxF README.md || true; } | sort
}

# A fragment the commit adding a version heading ($1) held is an entry of that
# release missing from its section, unless the released commit ($2) no longer
# holds it (a later merge moved it into the section). A fragment added after $1
# belongs to the next release.
fragments_collected() {
  local left
  left="$(comm -12 <(fragment_names "$1") <(fragment_names "$2"))"
  [ -z "$left" ] \
    || fail "the commit that adds $3 still holds changelog fragments (changelog.d/: ${left//$'\n'/, }); a release pull request runs .github/scripts/changelog-release.ts $3, and a refused one moves them into the $3 section"
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
  local sha="${GITHUB_SHA:?}" id deadline line status conclusion run_status
  case "${EVENT:?}" in
    push) id="${GITHUB_RUN_ID:?}" ;;
    workflow_dispatch)
      id="$(gh api "repos/${repo}/actions/workflows/images.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=1" \
        --jq '.workflow_runs[0].id // empty')" || fail "could not read the Images push runs of ${sha}"
      [ -n "$id" ] || fail "no Images push run of ${sha}"
      ;;
    *) fail "no main chain is read for a ${EVENT} run" ;;
  esac
  deadline=$((SECONDS + ${MAIN_CHAIN_WAIT_SECONDS:-3600}))
  while :; do
    # A retry started right after the merge can find the push run still on
    # its way. Its status is read before its jobs: a run already completed
    # then has final jobs, and one not done there never ran.
    run_status=""
    if [ "$EVENT" = workflow_dispatch ]; then
      run_status="$(gh api "repos/${repo}/actions/runs/${id}" --jq .status)" \
        || fail "could not read Images run ${id}"
    fi
    line="$(gh api --paginate "repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100" \
      --jq '.jobs[] | select(.name == "chart-publish-main") | "\(.status) \(.conclusion // "none")"')" \
      || fail "could not read the jobs of Images run ${id}"
    read -r status conclusion <<<"$line"
    if [ "${status:-}" = completed ]; then
      [ "$conclusion" = success ] \
        || fail "chart-publish-main of Images run ${id} on ${sha} concluded ${conclusion}"
      echo "main chain: chart-publish-main passed in Images run ${id}"
      return 0
    fi
    [ "$run_status" != completed ] \
      || fail "chart-publish-main of the ended Images run ${id} on ${sha} is ${status:-absent}, not completed"
    [ "$SECONDS" -lt "$deadline" ] \
      || fail "chart-publish-main of Images run ${id} is still ${status:-absent} after ${MAIN_CHAIN_WAIT_SECONDS:-3600}s"
    sleep "${CI_POLL_SECONDS:-60}"
  done
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

# The pass is the smoke step itself, not the job: a job can end green
# without it. ci.yml's `changes` runs its reuse step only when ci-reuse.sh
# found that same step passed in the PR run of this tree. Every attempt is
# read, as check-agent-sdk-compat-job.sh does: a rerun of another job alone
# leaves an attempt without these jobs. Each job is judged by its newest
# attempt, so a rerun of k8s-smoke that failed is no pass. Pages of 30: a
# jobs page carries every step, and pages of 100 often come back as a 502.
k8s_smoke() {
  local sha="${GITHUB_SHA:?}" ids id lines conclusion passed
  ids="$(gh api "repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=completed&per_page=100" \
    --jq "[.workflow_runs[] | select(.head_sha == \"${sha}\" and (.event == \"push\" or .event == \"workflow_dispatch\")) | .id] | sort | reverse | .[]")" \
    || fail "could not read the ci.yml runs of ${sha}"
  for id in $ids; do
    lines="$(gh api --paginate "repos/${repo}/actions/runs/${id}/jobs?filter=all&per_page=30" \
      --jq '.jobs[] | select(.name == "k8s-smoke" or .name == "changes")
        | (if .name == "k8s-smoke" then "deploy/kind/smoke.sh" else "k8s-smoke passed in the reused PR run" end) as $step
        | "\(.run_attempt) \(.name) \(.conclusion // "none") \(any(.steps[]?; .name == $step and .conclusion == "success"))"')" \
      || fail "could not read the jobs of ci.yml run ${id}"
    read -r _ _ conclusion passed <<<"$(awk '$2 == "k8s-smoke"' <<<"$lines" | sort -n | tail -n 1)"
    if [ "${conclusion:-}" = success ] && [ "${passed:-}" = true ]; then
      echo "k8s-smoke: passed in ci.yml run ${id}"
      return 0
    fi
    read -r _ _ conclusion passed <<<"$(awk '$2 == "changes"' <<<"$lines" | sort -n | tail -n 1)"
    if [ "${conclusion:-}" = success ] && [ "${passed:-}" = true ]; then
      echo "k8s-smoke: ci.yml run ${id} reused the pull request run of this tree that passed it"
      return 0
    fi
    echo "ci.yml run ${id} did not pass k8s-smoke"
  done
  fail "no ci.yml push or manual run of ${sha} passed k8s-smoke; run ci.yml by hand with only=k8s-smoke on a ref at ${sha} (gh workflow run ci.yml --ref <tag> -f only=k8s-smoke), then re-run the failed jobs"
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
  k8s-smoke) k8s_smoke ;;
  free) free ;;
  tag) tag ;;
  *)
    echo "usage: release-auto.sh detect|ci|main-chain|conformance|k8s-smoke|free|tag" >&2
    exit 2
    ;;
esac
