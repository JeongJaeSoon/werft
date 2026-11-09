#!/usr/bin/env bash
# Known vulnerabilities in one app image, on a runner of its architecture:
# `image-scan.sh <app>-<arch> <image ref> <result dir>`.
#
# Grype over the whole image: Debian packages and the npm packages under
# /app. A release binary pinned by version and checksum rather than a
# third-party action, whose tags can be moved under us. The log gets the
# unfiltered table. High and critical findings go to the step summary and to
# <result dir>/<app>-<arch>.json, split by whether a fix is available; only the
# fixable ones that .github/vulnerability-exceptions.json does not cover
# count, and <result dir>/<app>-<arch>.txt says `clean` or `found <n>`.
#
# Findings never fail this script: whether they fail anything is the
# caller's policy (the `supply-chain` job and `publish` in images.yml). A
# scan that could not run exits non-zero and leaves `error` in the result
# file; the build job fails with it.
set -euo pipefail

app="$1"
image="$2"
results="$3"
exceptions="$(dirname "$0")/../vulnerability-exceptions.json"

GRYPE_VERSION=0.119.0

mkdir -p "$results"
result=error
work="$(mktemp -d)"
trap 'echo "$result" >"${results}/${app}.txt"; rm -rf "$work"' EXIT

case "$(uname -m)" in
  x86_64)
    GRYPE_ARCH=amd64
    GRYPE_ASSET=570620608
    GRYPE_SHA256=3fa2dc4b924621ab65404cf08d0b8438d896d80ab949c9d5a4ca283c36004c9b
    ;;
  aarch64)
    GRYPE_ARCH=arm64
    GRYPE_ASSET=570620605
    GRYPE_SHA256=29f0ec7c549ddb0e2b6a0ca714851f7399438afc399b80c12808e065edc9a8f8
    ;;
  *)
    echo "::error::no grype pinned for $(uname -m)"
    exit 1
    ;;
esac

# Browser release URLs can persistently return an error document. The API
# serves the same archive through an independent path; verify the pin again.
if ! curl -fsSL --connect-timeout 10 --max-time 120 -o "${work}/grype.tar.gz" \
  "https://github.com/anchore/grype/releases/download/v${GRYPE_VERSION}/grype_${GRYPE_VERSION}_linux_${GRYPE_ARCH}.tar.gz" \
  || ! (cd "$work" && echo "${GRYPE_SHA256}  grype.tar.gz" | sha256sum -c -); then
  echo "using official Grype asset API after browser download failed"
  curl -fsSL --retry 2 --retry-delay 5 --retry-all-errors \
    --connect-timeout 10 --max-time 120 -H 'Accept: application/octet-stream' \
    -o "${work}/grype.tar.gz" \
    "https://api.github.com/repos/anchore/grype/releases/assets/${GRYPE_ASSET}"
fi
(cd "$work" && echo "${GRYPE_SHA256}  grype.tar.gz" | sha256sum -c - && tar -xzf grype.tar.gz grype)

# Grype refuses a database older than five days on its own, so a stale one
# is an error here, not a quiet pass.
"${work}/grype" db update
"${work}/grype" "docker:${image}" -o table -o "json=${work}/scan.json"

# Same shape as npm-audit.ts's findings. `fix` is null for `not-fixed`,
# `wont-fix` and `unknown` alike: none of them has a version to move to.
jq --slurpfile exceptions "$exceptions" --arg today "$(date -u +%F)" '
  [.matches[]
    | select(.vulnerability.severity == "High" or .vulnerability.severity == "Critical")
    | {package: .artifact.name, version: .artifact.version,
       id: .vulnerability.id, severity: (.vulnerability.severity | ascii_downcase),
       fix: (if .vulnerability.fix.state == "fixed"
             then (.vulnerability.fix.versions | join(",")) else null end)}
    | . as $f
    | ($exceptions[0] | map(select(.id == $f.id and .package == $f.package
        and .expires >= $today)) | first) as $e
    | if $e then . + {excepted: $e.reason} else . end]
  | unique' "${work}/scan.json" >"${results}/${app}.json"

count="$(jq '[.[] | select(.fix != null and .excepted == null)] | length' "${results}/${app}.json")"
unfixed="$(jq '[.[] | select(.fix == null)] | length' "${results}/${app}.json")"
line='"\(.severity) \(.package) \(.version) → \(.fix // "no fix") \(.id)\(if .excepted then " (excepted: \(.excepted))" else "" end)"'
{
  echo "### ${app}: vulnerabilities"
  echo
  echo "${count} high or critical with a fix available, ${unfixed} without one (reported, not blocking). Full table in the step log."
  echo
  echo '```text'
  jq -r ".[] | select(.fix != null) | ${line}" "${results}/${app}.json"
  echo '```'
  echo
  echo "<details><summary>${unfixed} without a fix</summary>"
  echo
  echo '```text'
  jq -r ".[] | select(.fix == null) | ${line}" "${results}/${app}.json"
  echo '```'
  echo
  echo "</details>"
  echo
} >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ "$count" -gt 0 ]; then
  result="found ${count}"
  echo "::warning::${app}: ${count} high or critical vulnerabilities with a fix available"
else
  result=clean
fi
