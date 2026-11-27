#!/usr/bin/env bash
# Prints the issue body for a push run on main that did not pass: the run, its
# commit, the pull request the commit came from and the jobs that failed.
#
# The jobs are those of the run's latest attempt. The pull request is a pointer
# for whoever reads the issue, so a lookup that fails is said in the body
# instead of losing the report.
#
# usage: main-failure-body.sh <run-id>
# env:   GH_REPO (owner/name), GH_TOKEN with actions:read and pull-requests:read

set -euo pipefail

run_id=${1:?usage: main-failure-body.sh <run-id>}
: "${GH_REPO:?GH_REPO must name the repository as owner/name}"

IFS=$'\t' read -r name conclusion sha attempt url < <(
  gh api "repos/${GH_REPO}/actions/runs/${run_id}" \
    --jq '[.name, .conclusion, .head_sha, .run_attempt, .html_url] | @tsv'
)
jobs=$(gh api "repos/${GH_REPO}/actions/runs/${run_id}/attempts/${attempt}/jobs?per_page=100" \
  --paginate \
  --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | "- [\(.name)](\(.html_url))"')

pulls=$(gh api "repos/${GH_REPO}/commits/${sha}/pulls" \
  --jq '[.[] | "#\(.number)"] | join(", ")') || pulls="could not be read"

echo "<!-- ci-main-failure -->"
echo "\`${name}\` ended \`${conclusion}\` on main @ \`${sha}\` ([run ${run_id}, attempt ${attempt}](${url}))."
echo
echo "Pull request of the commit: ${pulls:-none found}"
echo
echo "Failed jobs:"
echo "${jobs:-- none listed; the run failed before or outside its jobs}"
echo
echo "Nothing is reverted. A rerun that passes does not close this issue: close it once the failure is understood, and the next failure opens a new one."
