#!/usr/bin/env bash
# What the images are built from: HEAD plus a digest of uncommitted changes
# (tracked diffs and untracked files), the verify skill and its scripts excluded.
#   tree-id.sh <repo>
set -euo pipefail
cd "$1"
{
  git diff HEAD --binary -- . ':!.claude' ':!scripts/verify'
  git ls-files --others --exclude-standard -z -- . ':!.claude' ':!scripts/verify' | xargs -0 -r shasum
} | shasum | { read -r digest _; echo "$(git rev-parse HEAD)+$digest"; }
