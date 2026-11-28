#!/usr/bin/env bash
# Prints `to=<cache-to>` for GITHUB_OUTPUT: what a trusted image build writes to
# the buildkit layer cache of scope images-<APP>-<ARCH>.
#
# A build writes it until the ref has an entry made that UTC day that counts
# (the two rules below); later builds that day only read it. Every write stores the release stage again, and its
# `COPY --from=pruned /app` layer (about 190 MB for worker and worker-codex)
# changes with every commit, so a write per main push filled the 10 GB
# repository cache with layers nothing reads again. The layers later builds
# reuse (apt upgrade, git-lfs, gh, git hooks) change with the Dockerfiles'
# APT_UPGRADE_KEY, the UTC date, so one write a day keeps them warm.
#
# The day's entry is also written again after the image's Dockerfile or
# fetch-pinned.ts changed: with mode=min a later build reuses the Go build
# stages from this cache only through the release layers copied from them, so
# after a pin change a build that has no result of its own compiles them until an
# entry holds the new pins.
#
# An entry written before 00:30Z may come from a build that started the day
# before, with that day's APT_UPGRADE_KEY, so it does not count as today's.
# For the same reason an entry written less than 30 minutes after an input
# change may come from a build of the commit before it, and does not count.
# A shallow checkout cannot date that change and skips the input rule.
# A main build whose inputs differ from origin/main's (queued behind a pin
# change, or a rerun) never writes: its entry would pass for a current one.
# publish-main fetches origin/main before this step; a shallow checkout fetches
# it here. A build that fetched before the change ends within its job timeout
# (publish-main 20 minutes), so while the commit time is close to the merge time
# its entry is inside those 30 minutes and the next build writes again.
#
# Never fails the job and never holds it: the listing and the fetch are each
# cut after LIST_TIMEOUT seconds (plus 2 for one that ignores TERM), a listing that fails writes as before, and ignore-error=true keeps a
# failed upload from failing the build.
set -uo pipefail

scope="images-${APP:?}-${ARCH:?}"
today="${TODAY:-$(date -u +%F)}"
limit="${LIST_TIMEOUT:-20}"
to="type=gha,scope=${scope},mode=min,ignore-error=true"

# Runs a command for at most LIST_TIMEOUT seconds.
bounded() {
  "$@" &
  local pid=$! killer status
  # TERM first; KILL two seconds later, for a command that ignores TERM.
  (sleep "$limit" && kill "$pid" && sleep 2 && kill -9 "$pid") >/dev/null 2>&1 &
  killer=$!
  wait "$pid"
  status=$?
  kill "$killer" >/dev/null 2>&1
  return "$status"
}

out="$(mktemp)"
bounded gh api -X GET "repos/${GITHUB_REPOSITORY:?}/actions/caches" \
  -f key="index-${scope}-" -f ref="${GITHUB_REF:?}" \
  -f sort=created_at -f direction=desc -f per_page=1 \
  --jq '.actions_caches[0].created_at // ""' >"$out" 2>&1
status=$?
latest="$(cat "$out")"
rm -f "$out"

inputs=("apps/${APP%-codex}/Dockerfile" scripts/fetch-pinned.ts)

# True only when git shows that main has moved the inputs away from HEAD's.
superseded() {
  [ "$GITHUB_REF" = refs/heads/main ] || return 1
  # A shallow checkout's origin/main is its own commit.
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = true ]; then
    # To a file: a remote helper that outlives git must not hold the step's log.
    local log
    log="$(mktemp)"
    bounded git fetch -q --no-tags --depth=1 \
      origin +refs/heads/main:refs/remotes/origin/main >"$log" 2>&1 ||
      echo "::warning::could not fetch origin/main for ${scope}: $(cat "$log")" >&2
    rm -f "$log"
  fi
  local status=0
  git diff --quiet HEAD refs/remotes/origin/main -- "${inputs[@]}" >&2 || status=$?
  [ "$status" -le 1 ] ||
    echo "::warning::could not compare the build inputs of ${scope} with origin/main; writing it" >&2
  [ "$status" -eq 1 ]
}

# Prints the time from which an entry holds the current inputs, nothing in a
# shallow checkout; fails when git cannot tell.
fresh_from() {
  local shallow changed
  shallow="$(git rev-parse --is-shallow-repository)" || return 1
  [ "$shallow" = false ] || return 0
  changed="$(git log -1 --first-parent --format=%ct -- "${inputs[@]}")" || return 1
  [ -n "$changed" ] || return 1
  jq -nr "($changed + 1800) | todateiso8601"
}

if [ "$status" -eq 0 ]; then
  if [ "${latest:0:10}" = "$today" ] && [[ "${latest:11:5}" > "00:29" ]]; then
    if ! fresh="$(fresh_from)"; then
      echo "::warning::could not date the build inputs of ${scope}; writing it" >&2
    elif [[ "$latest" < "$fresh" ]]; then
      echo "::notice::layer cache ${scope} (${latest}) is older than its build inputs allow (${fresh}); writing it" >&2
    else
      echo "::notice::layer cache ${scope} was written today (${latest}); this build only reads it" >&2
      to=""
    fi
  fi
else
  echo "::warning::could not list the layer cache of ${scope} (exit ${status}); writing it: ${latest}" >&2
fi
if [ -n "$to" ] && superseded; then
  echo "::notice::the build inputs of ${scope} differ on origin/main; this older build only reads the layer cache" >&2
  to=""
fi
echo "to=${to}"
