#!/usr/bin/env bash
# The kind smoke (94S-525, CI job `k8s-smoke`): installs the chart with
# up.sh and checks, through the public API and kubectl, that the kubernetes
# execution backend and the worker NetworkPolicy hold on a real cluster.
#
#   1. failed-install  on a fresh cluster with the fake model and no
#                   EXTRA_VALUES: up.sh with a migrate Job that cannot be
#                   scheduled leaves a failed release and no Deployment
#   2. install      up.sh: chart up, /readyz and /docs 200. After step 1 this
#                   is the retry, which upgrade-check must let through
#   3. session      one session reaches turn 1 completed in a worker Pod the
#                   scheduler launched, with sample-app cloned from the git
#                   host and its usage recorded
#   4. reclaim      after terminate, the session's worker Pod, nonce Secret
#                   and workspace PVC are gone
#   5. egress       a Pod with the worker labels reaches the egress proxy
#                   (3128, 3129) and nothing else: api 3000, authorizer 3100,
#                   postgres, localstack, cloud metadata and DNS are blocked;
#                   an unlabelled Pod gets the opposite answers (the proxy
#                   admits workers alone), so the network itself is up
#   6. upgrade      a helm upgrade with the same values, no worker runtime set,
#                   passes upgrade-check and the api stays ready
#   7. contract     the KubernetesBackend contract and integration suites
#                   (K8S_BACKEND_TEST=1) against this cluster
#
#   deploy/kind/smoke.sh        run all of it; delete the cluster and registry
#                               at the end if this run created them (with
#                               CLUSTER_PROVIDER=orbstack, the namespace)
#   deploy/kind/smoke.sh down   delete them (up.sh down)
#
# Each step prints `== k8s-smoke: <step>` and ends in `PASS <step>`; any
# failure exits non-zero after printing the cluster's state.
#
# Settings, besides up.sh's (CLUSTER_NAME, REGISTRY_PORT, CLUSTER_PROVIDER,
# EXTRA_VALUES, the CI mirror):
#   KIND_MODEL=fake      default: the fake-model settings and fake
#                        Messages API; no provider account, no cost
#   KIND_MODEL=real      opt-in, paid: an agent on the real-model connection
#                        against api.anthropic.com, under a 1 USD session
#                        cost limit. The key is the shell's ANTHROPIC_API_KEY,
#                        else the ANTHROPIC_API_KEY line of the file
#                        AGENT_PLATFORM_DOTENV names (default .env), read by
#                        scripts/lib/real-model-key.sh. up.sh hands it to the
#                        Secret through a file descriptor: it is never
#                        printed nor put in an argument. Needs a fresh cluster.
#   KEEP_CLUSTER=1       leave the cluster up for a look afterwards
#   PROBE_IMAGE          busybox for the egress probe, by digest
#   K8S_BACKEND_TEST_IMAGE  the contract suite's image (its README)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
export CLUSTER_NAME="${CLUSTER_NAME:-werft-smoke}"
export KIND_MODEL="${KIND_MODEL:-fake}"
export NAMESPACE="${NAMESPACE:-werft}"
export RELEASE="${RELEASE:-werft}"
# As up.sh checks it: it is in a path below, and the namespace the teardown
# may delete.
if ! [[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]]; then
  echo "NAMESPACE must be a Kubernetes namespace name, not '${NAMESPACE}'" >&2
  exit 1
fi
# up.sh's default.
if [ "${CLUSTER_PROVIDER:-kind}" = orbstack ]; then
  export STATE_DIR="${STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/werft/orbstack/${NAMESPACE}}"
else
  export STATE_DIR="${STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/werft/kind/${CLUSTER_NAME}}"
fi
export KUBECONFIG="${STATE_DIR}/kubeconfig"
PROBE_IMAGE="${PROBE_IMAGE:-busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662}"
API_PORT="${SMOKE_API_PORT:-13080}"
API="http://127.0.0.1:${API_PORT}"

if [ "${1:-}" = down ]; then
  exec "$here/up.sh" down
fi
case "$KIND_MODEL" in
  fake | real) ;;
  *) echo "KIND_MODEL must be fake or real, not '${KIND_MODEL}'" >&2; exit 1 ;;
esac

fullname="$RELEASE"
case "$RELEASE" in *werft*) ;; *) fullname="${RELEASE}-werft" ;; esac
fullname="${fullname:0:50}"
fullname="${fullname%-}"
k() { kubectl -n "$NAMESPACE" "$@"; }
step() { current="$1"; echo; echo "== k8s-smoke: $*"; }
pass() { echo "PASS ${current}"; }
fail() { echo "FAIL ${current}: $*" >&2; exit 1; }

# A kind or docker error must not read as "no cluster": the teardown below
# would then delete a cluster this run did not create.
created=""
if [ "${CLUSTER_PROVIDER:-kind}" = orbstack ]; then
  # The namespace is this run's to delete; the cluster is OrbStack's.
  if ! ns="$(env -u KUBECONFIG kubectl --context orbstack get namespace "$NAMESPACE" -o name --ignore-not-found)"; then
    echo "kubectl cannot reach the orbstack context (orb start k8s)" >&2
    exit 1
  fi
  [ -n "$ns" ] || created=1
else
  clusters="$(kind get clusters)"
  printf '%s\n' "$clusters" | grep -qx "$CLUSTER_NAME" || created=1
fi
forward=""
auth="$STATE_DIR/smoke-auth-header"
finish() {
  local status=$?
  [ -z "$forward" ] || kill "$forward" 2>/dev/null || true
  rm -f "$auth" "$auth.approve"
  if [ "$status" != 0 ] && [ -f "$KUBECONFIG" ]; then
    echo "== k8s-smoke: state after the failure" >&2
    k get deploy,pods,pvc,networkpolicy -o wide >&2 || true
    k get pods -l app.kubernetes.io/component=worker --show-labels >&2 || true
    for app in scheduler api egress-proxy; do
      echo "-- logs ${app}" >&2
      k logs "deploy/${fullname}-${app}" --tail=150 --all-containers >&2 || true
    done
  fi
  if [ -n "$created" ] && [ "${KEEP_CLUSTER:-}" != 1 ]; then
    "$here/up.sh" down || true
  fi
  exit "$status"
}
trap finish EXIT

# The verdict line of the upgrade-check Job the last upgrade ran.
upgrade_check_verdict() {
  local verdict
  verdict="$(k logs "job/${fullname}-upgrade-check" | jq -c 'select(.verdict)')"
  echo "upgrade-check: ${verdict}"
  echo "$verdict" | jq -e "$1" >/dev/null || fail "upgrade-check did not say $1"
}
helm_status() {
  helm status "$RELEASE" --namespace "$NAMESPACE" -o json | jq -r .info.status
}

# up.sh takes one EXTRA_VALUES file, and KIND_MODEL=real refuses a second run.
retried=""
if [ -n "$created" ] && [ "$KIND_MODEL" = fake ] && [ -z "${EXTRA_VALUES:-}" ]; then
  step failed-install
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  cat >"$STATE_DIR/smoke-failed-install.yaml" <<'EOF'
migrate:
  activeDeadlineSeconds: 30
  resources:
    requests: {cpu: "1000"}
EOF
  if EXTRA_VALUES="$STATE_DIR/smoke-failed-install.yaml" "$here/up.sh"; then
    fail "the install succeeded with a migrate Job no node can hold"
  fi
  # up.sh fails for other reasons too; only this failure is the one wanted.
  [ "$(helm_status)" = failed ] || fail "the release is $(helm_status), not failed"
  k get job "${fullname}-migrate" -o json |
    jq -e '.status.conditions[]? | select(.type == "Failed" and .reason == "DeadlineExceeded")' ||
    fail "the migrate Job did not hit its deadline"
  k get events --field-selector reason=FailedScheduling -o jsonpath='{.items[*].involvedObject.name}' |
    grep "${fullname}-migrate-" >/dev/null ||
    fail "the migrate Pod was never refused a node"
  [ -z "$(k get deploy "${fullname}-scheduler" -o name --ignore-not-found)" ] ||
    fail "the failed install left a scheduler Deployment"
  retried=1
  pass
fi

step install
"$here/up.sh"
# up.sh needed it for KIND_MODEL=real; nothing after this does.
unset ANTHROPIC_API_KEY
if [ -n "$retried" ]; then
  [ "$(helm_status)" = deployed ] || fail "the retry left the release $(helm_status)"
  upgrade_check_verdict '.verdict == "proceed" and .deployedWorker == null'
fi
pass

step session
{ set +x; } 2>/dev/null
umask 077
# shellcheck source=release-key.sh
. "$here/release-key.sh"
k port-forward --address 127.0.0.1 "svc/${fullname}-api" "${API_PORT}:3000" >"$STATE_DIR/smoke-port-forward.log" 2>&1 &
forward=$!
# Only through our own forward: one that failed (the port taken) would hand
# the key below to whatever listens there.
for _ in $(seq 1 30); do
  kill -0 "$forward" 2>/dev/null || fail "kubectl port-forward on ${API_PORT} exited; set SMOKE_API_PORT"
  grep -q "Forwarding from" "$STATE_DIR/smoke-port-forward.log" &&
    curl -s -o /dev/null "$API/healthz" && break
  sleep 1
done
# Every session runs an agent release: the first owner releases the smoke's
# agent and its key, in a 0600 header file, starts the session.
kind_release_key "$API" "$auth" || fail "the smoke's agent was not released"
get() { curl -sS --fail-with-body "$API$1" -H @"$auth"; }
post() {
  curl -sS --fail-with-body "$API$1" -H @"$auth" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(openssl rand -hex 16)" -d "$2"
}
installation="$(k get "deploy/${fullname}-scheduler" \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="EXECUTION_INSTALLATION_ID")].value}')"
workers="app.kubernetes.io/part-of=werft,app.kubernetes.io/component=worker,werft.installation=${installation}"

if [ "$KIND_MODEL" = fake ]; then
  body="$(jq -nc --arg r "$KIND_RELEASE_ID" '{agent_release_id: $r, repository_id: "sample-app",
    message: ("GATE-SPEC " + ({id: "kind-smoke", steps: [], final: "kind smoke done"} | tojson))}')"
else
  body="$(jq -nc --arg r "$KIND_RELEASE_ID" '{agent_release_id: $r, repository_id: "sample-app",
    message: "Reply with the single word ok. Use no tools."}')"
fi
created_session="$(post /v1/sessions "$body")"
echo "$created_session" | jq -c .
sid="$(echo "$created_session" | jq -r .session_id)"
# The worker Pod is looked at while the turn runs: after it, the Pod may
# already be on its way out.
pod=""
turn=""
for _ in $(seq 1 600); do
  [ -n "$pod" ] || pod="$(k get pods -l "${workers},werft.session-id=${sid}" -o name 2>/dev/null | head -n 1)"
  if [ -n "$pod" ] && [ -z "${pod_listing:-}" ]; then
    # Gone again before it was read: look for the next one.
    pod_listing="$(k get "$pod" -o wide --show-labels 2>/dev/null)" &&
      execution="$(k get "$pod" -o jsonpath='{.metadata.labels.werft\.session-execution-id}' 2>/dev/null)" &&
      mounted="$(k get "$pod" -o jsonpath='{.spec.volumes[?(@.name=="workspace")].persistentVolumeClaim.claimName}' 2>/dev/null)" ||
      { pod=""; pod_listing=""; }
  fi
  turn="$(get "/v1/sessions/${sid}/turns/1" | jq -r .status)"
  case "$turn" in completed | failed | interrupted | cancelled | outcome_unknown) break ;; esac
  sleep 1
done
echo "turn 1: ${turn}"
[ "$turn" = completed ] || fail "turn 1 ended ${turn:-nowhere}"
[ -n "${pod_listing:-}" ] || fail "no Pod labelled ${workers} ran the session"
echo "worker Pod the scheduler launched:"
echo "$pod_listing"
[ "${mounted:-}" = "werft-ws-${installation}-${sid}" ] ||
  fail "the Pod mounts claim '${mounted:-}', not werft-ws-${installation}-${sid}"
k get pvc "$mounted" -o json |
  jq -e --arg sid "$sid" --arg inst "$installation" '.metadata.labels
    | .["app.kubernetes.io/part-of"] == "werft" and .["werft.session-id"] == $sid
      and .["werft.installation"] == $inst' >/dev/null ||
  fail "claim ${mounted} does not carry the werft labels"
# A turn can complete without its workspace, so ask the git host itself.
clones="$(k exec deploy/fake-git -- bun -e 'console.log(await (await fetch("http://127.0.0.1:3000/requests")).text())')"
echo "$clones" | jq -c '[.[] | select(.path | contains("sample-app"))]'
echo "$clones" | jq -e 'any(.[]; .path == "/agent/sample-app.git/git-upload-pack" and .status == 200)' >/dev/null ||
  fail "the git host served no clone of sample-app"
usage="$(get "/v1/sessions/${sid}/usage")"
echo "$usage" | jq -c '{token_count, cost: .cost | {amount_usd, kind, reported_turn_count}}'
echo "$usage" | jq -e '.token_count > 0 and .cost.reported_turn_count >= 1' >/dev/null ||
  fail "no usage recorded"
pass

step reclaim
# This session's alone: the Pod and PVC by its id, the nonce Secret by the
# execution the Pod ran.
[ -n "${execution:-}" ] || fail "no execution id on ${pod}"
session_resources() {
  k get pods,pvc -l "werft.session-id=${sid}" "$@"
  k get secrets -l "werft.session-execution-id=${execution}" "$@"
}
echo "before terminate:"
session_resources
revision="$(get "/v1/sessions/${sid}" | jq .revision)"
post "/v1/sessions/${sid}/terminate" \
  "$(jq -nc --argjson r "$revision" '{expected_revision: $r, reason: "kind smoke"}')" | jq -c .
left=""
for _ in $(seq 1 180); do
  left="$(session_resources -o name 2>/dev/null)"
  [ -z "$left" ] && break
  sleep 1
done
echo "after terminate:"
session_resources 2>&1
[ -z "$left" ] || fail "still there after 180s: $(echo "$left" | tr '\n' ' ')"
get "/v1/sessions/${sid}" | jq -c '{status, admission_state}'
pass

step egress
cluster_ip() { kubectl -n "$1" get svc "$2" -o jsonpath='{.spec.clusterIP}'; }
proxy_svc="$(k get svc -l app.kubernetes.io/component=egress-proxy -o name | head -n 1)"
proxy="$(cluster_ip "$NAMESPACE" "${proxy_svc#service/}")"
api="$(cluster_ip "$NAMESPACE" "${fullname}-api")"
authorizer="$(cluster_ip "$NAMESPACE" "${fullname}-api-authorizer")"
postgres="$(cluster_ip "$NAMESPACE" postgres)"
localstack="$(cluster_ip "$NAMESPACE" localstack)"
dns="$(cluster_ip kube-system kube-dns)"
# Addresses, not names: the probe itself must not need DNS.
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
      command: ["sleep", "600"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: {drop: [ALL]}
EOF
  k wait --for=condition=Ready "pod/${name}" --timeout=120s >/dev/null
}
probe_pod k8s-smoke-worker "app.kubernetes.io/part-of: werft, app.kubernetes.io/component: worker, werft.installation: \"${installation}\""
probe_pod k8s-smoke-control "app: k8s-smoke-probe"
k get pod k8s-smoke-worker k8s-smoke-control --show-labels
bad=0
# check <pod> <what> <expected open|blocked> <command...>
check() {
  local pod="$1" what="$2" want="$3" got=blocked
  shift 3
  k exec "$pod" -- timeout 8 "$@" >/dev/null 2>&1 && got=open
  local verdict=ok
  [ "$got" = "$want" ] || { verdict=WRONG; bad=1; }
  printf '%-18s %-34s %-8s (want %-7s) %s\n' "$pod" "$what" "$got" "$want" "$verdict"
}
tcp() { echo nc -z -w 5 "$1" "$2"; }
# The proxy admits workers alone; everything else is the other way round.
for pod in k8s-smoke-worker k8s-smoke-control; do
  if [ "$pod" = k8s-smoke-worker ]; then
    proxied=open closed=blocked
  else
    proxied=blocked closed=open
  fi
  check "$pod" "egress-proxy ${proxy}:3128" "$proxied" $(tcp "$proxy" 3128)
  check "$pod" "egress-proxy ${proxy}:3129" "$proxied" $(tcp "$proxy" 3129)
  check "$pod" "api ${api}:3000" "$closed" $(tcp "$api" 3000)
  check "$pod" "postgres ${postgres}:5432" "$closed" $(tcp "$postgres" 5432)
  check "$pod" "localstack ${localstack}:4566" "$closed" $(tcp "$localstack" 4566)
  check "$pod" "dns ${dns}:53/tcp" "$closed" $(tcp "$dns" 53)
  check "$pod" "dns ${dns}:53/udp" "$closed" nslookup kubernetes.default.svc.cluster.local "$dns"
done
# Only the egress proxy may reach these, so the unlabelled Pod is blocked too.
check k8s-smoke-worker "authorizer ${authorizer}:3100" blocked $(tcp "$authorizer" 3100)
check k8s-smoke-control "authorizer ${authorizer}:3100" blocked $(tcp "$authorizer" 3100)
# Nothing answers there on kind; on a cloud node the policy is what stops it.
check k8s-smoke-worker "metadata 169.254.169.254:80" blocked $(tcp 169.254.169.254 80)
k delete pod k8s-smoke-worker k8s-smoke-control --wait=false >/dev/null
[ "$bad" = 0 ] || fail "a connection above is not what the NetworkPolicy should allow"
pass

step upgrade
helm get values "$RELEASE" --namespace "$NAMESPACE" -o json >"$STATE_DIR/smoke-release-values.json"
helm upgrade "$RELEASE" "$root/deploy/helm/werft" \
  --namespace "$NAMESPACE" -f "$STATE_DIR/smoke-release-values.json" --timeout 10m
[ "$(helm_status)" = deployed ] || fail "the upgrade left the release $(helm_status)"
upgrade_check_verdict '.verdict == "proceed" and .deployedWorker == .targetWorker'
k rollout status "deploy/${fullname}-api" --timeout=300s
# The values did not change, so no Pod did and the forward still holds.
curl -sS --fail-with-body "$API/readyz" | jq -c .
pass

step contract
cd "$root"
log="$STATE_DIR/smoke-contract.log"
K8S_BACKEND_TEST=1 bun test \
  packages/adapters/execution/kubernetes/src/backend.contract.integration.test.ts \
  packages/adapters/execution/kubernetes/src/backend.integration.test.ts 2>&1 | tee "$log"
# A suite that skipped instead of running is not a pass.
grep -Eq '^ *[1-9][0-9]* pass$' "$log" || fail "no test ran"
! grep -Eq '^ *[1-9][0-9]* (skip|todo|fail)$' "$log" || fail "a test skipped or failed"
pass

echo
echo "k8s-smoke: every step passed"
