#!/usr/bin/env bash
# Prints the issue body for one attempt of a push run on main that did not
# pass: the run, its commit, the pull request the commit came from and the
# jobs that failed.
#
# The attempt is the one whose completion is being reported. A rerun keeps the
# run id, so the run read by id alone may already be a later attempt, green or
# still going. The pull request and the job list are pointers for whoever reads
# the issue: a lookup that fails is said in the body instead of losing the
# report.
#
# usage: main-failure-body.sh <run-id> <attempt>
# env:   GH_REPO (owner/name), GH_TOKEN with actions:read and pull-requests:read

set -euo pipefail

usage="usage: main-failure-body.sh <run-id> <attempt>"
run_id=${1:?$usage}
attempt=${2:?$usage}
: "${GH_REPO:?GH_REPO must name the repository as owner/name}"

# One value a line: an empty one stays in its place. The URL is the run's;
# with /attempts/<n> it opens this attempt, not the latest.
{
  read -r name
  read -r conclusion
  read -r sha
  read -r url
} < <(
  gh api "repos/${GH_REPO}/actions/runs/${run_id}/attempts/${attempt}" \
    --jq '.name, .conclusion, .head_sha, .html_url'
)

jobs=$(gh api "repos/${GH_REPO}/actions/runs/${run_id}/attempts/${attempt}/jobs?per_page=100" \
  --paginate \
  --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | "- [\(.name)](\(.html_url))"') ||
  jobs="- could not be read"

pulls=$(gh api "repos/${GH_REPO}/commits/${sha}/pulls" \
  --jq '[.[] | "#\(.number)"] | join(", ")') || pulls="could not be read"

echo "<!-- ci-main-failure -->"
echo "\`${name}\` ended \`${conclusion}\` on main @ \`${sha}\` ([run ${run_id}, attempt ${attempt}](${url}/attempts/${attempt}))."
echo
echo "Pull request of the commit: ${pulls:-none found}"
echo
echo "Failed jobs:"
echo "${jobs:-- none listed; the run failed before or outside its jobs}"
echo
echo "Nothing is reverted. A rerun that passes does not close this issue: close it once the failure is understood, and the next failure opens a new one."
