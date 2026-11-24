#!/usr/bin/env bash
# Whether a main push may reuse the pull request CI run that already tested its
# exact tree, instead of running the same suites a second time.
#
# A squash merge of a branch that already contained main's previous tip has
# the branch head's tree. The PR run of that head tested the merge of the head
# into a main tip at least as old as that previous tip (main is linear), which
# is then the head's tree too. So the push's tree was tested, file for file.
# A branch merged behind main gets a tree nobody tested, and runs everything.
#
# Reuse is all or nothing for the integration domains, the product scenarios
# and the executable guides, which share the plan's flags. helm-chart,
# k8s-smoke and sdk-pack-smoke are judged one by one: a PR plan may leave
# k8s-smoke out where a main push keeps it, and then main still runs it.
# The conformance suite is not reused: no PR runs it, and ci.yml's `changes`
# plans it for a main push apart from this script.
# Evidence is the job's own test step having run and passed, not the job's
# conclusion: a skipped plan ends in a green job as well.
#
# Prints `key=value` lines for GITHUB_OUTPUT:
#   reused       the URL of the PR run reused, empty when nothing is
#   helm k8s sdk_pack   true when that job's PR result is reused
# and one line on stderr saying why. Any doubt (a lookup that fails, a push of
# more than one commit, a PR not found, a tree that differs) prints an empty
# `reused` and exits 0: falling back to the full plan is always safe. A
# malformed input exits 2.
#
# env: GH_REPO (owner/name), GH_TOKEN with actions:read and contents:read,
#      GITHUB_SHA (the pushed commit, checked out), BEFORE_SHA (the push's
#      before), and the plan: TESTS PRODUCT QUICKSTART HELM K8S SDK_PACK
#      DOMAINS (JSON array), DOCS_ONLY.
set -euo pipefail

: "${GH_REPO:?}" "${GITHUB_SHA:?}"
before=${BEFORE_SHA:-}
for flag in TESTS PRODUCT QUICKSTART HELM K8S SDK_PACK DOCS_ONLY; do
  case "${!flag:-}" in
    true | false) ;;
    *) echo "::error::ci-reuse.sh: $flag must be true or false" >&2; exit 2 ;;
  esac
done
domains=${DOMAINS:?}
jq -e 'type == "array" and all(.[]; type == "string")' <<<"$domains" >/dev/null \
  || { echo "::error::ci-reuse.sh: DOMAINS is not a JSON array of names" >&2; exit 2; }

none() {
  echo "ci-reuse: full plan: $*" >&2
  printf '%s\n' reused= helm=false k8s=false sdk_pack=false
  exit 0
}

[ "$DOCS_ONLY" = false ] || none "documentation-only push; nothing heavy to reuse"
[[ "$before" =~ ^[0-9a-f]{40}$ && ! "$before" =~ ^0+$ ]] || none "no previous commit in the push"
parents=$(git rev-list --parents -n 1 HEAD) || none "cannot read the pushed commit"
read -r head parent extra <<<"$parents"
[ "$head" = "$GITHUB_SHA" ] || none "the checkout is not the pushed commit"
[ -n "${parent:-}" ] && [ -z "${extra:-}" ] || none "the pushed commit is not a single-parent commit"
[ "$parent" = "$before" ] || none "the push carries more than one commit"

# The PR GitHub merged as this very commit.
pr=$(gh api "repos/${GH_REPO}/commits/${GITHUB_SHA}/pulls" \
  --jq "[.[] | select(.merge_commit_sha == \"${GITHUB_SHA}\" and .base.ref == \"main\")] | first | if . == null then \"\" else \"\(.number) \(.head.sha) \(.head.ref)\" end") \
  || none "could not look up the pull request"
read -r number pr_head pr_ref <<<"$pr"
[ -n "${number:-}" ] && [ -n "${pr_ref:-}" ] && [[ "${pr_head:-}" =~ ^[0-9a-f]{40}$ ]] || none "no pull request merged as this commit"

# The head contained main's previous tip, so every tip the PR runs merged
# into was an ancestor of the head, and the merge was the head's own tree.
status=$(gh api "repos/${GH_REPO}/compare/${before}...${pr_head}" --jq .status) \
  || none "could not compare the previous tip with the PR head"
case "$status" in
  ahead | identical) ;;
  *) none "PR #${number} was ${status} of main when merged; its merge tree was never tested" ;;
esac
git fetch --no-tags --depth=1 origin "$pr_head" 2>/dev/null || none "could not fetch the PR head"
[ "$(git rev-parse "${pr_head}^{tree}")" = "$(git rev-parse 'HEAD^{tree}')" ] \
  || none "the pushed tree differs from PR #${number}'s head"

# The latest successful pull_request run of ci.yml on that head and branch.
# Not `.pull_requests`: GitHub empties it once the PR is merged.
run=$(gh api "repos/${GH_REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr_head}&per_page=100" \
  --jq "[.workflow_runs[] | select(.status == \"completed\" and .conclusion == \"success\" and .head_sha == \"${pr_head}\" and .head_branch == \"${pr_ref}\")] | sort_by(.id) | last | if . == null then \"\" else \"\(.id) \(.html_url)\" end") \
  || none "could not list the PR's CI runs"
read -r run_id run_url <<<"$run"
[ -n "${run_id:-}" ] || none "no successful CI run of PR #${number} on ${pr_head::12}"

jobs=$(gh api --paginate "repos/${GH_REPO}/actions/runs/${run_id}/jobs?filter=latest&per_page=100" \
  --jq '.jobs[] | {name, conclusion, steps: [.steps[]? | {name, conclusion}]}' | jq -s .) \
  || none "could not read the jobs of run ${run_id}"

# step_passed JOB STEP: that job's latest attempt ran STEP and it passed.
step_passed() {
  jq -e --arg job "$1" --arg step "$2" '
    [.[] | select(.name == $job)] | length == 1 and
    (.[0].conclusion == "success") and
    ([.[0].steps[] | select(.name == $step)] | length == 1 and .[0].conclusion == "success")
  ' <<<"$jobs" >/dev/null
}
job_passed() {
  jq -e --arg job "$1" '[.[] | select(.name == $job)] | length == 1 and .[0].conclusion == "success"' \
    <<<"$jobs" >/dev/null
}

core=true
missing=
need() { "$@" || { core=false; missing="${missing:+$missing, }${*:2}"; }; }
if [ "$TESTS" = true ]; then
  while IFS= read -r domain; do
    need step_passed "integration (${domain})" "Tests of this domain"
  done < <(jq -r '.[]' <<<"$domains")
  # A web-only plan runs the other unit tests as `check (<part>)` shards.
  if [ "$domains" = '["surface"]' ]; then
    parts=$(jq -r '[.[] | select((.name | startswith("check (")) and .name != "check (static)") | .name] | .[]' <<<"$jobs")
    [ -n "$parts" ] || { core=false; missing="${missing:+$missing, }check (<part>)"; }
    while IFS= read -r part; do
      [ -n "$part" ] && need step_passed "$part" "Tests of this part"
    done <<<"$parts"
  fi
fi
if [ "$PRODUCT" = true ]; then
  need step_passed e2e "Alpha path against the compose stack"
  need step_passed demo "Static build"
  need step_passed ui-pack "Install, type-check, build and render in an empty app"
  if jq -e 'index("docker") != null' <<<"$domains" >/dev/null; then
    need step_passed workspace-quota "Workspace suite against a quota-capable daemon"
  fi
fi
if [ "$QUICKSTART" = true ]; then
  need step_passed quickstart "docs/quickstart.md"
  need step_passed quickstart "reference/api-guide.mdx"
fi
[ "$core" = true ] || none "PR #${number}'s run ${run_id} did not run and pass: ${missing}"

helm=false k8s=false sdk_pack=false
[ "$HELM" = true ] && step_passed helm-chart kubeconform && helm=true
[ "$K8S" = true ] && step_passed k8s-smoke deploy/kind/smoke.sh && k8s=true
[ "$SDK_PACK" = true ] && step_passed sdk-pack-smoke "Install, type-check and run the sample in an empty project" && sdk_pack=true

echo "ci-reuse: PR #${number} run ${run_id} tested this tree; reusing it (helm=${helm} k8s=${k8s} sdk_pack=${sdk_pack})" >&2
printf '%s\n' "reused=${run_url}" "helm=${helm}" "k8s=${k8s}" "sdk_pack=${sdk_pack}"
