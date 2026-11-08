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
# generated from the lockfile, so it is not prose; .claude holds scripts as
# well as Markdown, so only its .md files count.
is_doc_path() {
  case "$1" in
    THIRD_PARTY_NOTICES.md) return 1 ;;
    README.md | CHANGELOG.md) return 0 ;;
    docs/*.md | apps/docs/content/*.mdx) return 0 ;;
    .claude/*.md | .github/ISSUE_TEMPLATE/*) return 0 ;;
    .github/*/*) return 1 ;;
    .github/*.md) return 0 ;;
    */*) return 1 ;;
    *.md) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "${GITHUB_EVENT_NAME:-}" = pull_request ] && [ "${BASE_REF:-}" = main ]; then
  base="${BASE_SHA:?BASE_SHA is required for a pull request}"
  if [[ ! "$base" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::invalid pull request base SHA" >&2
    exit 1
  fi
  git fetch --no-tags --depth=1 origin "$base"
  checkout_base=$(git rev-parse --verify 'HEAD^1' 2>/dev/null || true)
  if [ "$base" = "$checkout_base" ]; then
    paths="${RUNNER_TEMP:?}/ci-paths"
    git diff --name-only --no-renames -z "$base" HEAD >"$paths"
    docs_only=true
    guide=false
    site=false
    # Leaf apps that nothing else imports. Any path outside these and the
    # prose list is shared or unknown, and keeps the full plan.
    shared=false
    web=false
    egress=false
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
          apps/web/* | apps/storybook/*) web=true ;;
          apps/egress-proxy/*) egress=true ;;
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
      # Only leaf apps (and prose) changed. The control-host image bundles
      # apps/web, so e2e and the product jobs stay on; what drops out is the
      # work no changed path can reach.
      site=true
      helm=false
      k8s=$egress
      quickstart=$guide
      [ "$egress" = true ] && quickstart=true
      selected=()
      [ "$web" = true ] && selected+=('"surface"')
      [ "$egress" = true ] && selected+=('"egress"')
      domains="[$(IFS=,; echo "${selected[*]}")]"
      # Prose-only PRs return above, so a leaf app changed and one domain is
      # selected at least; an empty matrix would fail the job.
    else
      site=true
      quickstart=true
    fi
  else
    echo "PR base differs from the checkout parent; keeping full validation"
  fi
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
