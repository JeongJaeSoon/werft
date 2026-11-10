#!/usr/bin/env bash
set -euo pipefail

# Every integration-domain of ci.yml, in matrix order; tests/ci-plan.test.ts
# holds this list to the matrix.
all_domains='["db","api","surface","storage","docker","egress","worker"]'

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
# generated from the lockfile, so it is not prose. Everything under .claude counts,
# scripts included: no workflow and no image reads it, and the policy tests
# that exercise those scripts live in tests/, which docs-checks runs whole.
# The one exception is the sandbox seed that apps/control-host tests parse.
is_doc_path() {
  case "$1" in
    THIRD_PARTY_NOTICES.md | CHANGELOG.md) return 1 ;;
    README.md) return 0 ;;
    docs/*.md | apps/docs/content/*.mdx) return 0 ;;
    # control-host's settings and catalog tests parse this seed document.
    .claude/skills/verify-werft/github-sandbox/*) return 1 ;;
    .claude/* | .github/ISSUE_TEMPLATE/*) return 0 ;;
    .github/*/*) return 1 ;;
    .github/*.md) return 0 ;;
    */*) return 1 ;;
    *.md) return 0 ;;
    *) return 1 ;;
  esac
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

if [ -n "$base" ]; then
  if [[ ! "$base" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::invalid event base SHA" >&2
    exit 1
  fi
  git fetch --no-tags --depth=1 origin "$base"
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
      # is the work no changed path can reach. The surface domain owns
      # apps/web.
      site=true
      helm=false
      k8s=false
      quickstart=$guide
      domains='["surface"]'
    else
      site=true
      quickstart=true
    fi
  else
    echo "Event base differs from the checkout parent; keeping full validation"
  fi
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
