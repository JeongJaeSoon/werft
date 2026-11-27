#!/usr/bin/env bash
set -euo pipefail

# Every domain of .github/integration-domains.yml, in its order;
# tests/ci-plan.test.ts holds this list to that file.
all_domains='["db","sessions","api","surface","storage","docker","egress","worker"]'

tests=true
product=true
site=true
quickstart=true
docs_only=false
helm=true
k8s=true
domains=$all_domains
count=0

# Paths that only carry prose or repository metadata. THIRD_PARTY_NOTICES.md is
# generated from the lockfile, so it is not prose. Everything under .claude
# counts: the verify skill's scripts, which workflows and tests run, live in
# scripts/verify.
is_doc_path() {
  case "$1" in
    THIRD_PARTY_NOTICES.md | CHANGELOG.md) return 1 ;;
    README.md) return 0 ;;
    docs/*.md | apps/docs/content/*.mdx) return 0 ;;
    .claude/* | .github/ISSUE_TEMPLATE/*) return 0 ;;
    .github/*/*) return 1 ;;
    .github/*.md) return 0 ;;
    */*) return 1 ;;
    *.md) return 0 ;;
    *) return 1 ;;
  esac
}

# Paths k8s-smoke (deploy/kind) builds, deploys or runs beyond the app code
# quickstart and e2e already run: the chart and the kind scripts, the
# execution backends and the scheduler that drive worker Pods, the stand-ins
# up.sh mounts, the images and their lockfile, and this plan and job.
is_k8s_path() {
  case "$1" in
    deploy/* | packages/adapters/execution/* | apps/control-host/src/scheduler/* | \
      packages/platform/src/scheduler/* | packages/platform/src/testing/execution-backend-contract.ts | \
      packages/testkit/src/local-github* | packages/testkit/src/fake-messages-main.ts | \
      packages/testkit/src/fake-anthropic.ts | packages/testkit/src/scripted-messages.ts | \
      packages/testkit/src/request-log.ts | \
      infra/localstack/* | Dockerfile* | */Dockerfile* | .dockerignore | bun.lock | \
      .github/workflows/ci.yml | .github/scripts/ci-plan.sh | \
      .github/scripts/assert-no-docker-hub-images.sh | .github/actions/*) return 0 ;;
    *) return 1 ;;
  esac
}

# What a main push also runs the kind jobs for (k8s-smoke, and chart-main in
# images.yml): the rest of what the published images and chart are made of.
# A pull request's selection stays is_k8s_path.
is_publish_path() {
  case "$1" in
    .github/workflows/images.yml | .github/scripts/chart-* | .github/scripts/image-*.sh | \
      .github/scripts/release-auto.sh | \
      scripts/k8s-api.sh | scripts/lib/* | scripts/image-prune.sh | scripts/fetch-pinned.ts | \
      package.json | */package.json | bunfig.toml | tsconfig.base.json | \
      packages/adapters/runtimes/registry/* | packages/runtime-core/src/image-runtime.ts | \
      apps/worker/src/image-runtime.ts | apps/worker/git-hooks/* | \
      THIRD_PARTY_NOTICES.md | scripts/third-party-notices.ts | docs/api/index.html | docs/api/scalar.js | \
      packages/testkit/src/seed-credentials-main.ts | packages/testkit/src/fake-github.ts | \
      packages/testkit/src/git-http.ts | apps/control-host/src/api/settings.ts | \
      tests/e2e/owner-cookie.ts | tests/e2e/client.ts | tests/fixtures/settings/*-model.json) return 0 ;;
    *) return 1 ;;
  esac
}

# Whether a release needs this main commit: the push adds a version heading to
# CHANGELOG.md, or the top version has neither tag nor Release yet (a manual
# retry releases the main head and reads that commit's push runs). An answer
# release-auto.sh cannot give counts as yes.
release_pending() {
  local kind found head
  head=$(git rev-parse HEAD)
  for kind in push workflow_dispatch; do
    found=$(EVENT=$kind BEFORE="$base" AFTER="$head" GITHUB_OUTPUT=/dev/null \
      bash "$(dirname "${BASH_SOURCE[0]}")/release-auto.sh" detect) || return 0
    [ "${found##*$'\n'}" = "release tag: none" ] || return 0
  done
  return 1
}

event=${GITHUB_EVENT_NAME:-}
base=
if [ "$event" = pull_request ] && [ "${BASE_REF:-}" = main ]; then
  base="${BASE_SHA:?BASE_SHA is required for a pull request}"
elif [ "$event" = push ] && [ "${GITHUB_REF:-}" = refs/heads/main ]; then
  base=${BEFORE_SHA:-}
  # A new branch or a missing event range must keep full validation.
  [ "$base" != 0000000000000000000000000000000000000000 ] || base=
fi

# A base that cannot be read fails a pull request; a main push keeps the full
# plan instead, so the kind jobs run when nothing says they need not.
unreadable() {
  echo "::error::$1" >&2
  [ "$event" = push ] || exit 1
  base=
}
if [ -n "$base" ] && [[ ! "$base" =~ ^[0-9a-f]{40}$ ]]; then
  unreadable "invalid event base SHA"
fi
if [ -n "$base" ] && ! git fetch --no-tags --depth=1 origin "$base"; then
  unreadable "cannot fetch the event base"
fi

if [ -n "$base" ]; then
  checkout_base=$(git rev-parse --verify 'HEAD^1' 2>/dev/null || true)
  if [ "$event" = push ] || [ "$base" = "$checkout_base" ]; then
    paths="${RUNNER_TEMP:?}/ci-paths"
    git diff --name-only --no-renames -z "$base" HEAD >"$paths"
    docs_only=true
    guide=false
    site=false
    # The web console: nothing else imports it, and the only test that reads
    # its files needs no service, so `check` covers it.
    # apps/egress-proxy looks like a leaf too, but service-backed tests import
    # it. Any path outside these and the prose list is shared or unknown, and
    # keeps the full plan.
    shared=false
    k8s_path=false
    while IFS= read -r -d '' path; do
      count=$((count + 1))
      is_doc_path "$path" || docs_only=false
      case "$path" in
        apps/docs/content/*) site=true ;;
      esac
      case "$path" in
        docs/quickstart.md | apps/docs/content/docs/reference/api-guide.mdx) guide=true ;;
      esac
      if ! is_doc_path "$path"; then
        case "$path" in
          apps/web/*) ;;
          *) shared=true ;;
        esac
      fi
      if is_k8s_path "$path" || { [ "$event" = push ] && is_publish_path "$path"; }; then
        k8s_path=true
      fi
    done <"$paths"
    if [ "$count" -eq 0 ]; then
      docs_only=false
      site=true
    elif [ "$docs_only" = true ]; then
      tests=false
      product=false
      quickstart=$guide
      helm=false
      k8s=false
      domains='[]'
    elif [ "$shared" = false ]; then
      # Only the web console (and prose) changed. The control-host image
      # bundles apps/web, so e2e and the product jobs stay on; what drops out
      # is the work no changed path can reach. The surface domain owns apps/web.
      site=true
      helm=false
      # A main push lists the web package.json among what the images build from.
      if [ "$event" != push ] || [ "$k8s_path" = false ]; then k8s=false; fi
      quickstart=$guide
      domains='["surface"]'
    else
      site=true
      quickstart=true
      # The kind jobs run only for what the kind install builds, deploys or
      # runs. Over 2026-10-20..11-11 no app regression failed k8s-smoke alone
      # on a PR: quickstart, e2e, integration or check failed in the same run.
      # A commit a release needs runs them whatever it touches (below).
      [ "$k8s_path" = true ] || k8s=false
    fi
  else
    echo "Event base differs from the checkout parent; keeping full validation"
  fi
fi

if [ "$event" = push ] && [ "$k8s" = false ] && release_pending; then
  echo "A release needs this commit; running the kind jobs"
  k8s=true
fi

# Site builds and deploys belong to pages.yml on release tags; CI verifies the site on PRs and by hand.
if [ "$event" = push ]; then
  site=false
fi

printf '%s\n' \
  "tests=$tests" \
  "product=$product" \
  "site=$site" \
  "quickstart=$quickstart" \
  "docs_only=$docs_only" \
  "helm=$helm" \
  "k8s=$k8s" \
  "domains=$domains" >>"${GITHUB_OUTPUT:?}"
echo "CI plan: files=$count docs_only=$docs_only tests=$tests product=$product site=$site quickstart=$quickstart helm=$helm k8s=$k8s domains=$domains"
