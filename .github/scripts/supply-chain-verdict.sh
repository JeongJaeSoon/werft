#!/usr/bin/env bash
# The release policy over the scans' result files
# `supply-chain-verdict.sh <result dir> <warn|fail> [all|amd64|dependencies]`.
#
# Reads each app on each arch, <app>-<arch> (image-scan.sh), and npm
# (npm-audit.ts) from <result dir>/<name>.txt. `found <n>`, a high or
# critical finding with a fix available, always fails, and so does a missing
# file: the image was never built or never reached its scan. `error` means
# the scan ran and got no answer (release download, advisory database or
# service): a warning where an outage must not block every merge (pull
# requests, main pushes), a failure where a verdict is required (tags, the
# daily run). Findings without a fix never fail; they stay in the summary and
# the result artifact.
set -euo pipefail

results="$1"
no_verdict="$2"
case "$no_verdict" in warn | fail) ;; *)
  echo "usage: $0 <result dir> <warn|fail>" >&2
  exit 2
  ;;
esac

# An exception without its reason or expiry must not quietly clear a
# finding, whatever the mode: image-scan.sh applies the file without
# checking it, and npm-audit.ts's refusal alone would only be an `error`.
exceptions="$(dirname "$0")/../vulnerability-exceptions.json"
if ! jq -e 'type == "array" and all(.[];
    type == "object"
    and all(.id, .package, .reason; type == "string" and length > 0)
    and (.expires | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")))' \
  "$exceptions" >/dev/null; then
  echo "::error::${exceptions#*/.github/}: every entry needs id, package, reason and expires (YYYY-MM-DD)"
  exit 1
fi

# The image-build plan, when the caller has one (the `supply-chain` job; a
# publish judges its own digest and sets none, so it gets the full set).
# The plan is a value, never an absence: an unset variable means no plan to
# honour, but an empty or unknown one fails, so a planner that did not run
# cannot pass as "nothing to build".
scope=${3:-all}
case "$scope" in
  all) scans=({control-host,worker,egress-proxy}-{amd64,arm64} npm) ;;
  amd64) scans=({control-host,worker,egress-proxy}-amd64 npm) ;;
  dependencies) scans=(npm) ;;
  *) echo "::error::unknown scan scope"; exit 2 ;;
esac
if [ -n "${IMAGES_PLAN+x}" ]; then
  # A planner that failed or was cancelled can leave an output behind.
  if [ "${IMAGES_PLAN_RESULT:-}" != success ]; then
    echo "::error::the image build plan finished as '${IMAGES_PLAN_RESULT:-}'"
    exit 1
  fi
  case "$IMAGES_PLAN" in
    build)
      if [ "$scope" = dependencies ]; then
        echo "::error::a planned image build requires image scans"
        exit 1
      fi
      if [ "${IMAGES_BUILD_RESULT:-}" != success ]; then
        echo "::error::build was planned and finished as '${IMAGES_BUILD_RESULT:-}'"
        exit 1
      fi
      ;;
    skip)
      # Main prose pushes use the same plan; tags and manual runs stay full.
      case "${GITHUB_EVENT_NAME:-}:${GITHUB_REF:-}:${IMAGES_BUILD_RESULT:-}" in
        pull_request:*:skipped | push:refs/heads/main:skipped) scans=(npm) ;;
        *)
          echo "::error::build was planned out but the event is '${GITHUB_EVENT_NAME:-}' and the build '${IMAGES_BUILD_RESULT:-}'"
          exit 1
          ;;
      esac
      ;;
    *)
      echo "::error::no valid image build plan ('${IMAGES_PLAN}')"
      exit 1
      ;;
  esac
fi

found=0
missing=0
{
  echo "### supply-chain verdict"
  echo
  echo "| scan | result |"
  echo "| --- | --- |"
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
for scan in "${scans[@]}"; do
  result="$(cat "${results}/${scan}.txt" 2>/dev/null || echo "no result")"
  echo "${scan}: ${result}"
  echo "| ${scan} | ${result} |" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
  case "$result" in
    clean) ;;
    "found "*)
      found=1
      echo "::error::${scan}: ${result#found } high or critical with a fix available"
      ;;
    error)
      missing=1
      if [ "$no_verdict" = fail ]; then
        echo "::error::${scan}: no verdict (${result})"
      else
        echo "::warning::${scan}: no verdict (${result}); the daily run and the release check again"
      fi
      ;;
    *)
      found=1
      echo "::error::${scan}: ${result}"
      ;;
  esac
done

[ "$found" -eq 0 ] || exit 1
[ "$missing" -eq 0 ] || [ "$no_verdict" = warn ] || exit 1
