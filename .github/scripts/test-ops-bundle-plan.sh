#!/usr/bin/env bash
# Whether a main push runs test-ops-bundle: `ops_bundle=build` or `ops_bundle=skip`
# for GITHUB_OUTPUT, and one line on stderr saying why.
#
# A push of one commit onto `before` that changes none of what the job checks
# would build the same bytes the previous main commit built and checked, so it
# is left out. What the job checks is the bundle's own input list
# (test-ops-bundle.sh --inputs, the one list) plus the job's: its fixture
# manifest, images.yml and this script. Anything short of that proof builds:
# no previous commit (a new branch), a push of several commits or a force push
# (HEAD^ is not `before`), a diff or list that cannot be read, and any
# .gitattributes change (it can change the bytes a checkout gives the bundle).
# Every input has to be a regular file git tracks at that very path: a symlink,
# or a path under a symlinked directory, makes the bundle copy bytes the list
# does not name, so it builds. Files outside
# the list that still break the bundle surface in the next scheduled or tag
# run, which always build it.
#
# env: GITHUB_SHA (the pushed commit, checked out with its parent),
#      BEFORE_SHA (the push's before), GITHUB_STEP_SUMMARY (optional).
set -uo pipefail

build() {
  echo "test-ops-bundle-plan: build: $*" >&2
  echo ops_bundle=build
  exit 0
}

: "${GITHUB_SHA:?}"
before=${BEFORE_SHA:-}
[[ "$before" =~ ^[0-9a-f]{40}$ && ! "$before" =~ ^0+$ ]] || build "no previous commit in the push"
head=$(git rev-parse HEAD 2>/dev/null) || build "cannot read the pushed commit"
[ "$head" = "$GITHUB_SHA" ] || build "the checkout is not the pushed commit"
parent=$(git rev-parse --verify --quiet 'HEAD^1') || build "cannot read the pushed commit's parent"
[ "$parent" = "$before" ] || build "HEAD^ is not the push's before (several commits or a force push)"

inputs=$(bash .github/scripts/test-ops-bundle.sh --inputs) && [ -n "$inputs" ] \
  || build "test-ops-bundle.sh --inputs gave no list"
inputs+=$'\n'"tests/fixtures/test-ops-release-manifest.json"
inputs+=$'\n'".github/workflows/images.yml"
inputs+=$'\n'".github/scripts/test-ops-bundle-plan.sh"

# Literal pathspecs and git's own exit code: 0 nothing changed, 1 something
# did, anything else is an error. No name is parsed back out of git's output.
specs=(':(glob,top).gitattributes' ':(glob,top)**/.gitattributes')
while IFS= read -r path; do
  [ -z "$path" ] || specs+=(":(literal,top)${path}")
done <<<"$inputs"
while IFS= read -r path; do
  [ -n "$path" ] || continue
  # One index entry, a regular file, and a blob at HEAD:<path> (a path under a
  # symlinked directory has no such blob). git quotes some names in
  # ls-files output, so the name itself is not compared.
  entry=$(git ls-files -s -- ":(literal,top)${path}") || build "cannot read how git tracks ${path}"
  [[ "$entry" =~ ^100(644|755)\  && "$entry" != *$'\n'* ]] \
    && [ "$(git cat-file -t "HEAD:${path}" 2>/dev/null)" = blob ] \
    || build "an input is not a regular tracked file: ${path}"
done <<<"$inputs"
attributes=$(git ls-files -s -- "${specs[@]:0:2}") || build "cannot read the .gitattributes files"
if grep -q '^120000 ' <<<"$attributes"; then
  build "a .gitattributes is a symlink"
fi
git diff --quiet --no-renames "$before" HEAD -- "${specs[@]}"
case $? in
  0) ;;
  1) build "$(git diff --name-only --no-renames "$before" HEAD -- "${specs[@]}" | head -n 1) changed in ${before::12}..${head::12}" ;;
  *) build "cannot diff ${before::12}..${head::12}" ;;
esac

echo "test-ops-bundle-plan: skip: no bundle input changed in ${before::12}..${head::12}" >&2
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "test-ops-bundle left out: no bundle input changed in ${before}..${head}" >>"$GITHUB_STEP_SUMMARY"
fi
echo ops_bundle=skip
