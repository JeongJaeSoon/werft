#!/usr/bin/env bash
# Publishes a packaged chart: `chart-push.sh <werft-<version>.tgz> <registry>`,
# e.g. ghcr.io/<owner>; helm adds the chart's name. REGISTRY_TOKEN logs in.
# CHART_PLAIN_HTTP=1 is for a local test registry.
#
# A version is written once. One already there is fetched and compared by its
# unpacked files, because the tgz carries packaging times: the same files are a
# rerun, other files fail the run and nothing is overwritten. Whatever happened,
# the version must then read back without any login and match the candidate.
#
# ghcr can answer `not found` for the manifest a push has just written, at the
# moment the push tags it. Only that answer is tried again, twice, each after a
# pause and a new look: the push may have landed, and a version is written once.
set -euo pipefail

candidate="$1"
registry="$2"
base="$(basename "$candidate")"
version="${base#werft-}"
version="${version%.tgz}"
ref="oci://${registry}/werft"
plain=()
[ -z "${CHART_PLAIN_HTTP:-}" ] || plain=(--plain-http)

work="$(mktemp -d)"
trap 'rm -rf "${work:?}"' EXIT
mkdir -p "$work/no-login"

# Helm falls back to Docker's credentials, so both configs are left empty.
anonymous() {
  HELM_REGISTRY_CONFIG="$work/no-login/config.json" DOCKER_CONFIG="$work/no-login" "$@"
}

# Fetches the version into <dir>; prints found, absent or denied. Any other
# answer is no answer: it exits non-zero, and a run that cannot look does not
# write.
fetch() {
  local dir="$1" out status
  shift
  mkdir -p "$dir"
  set +e
  out="$("$@" helm pull "$ref" --version "$version" --destination "$dir" ${plain[@]+"${plain[@]}"} 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo found
    return 0
  fi
  case "$out" in
    *"not found"* | *MANIFEST_UNKNOWN* | *NAME_UNKNOWN*) echo absent ;;
    *denied*) echo denied ;;
    *)
      echo "::error::could not look up ${ref} ${version}: ${out}" >&2
      return 1
      ;;
  esac
}

same_files() {
  local fetched="$1" compared
  compared="$(mktemp -d "${work:?}/compared.XXXXXX")"
  mkdir "$compared/ours" "$compared/theirs"
  tar -xzf "$candidate" -C "$compared/ours"
  tar -xzf "${fetched}/${base}" -C "$compared/theirs"
  diff -r "$compared/ours" "$compared/theirs" >&2 || {
    echo "::error::${ref} ${version} differs from this run's chart" >&2
    return 1
  }
}

printf '%s' "${REGISTRY_TOKEN:?}" |
  helm registry login "${registry%%/*}" --username "${GITHUB_ACTOR:?}" --password-stdin ${plain[@]+"${plain[@]}"}

for attempt in 1 2 3; do
  state="$(fetch "$work/login-${attempt}")"
  fetched="$work/login-${attempt}"
  # ghcr may answer `denied` for a package that does not exist yet. The token
  # that can push reads whatever exists, and an existing chart is public, so the
  # same answer without a login leaves nothing this push could overwrite.
  if [ "$state" = denied ]; then
    state="$(fetch "$work/before-${attempt}" anonymous)"
    fetched="$work/before-${attempt}"
  fi

  if [ "$state" = found ]; then
    same_files "$fetched"
    echo "${ref} ${version} is already published with these files: a rerun"
    break
  fi
  set +e
  pushed="$(helm push "$candidate" "oci://${registry}" ${plain[@]+"${plain[@]}"} 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$pushed"
  [ "$status" -ne 0 ] || break
  case "$pushed" in
    *'failed to perform "Tag"'*'not found'*) ;;
    *) exit "$status" ;;
  esac
  [ "$attempt" != 3 ] || exit "$status"
  echo "::warning::the registry did not find the manifest this push had just written; looking again (try ${attempt} of 3)"
  sleep "${CHART_PUSH_RETRY_SECONDS:-10}"
done

state="$(fetch "$work/after" anonymous)"
if [ "$state" != found ]; then
  echo "::error::${ref} ${version} does not read back without a login (${state}): the package may be private" >&2
  exit 1
fi
same_files "$work/after"
anonymous helm show chart "$ref" --version "$version" ${plain[@]+"${plain[@]}"}
