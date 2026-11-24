#!/usr/bin/env bash
# The release steps of the main-push Images run, one subcommand each, in the
# order the jobs run them: `release-auto.sh detect|ci|conformance|free|tag`.
#
#   detect  BEFORE and AFTER (the push's two commits): the one CHANGELOG.md
#           heading `## vX.Y.Z` that AFTER has and BEFORE lacks is the release
#           to make; none means an ordinary merge. Writes `tag=` to
#           GITHUB_OUTPUT. Anything that is not one clean new heading fails.
#   ci      waits for the ci.yml push run of GITHUB_SHA and requires success
#   conformance  a ci.yml push or manual run of GITHUB_SHA passed the
#           conformance suite on every engine (no pull request runs it)
#   free    TAG has no tag ref and no Release (also run again right before tagging)
#   tag     creates the annotated tag TAG at GITHUB_SHA and reads it back
#
# env: GH_REPO, GH_TOKEN, GITHUB_SHA; TAG for free/tag; BEFORE/AFTER for detect;
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

detect() {
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
    [[ "$added" =~ $version_pattern ]] \
      || fail "'${added}' is not v<major>.<minor>.<patch>[-<prerelease>]"
    # Helm parses the numbers as uint64, and a label value must end in an
    # alphanumeric. Both fail only after the images are published, so refuse here.
    [[ ! "$added" =~ [0-9]{19} ]] || fail "'${added}' has a number of 19 or more digits"
    [[ "$added" =~ [0-9A-Za-z]$ ]] || fail "'${added}' must end in a letter or digit to be a chart label"
    # chart-package.ts rejects a helm.sh/chart label "werft-<version>" over 63
    # characters, and by then the images are published: refuse it here.
    [ "${#added}" -le 58 ] || fail "'${added}' is too long: the chart label werft-${added#v} would pass 63 characters"
    tag="$added"
    TAG="$tag" free
  fi
  echo "release tag: ${tag:-none}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "tag=${tag}" >>"$GITHUB_OUTPUT"
  fi
}

free() {
  local tag="${TAG:?}" out found
  if out="$(gh api "repos/${repo}/git/ref/tags/${tag}" 2>&1)"; then
    fail "tag ${tag} already exists; a version is never released twice"
  fi
  case "$out" in
    *"HTTP 404"*) ;;
    *) fail "could not look up tag ${tag}: ${out}" ;;
  esac
  # A draft Release holds a tag name without a tag.
  found="$(gh api --paginate "repos/${repo}/releases?per_page=100" \
    --jq ".[] | select(.tag_name == \"${tag}\") | .id")" || fail "could not list releases"
  [ -z "$found" ] || fail "a Release for ${tag} already exists"
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
  conformance) conformance ;;
  free) free ;;
  tag) tag ;;
  *)
    echo "usage: release-auto.sh detect|ci|conformance|free|tag" >&2
    exit 2
    ;;
esac
