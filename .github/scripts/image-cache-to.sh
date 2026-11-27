#!/usr/bin/env bash
# Prints `to=<cache-to>` for GITHUB_OUTPUT: what a trusted image build writes to
# the buildkit layer cache of scope images-<APP>-<ARCH>.
#
# The first build of a UTC day on this ref writes it; later builds that day
# only read it. Every write stores the release stage again, and its
# `COPY --from=pruned /app` layer (about 190 MB for worker and worker-codex)
# changes with every commit, so a write per main push filled the 10 GB
# repository cache with layers nothing reads again. The layers later builds
# reuse (apt upgrade, git-lfs, gh, git hooks) change with the Dockerfiles'
# APT_UPGRADE_KEY, the UTC date, so one write a day keeps them warm.
#
# Never fails the job: a cache listing that fails writes as before, and
# ignore-error=true keeps a failed upload from failing the build.
set -uo pipefail

scope="images-${APP:?}-${ARCH:?}"
today="${TODAY:-$(date -u +%F)}"
to="type=gha,scope=${scope},mode=min,ignore-error=true"

if latest="$(gh api -X GET "repos/${GITHUB_REPOSITORY:?}/actions/caches" \
  -f key="index-${scope}-" -f ref="${GITHUB_REF:?}" \
  -f sort=created_at -f direction=desc -f per_page=1 \
  --jq '.actions_caches[0].created_at // ""' 2>&1)"; then
  if [ "${latest:0:10}" = "$today" ]; then
    echo "::notice::layer cache ${scope} was written today (${latest}); this build only reads it" >&2
    to=""
  fi
else
  echo "::warning::could not list the layer cache of ${scope}; writing it: ${latest}" >&2
fi
echo "to=${to}"
