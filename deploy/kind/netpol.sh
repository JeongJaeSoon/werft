#!/usr/bin/env bash
# Whether the chart's NetworkPolicies are enforced on a real cluster, by the
# CNI kind ships (kindnet), with nothing laid over it. Heavier than the
# `egress` step of smoke.sh, which runs on every pull request and checks the
# same Pods once; this one is dispatched or triggered by the policy's own path.
#
#   1. enforced    a Pod with the worker labels reaches the egress proxy
#                  (3128, 3129, and an HTTP request through 3128 answers) and
#                  nothing else: api 3000, authorizer 3100, postgres,
#                  localstack, DNS, the metadata address, kube-apiserver (its
#                  Service and the node's 6443) and an outside address are
#                  blocked. An unlabelled Pod gets the opposite answers, so
#                  the network itself is up and the outside address is
#                  reachable at all.
#   2. mutation    helm upgrade with networkPolicy.enabled=false: what step 1
#                  blocked now answers. The blocks were the policy's doing.
#   3. restored    helm upgrade with it back on: step 1's answers again.
#
# 169.254.169.254 answers on a CI runner and not on a laptop, with or without
# a policy. The unlabelled Pod tells which: with the policy the worker Pod is
# blocked either way, and without it answers like the unlabelled one.
#
#   deploy/kind/netpol.sh        run all of it; delete the cluster and registry
#                                at the end if this run created them
#   deploy/kind/netpol.sh down   delete them (up.sh down)
#
# Settings, besides up.sh's (REGISTRY_PORT, the CI mirror):
#   CLUSTER_NAME         default werft-netpol
#   KEEP_CLUSTER=1       leave the cluster up for a look afterwards
#   PROBE_IMAGE          busybox for the probes, by digest
#   OUTSIDE_ADDRESS      host:port the "outside" probe dials (default 1.1.1.1:443)
#   SETTLE_SEC           how long a changed policy may take to show (default 90)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
export CLUSTER_NAME="${CLUSTER_NAME:-werft-netpol}"
export KIND_MODEL=none
export NAMESPACE="${NAMESPACE:-werft}"
export RELEASE="${RELEASE:-werft}"
if ! [[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]]; then
  echo "NAMESPACE must be a Kubernetes namespace name, not '${NAMESPACE}'" >&2
  exit 1
fi
export STATE_DIR="${STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/werft/kind/${CLUSTER_NAME}}"
export KUBECONFIG="${STATE_DIR}/kubeconfig"
PROBE_IMAGE="${PROBE_IMAGE:-busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662}"
OUTSIDE_ADDRESS="${OUTSIDE_ADDRESS:-1.1.1.1:443}"
SETTLE_SEC="${SETTLE_SEC:-90}"

if [ "${1:-}" = down ]; then
  exec "$here/up.sh" down
fi

fullname="$RELEASE"
case "$RELEASE" in *werft*) ;; *) fullname="${RELEASE}-werft" ;; esac
fullname="${fullname:0:50}"
fullname="${fullname%-}"
k() { kubectl -n "$NAMESPACE" "$@"; }
step() { current="$1"; echo; echo "== k8s-netpol: $*"; }
pass() { echo "PASS ${current}"; }
fail() { echo "FAIL ${current}: $*" >&2; exit 1; }

# A kind or docker error must not read as "no cluster": the teardown below
# would then delete a cluster this run did not create.
clusters="$(kind get clusters)"
created=""
printf '%s\n' "$clusters" | grep -qx "$CLUSTER_NAME" || created=1
finish() {
  local status=$?
  if [ "$status" != 0 ] && [ -f "$KUBECONFIG" ]; then
    echo "== k8s-netpol: state after the failure" >&2
    k get deploy,pods,networkpolicy -o wide >&2 || true
    k get pods --show-labels >&2 || true
  fi
  if [ -f "$KUBECONFIG" ]; then
    k delete pod netpol-worker netpol-control --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  if [ -n "$created" ] && [ "${KEEP_CLUSTER:-}" != 1 ]; then
    "$here/up.sh" down || true
  fi
  exit "$status"
}
trap finish EXIT

step install
"$here/up.sh"
echo "kind: $(kind version)"
echo "kindnet image: $(kubectl -n kube-system get ds kindnet -o jsonpath='{.spec.template.spec.containers[0].image}')"
pass

installation="$(k get "deploy/${fullname}-scheduler" \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="EXECUTION_INSTALLATION_ID")].value}')"
[ -n "$installation" ] || fail "the scheduler names no installation"

cluster_ip() { kubectl -n "$1" get svc "$2" -o jsonpath='{.spec.clusterIP}'; }
proxy_svc="$(k get svc -l app.kubernetes.io/component=egress-proxy -o name | head -n 1)"
proxy="$(cluster_ip "$NAMESPACE" "${proxy_svc#service/}")"
api="$(cluster_ip "$NAMESPACE" "${fullname}-api")"
authorizer="$(cluster_ip "$NAMESPACE" "${fullname}-api-authorizer")"
postgres="$(cluster_ip "$NAMESPACE" postgres)"
localstack="$(cluster_ip "$NAMESPACE" localstack)"
dns="$(cluster_ip kube-system kube-dns)"
apiserver="$(cluster_ip default kubernetes)"
node_ip="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
outside_host="${OUTSIDE_ADDRESS%:*}"
outside_port="${OUTSIDE_ADDRESS##*:}"

# Addresses, not names: the probes themselves must not need DNS.
probe_pod() {
  local name="$1" labels="$2"
  k delete pod "$name" --ignore-not-found --wait >/dev/null
  k apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  labels: {${labels}}
spec:
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 0
  restartPolicy: Never
  securityContext: {runAsNonRoot: true, runAsUser: 65534, runAsGroup: 65534}
  containers:
    - name: probe
      image: ${PROBE_IMAGE}
      command: ["sleep", "1200"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: {drop: [ALL]}
EOF
  k wait --for=condition=Ready "pod/${name}" --timeout=120s >/dev/null
}
probe_pod netpol-worker "app.kubernetes.io/part-of: werft, app.kubernetes.io/component: worker, werft.installation: \"${installation}\""
probe_pod netpol-control "app: netpol-probe"
k get pod netpol-worker netpol-control --show-labels

bad=0
# expect <pod> <what> <open|blocked> <command...>: polls until the answer is the
# wanted one (a policy change takes a moment to reach the node), then prints it.
expect() {
  local pod="$1" what="$2" want="$3" got deadline
  shift 3
  deadline=$((SECONDS + SETTLE_SEC))
  while :; do
    got=blocked
    k exec "$pod" -- timeout 8 "$@" >/dev/null 2>&1 && got=open
    [ "$got" = "$want" ] && break
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep 2
  done
  local verdict=ok
  [ "$got" = "$want" ] || { verdict=WRONG; bad=1; }
  printf '%-14s %-38s %-8s (want %-7s) %s\n' "$pod" "$what" "$got" "$want" "$verdict"
}
tcp() { echo nc -z -w 3 "$1" "$2"; }
# An HTTP answer of any status, 403 included, proves the path to the proxy.
via_proxy="http_proxy=http://${proxy}:3128 wget -S -T 4 -O /dev/null http://localstack:4566/ 2>&1 | grep -q 'HTTP/'"

# The same targets for both Pods: `w_*` is the worker Pod's wanted answer,
# `c_*` the unlabelled Pod's.
matrix() {
  local w_proxy="$1" w_rest="$2" c_proxy="$3" c_rest="$4" c_authz="$5"
  expect netpol-worker "egress-proxy ${proxy}:3128" "$w_proxy" $(tcp "$proxy" 3128)
  expect netpol-worker "egress-proxy ${proxy}:3129" "$w_proxy" $(tcp "$proxy" 3129)
  expect netpol-worker "HTTP through ${proxy}:3128" "$w_proxy" sh -c "$via_proxy"
  expect netpol-worker "api ${api}:3000" "$w_rest" $(tcp "$api" 3000)
  expect netpol-worker "authorizer ${authorizer}:3100" "$w_rest" $(tcp "$authorizer" 3100)
  expect netpol-worker "postgres ${postgres}:5432" "$w_rest" $(tcp "$postgres" 5432)
  expect netpol-worker "localstack ${localstack}:4566" "$w_rest" $(tcp "$localstack" 4566)
  expect netpol-worker "dns ${dns}:53/tcp" "$w_rest" $(tcp "$dns" 53)
  expect netpol-worker "dns ${dns}:53/udp" "$w_rest" nslookup kubernetes.default.svc.cluster.local "$dns"
  expect netpol-worker "kube-apiserver ${apiserver}:443" "$w_rest" $(tcp "$apiserver" 443)
  expect netpol-worker "kube-apiserver ${node_ip}:6443" "$w_rest" $(tcp "$node_ip" 6443)
  expect netpol-worker "outside ${OUTSIDE_ADDRESS}" "$w_rest" $(tcp "$outside_host" "$outside_port")
  expect netpol-control "egress-proxy ${proxy}:3128" "$c_proxy" $(tcp "$proxy" 3128)
  expect netpol-control "api ${api}:3000" "$c_rest" $(tcp "$api" 3000)
  expect netpol-control "authorizer ${authorizer}:3100" "$c_authz" $(tcp "$authorizer" 3100)
  expect netpol-control "postgres ${postgres}:5432" "$c_rest" $(tcp "$postgres" 5432)
  expect netpol-control "kube-apiserver ${apiserver}:443" "$c_rest" $(tcp "$apiserver" 443)
  expect netpol-control "outside ${OUTSIDE_ADDRESS}" "$c_rest" $(tcp "$outside_host" "$outside_port")
}
# Whether the metadata address answers depends on where the cluster runs: not
# on a laptop, yes on a CI runner. The unlabelled Pod says which, and the
# worker Pod must then be blocked with the policy and answer like it without.
metadata() {
  local control=blocked want="$1"
  k exec netpol-control -- timeout 8 $(tcp 169.254.169.254 80) >/dev/null 2>&1 && control=open
  printf '%-14s %-38s %-8s (not asserted)\n' netpol-control "metadata 169.254.169.254:80" "$control"
  [ "$want" = blocked ] || want="$control"
  expect netpol-worker "metadata 169.254.169.254:80" "$want" $(tcp 169.254.169.254 80)
}
policy_count() { k get networkpolicy -o name | wc -l | tr -d ' '; }

step enforced
[ "$(policy_count)" != 0 ] || fail "the chart installed no NetworkPolicy"
k get networkpolicy
# Only the proxy admits workers, and only the proxy reaches the authorizer.
matrix open blocked blocked open blocked
metadata blocked
[ "$bad" = 0 ] || fail "a connection above is not what the NetworkPolicy should allow"
pass

step mutation
helm upgrade "$RELEASE" "$here/../helm/werft" --namespace "$NAMESPACE" \
  --reuse-values --set networkPolicy.enabled=false --timeout 10m
[ "$(policy_count)" = 0 ] || fail "NetworkPolicies are left with networkPolicy.enabled=false"
# The worker's and the unlabelled Pod's answers are now the same: the cluster
# is open. The authorizer and the proxy answer both.
matrix open open open open open
metadata open
[ "$bad" = 0 ] || fail "without the NetworkPolicy a connection is still blocked: the block was not the policy's"
pass

step restored
helm upgrade "$RELEASE" "$here/../helm/werft" --namespace "$NAMESPACE" \
  --reuse-values --set networkPolicy.enabled=true --timeout 10m
[ "$(policy_count)" != 0 ] || fail "the NetworkPolicies did not come back"
matrix open blocked blocked open blocked
metadata blocked
[ "$bad" = 0 ] || fail "after restoring the NetworkPolicy a connection is not what it should allow"
pass

echo
echo "k8s-netpol: every step passed"
