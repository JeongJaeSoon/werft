#!/usr/bin/env bash
# Checks a request for an Actions preview (.github/workflows/preview.yml)
# before any of the pull request's code is checked out. The preview is open
# to the internet, so only an open pull request from a branch of this
# repository, started by someone with write access or above, gets one.
#
#   PR          the pull request number
#   MINUTES     how long the preview stays up (5 to 180)
#   STARTER     who started the run (github.triggering_actor)
#   RECIPIENT   optional: one more age or SSH public key to encrypt the demo
#               password to
#   RECIPIENTS  the file the age recipients are written to: STARTER's
#               ssh-ed25519 and ssh-rsa keys on GitHub, then RECIPIENT
#   LABEL_HEAD  label runs: the head the label was put on, which is the one
#               served even if the branch moved since; the label must still
#               be on the pull request (an event can arrive late)
#
# Writes head=<the sha to serve> to GITHUB_OUTPUT. Any refusal exits 1 with
# the reason as an ::error:: line.
set -euo pipefail

fail() {
  echo "::error::preview refused: $*"
  exit 1
}

repo="${GITHUB_REPOSITORY:?}"
[[ "${PR:-}" =~ ^[1-9][0-9]{0,6}$ ]] || fail "PR must be a pull request number, not '${PR:-}'"
if ! [[ "${MINUTES:-}" =~ ^[1-9][0-9]{0,2}$ ]] || [ "$MINUTES" -lt 5 ] || [ "$MINUTES" -gt 180 ]; then
  fail "minutes must be a whole number from 5 to 180, not '${MINUTES:-}'"
fi
[[ "${STARTER:-}" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || fail "'${STARTER:-}' is not a GitHub login"
if [ -n "${RECIPIENT:-}" ] &&
  ! [[ "$RECIPIENT" =~ ^(age1[a-z0-9]{58}|(ssh-ed25519|ssh-rsa)\ [A-Za-z0-9+/]+={0,2})$ ]]; then
  fail "recipient must be one age1… or ssh-ed25519/ssh-rsa public key without a comment"
fi

pull="$(gh api "repos/${repo}/pulls/${PR}")" || fail "cannot read pull request #${PR}"
head_repo="$(jq -r '.head.repo.full_name // ""' <<<"$pull")"
state="$(jq -r '.state' <<<"$pull")"
head="$(jq -r '.head.sha' <<<"$pull")"
[ "$head_repo" = "$repo" ] || fail "#${PR} comes from ${head_repo:-a deleted fork}, not a branch of ${repo}"
[ "$state" = open ] || fail "#${PR} is ${state}, not open"
if [ -n "${LABEL_HEAD:-}" ]; then
  jq -e '[.labels[].name] | index("preview")' <<<"$pull" >/dev/null ||
    fail "#${PR} no longer has the preview label"
  head="$LABEL_HEAD"
fi
[[ "$head" =~ ^[0-9a-f]{40}$ ]] || fail "#${PR} has no head sha"

# Labels take triage, which cannot push; write and above can change this
# workflow anyway, so nothing narrower would hold.
permission="$(gh api "repos/${repo}/collaborators/${STARTER}/permission" --jq .permission)" ||
  fail "cannot read ${STARTER}'s permission on ${repo}"
case "$permission" in
  admin | maintain | write) ;;
  *) fail "${STARTER} has ${permission:-no} access to ${repo}; a preview takes write or above" ;;
esac

# Only the keys age can encrypt to.
gh api "users/${STARTER}/keys" --jq '.[]["key"]' | grep -E '^(ssh-ed25519|ssh-rsa) ' >"${RECIPIENTS:?}" || true
[ -z "${RECIPIENT:-}" ] || printf '%s\n' "$RECIPIENT" >>"$RECIPIENTS"
[ -s "$RECIPIENTS" ] ||
  fail "${STARTER} has no ssh-ed25519 or ssh-rsa key on GitHub and the run names no recipient: nobody could read the demo password"

echo "preview of #${PR} at ${head} for ${MINUTES} minutes, started by ${STARTER} (${permission}); $(wc -l <"$RECIPIENTS" | tr -d ' ') recipients"
echo "head=${head}" >>"${GITHUB_OUTPUT:?}"
