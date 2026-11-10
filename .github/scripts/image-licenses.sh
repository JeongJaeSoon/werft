#!/usr/bin/env bash
# What one app image ships, against THIRD_PARTY_NOTICES.md
# `image-licenses.sh <control-host|worker|worker-codex|egress-proxy> <image ref>`.
#
# The notices are computed from bun.lock; this is where that model meets a
# built image. Every npm package under /app must be listed for this app, the
# Bun builds and license texts the notices name must be the ones inside, and
# /app/DEBIAN_SOURCES.md must match the installed packages (the script runs
# on the image's own Bun, with the checkout mounted read-only). Every Debian
# package must carry the copyright file the notices point to. Shared by images.yml's build and publish jobs, like image-smoke.sh.
set -euo pipefail

app="$1"
image="$2"

docker run --rm --entrypoint bun -v "$PWD:/repo:ro" "$image" \
  /repo/scripts/third-party-notices.ts --verify "$app" /app

# The corresponding-source list this build shipped, for the log.
echo "::group::${app}: /app/DEBIAN_SOURCES.md"
docker run --rm --entrypoint cat "$image" /app/DEBIAN_SOURCES.md
echo "::endgroup::"

# \${Package} reaches the image's sh as ${Package} inside double quotes, which
# dpkg-query, not the shell, expands. Installed packages only: one removed
# with its configuration kept is still listed, without its docs.
missing="$(docker run --rm --entrypoint sh "$image" -c \
  'dpkg-query -W -f "\${db:Status-Status} \${Package}\n" | while read -r s p; do [ "$s" = installed ] || continue; [ -e "/usr/share/doc/$p/copyright" ] || echo "$p"; done')"
if [ -n "$missing" ]; then
  echo "::error::${app}: Debian packages without /usr/share/doc/<package>/copyright: ${missing//$'\n'/ }"
  exit 1
fi
echo "${app}: every Debian package carries its copyright file"
