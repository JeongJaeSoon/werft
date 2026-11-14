#!/usr/bin/env bash
# Brings a pull request up as a preview on OrbStack's built-in Kubernetes:
# its own namespace pr-<N>, at http://pr-<N>.localhost:18180/ through one
# Traefik shared by every preview. Browsers resolve *.localhost to loopback
# and count http on it as a secure origin, so the console's Secure
# __Host- session cookie is set there, and each preview's host keeps its
# own: signing in to one does not sign another out.
#
#   deploy/preview/preview.sh up <N>    check the PR head out, build its images
#                                       (tag pr-<N>), install or upgrade, and
#                                       read /readyz through Traefik
#   deploy/preview/preview.sh down <N>  delete the namespace, the image tags
#                                       and the checkout
#   deploy/preview/preview.sh list      the previews: URL, head, memory in use,
#                                       /readyz
#   deploy/preview/preview.sh reap      `down` every preview whose last `up`
#                                       is older than the TTL or whose PR is
#                                       closed or merged
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
set -euo pipefail

PREVIEW_HOME="${PREVIEW_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/werft/preview}"
PREVIEW_MEMORY_MI="${PREVIEW_MEMORY_MI:-2560}"
PREVIEW_TTL_HOURS="${PREVIEW_TTL_HOURS:-24}"
INGRESS_NAMESPACE=preview-ingress
TRAEFIK_CHART=oci://ghcr.io/traefik/helm/traefik
TRAEFIK_VERSION=42.1.3
HTTP_PORT=18180
HTTPS_PORT=18543
APPS=(control-host egress-proxy worker)

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

usage() {
  echo "usage: $0 up <PR number> | down <PR number> | list | reap" >&2
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
  printf 'http://%s.localhost:%s/' "$1" "$HTTP_PORT"
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
  local n namespace host dir head code
  n="$(pr_number "${1:-}")"
  namespace="pr-${n}"
  host="${namespace}.localhost"
  dir="${PREVIEW_HOME}/${namespace}"
  SECONDS=0

  lock_preview "$namespace"
  require_local_only
  if kubectl get namespace "$namespace" >/dev/null 2>&1; then
    require_preview "$namespace"
  else
    require_memory "$namespace"
  fi
  ensure_traefik

  git -C "$root" fetch -q origin "+refs/pull/${n}/head:refs/preview/${namespace}"
  head="$(git -C "$root" rev-parse "refs/preview/${namespace}")"
  if [ -d "${dir}/src" ]; then
    git -C "${dir}/src" checkout -q --force --detach "$head"
  else
    git -C "$root" worktree add -q --detach "${dir}/src" "$head"
  fi
  cp "$root/deploy/kind/up.sh" "${dir}/src/deploy/kind/preview-up.sh"
  echo "${namespace}: head ${head}"

  kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl label namespace "$namespace" --overwrite werft.dev/preview=true >/dev/null
  kubectl annotate namespace "$namespace" --overwrite \
    "werft.dev/preview-up-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null

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
    - host: ${host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: $(cat "${dir}/state/fullname")-api
                port:
                  number: 3000
EOF
  kubectl annotate namespace "$namespace" --overwrite "werft.dev/preview-head=${head}" >/dev/null

  for _ in $(seq 1 30); do
    code="$(readyz "$namespace")"
    [ "$code" = 200 ] && break
    sleep 2
  done
  echo "GET $(url "$namespace")readyz -> ${code}"
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

case "${1:-}" in
  up) up "${2:-}" ;;
  down) down "${2:-}" ;;
  list) list ;;
  reap) reap ;;
  *) usage ;;
esac
