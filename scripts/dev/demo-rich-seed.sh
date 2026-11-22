#!/usr/bin/env bash
# Seed the rich demo data into a verify-werft run started with
# VERIFY_DEMO_ACCOUNTS=1, a PLATFORM_SECRET_KEY and infra/compose.mock-slack.yml:
#   scripts/dev/demo-rich-seed.sh <run dir> [--keep-running]
# Account passwords stay in <run dir>/demo-rich-accounts.json (0600); the
# script never prints them. --keep-running stays in the foreground: it keeps
# the waiting sessions waiting and serves the fake GitHub the App reads.
set -euo pipefail
run=${1:?run dir}
shift
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$repo"
# shellcheck disable=SC1091
. scripts/verify/lib.sh "$run" >/dev/null
accounts="$run/demo-rich-accounts.json"
# Its imports name apps/ from the repository root, as /app is in the image.
# /app itself is root's; the script only needs to be readable there.
inside=/app/scripts/dev/demo-rich-seed.ts
ap_compose exec -T -u 0 api mkdir -p /app/scripts/dev
ap_compose cp scripts/dev/demo-rich-seed.ts "api:$inside" >/dev/null
# Written through stdin so the file belongs to the container's user;
# `compose cp` would keep the host owner and its 0600 would lock it out.
if [ -f "$accounts" ]; then
  ap_compose exec -T api sh -c 'umask 077; cat > /tmp/demo-rich-creds.json' <"$accounts"
fi
code=0
ap_compose exec -T -w /app api bun run "$inside" "$@" || code=$?
if [ "$*" != "--keep-running" ]; then
  umask 077
  # A run that died before writing must not blank the passwords kept so far.
  if ap_compose exec -T api cat /tmp/demo-rich-creds.json >"$accounts.new" && [ -s "$accounts.new" ]; then
    mv "$accounts.new" "$accounts"
    chmod 600 "$accounts"
  else
    rm -f "$accounts.new"
  fi
fi
exit "$code"
