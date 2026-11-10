#!/bin/sh
# What a published image does not ship: test sources, test helpers,
# testkit, benchmarks and the demo-account tools.
#
#   image-prune.sh --list   <root>   print every such path under <root>
#   image-prune.sh --delete <root>   remove them, then the workspace links in
#                                    node_modules that pointed at them
#
# The app Dockerfiles run --delete on a copy of the source tree (the `pruned`
# stage); the `local` target of apps/control-host/Dockerfile copies back only
# testkit and the demo tools it needs. images.yml's smoke runs --list inside
# the built image and fails on any output. Only <root>/apps and <root>/packages
# are searched, and node_modules is never entered: a dependency's own tests
# are not ours to remove.
set -eu

mode="${1:?usage: image-prune.sh --list|--delete <root>}"
root="${2:?usage: image-prune.sh --list|--delete <root>}"
cd "$root"

matches() {
  # The egress proxy's /app is its own src/ alone, with neither directory.
  dirs=""
  for dir in apps packages; do [ -d "$dir" ] && dirs="$dirs $dir"; done
  [ -n "$dirs" ] || return 0
  # shellcheck disable=SC2086 # two fixed names
  find $dirs \
    -name node_modules -prune -o \
    \( -type d \( \
         -path packages/testkit -o \
         -path apps/web/src/demo -o \
         -path '*/src/testing' -o \
         -path '*/src/test-support' -o \
         -path '*/__fixtures__' -o \
         -path '*/__snapshots__' -o \
         -path packages/adapters/runtimes/registry/variants -o \
         -path '*/bench' \
       \) -print -prune \) -o \
    \( -type f \( \
         -name '*.test.ts' -o -name '*.test.tsx' -o \
         -name '*.fixture.ts' -o \
         -path packages/db/src/pglite-release.ts -o \
         -path '*/src/testing.ts' -o \
         -path packages/adapters/execution/kubernetes/src/fake-client.ts -o \
         -path apps/control-host/src/api/route-error-coverage.ts -o \
         -path apps/control-host/src/api/demo-accounts.ts -o \
         -path apps/control-host/src/api/demo-data.ts \
       \) -print \)
}

# A workspace link whose target is gone (packages/testkit) after the delete.
dangling() {
  [ -d node_modules ] || return 0
  find node_modules -maxdepth 2 -xtype l
}

case "$mode" in
  --list)
    matches
    dangling
    ;;
  --delete)
    matches | while IFS= read -r path; do rm -rf -- "$path"; done
    dangling | while IFS= read -r link; do rm -f -- "$link"; done
    ;;
  *)
    echo "usage: image-prune.sh --list|--delete <root>" >&2
    exit 2
    ;;
esac
