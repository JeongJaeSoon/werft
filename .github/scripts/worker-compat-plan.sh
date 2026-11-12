#!/usr/bin/env bash
# The old image sets the worker compatibility job runs against
# (docs/contributing/decisions/worker-compat.md § 4.1). Appends to
# GITHUB_OUTPUT:
#
#   olds=[{name, commit, control_host, worker, worker_codex, egress_proxy}]
#   baseline_ref=<the newest release among them, or empty>
#
# OLD (a dispatch) names one set: a release tag, or main-<12 hex> for main's
# images of that commit. Without it the set is the SUPPORT_WINDOW newest
# published releases other than RELEASE_TAG (the one being made), less any
# built before FLOOR_COMMIT, the oldest commit the window promises to serve.
# An empty window is a pass, said in a warning and the step summary.
set -euo pipefail

: "${SUPPORT_WINDOW:?}" "${FLOOR_COMMIT:?}" "${GH_REPO:?}" "${GITHUB_OUTPUT:?}"
old="${OLD:-}"
release_tag="${RELEASE_TAG:-}"
owner="$(printf '%s' "${GH_REPO%%/*}" | tr '[:upper:]' '[:lower:]')"
prefix="ghcr.io/${owner}/werft"

# The decision record, the matrix and the runner assume one old release.
if [ "$SUPPORT_WINDOW" != 1 ]; then
  echo "::error::SUPPORT_WINDOW is ${SUPPORT_WINDOW}; the compatibility job and docs/contributing/decisions/worker-compat.md are written for 1. Change them together."
  exit 1
fi

emit() {
  echo "olds=$1" >>"$GITHUB_OUTPUT"
  echo "baseline_ref=$2" >>"$GITHUB_OUTPUT"
  echo "$1" | jq .
}

skip() {
  echo "::warning::worker compatibility skipped: $1"
  {
    echo "### Worker compatibility: no release in the support window"
    echo
    echo "$1"
  } >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
  emit '[]' ''
  exit 0
}

# One set from a release's manifest, as an operator would read it.
from_release() {
  local tag="$1" dir
  dir="$(mktemp -d)"
  REHEARSAL_REPOSITORY="$GH_REPO" .github/scripts/rehearsal-release.sh "$tag" "$dir" >/dev/null
  jq -c --arg name "$tag" '{
      name: $name,
      commit: .commit,
      control_host: (.images["control-host"] | "\(.image)@\(.digest)"),
      worker: (.images.worker | "\(.image)@\(.digest)"),
      worker_codex: (.images["worker-codex"] // null | if . then "\(.image)@\(.digest)" else "" end),
      egress_proxy: (.images["egress-proxy"] | "\(.image)@\(.digest)")
    }' "$dir/release-manifest.json"
}

if [ -n "$old" ]; then
  case "$old" in
    v[0-9]*)
      set_json="$(from_release "$old")"
      emit "[${set_json}]" "$old" ;;
    main-[0-9a-f]*)
      short="${old#main-}"
      [[ "$short" =~ ^[0-9a-f]{12}$ ]] || { echo "::error::main-<12 hex>, not ${old}"; exit 1; }
      commit="$(git rev-parse --verify "${short}^{commit}")"
      emit "$(jq -nc --arg name "$old" --arg commit "$commit" --arg p "$prefix" --arg t "$old" '[{
          name: $name, commit: $commit,
          control_host: "\($p)-control-host:\($t)",
          worker: "\($p)-worker:\($t)",
          worker_codex: "\($p)-worker-codex:\($t)",
          egress_proxy: "\($p)-egress-proxy:\($t)"
        }]')" "" ;;
    *) echo "::error::OLD is a release tag or main-<12 hex>, not ${old}"; exit 1 ;;
  esac
  exit 0
fi

# A failed lookup must fail the gate, not read as an empty window.
releases="$(gh release list --exclude-drafts --exclude-pre-releases --limit 50 \
  --json tagName,publishedAt --jq 'sort_by(.publishedAt) | reverse | .[].tagName')"
newest="$(grep -vxF "${release_tag:-//none//}" <<<"$releases" | head -n "$SUPPORT_WINDOW" || true)"
[ -n "$newest" ] || skip "no published release${release_tag:+ other than ${release_tag}}."
set_json="$(from_release "$newest")"
commit="$(jq -r '.commit' <<<"$set_json")"
status=0
git merge-base --is-ancestor "$FLOOR_COMMIT" "$commit" || status=$?
case "$status" in
  0) ;;
  1) skip "the newest release ${newest} (${commit}) was built before ${FLOOR_COMMIT}, the oldest commit the support window serves; its workers are outside the window." ;;
  *) echo "::error::cannot tell whether ${newest} (${commit}) contains ${FLOOR_COMMIT}"; exit 1 ;;
esac
emit "[${set_json}]" "$newest"
