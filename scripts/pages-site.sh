#!/usr/bin/env bash
# Assembles the Pages site: the docs build at the root and the Scalar API
# reference below /api/.
#
#   pages-site.sh <docs-out> <site dir>
#
# Shared by ci.yml (a pull request proves the layout) and pages.yml (the
# deploy), so the two cannot drift apart.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <docs-out> <site dir>" >&2
  exit 2
fi
docs="$1"
site="$2"

if [ ! -d "$docs" ]; then
  echo "::error::$docs is not a directory" >&2
  exit 1
fi
if [ -e "$site" ]; then
  echo "::error::$site exists; the site is assembled into a fresh directory" >&2
  exit 1
fi

mkdir -p "$site"
cp -R "$docs"/. "$site"/

# The docs build owns the root; a docs page at /api would be silently merged
# with or replaced by the reference below.
if [ -e "$site/api" ]; then
  echo "::error::apps/docs produced api, which the Pages site reserves" >&2
  exit 1
fi

mkdir -p "$site/api"
cp docs/api/index.html docs/api/scalar.js docs/openapi.json "$site/api/"
ls "$site" "$site/api"
