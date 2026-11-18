#!/usr/bin/env bash
# Brings a pull request up as a preview on OrbStack's built-in Kubernetes:
# its own namespace pr-<N>, at http://pr-<N>.localhost:18180/ through one
# Traefik shared by every preview. Browsers resolve *.localhost to loopback
# and count http on it as a secure origin, so the console's Secure
# __Host- session cookie is set there, and each preview's host keeps its
# own: signing in to one does not sign another out.
#
#   deploy/preview/preview.sh up <N> [<sha>]
#                                       check the PR head out, build its images
#                                       (tag pr-<N>), install it in a fresh
#                                       namespace (an existing preview's is
#                                       deleted first), and read /readyz
#                                       through Traefik; with <sha>, exit 75
#                                       unless the head is still that commit
#   deploy/preview/preview.sh down <N>  delete the namespace, the image tags
#                                       and the checkout
#   deploy/preview/preview.sh list      the previews: URL, head, memory in use,
#                                       /readyz
#   deploy/preview/preview.sh reap      `down` every preview whose last `up`
#                                       is older than the TTL or whose PR is
#                                       closed or merged
#   deploy/preview/preview.sh sync      bring up or down the previews of the
#                                       PRs with PREVIEW_LABEL (see sync()),
#                                       then reap; for a scheduler run every
#                                       minute
#
# The PR's own tree is installed (Dockerfiles, chart, stand-ins) by this
# checkout's deploy/kind/up.sh, copied into it, so a head that predates
# up.sh's orbstack mode still installs. The fake model only.
#
# Each preview namespace carries the label werft.dev/preview=true
# and the annotations werft.dev/preview-head (the installed head)
# and werft.dev/preview-up-at (when `up` last started).
#
#   PREVIEW_HOME       checkouts and up.sh state, outside any git worktree
#                      (default ~/.cache/werft/preview)
#   PREVIEW_MEMORY_MI  what one preview needs from the node's unrequested
#                      memory before `up` installs it (default 2560: the
#                      requests of deploy/preview/values.yaml's Deployments
#                      and one session worker)
#   MAX_MEMORY_MI      the node memory the check counts from, in place of
#                      its allocatable memory
#   PREVIEW_TTL_HOURS  how long after its last `up` reap deletes a preview
#                      (default 24)
#   PREVIEW_DOMAIN     optional: each preview also answers Host
#                      pr-<N>.<PREVIEW_DOMAIN>, for a reverse proxy that
#                      ends TLS for *.<PREVIEW_DOMAIN> and passes Host on
#                      unchanged; its https address is the one printed
#   PREVIEW_LABEL      the pull request label `sync` follows (default
#                      preview)
#   PREVIEW_PUBLIC_DOMAIN
#                      optional: a second domain, for a tunnel that puts a
#                      login in front of *.<PREVIEW_PUBLIC_DOMAIN>; `sync`
#                      routes Host pr-<N>.<PREVIEW_PUBLIC_DOMAIN> only for the
#                      previews whose PR also has PREVIEW_PUBLIC_LABEL (see
#                      sync_public()). Empty: no preview answers it
#   PREVIEW_PUBLIC_LABEL
#                      that second label (default preview-public)
#   PREVIEW_SOURCE     `up` writes it to the namespace's annotation
#                      werft.dev/preview-source (`sync` sets label)
set -euo pipefail

PREVIEW_HOME="${PREVIEW_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/werft/preview}"
PREVIEW_MEMORY_MI="${PREVIEW_MEMORY_MI:-2560}"
PREVIEW_TTL_HOURS="${PREVIEW_TTL_HOURS:-24}"
PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-}"
PREVIEW_LABEL="${PREVIEW_LABEL:-preview}"
PREVIEW_PUBLIC_DOMAIN="${PREVIEW_PUBLIC_DOMAIN:-}"
PREVIEW_PUBLIC_LABEL="${PREVIEW_PUBLIC_LABEL:-preview-public}"
INGRESS_NAMESPACE=preview-ingress
TRAEFIK_CHART=oci://ghcr.io/traefik/helm/traefik
TRAEFIK_VERSION=42.1.3
HTTP_PORT=18180
HTTPS_PORT=18543
APPS=(control-host egress-proxy worker)

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

usage() {
  echo "usage: $0 up <PR number> [<head sha>] | down <PR number> | list | reap | sync" >&2
  exit 2
}

for name in PREVIEW_MEMORY_MI MAX_MEMORY_MI; do
  if [ -n "${!name:-}" ] && ! [[ "${!name}" =~ ^[0-9]+$ ]]; then
    echo "${name} must be a whole number of MiB, not '${!name}'" >&2
    exit 1
  fi
done
if ! [[ "$PREVIEW_TTL_HOURS" =~ ^[0-9]+$ ]]; then
  echo "PREVIEW_TTL_HOURS must be a whole number of hours, not '${PREVIEW_TTL_HOURS}'" >&2
  exit 1
fi
if [ -n "$PREVIEW_DOMAIN" ] &&
  ! [[ "$PREVIEW_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; then
  echo "PREVIEW_DOMAIN must be a lowercase DNS name such as preview.example.dev, not '${PREVIEW_DOMAIN}'" >&2
  exit 1
fi
if [ -n "$PREVIEW_PUBLIC_DOMAIN" ] &&
  { ! [[ "$PREVIEW_PUBLIC_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] ||
    [[ "$PREVIEW_PUBLIC_DOMAIN" == *.localhost ]] ||
    [ "$PREVIEW_PUBLIC_DOMAIN" = "$PREVIEW_DOMAIN" ]; }; then
  echo "PREVIEW_PUBLIC_DOMAIN must be a lowercase DNS name such as public.example.dev, not under localhost and not PREVIEW_DOMAIN, not '${PREVIEW_PUBLIC_DOMAIN}'" >&2
  exit 1
fi
for name in PREVIEW_LABEL PREVIEW_PUBLIC_LABEL; do
  if ! [[ "${!name}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$ ]]; then
    echo "${name} must be a label name of letters, digits, . _ -, not '${!name}'" >&2
    exit 1
  fi
done
if [ -n "$PREVIEW_PUBLIC_DOMAIN" ] && [ "$PREVIEW_PUBLIC_LABEL" = "$PREVIEW_LABEL" ]; then
  echo "PREVIEW_PUBLIC_LABEL must not be PREVIEW_LABEL ('${PREVIEW_LABEL}')" >&2
  exit 1
fi

pr_number() {
  if ! [[ "${1:-}" =~ ^[1-9][0-9]{0,6}$ ]]; then
    echo "a PR number, not '${1:-}'" >&2
    usage
  fi
  printf '%s' "$1"
}

mkdir -p "$PREVIEW_HOME"
chmod 700 "$PREVIEW_HOME"
# Only OrbStack's cluster, whatever the shell's current context is.
export KUBECONFIG="${PREVIEW_HOME}/kubeconfig"
if ! env -u KUBECONFIG kubectl config view --raw --minify --context orbstack >"$KUBECONFIG" 2>/dev/null; then
  echo "no orbstack context in the default kubeconfig: is OrbStack's Kubernetes on?" >&2
  exit 1
fi
chmod 600 "$KUBECONFIG"

# The LoadBalancer ports stay on the Mac's 127.0.0.1 only while OrbStack does
# not expose services to the local network.
require_local_only() {
  local expose
  expose="$(orb config get k8s.expose_services)"
  if [ "$expose" != false ]; then
    echo "OrbStack k8s.expose_services is '${expose}': Traefik's ports would be open to the network" >&2
    exit 1
  fi
}

ensure_traefik() {
  local status
  status="$(helm status traefik --namespace "$INGRESS_NAMESPACE" -o json 2>/dev/null | jq -r .info.status || true)"
  [ "$status" = deployed ] && return
  echo "installing Traefik ${TRAEFIK_VERSION} into ${INGRESS_NAMESPACE}"
  # Without the CRD provider the chart needs none of its CRDs, and skipping
  # them leaves nothing cluster-wide behind an uninstall but the IngressClass.
  helm upgrade --install traefik "$TRAEFIK_CHART" --version "$TRAEFIK_VERSION" \
    --namespace "$INGRESS_NAMESPACE" --create-namespace --skip-crds \
    -f "$here/traefik-values.yaml" \
    --set "ports.web.exposedPort=${HTTP_PORT}" \
    --set "ports.websecure.exposedPort=${HTTPS_PORT}" \
    --wait --timeout 5m
}

# Quantities as Kubernetes writes them (128Mi, 1Gi, 512M, bytes) in MiB.
JQ_MI='def mi: capture("^(?<n>[0-9.]+)(?<u>[A-Za-z]*)$")
  | (.n | tonumber) * {"": 1, "k": 1e3, "Ki": 1024, "M": 1e6, "Mi": 1048576,
      "G": 1e9, "Gi": 1073741824, "T": 1e12, "Ti": 1099511627776}[.u] / 1048576;'

require_memory() {
  local namespace="$1" allocatable requested free
  allocatable="${MAX_MEMORY_MI:-$(kubectl get nodes -o json \
    | jq "${JQ_MI} [.items[].status.allocatable.memory | mi] | add | floor")}"
  requested="$(kubectl get pods --all-namespaces -o json | jq "${JQ_MI}
    [.items[] | select(.status.phase != \"Succeeded\" and .status.phase != \"Failed\")
      | .spec.containers[].resources.requests.memory // \"0\" | mi] | add // 0 | ceil")"
  free=$((allocatable - requested))
  if [ "$free" -lt "$PREVIEW_MEMORY_MI" ]; then
    echo "not installing ${namespace}: the node has ${allocatable}Mi, pods request ${requested}Mi," \
      "leaving ${free}Mi, under the ${PREVIEW_MEMORY_MI}Mi one preview needs" >&2
    exit 1
  fi
  echo "memory: ${allocatable}Mi - ${requested}Mi requested = ${free}Mi free, ${PREVIEW_MEMORY_MI}Mi needed"
}

url() {
  if [ -n "$PREVIEW_DOMAIN" ]; then
    printf 'https://%s.%s/' "$1" "$PREVIEW_DOMAIN"
  else
    printf 'http://%s.localhost:%s/' "$1" "$HTTP_PORT"
  fi
}

# The Ingress rules for each host, all to the namespace's api.
ingress_rules() {
  local host service="$1"
  shift
  for host in "$@"; do
    cat <<EOF
    - host: ${host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${service}
                port:
                  number: 3000
EOF
  done
}

readyz() {
  local host="$1.localhost"
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "${host}:${HTTP_PORT}:127.0.0.1" "http://${host}:${HTTP_PORT}/readyz" || true
}

free_port() {
  bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    console.log(s.port); s.stop(true);'
}

# One `up` or `down` per preview at a time, held until this process exits.
# The lock is a symlink to the holder's pid, so taking it is atomic. A lock
# whose holder is gone is replaced only under a second lock, by the one
# process that still finds that holder in it. A busy preview exits 75.
lock_preview() {
  local holder took=""
  lock="${PREVIEW_HOME}/$1.lock"
  if ! ln -s "$$" "$lock" 2>/dev/null; then
    holder="$(readlink "$lock" || true)"
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      echo "$1: busy, pid ${holder} is running up or down on it" >&2
      exit 75
    fi
    if ln -s "$$" "${lock}.reclaim" 2>/dev/null; then
      if [ "$(readlink "$lock" || true)" = "$holder" ]; then
        rm -f -- "$lock"
      fi
      ln -s "$$" "$lock" 2>/dev/null && took=1
      rm -f -- "${lock}.reclaim"
    fi
    if [ -z "$took" ]; then
      echo "$1: busy, another process is taking ${lock}" >&2
      exit 75
    fi
  fi
  trap 'rm -f -- "$lock"' EXIT
}

up() {
  local n namespace host dir head code existing=""
  n="$(pr_number "${1:-}")"
  namespace="pr-${n}"
  host="${namespace}.localhost"
  dir="${PREVIEW_HOME}/${namespace}"
  SECONDS=0

  lock_preview "$namespace"
  require_local_only
  if kubectl get namespace "$namespace" >/dev/null 2>&1; then
    require_preview "$namespace"
    existing=1
  else
    require_memory "$namespace"
  fi
  ensure_traefik

  git -C "$root" fetch -q origin "+refs/pull/${n}/head:refs/preview/${namespace}"
  head="$(git -C "$root" rev-parse "refs/preview/${namespace}")"
  # `sync` passes the head it checked; a push since then is not that head.
  if [ -n "${2:-}" ] && [ "$head" != "$2" ]; then
    echo "${namespace}: head is ${head} now, not the ${2} asked for" >&2
    exit 75
  fi
  if [ -d "${dir}/src" ]; then
    git -C "${dir}/src" checkout -q --force --detach "$head"
  else
    git -C "$root" worktree add -q --detach "${dir}/src" "$head"
  fi
  cp "$root/deploy/kind/up.sh" "${dir}/src/deploy/kind/preview-up.sh"
  echo "${namespace}: head ${head}"

  # A Helm upgrade would run the chart's pre-upgrade upgrade-check, which
  # fails on the rebuilt worker image (preview installs set no worker
  # runtime). A preview keeps no data worth that check, so it is reinstalled.
  if [ -n "$existing" ]; then
    echo "${namespace}: deleting the running preview to install ${head} fresh"
    kubectl delete namespace "$namespace" --wait --timeout 5m
  fi
  kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl label namespace "$namespace" --overwrite werft.dev/preview=true >/dev/null
  kubectl annotate namespace "$namespace" --overwrite \
    "werft.dev/preview-up-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    ${PREVIEW_SOURCE:+"werft.dev/preview-source=${PREVIEW_SOURCE}"} >/dev/null

  CLUSTER_PROVIDER=orbstack KIND_MODEL=fake RELEASE=werft \
    NAMESPACE="$namespace" IMAGE_TAG="$namespace" \
    EXTRA_VALUES="$here/values.yaml" STATE_DIR="${dir}/state" FORWARD_PORT="$(free_port)" \
    "${dir}/src/deploy/kind/preview-up.sh"

  # Traefik's legacy router names come from the Ingress name alone, so the
  # same name in two namespaces collides and the second host answers 404.
  kubectl -n "$namespace" apply -f - >/dev/null <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: preview-${namespace}
spec:
  ingressClassName: preview
  rules:
$(ingress_rules "$(cat "${dir}/state/fullname")-api" "$host" ${PREVIEW_DOMAIN:+"${namespace}.${PREVIEW_DOMAIN}"})
EOF
  kubectl annotate namespace "$namespace" --overwrite "werft.dev/preview-head=${head}" >/dev/null

  for _ in $(seq 1 30); do
    code="$(readyz "$namespace")"
    [ "$code" = 200 ] && break
    sleep 2
  done
  echo "GET http://${host}:${HTTP_PORT}/readyz -> ${code}"
  # The quickstart's demo accounts and data, as scripts/local.sh adds them.
  # The data's exit 2 is its CLI refusing (a head without it, say): said,
  # not fatal.
  local api code_data=0
  api="deploy/$(cat "${dir}/state/fullname")-api"
  kubectl -n "$namespace" exec "$api" -- env DEMO_ACCOUNTS=local \
    bun run apps/control-host/src/api/demo-accounts.ts
  kubectl -n "$namespace" exec "$api" -- env DEMO_ACCOUNTS=local \
    bun run apps/control-host/src/api/demo-data.ts || code_data=$?
  case "$code_data" in
    0) ;;
    2) echo "${namespace}: demo data not added" >&2 ;;
    *) echo "${namespace}: adding the demo data failed" >&2; exit 1 ;;
  esac
  echo "${namespace} up in ${SECONDS}s: $(url "$namespace")"
  [ "$code" = 200 ]
}

# Refuses a namespace this script did not make.
require_preview() {
  local label
  label="$(kubectl get namespace "$1" -o jsonpath='{.metadata.labels.werft\.dev/preview}')"
  if [ "$label" != true ]; then
    echo "namespace $1 exists without the label werft.dev/preview=true: not a preview" >&2
    exit 1
  fi
}

# PREVIEW_REAP_UP_AT is the preview-up-at reap decided on: an `up` since
# then keeps the preview (exit 75).
down() {
  local n namespace dir left app up_at
  n="$(pr_number "${1:-}")"
  namespace="pr-${n}"
  dir="${PREVIEW_HOME}/${namespace}"

  lock_preview "$namespace"
  if kubectl get namespace "$namespace" >/dev/null 2>&1; then
    require_preview "$namespace"
    if [ -n "${PREVIEW_REAP_UP_AT+set}" ]; then
      up_at="$(kubectl get namespace "$namespace" \
        -o jsonpath='{.metadata.annotations.werft\.dev/preview-up-at}')"
      if [ "$up_at" != "$PREVIEW_REAP_UP_AT" ]; then
        echo "${namespace}: up again at ${up_at} after reap read ${PREVIEW_REAP_UP_AT:-none}" >&2
        exit 75
      fi
    fi
    kubectl delete namespace "$namespace" --wait --timeout 5m
  fi
  # The kubelet removes the pods' exited containers within about a minute;
  # until then they hold the images.
  for _ in $(seq 1 24); do
    left="$(docker ps -aq --filter "label=io.kubernetes.pod.namespace=${namespace}" | wc -l | tr -d ' ')"
    [ "$left" = 0 ] && break
    sleep 5
  done
  echo "${namespace}: ${left} containers left"
  for app in "${APPS[@]}"; do
    image="werft-${app}:${namespace}"
    docker image rm "$image" >/dev/null 2>&1 && echo "removed ${image}"
  done
  if [ -d "${dir}/src" ]; then
    git -C "$root" worktree remove --force "${dir}/src"
  fi
  git -C "$root" update-ref -d "refs/preview/${namespace}" 2>/dev/null || true
  rm -rf -- "${PREVIEW_HOME:?}/${namespace:?}"
}

# What the namespace's running containers use, in MiB. OrbStack's cluster has
# no Metrics API, but its pods are containers of the shared Docker engine.
memory_used_mi() {
  local ids
  ids="$(docker ps -q --filter "label=io.kubernetes.pod.namespace=$1")"
  [ -n "$ids" ] || { echo 0; return; }
  # shellcheck disable=SC2086 # one argument per container id
  docker stats --no-stream --format '{{.MemUsage}}' $ids | awk '
    { n = $1; u = n; sub(/[A-Za-z]+$/, "", n); sub(/^[0-9.]+/, "", u)
      total += n * (u == "GiB" ? 1024 : u == "KiB" ? 1 / 1024 : u == "B" ? 1 / 1048576 : 1) }
    END { printf "%d", total }'
}

list() {
  local namespace head up_at memory
  printf '%-10s %-36s %-12s %-20s %-14s %s\n' NAMESPACE URL HEAD UP_AT MEMORY READYZ
  kubectl get namespaces -l werft.dev/preview=true -o json | jq -r '.items[]
    | [.metadata.name,
       (.metadata.annotations["werft.dev/preview-head"] // "-"),
       (.metadata.annotations["werft.dev/preview-up-at"] // "-")] | @tsv' \
    | while IFS=$'\t' read -r namespace head up_at; do
      memory="$(memory_used_mi "$namespace")Mi used"
      printf '%-10s %-36s %-12s %-20s %-14s %s\n' "$namespace" \
        "$(url "$namespace")" "${head:0:12}" "$up_at" "$memory" "$(readyz "$namespace")"
    done
}

# Only labeled pr-<N> namespaces. The TTL needs no GitHub; a PR state that
# cannot be read keeps the preview, never counts as closed.
reap() {
  local rows namespace up_at age n reason state code deleted=() failed=()
  echo "reap $(date -u +%Y-%m-%dT%H:%M:%SZ): TTL ${PREVIEW_TTL_HOURS}h"
  # \x1f, not a tab: read collapses empty fields between whitespace separators.
  rows="$(kubectl get namespaces -l werft.dev/preview=true -o json | jq -r '.items[]
    | (.metadata.annotations["werft.dev/preview-up-at"] // "") as $at
    | [.metadata.name, $at, ($at | try (now - fromdateiso8601 | floor | tostring) catch "")]
    | join("\u001f")')"
  while IFS=$'\x1f' read -r namespace up_at age; do
    [ -n "$namespace" ] || continue
    if ! [[ "$namespace" =~ ^pr-([1-9][0-9]{0,6})$ ]]; then
      echo "${namespace}: kept, not named pr-<N>"
      continue
    fi
    n="${BASH_REMATCH[1]}"
    reason=""
    if [ -z "$age" ]; then
      echo "${namespace}: no readable werft.dev/preview-up-at, TTL not applied"
    elif [ "$age" -gt $((PREVIEW_TTL_HOURS * 3600)) ]; then
      reason="last up $((age / 3600))h ago"
    fi
    if [ -z "$reason" ]; then
      if ! state="$(cd "$root" && GH_NO_UPDATE_NOTIFIER=1 \
        gh pr view "$n" --json state --jq .state 2>"${PREVIEW_HOME}/gh-error" </dev/null)"; then
        echo "${namespace}: kept, GitHub lookup failed: $(tr '\n' ' ' <"${PREVIEW_HOME}/gh-error")"
        continue
      fi
      case "$state" in
        CLOSED | MERGED) reason="PR ${state}" ;;
        OPEN)
          echo "${namespace}: kept, PR OPEN${age:+, last up $((age / 3600))h ago}"
          continue
          ;;
        *)
          echo "${namespace}: kept, unexpected PR state '${state}'"
          continue
          ;;
      esac
    fi
    echo "${namespace}: deleting, ${reason}"
    code=0
    PREVIEW_REAP_UP_AT="$up_at" "$here/preview.sh" down "$n" </dev/null || code=$?
    case "$code" in
      0) deleted+=("$namespace") ;;
      75) echo "${namespace}: kept, see above" ;;
      *) failed+=("$namespace") ;;
    esac
  done <<<"$rows"
  echo "reap deleted: ${deleted[*]:-none}${failed[*]:+, failed: ${failed[*]}}"
  [ "${#failed[@]}" = 0 ]
}

COMMENT_MARKER='<!-- werft-preview-local -->'

# Writes the pull request's one sync comment (the marker, by this gh user),
# editing it after the first. A write GitHub does not take is kept in
# sync/pr-<N>.comment for the next run to send again (send_pending), since
# a run that finds the preview as it left it brings nothing up and writes
# nothing else; a later write replaces it.
comment() {
  local n="$1" body id pending="${PREVIEW_HOME}/sync/pr-$1.comment"
  body="${COMMENT_MARKER}
### PR 미리보기: $2"
  # A list that cannot be read is a failed write, not "no comment yet": a
  # new one would leave the old one standing.
  if id="$(cd "$root" && gh api --paginate "repos/{owner}/{repo}/issues/${n}/comments" \
    --jq ".[] | select(.user.login == \"${gh_user}\" and (.body | startswith(\"${COMMENT_MARKER}\"))) | .id" \
    </dev/null | tail -n 1)" &&
    if [ -n "$id" ]; then
      (cd "$root" && gh api -X PATCH "repos/{owner}/{repo}/issues/comments/${id}" -f body="$body" --jq .id </dev/null) >/dev/null
    else
      (cd "$root" && gh api "repos/{owner}/{repo}/issues/${n}/comments" -f body="$body" --jq .id </dev/null) >/dev/null
    fi; then
    rm -f -- "$pending"
  else
    echo "pr-${n}: writing the PR comment failed" >&2
    # "Bringing up" is not held: the same run writes how it ended, and an
    # up that ends in 75 builds nothing until a later run says so itself.
    [[ "$2" == "올리는 중"* ]] && return
    printf '%s\n' "$2" >"${pending}.tmp"
    mv -f -- "${pending}.tmp" "$pending"
  fi
}

# Sends again each comment a run before could not write, without bringing
# anything up; $1 is " <N> <N> ", the pull requests still labeled and open
# or whose down did not go through. Called after sync's downs, so any other
# has no label preview left: it is told so, whatever the held comment said.
# A held "up" is sent only while its label preview is there: reap or a down
# by hand may have taken it while GitHub could not be read, and the rest of
# the run corrects nothing when the label's events cannot be read.
send_pending() {
  local pending n body source
  for pending in "${PREVIEW_HOME}/sync"/pr-*.comment; do
    [[ "$(basename -- "$pending")" =~ ^pr-([1-9][0-9]{0,6})\.comment$ ]] || continue
    n="${BASH_REMATCH[1]}"
    body="$(cat -- "$pending")"
    if [[ "$1" != *" ${n} "* ]]; then
      [[ "$body" == 내려갔다* ]] || body="내려갔다

$(date -u '+%Y-%m-%d %H:%M UTC') 전에 미리보기가 없어졌다. 라벨 \`${PREVIEW_LABEL}\`가 없거나 PR이 닫혔다. 다시 보려면 열린 PR에 라벨을 붙인다."
    elif [[ "$body" == "떠 있다"* ]]; then
      source="$(kubectl get namespace "pr-${n}" \
        -o jsonpath='{.metadata.annotations.werft\.dev/preview-source}' --ignore-not-found)" || continue
      [ "$source" = label ] || body="내려갔다

$(date -u '+%Y-%m-%d %H:%M UTC') 전에 미리보기가 없어졌다(마지막으로 띄운 지 ${PREVIEW_TTL_HOURS}시간이 지났거나 손으로 내렸다). 다시 보려면 새 커밋을 push하거나 라벨 \`${PREVIEW_LABEL}\`를 다시 붙인다."
    fi
    comment "$n" "$body"
  done
}

# When the label was last put on the pull request and by whom:
# "<created_at> <login>", or nothing.
last_labeled() {
  local events
  events="$(cd "$root" && gh api --paginate "repos/{owner}/{repo}/issues/$1/events" \
    --jq ".[] | select(.event == \"labeled\" and .label.name == \"${PREVIEW_LABEL}\") | \"\(.created_at) \(.actor.login)\"" \
    </dev/null)" || return 1
  tail -n 1 <<<"$events"
}

# Replaces sync's record of pull request $1 in one rename.
record() {
  printf '%s\n' "$2" >"${PREVIEW_HOME}/sync/pr-$1.tmp"
  mv -f -- "${PREVIEW_HOME}/sync/pr-$1.tmp" "${PREVIEW_HOME}/sync/pr-$1"
}

# Everyone but this Mac's own GitHub login who may push to the repository.
other_pushers() {
  (cd "$root" && gh api --paginate "repos/{owner}/{repo}/collaborators" \
    --jq ".[] | select(.permissions.push and .login != \"${gh_user}\") | .login" </dev/null)
}

# A labeled open pull request from a branch of this repository gets a
# preview of its head, brought up again when the head moves; taking the
# label off or closing the pull request downs it. Previews brought up by
# hand (no werft.dev/preview-source=label) are left to reap.
#
# The previews run the pull request's code on this Mac (its Dockerfiles,
# chart and scripts), so only a label this Mac's own GitHub login put on
# counts, and nothing runs while anyone else may push to the repository.
#
# PREVIEW_HOME/sync/pr-<N> holds "<head> <up|failed|refused|gone>
# <labeled at>": a head is tried once per label, so a failing head is not
# rebuilt every run, and putting the label on again asks again. A preview
# gone at the head it was up at (reap's TTL, a `down` by hand) keeps its
# label and comes back on a push or a new label. Anything GitHub does not
# answer changes nothing; a comment it did not take is written again on the
# next run (comment). The outside routes are sync_public()'s.
sync() {
  local pulls n head cross public state_file tried status tried_at ns_head source
  local labeled label_at actor code namespace up_at count refusal rows others
  local wanted=" " kept="" public_wanted=" " heads=" " LIMIT=500
  lock_preview sync
  echo "sync $(date -u +%Y-%m-%dT%H:%M:%SZ): label ${PREVIEW_LABEL}"
  mkdir -p "${PREVIEW_HOME}/sync"
  # A list that cannot be trusted closes every outside route: opening one
  # again costs an apply, not a build.
  if ! gh_user="$(cd "$root" && gh api user --jq .login </dev/null)" ||
    ! others="$(other_pushers)" ||
    ! pulls="$(cd "$root" && GH_NO_UPDATE_NOTIFIER=1 gh pr list --label "$PREVIEW_LABEL" \
      --state open --limit "$LIMIT" --json number,headRefOid,isCrossRepository,labels \
      --jq ".[] | [.number, .headRefOid, .isCrossRepository,
        ((.labels // []) | any(.name == \"${PREVIEW_PUBLIC_LABEL}\"))] | @tsv" </dev/null)"; then
    echo "sync: GitHub could not be read; no preview changed"
    close_all_public || true
    reap
    return
  fi
  count="$(grep -c . <<<"$pulls" || true)"
  if [ "$count" -ge "$LIMIT" ]; then
    echo "sync: ${count} labeled pull requests, the list may be cut; no preview changed"
    close_all_public || true
    reap
    return
  fi
  while IFS=$'\t' read -r n head cross public; do
    [[ "$n" =~ ^[1-9][0-9]{0,6}$ ]] || continue
    wanted+="${n} "
    heads+="${n}=${head} "
    [ "$public" = true ] && [ "$cross" = false ] && public_wanted+="${n} "
  done <<<"$pulls"

  # First what is no longer wanted (label off, closed, merged), so a long
  # build below does not hold it up. Owner and up time come from one read:
  # `down` keeps a namespace whose up time changed since (75), so one
  # brought up again in between, by hand or not, stays.
  rows="$(kubectl get namespaces -l werft.dev/preview=true -o json | jq -r '.items[]
    | select(.metadata.annotations["werft.dev/preview-source"] == "label")
    | [.metadata.name, (.metadata.annotations["werft.dev/preview-up-at"] // "")]
    | join("\u001f")')"
  while IFS=$'\x1f' read -r namespace up_at; do
    [[ "$namespace" =~ ^pr-([1-9][0-9]{0,6})$ ]] || continue
    n="${BASH_REMATCH[1]}"
    [[ "$wanted" == *" ${n} "* ]] && continue
    echo "${namespace}: no longer labeled or open; down"
    code=0
    PREVIEW_REAP_UP_AT="$up_at" "$here/preview.sh" down "$n" </dev/null || code=$?
    case "$code" in
      0) comment "$n" "내려갔다

$(date -u '+%Y-%m-%d %H:%M UTC')에 내렸다. 라벨 \`${PREVIEW_LABEL}\`가 없거나 PR이 닫혔다. 다시 보려면 열린 PR에 라벨을 붙인다." ;;
      75) echo "${namespace}: kept, see above"; kept+="${n} " ;;
      *) echo "${namespace}: down failed" >&2; kept+="${n} " ;;
    esac
  done <<<"$rows"
  for state_file in "${PREVIEW_HOME}/sync"/pr-*; do
    [[ "$(basename -- "$state_file")" =~ ^pr-([1-9][0-9]{0,6})$ ]] || continue
    n="${BASH_REMATCH[1]}"
    [[ "$wanted$kept" == *" ${n} "* ]] && continue
    rm -f -- "$state_file" "${state_file}.log"
  done
  for state_file in "${PREVIEW_HOME}/sync"/pr-*.public; do
    [[ "$(basename -- "$state_file")" =~ ^pr-([1-9][0-9]{0,6})\.public$ ]] || continue
    [[ "$public_wanted" == *" ${BASH_REMATCH[1]} "* ]] || rm -f -- "$state_file"
  done
  send_pending "$wanted$kept"
  sync_public close

  while IFS=$'\t' read -r n head cross public; do
    [ -n "$n" ] || continue
    if ! [[ "$n" =~ ^[1-9][0-9]{0,6}$ && "$head" =~ ^[0-9a-f]{40}$ ]]; then
      echo "sync: skipped a row that is not a pull request number and head: ${n} ${head}"
      continue
    fi
    state_file="${PREVIEW_HOME}/sync/pr-${n}"
    tried="" status="" tried_at=""
    # A record cut short reads as part of one, or none.
    [ -f "$state_file" ] && { read -r tried status tried_at <"$state_file" || true; }
    ns_head="$(kubectl get namespace "pr-${n}" -o jsonpath='{.metadata.annotations.werft\.dev/preview-head}' 2>/dev/null || true)"
    source="$(kubectl get namespace "pr-${n}" -o jsonpath='{.metadata.annotations.werft\.dev/preview-source}' 2>/dev/null || true)"
    if [ "$ns_head" = "$head" ] && [ "$source" = label ] && [ "$status" = up ]; then
      continue
    fi
    if ! labeled="$(last_labeled "$n")" || [ -z "$labeled" ]; then
      echo "pr-${n}: the label's events could not be read; nothing changed"
      continue
    fi
    label_at="${labeled%% *}"
    actor="${labeled#* }"
    if [ "$tried" = "$head" ] && [ "$tried_at" = "$label_at" ]; then
      if [ "$status" = up ] && [ -z "$ns_head" ]; then
        record "$n" "$head gone $label_at"
        echo "pr-${n}: gone at ${head:0:12}; up again on a push or a new label"
        comment "$n" "내려갔다

$(date -u '+%Y-%m-%d %H:%M UTC') 전에 미리보기가 없어졌다(마지막으로 띄운 지 ${PREVIEW_TTL_HOURS}시간이 지났거나 손으로 내렸다). 다시 보려면 새 커밋을 push하거나 라벨 \`${PREVIEW_LABEL}\`를 다시 붙인다."
      fi
      continue
    fi
    refusal=""
    if [ "$cross" != false ]; then
      refusal="fork의 브랜치다. 이 저장소의 브랜치에서 연 PR만 띄운다."
    elif [ "$actor" != "$gh_user" ]; then
      refusal="라벨 \`${PREVIEW_LABEL}\`를 마지막으로 붙인 ${actor}가 미리보기를 띄우는 Mac의 GitHub 로그인이 아니다. PR 코드가 그 Mac에서 돌기 때문에 그 로그인이 붙인 라벨만 센다."
    elif [ -n "$others" ]; then
      refusal="이 저장소에 push할 수 있는 사람이 미리보기를 띄우는 Mac의 GitHub 로그인 말고도 있다($(tr '\n' ' ' <<<"$others" | sed 's/ $//')). PR 코드가 그 Mac에서 돌기 때문에 그동안은 띄우지 않는다."
    fi
    if [ -n "$refusal" ]; then
      record "$n" "$head refused $label_at"
      echo "pr-${n}: refused at ${head:0:12}: ${refusal}"
      comment "$n" "거절했다

${refusal}"
      continue
    fi
    echo "pr-${n}: up at ${head:0:12}, labeled by ${actor} at ${label_at}"
    comment "$n" "올리는 중

head \`${head}\`를 빌드해 띄운다. 몇 분 걸린다."
    code=0
    PREVIEW_SOURCE=label "$here/preview.sh" up "$n" "$head" </dev/null \
      >"${PREVIEW_HOME}/sync/pr-${n}.log" 2>&1 || code=$?
    case "$code" in
      0)
        record "$n" "$head up $label_at"
        echo "pr-${n}: up at ${head:0:12}"
        comment "$n" "$(up_body "$n" "$head")"
        ;;
      75)
        echo "pr-${n}: busy or the head moved; the next run tries again: $(tail -n 1 "${PREVIEW_HOME}/sync/pr-${n}.log")"
        ;;
      *)
        record "$n" "$head failed $label_at"
        echo "pr-${n}: up failed (exit ${code}); see ${PREVIEW_HOME}/sync/pr-${n}.log"
        comment "$n" "실패했다

head \`${head}\`를 띄우지 못했다(exit ${code}). 로그는 미리보기를 띄우는 Mac에 있다. 새 커밋을 push하거나 라벨 \`${PREVIEW_LABEL}\`를 다시 붙이면 다시 시도한다."
        ;;
    esac
  done <<<"$pulls"
  sync_public open
  reap
}

# The outside route of preview pr-<N> is its Ingress preview-public-pr-<N>,
# labeled werft.dev/preview-public=true, with the one Host
# pr-<N>.<PREVIEW_PUBLIC_DOMAIN>. The namespace carries it, so a down, reap
# or reinstall takes it too.
PUBLIC_SELECTOR=werft.dev/preview-public=true

close_all_public() {
  kubectl delete ingress -A -l "$PUBLIC_SELECTOR" --ignore-not-found >/dev/null && return 0
  echo "sync: deleting the outside routes failed" >&2
  return 1
}

# Whether preview pr-$1 may have an outside route, from what this run read:
# both labels on an open PR from this repository, nobody else may push, and
# the namespace is the label's preview at the PR head sync recorded as up
# (an up that fails after writing preview-head leaves a failed record).
public_ready() {
  local n="$1" head
  [[ "$public_wanted" == *" ${n} "* && -z "$others" ]] || return 1
  [[ "$heads" =~ \ ${n}=([0-9a-f]{40})\  ]] || return 1
  head="${BASH_REMATCH[1]}"
  [ "$(recorded_up "$n")" = "$head" ] &&
    [ "$(kubectl get namespace "pr-${n}" -o jsonpath='{.metadata.annotations.werft\.dev/preview-source}' 2>/dev/null)" = label ]
}

# The head sync recorded as up for pr-$1, while the namespace is at it.
recorded_up() {
  local tried status
  [ -f "${PREVIEW_HOME}/sync/pr-$1" ] || return 0
  read -r tried status _ <"${PREVIEW_HOME}/sync/pr-$1" || true
  [ "$status" = up ] &&
    [ "$(kubectl get namespace "pr-$1" -o jsonpath='{.metadata.annotations.werft\.dev/preview-head}' 2>/dev/null)" = "$tried" ] &&
    printf '%s' "$tried"
  return 0
}

# The login in front of the outside domain answers a request without its
# cookie with a 302 to https://<team>.cloudflareaccess.com/. Anything else
# (the preview itself, a 404, another redirect, no answer) means that login
# is not there, and the route stays closed. Run from this machine, it does
# not prove what an outside client gets, only that the front is not missing.
gate_ok() {
  local out expected='^302 https://[a-z0-9-]+\.cloudflareaccess\.com/'
  # -q first: no ~/.curlrc to turn certificate checks off.
  out="$(curl -q -sS -o /dev/null --max-time 5 -w '%{http_code} %{redirect_url}' \
    "https://pr-$1.${PREVIEW_PUBLIC_DOMAIN}/readyz" 2>/dev/null)" || return 1
  [[ "$out" =~ $expected ]]
}

# Reads the last time the outside label went on or came off into the
# caller's event (labeled or unlabeled), label_at and actor. Fails when the
# events cannot be read or hold none.
public_event() {
  local events
  events="$(cd "$root" && gh api --paginate "repos/{owner}/{repo}/issues/$1/events" \
    --jq ".[] | select((.event == \"labeled\" or .event == \"unlabeled\") and .label.name == \"${PREVIEW_PUBLIC_LABEL}\") | \"\(.event) \(.created_at) \(.actor.login)\"" \
    </dev/null)" || return 1
  read -r event label_at actor <<<"$(tail -n 1 <<<"$events")"
  [ -n "$event" ]
}

# The one rule both opening and keeping a route follow: the outside label's
# last event (as public_event read it) is a labeled by this machine's own
# login.
public_label_ours() {
  [ -n "$gh_user" ] && [ "$event" = labeled ] && [ "$actor" = "$gh_user" ]
}

PUBLIC_OPEN_LINE="바깥 경로: 열려 있다(오너 로그인 뒤)."

# Rewrites the up comment of preview pr-$1 with the outside route's line $2.
# PREVIEW_HOME/sync/pr-<N>.open marks a comment that says the route is open.
public_comment() {
  local head
  head="$(kubectl get namespace "pr-$1" -o jsonpath='{.metadata.annotations.werft\.dev/preview-head}' 2>/dev/null)" || true
  if [ -n "$head" ]; then
    comment "$1" "$(up_body "$1" "$head" "$2")"
  fi
  if [[ "$2" == "$PUBLIC_OPEN_LINE"* ]]; then
    : >"${PREVIEW_HOME}/sync/pr-$1.open"
  else
    rm -f -- "${PREVIEW_HOME}/sync/pr-$1.open"
  fi
}

# A comment that still says open while no route is (the feature turned off,
# or every route closed in a run that could not read GitHub) says closed
# once, in the next run that can write it. $open is " pr-<N> ..." of the
# routes there now.
settle_public() {
  local marker n
  for marker in "${PREVIEW_HOME}/sync"/pr-*.open; do
    [[ "$(basename -- "$marker")" =~ ^pr-([1-9][0-9]{0,6})\.open$ ]] || continue
    n="${BASH_REMATCH[1]}"
    [[ "$open" == *" pr-${n} "* ]] && continue
    if [ -n "$(recorded_up "$n")" ]; then
      public_comment "$n" "바깥 경로: 닫혀 있다."
    else
      rm -f -- "$marker"
    fi
  done
}

# close (before the builds): deletes each outside route this run does not
# keep. open (after them): adds the route of each ready preview whose last
# outside-label event is a labeled by this machine's own login, once the
# login in front answers. The domain's value never goes in a comment or the
# log; a comment only says the route is open or closed.
sync_public() {
  local rows namespace name hosts n event label_at actor line open=" " service
  if [ -z "$PREVIEW_PUBLIC_DOMAIN" ]; then
    # A comment says closed only once the routes are gone.
    if [ "$1" = close ] && close_all_public; then
      settle_public
    fi
    return 0
  fi
  rows="$(kubectl get ingress -A -l "$PUBLIC_SELECTOR" -o json | jq -r '.items[]
    | [.metadata.namespace, .metadata.name, ([.spec.rules[]?.host] | join(" "))]
    | join("\u001f")')" || { close_all_public || true; return 0; }
  if [ "$1" = close ]; then
    while IFS=$'\x1f' read -r namespace name hosts; do
      [ -n "$namespace" ] || continue
      n=""
      [[ "$namespace" =~ ^pr-([1-9][0-9]{0,6})$ ]] && n="${BASH_REMATCH[1]}"
      line=""
      if [ -z "$n" ] || [ "$name" != "preview-public-${namespace}" ] ||
        [ "$hosts" != "${namespace}.${PREVIEW_PUBLIC_DOMAIN}" ]; then
        echo "${namespace}/${name}: not this domain's outside route; deleted"
      elif ! public_ready "$n"; then
        echo "${namespace}: outside label off, or not the recorded up preview; outside route closed"
        line="바깥 경로: 닫혀 있다."
      elif ! public_event "$n"; then
        echo "${namespace}: the outside label's events could not be read; outside route closed"
        line="바깥 경로: 닫혀 있다."
      elif ! public_label_ours; then
        echo "${namespace}: the outside label's last event is ${event} by ${actor}, not a labeled by this machine's login; outside route closed"
        line="바깥 경로: 닫혀 있다."
      elif ! gate_ok "$n"; then
        echo "${namespace}: the login in front of the outside domain did not answer as expected; outside route closed"
        line="바깥 경로: 닫았다. 앞단의 로그인 확인에 실패했다."
      else
        continue
      fi
      kubectl delete ingress -n "$namespace" "$name" --ignore-not-found >/dev/null ||
        { echo "${namespace}: deleting ${name} failed" >&2; continue; }
      [ -n "$line" ] && [ -n "$(recorded_up "$n")" ] && public_comment "$n" "$line"
    done <<<"$rows"
    return 0
  fi
  while IFS=$'\x1f' read -r namespace name hosts; do
    open+="${namespace} "
  done <<<"$rows"
  for n in $public_wanted; do
    [[ "$open" == *" pr-${n} "* ]] && continue
    public_ready "$n" || continue
    if ! service="$(cat "${PREVIEW_HOME}/pr-${n}/state/fullname" 2>/dev/null)-api" || [ "$service" = -api ]; then
      echo "pr-${n}: no ${PREVIEW_HOME}/pr-${n}/state/fullname; outside route not opened" >&2
      continue
    fi
    if ! public_event "$n"; then
      echo "pr-${n}: the outside label's events could not be read; outside route not opened"
      continue
    fi
    if ! public_label_ours; then
      echo "pr-${n}: the outside label's last event is ${event} by ${actor}, not a labeled by this machine's login; outside route not opened"
      # Someone else's label is said once per label; an unlabeled says nothing.
      if [ "$event" = labeled ] &&
        [ "$(cat "${PREVIEW_HOME}/sync/pr-${n}.public" 2>/dev/null)" != "$label_at" ]; then
        printf '%s\n' "$label_at" >"${PREVIEW_HOME}/sync/pr-${n}.public"
        public_comment "$n" "바깥 경로: 열지 않았다. 라벨 \`${PREVIEW_PUBLIC_LABEL}\`를 마지막으로 붙인 ${actor}가 미리보기를 띄우는 기계의 GitHub 로그인이 아니다."
      fi
      continue
    fi
    if ! gate_ok "$n"; then
      echo "pr-${n}: the login in front of the outside domain did not answer as expected; outside route not opened"
      continue
    fi
    if ! kubectl apply -f - >/dev/null <<EOF; then
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: preview-public-pr-${n}
  namespace: pr-${n}
  labels:
    ${PUBLIC_SELECTOR%=*}: "true"
spec:
  ingressClassName: preview
  rules:
$(ingress_rules "$service" "pr-${n}.${PREVIEW_PUBLIC_DOMAIN}")
EOF
      echo "pr-${n}: adding the outside route failed" >&2
      continue
    fi
    rm -f -- "${PREVIEW_HOME}/sync/pr-${n}.public"
    open+="pr-${n} "
    echo "pr-${n}: outside route open"
    public_comment "$n" "${PUBLIC_OPEN_LINE} 주소는 이 댓글에 적지 않는다. 라벨 \`${PREVIEW_PUBLIC_LABEL}\`를 떼면 다음 실행에서 바깥 경로만 닫힌다."
  done
  settle_public
}

up_body() {
  cat <<EOF
떠 있다

- 주소: $(url "pr-$1")
- head: \`$2\`
- 데모 계정: \`demo-owner@example.test\`(owner), \`demo-member@example.test\`(member). 비밀번호는 [quickstart](https://github.com/JeongJaeSoon/werft/blob/main/docs/quickstart.md)의 "웹 콘솔 데모 계정"과 같다.
- 새 커밋을 push하면 다음 실행(1분 안팎)에서 새 head를 빌드해 다시 띄운다. 라벨 \`${PREVIEW_LABEL}\`를 떼거나 PR을 닫으면 내려간다. 마지막으로 띄운 지 ${PREVIEW_TTL_HOURS}시간이 지나면 내려간다. 라벨은 남으니, 다시 보려면 push하거나 라벨을 다시 붙인다.${3:+
- $3}

fake 모델이라 실제 모델·GitHub·Slack에는 닿지 않는다.
EOF
}

case "${1:-}" in
  up) up "${2:-}" "${3:-}" ;;
  down) down "${2:-}" ;;
  list) list ;;
  reap) reap ;;
  sync) sync ;;
  *) usage ;;
esac
