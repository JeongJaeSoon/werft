#!/usr/bin/env bash
# Whether a main push may leave out test-ops-bundle because the pull request
# Images run of its exact tree already built the bundle twice and ran it.
#
# The proof is ci-reuse.sh's: a squash merge of a head that contained main's
# previous tip has the head's tree, and the PR run tested that tree. Evidence
# is the job's own steps having run and passed in the latest successful
# pull_request run of images.yml on that head: a PR whose plan left the
# bundle out proves nothing, and main builds it.
#
# Prints `reused=<run URL>` for GITHUB_OUTPUT, empty when nothing is, and one
# line on stderr saying why. Any doubt prints an empty `reused` and exits 0:
# building the bundle is always safe.
#
# env: GH_REPO (owner/name), GH_TOKEN with actions:read and contents:read,
#      GITHUB_SHA (the pushed commit, checked out), BEFORE_SHA (the push's before).
set -euo pipefail

: "${GH_REPO:?}" "${GITHUB_SHA:?}"
before=${BEFORE_SHA:-}

none() {
  echo "images-reuse: test-ops-bundle runs: $*" >&2
  echo reused=
  exit 0
}

[[ "$before" =~ ^[0-9a-f]{40}$ && ! "$before" =~ ^0+$ ]] || none "no previous commit in the push"
parents=$(git rev-list --parents -n 1 HEAD) || none "cannot read the pushed commit"
read -r head parent extra <<<"$parents"
[ "$head" = "$GITHUB_SHA" ] || none "the checkout is not the pushed commit"
[ -n "${parent:-}" ] && [ -z "${extra:-}" ] || none "the pushed commit is not a single-parent commit"
[ "$parent" = "$before" ] || none "the push carries more than one commit"

pr=$(gh api "repos/${GH_REPO}/commits/${GITHUB_SHA}/pulls" \
  --jq "[.[] | select(.merge_commit_sha == \"${GITHUB_SHA}\" and .base.ref == \"main\")] | first | if . == null then \"\" else \"\(.number) \(.head.sha) \(.head.ref)\" end") \
  || none "could not look up the pull request"
read -r number pr_head pr_ref <<<"$pr"
[ -n "${number:-}" ] && [ -n "${pr_ref:-}" ] && [[ "${pr_head:-}" =~ ^[0-9a-f]{40}$ ]] || none "no pull request merged as this commit"

status=$(gh api "repos/${GH_REPO}/compare/${before}...${pr_head}" --jq .status) \
  || none "could not compare the previous tip with the PR head"
case "$status" in
  ahead | identical) ;;
  *) none "PR #${number} was ${status} of main when merged; its merge tree was never tested" ;;
esac
git fetch --no-tags --depth=1 origin "$pr_head" 2>/dev/null || none "could not fetch the PR head"
[ "$(git rev-parse "${pr_head}^{tree}")" = "$(git rev-parse 'HEAD^{tree}')" ] \
  || none "the pushed tree differs from PR #${number}'s head"

run=$(gh api "repos/${GH_REPO}/actions/workflows/images.yml/runs?event=pull_request&head_sha=${pr_head}&per_page=100" \
  --jq "[.workflow_runs[] | select(.status == \"completed\" and .conclusion == \"success\" and .head_sha == \"${pr_head}\" and .head_branch == \"${pr_ref}\")] | sort_by(.id) | last | if . == null then \"\" else \"\(.id) \(.html_url)\" end") \
  || none "could not list the PR's Images runs"
read -r run_id run_url <<<"$run"
[ -n "${run_id:-}" ] || none "no successful Images run of PR #${number} on ${pr_head::12}"

jobs=$(gh api --paginate "repos/${GH_REPO}/actions/runs/${run_id}/jobs?filter=latest&per_page=100" \
  --jq '.jobs[] | {name, conclusion, steps: [.steps[]? | {name, conclusion}]}' | jq -s .) \
  || none "could not read the jobs of run ${run_id}"

jq -e '
  [.[] | select(.name == "test-ops-bundle")] | length == 1 and (.[0].conclusion == "success") and
  ([.[0].steps[] | select(
    (.name == "Build the bundle twice" or .name == "Run the bundle'"'"'s scripts without a checkout")
    and .conclusion == "success")] | length == 2)
' <<<"$jobs" >/dev/null || none "PR #${number}'s Images run ${run_id} did not build and run the bundle"

echo "images-reuse: PR #${number} Images run ${run_id} built and ran the bundle of this tree; reusing it" >&2
echo "reused=${run_url}"
