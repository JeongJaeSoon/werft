#!/usr/bin/env bash
# Assembles the Pages site: the docs build at the root, Storybook below
# /storybook/ and the Scalar API reference below /api/.
#
#   pages-site.sh <docs-out> <storybook-dist> <site dir>
#
# Shared by ci.yml (a pull request proves the layout) and pages.yml (the
# deploy), so the two cannot drift apart.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <docs-out> <storybook-dist> <site dir>" >&2
  exit 2
fi
docs="$1"
storybook="$2"
site="$3"

for dir in "$docs" "$storybook"; do
  if [ ! -d "$dir" ]; then
    echo "::error::$dir is not a directory" >&2
    exit 1
  fi
done
if [ -e "$site" ]; then
  echo "::error::$site exists; the site is assembled into a fresh directory" >&2
  exit 1
fi

mkdir -p "$site"
cp -R "$docs"/. "$site"/

# The docs build owns the root; a docs page at /api or /storybook would be
# silently merged with or replaced by the sibling below.
for sibling in "$site/api" "$site/storybook"; do
  if [ -e "$sibling" ]; then
    echo "::error::apps/docs produced ${sibling#"$site"/}, which the Pages site reserves" >&2
    exit 1
  fi
done

mkdir -p "$site/storybook" "$site/api"
cp -R "$storybook"/. "$site/storybook"/
"$(dirname "$0")/storybook-pages.sh" check "$site/storybook"
cp docs/api/index.html docs/api/scalar.js docs/openapi.json "$site/api/"
ls "$site" "$site/api" "$site/storybook"
