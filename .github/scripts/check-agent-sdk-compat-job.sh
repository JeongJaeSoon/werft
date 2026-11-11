#!/usr/bin/env bash
# Judges the `agent-sdk-compat` job of one ci.yml run from outside that run.
#
# The issue step inside `agent-sdk-compat` cannot report the failures that stop it from
# running: a job timeout or a cancellation skips it, and a failed `gh` call in
# it stays hidden behind the job's continue-on-error. This reads the job's own
# conclusion instead, which continue-on-error does not turn into `success`.
#
# A failed job counts as already reported when a `ci-agent-sdk-compat-failure` issue,
# open or closed, carries the run's URL in its body or in one of its comments:
# the in-run step writes it there, and so does whoever reports it from here.
# Closing that issue therefore acknowledges the run, and a second look at the
# same run adds nothing. The identity is the run, not the attempt: a rerun is
# someone already looking at a run whose failure is on an issue, so a second
# failing attempt of it is not a signal nobody saw. The lookup reads the list endpoints, not search,
# which is indexed with a delay, and only what changed since the run was
# created, because no report of it can be older.
#
# Prints one line:
#   ok <conclusion>                 success or skipped
#   ok absent                       other jobs ran but none is `agent-sdk-compat`: the
#                                   workflow at that commit had no such job
#   pending <status>                the job has not finished; judge it later
#   reported <conclusion>           failed, and an issue already names the run
#   unreported <conclusion> <run-url> <head-sha>
# The conclusion is `missing` when a finished run has no jobs at all (a
# workflow that failed to start), which is no harness signal either. A renamed
# job would read as `absent` on every run; the tests pin the name.
# Exits 2, printing nothing, when GitHub could not be asked.
#
# usage: check-agent-sdk-compat-job.sh <run-id>
# env:   GH_REPO (owner/name), GH_TOKEN with actions:read and issues:read

set -euo pipefail

label=ci-agent-sdk-compat-failure

[ "$#" -eq 1 ] || {
  echo "usage: $0 <run-id>" >&2
  exit 2
}
run_id=$1
case "$run_id" in
'' | *[!0-9]*)
  echo "run id must be a number: ${run_id}" >&2
  exit 2
  ;;
esac
: "${GH_REPO:?GH_REPO must name the repository as owner/name}"

api_failed() {
  echo "GitHub API call failed: $1" >&2
  exit 2
}

# GitHub answers a slow listing with a 502 instead of a slow page, and one
# such answer used to fail the whole scheduled check (four of five runs on
# 2026-11-09..11). A failed call is asked again a few times before it counts;
# a call that keeps failing still ends in api_failed. Only the attempt that
# succeeded is printed, so a paginated call that failed on a later page does
# not leave its earlier pages behind twice.
gh_api() {
  local attempt=1 delay=${GH_RETRY_DELAY:-5} out
  while ! out=$(gh api "$@"); do
    [ "$attempt" -lt 3 ] || return 1
    echo "gh api $1 failed (attempt ${attempt}); retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
  printf '%s\n' "$out"
}

run=$(gh_api "repos/${GH_REPO}/actions/runs/${run_id}" \
  --jq '"\(.status) \(.created_at) \(.html_url) \(.head_sha)"') ||
  api_failed "runs/${run_id}"
read -r run_status created_at run_url head_sha <<<"$run"

# Every attempt, not only the latest (`filter=latest`, the default): a rerun
# of some other job alone leaves an attempt without `agent-sdk-compat`, which
# would read as `absent` and bury the failure before it. The newest attempt that
# ran `agent-sdk-compat` is the one judged, so a rerun of it that passed clears
# the failure. One `jobs <n>` line per page, then a line per attempt of the job.
# Pages of 30: a jobs page carries every step of every job, and 100 of them
# (a run rerun twice has about 84 jobs) took 8-10s and often came back as a
# 502; 30 take about 1.3s.
jobs=$(gh_api "repos/${GH_REPO}/actions/runs/${run_id}/jobs?filter=all&per_page=30" --paginate \
  --jq '"jobs \(.jobs | length)", (.jobs[] | select(.name == "agent-sdk-compat") | "agent-sdk-compat \(.run_attempt) \(.status) \(.conclusion)")') ||
  api_failed "runs/${run_id}/jobs"
job=$(awk '$1 == "agent-sdk-compat" { print $2, $3, $4 }' <<<"$jobs" | sort -n | tail -n 1 | cut -d' ' -f2-)
job_count=$(awk '$1 == "jobs" { n += $2 } END { print n + 0 }' <<<"$jobs")

if [ -z "$job" ]; then
  if [ "$run_status" != completed ]; then
    echo "pending ${run_status}"
    exit 0
  fi
  if [ "$job_count" -gt 0 ]; then
    echo "ok absent"
    exit 0
  fi
  conclusion=missing
else
  read -r job_status conclusion <<<"$job"
  if [ "$job_status" != completed ]; then
    echo "pending ${job_status}"
    exit 0
  fi
  case "$conclusion" in
  success | skipped)
    echo "ok ${conclusion}"
    exit 0
    ;;
  esac
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# Pages land as one JSON array after another; jq --slurpfile reads them all.
# Files rather than arguments: a page of comment bodies can outgrow the
# per-argument limit.
gh_api "repos/${GH_REPO}/issues?labels=${label}&state=all&since=${created_at}&per_page=100" \
  --paginate >"$scratch/issues" || api_failed "issues labelled ${label}"
gh_api "repos/${GH_REPO}/issues/comments?since=${created_at}&per_page=100" \
  --paginate >"$scratch/comments" || api_failed "issue comments since ${created_at}"

# The id must end where the URL's digits end: run 123 is not run 1234.
# Comments count only on the labelled issues, so a person quoting the run
# anywhere else does not silence it.
named=$(jq -n --slurpfile issues "$scratch/issues" \
  --slurpfile comments "$scratch/comments" \
  --arg pattern "/actions/runs/${run_id}([^0-9]|$)" '
  [$issues[][]] as $labelled
  | [$labelled[].url] as $urls
  | [($labelled[].body // ""),
     ($comments[][] | select(.issue_url | IN($urls[])) | .body // "")]
  | any(test($pattern))')

if [ "$named" = true ]; then
  echo "reported ${conclusion}"
else
  echo "unreported ${conclusion} ${run_url} ${head_sha}"
fi
