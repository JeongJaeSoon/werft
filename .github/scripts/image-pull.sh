#!/usr/bin/env bash
# Pulls an image by the digest a push has just reported.
#
# ghcr can answer `manifest unknown` for a digest it has just accepted. Only
# that answer is tried again, after the pauses in IMAGE_PULL_WAITS (seconds,
# default 5 10 20 40: five pulls in about 75 s). Any other failure, and the last
# `manifest unknown`, fails with the pull's own exit code and output.
set -uo pipefail

ref="${1:?}"
read -r -a waits <<<"${IMAGE_PULL_WAITS:-5 10 20 40}"
out="$(mktemp)"
trap 'rm -f "${out:?}"' EXIT

for ((attempt = 1; ; attempt++)); do
  status=0
  docker pull "$ref" >"$out" 2>&1 || status=$?
  cat "$out"
  [ "$status" -ne 0 ] || exit 0
  grep -Eq '^Error response from daemon: manifest unknown$' "$out" || exit "$status"
  [ "$attempt" -le "${#waits[@]}" ] || exit "$status"
  echo "::warning::the registry did not find $ref, which this run had just pushed; pulling again (try $attempt of $((${#waits[@]} + 1)))"
  sleep "${waits[attempt - 1]}"
done
