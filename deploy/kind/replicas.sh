#!/usr/bin/env bash
# The chart's default two replicas of the api and of the egress proxy, on
# kind: the session flow must come out right whichever replica a call lands
# on. The chart installs both Deployments with 2 replicas; this script talks
# to each api Pod by its own port-forward, so the replica is chosen, not left
# to the Service.
#
#   1. replicas    two Ready Pods of each Deployment, on two different Pods
#   2. flow        a session created on api A: its stream read on api B sees
#                  the permission question live; pending-requests on B; the
#                  answer sent to A (and once more to B under the same
#                  Idempotency-Key: the same receipt, no second effect);
#                  turn 1 completes with one reported turn; a message on B
#                  runs turn 2, read back on A
#   3. resume      the full event list read on A and the list resumed on B
#                  from a cursor (Last-Event-ID) are the same events, in the
#                  same order, none twice
#   4. spread      several sessions created alternately on A and B all
#                  complete once each (usage: one reported turn), no worker
#                  ran a turn twice
#   5. proxy       both egress-proxy Pods answer a worker-labelled Pod
#                  directly, and both served provider routes during step 4
#
#   deploy/kind/replicas.sh        run all of it; delete the cluster and
#                                  registry at the end if this run created them
#   deploy/kind/replicas.sh down   delete them (up.sh down)
#
# Settings, besides up.sh's (REGISTRY_PORT, the CI mirror):
#   CLUSTER_NAME         default werft-replicas
#   KEEP_CLUSTER=1       leave the cluster up for a look afterwards
#   REUSE_CLUSTER=1      run on a cluster of that name that already exists
#                        (refused otherwise; such a cluster is never deleted)
#   SPREAD_SESSIONS      sessions of step 4 (default 8)
#   REPLICAS_PORT_A/_B   local ends of the two api forwards (13081, 13082)
#   PROBE_IMAGE          busybox for the proxy probe, by digest
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
export CLUSTER_NAME="${CLUSTER_NAME:-werft-replicas}"
export KIND_MODEL=fake
export NAMESPACE="${NAMESPACE:-werft}"
export RELEASE="${RELEASE:-werft}"
if ! [[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]]; then
  echo "NAMESPACE must be a Kubernetes namespace name, not '${NAMESPACE}'" >&2
  exit 1
fi
export STATE_DIR="${STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/werft/kind/${CLUSTER_NAME}}"
export KUBECONFIG="${STATE_DIR}/kubeconfig"
PROBE_IMAGE="${PROBE_IMAGE:-busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662}"
PORT_A="${REPLICAS_PORT_A:-13081}"
PORT_B="${REPLICAS_PORT_B:-13082}"
SPREAD_SESSIONS="${SPREAD_SESSIONS:-8}"

if [ "${1:-}" = down ]; then
  exec "$here/up.sh" down
fi

fullname="$RELEASE"
case "$RELEASE" in *werft*) ;; *) fullname="${RELEASE}-werft" ;; esac
fullname="${fullname:0:50}"
fullname="${fullname%-}"
k() { kubectl -n "$NAMESPACE" "$@"; }
step() { current="$1"; echo; echo "== k8s-replicas: $*"; }
pass() { echo "PASS ${current}"; }
fail() { echo "FAIL ${current}: $*" >&2; exit 1; }

# A kind or docker error must not read as "no cluster": the teardown below
# would then delete a cluster this run did not create.
clusters="$(kind get clusters)"
created=""
if printf '%s\n' "$clusters" | grep -qx "$CLUSTER_NAME"; then
  [ "${REUSE_CLUSTER:-}" = 1 ] || {
    echo "a cluster named ${CLUSTER_NAME} already exists; set CLUSTER_NAME, or REUSE_CLUSTER=1 to run on it" >&2
    exit 1
  }
else
  created=1
fi

pids=()
auth="$STATE_DIR/replicas-auth-header"
work="$STATE_DIR/replicas-work"
finish() {
  local status=$?
  local pid
  for pid in ${pids[@]+"${pids[@]}"}; do kill "$pid" 2>/dev/null || true; done
  rm -f "$auth"
  if [ "$status" != 0 ] && [ -f "$KUBECONFIG" ]; then
    echo "== k8s-replicas: state after the failure" >&2
    k get deploy,pods -o wide >&2 || true
    for app in scheduler api egress-proxy; do
      echo "-- logs ${app}" >&2
      k logs "deploy/${fullname}-${app}" --tail=100 --all-containers >&2 || true
    done
  fi
  if [ -f "$KUBECONFIG" ]; then
    k delete pod replicas-probe --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  if [ -n "$created" ] && [ "${KEEP_CLUSTER:-}" != 1 ]; then
    "$here/up.sh" down || true
  fi
  exit "$status"
}
trap finish EXIT

step install
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
rm -rf "${work:?}"
mkdir -p "$work"
"$here/up.sh"
echo "kind: $(kind version)"
pass

step replicas
for component in api egress-proxy; do
  ready="$(k get "deploy/${fullname}-${component}" -o jsonpath='{.status.readyReplicas}')"
  want="$(k get "deploy/${fullname}-${component}" -o jsonpath='{.spec.replicas}')"
  echo "${component}: ${ready}/${want} Ready"
  [ "$want" = 2 ] && [ "$ready" = 2 ] || fail "${component} is not at two Ready replicas"
done
# Running Pods of a component, one name per line, into the array named $1
# (bash 3.2 on macOS has no mapfile).
running_pods() {
  local name="$1" component="$2" pod
  eval "${name}=()"
  while IFS= read -r pod; do
    [ -z "$pod" ] || eval "${name}+=(\"\$pod\")"
  done < <(k get pods -l "app.kubernetes.io/component=${component}" --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
}
running_pods api_pods api
running_pods proxy_pods egress-proxy
[ "${#api_pods[@]}" = 2 ] && [ "${api_pods[0]}" != "${api_pods[1]}" ] || fail "no two distinct api Pods: ${api_pods[*]}"
[ "${#proxy_pods[@]}" = 2 ] && [ "${proxy_pods[0]}" != "${proxy_pods[1]}" ] || fail "no two distinct egress-proxy Pods: ${proxy_pods[*]}"
echo "api A=${api_pods[0]} B=${api_pods[1]}"
echo "egress-proxy ${proxy_pods[0]} ${proxy_pods[1]}"
pass

# A key for this run alone, in a 0600 header file, never in an argument or
# the log.
{ set +x; } 2>/dev/null
umask 077
key="$(k exec "pod/${api_pods[0]}" -- bun run apps/control-host/src/api/keys.ts create kind-replicas \
  --scopes sessions:read,sessions:write,sessions:control 2>/dev/null)"
[ -n "$key" ] || fail "the key CLI printed no key"
printf 'Authorization: Bearer %s\n' "$key" >"$auth"
unset key
forward() {
  local pod="$1" port="$2"
  k port-forward --address 127.0.0.1 "pod/${pod}" "${port}:3000" >"$work/forward-${port}.log" 2>&1 &
  pids+=("$!")
  local pid=$!
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || fail "port-forward to ${pod} on ${port} exited; set REPLICAS_PORT_A/_B"
    grep -q "Forwarding from" "$work/forward-${port}.log" &&
      curl -s -o /dev/null "http://127.0.0.1:${port}/healthz" && return
    sleep 1
  done
  fail "port-forward to ${pod} never answered"
}
forward "${api_pods[0]}" "$PORT_A"
forward "${api_pods[1]}" "$PORT_B"
get() { curl -sS --fail-with-body "http://127.0.0.1:$1$2" -H @"$auth"; }
# post <port> <path> <body> [idempotency key]
post() {
  curl -sS --fail-with-body "http://127.0.0.1:$1$2" -H @"$auth" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: ${4:-$(openssl rand -hex 16)}" -d "$3"
}
# Which replica a port reaches, from its own log: asked of the Pod itself.
for port in "$PORT_A" "$PORT_B"; do
  get "$port" /readyz >/dev/null || fail "api on ${port} is not ready"
done

# A turn's status, read on the given port.
turn_status() { get "$1" "/v1/sessions/$2/turns/$3" | jq -r .status; }
wait_turn() {
  local port="$1" sid="$2" turn="$3" want="${4:-completed}" status="" _
  for _ in $(seq 1 300); do
    status="$(turn_status "$port" "$sid" "$turn" 2>/dev/null || true)"
    case "$status" in "$want") return 0 ;; failed | interrupted | cancelled | outcome_unknown) break ;; esac
    sleep 1
  done
  fail "turn ${turn} of ${sid} ended ${status:-nowhere}, not ${want}"
}
# sse <port> <sid> <outfile> <seconds> [last-event-id]: the stream until the
# time is up (it never ends by itself, so curl's own timeout, 28, is normal).
sse() {
  local port="$1" sid="$2" out="$3" secs="$4" last="${5:-}"
  curl -sSN --max-time "$secs" "http://127.0.0.1:${port}/v1/sessions/${sid}/events" -H @"$auth" \
    ${last:+-H "Last-Event-ID: ${last}"} >"$out" 2>/dev/null || [ "$?" = 28 ]
}
event_ids() { sed -n 's/^id: *//p' "$1"; }

step flow
# The first turn asks permission (tee writes a file), so the session waits.
spec='{"id":"replicas-flow","steps":[{"tool":"Bash","input":{"command":"echo replicas | tee hello.txt","description":"write a file"}}],"final":"replicas flow done"}'
body="$(jq -nc --arg m "GATE-SPEC ${spec}" '{profile_id: "claude-coding-local", repository_id: "sample-app", message: $m}')"
created_session="$(post "$PORT_A" /v1/sessions "$body")"
sid="$(echo "$created_session" | jq -r .session_id)"
echo "created on A: ${sid} $(echo "$created_session" | jq -c '{turn_id, status}')"
# Read on B while the worker is still starting: the question must arrive
# through B's own wakeup, not from A.
sse "$PORT_B" "$sid" "$work/flow-b.sse" 60 &
reader=$!
pids+=("$reader")
for _ in $(seq 1 60); do
  grep -q '^event: question' "$work/flow-b.sse" 2>/dev/null && break
  sleep 1
done
grep -q '^event: question' "$work/flow-b.sse" || fail "api B's stream never carried the permission question"
echo "api B stream: $(sed -n 's/^event: *//p' "$work/flow-b.sse" | tr '\n' ' ')"
pending="$(get "$PORT_B" "/v1/sessions/${sid}/pending-requests")"
echo "$pending" | jq -c '.items[] | {kind, tool, turn_id}'
[ "$(echo "$pending" | jq '.items | length')" = 1 ] || fail "B does not see exactly one pending request"
request_id="$(echo "$pending" | jq -r '.items[0].request_id')"
[ "$(get "$PORT_A" "/v1/sessions/${sid}" | jq -r .status)" = needs_input ] || fail "A does not say needs_input"
answer="$(jq -nc --arg r "$request_id" '{request_id: $r, kind: "permission", action: "allow"}')"
idem="$(openssl rand -hex 16)"
first="$(post "$PORT_A" "/v1/sessions/${sid}/answers" "$answer" "$idem")"
second="$(post "$PORT_B" "/v1/sessions/${sid}/answers" "$answer" "$idem")"
echo "answer on A: $(echo "$first" | jq -c .)  same key on B: $(echo "$second" | jq -c .)"
[ "$(echo "$first" | jq -r .receipt_id)" = "$(echo "$second" | jq -r .receipt_id)" ] ||
  fail "the same Idempotency-Key gave another receipt on the other replica"
wait_turn "$PORT_B" "$sid" 1
echo "turn 1 completed (read on B)"
usage="$(get "$PORT_A" "/v1/sessions/${sid}/usage")"
echo "$usage" | jq -c '{token_count, reported_turn_count: .cost.reported_turn_count}'
[ "$(echo "$usage" | jq .cost.reported_turn_count)" = 1 ] || fail "turn 1 was reported other than once"
spec2='{"id":"replicas-second","steps":[],"final":"second turn done"}'
sent="$(post "$PORT_B" "/v1/sessions/${sid}/messages" "$(jq -nc --arg m "GATE-SPEC ${spec2}" '{message: $m}')")"
echo "message on B: $(echo "$sent" | jq -c .)"
wait_turn "$PORT_A" "$sid" 2
echo "turn 2 completed (read on A)"
[ "$(get "$PORT_B" "/v1/sessions/${sid}/usage" | jq .cost.reported_turn_count)" = 2 ] || fail "two turns are not two reported turns"
pass

step resume
sse "$PORT_A" "$sid" "$work/full-a.sse" 8
sse "$PORT_B" "$sid" "$work/full-b.sse" 8
event_ids "$work/full-a.sse" >"$work/ids-a"
event_ids "$work/full-b.sse" >"$work/ids-b"
echo "events: A=$(wc -l <"$work/ids-a" | tr -d ' ') B=$(wc -l <"$work/ids-b" | tr -d ' ')"
[ "$(wc -l <"$work/ids-a")" -ge 4 ] || fail "too few events to resume from"
cmp -s "$work/ids-a" "$work/ids-b" || fail "A and B list different events for the same session"
[ -z "$(sort "$work/ids-a" | uniq -d)" ] || fail "an event id appears twice"
cursor="$(sed -n 2p "$work/ids-a")"
sse "$PORT_B" "$sid" "$work/resumed-b.sse" 8 "$cursor"
event_ids "$work/resumed-b.sse" >"$work/ids-resumed"
tail -n +3 "$work/ids-a" >"$work/ids-expected"
echo "cursor ${cursor}: resumed on B $(wc -l <"$work/ids-resumed" | tr -d ' ') events, expected $(wc -l <"$work/ids-expected" | tr -d ' ')"
cmp -s "$work/ids-expected" "$work/ids-resumed" || {
  diff "$work/ids-expected" "$work/ids-resumed" >&2 || true
  fail "resuming on the other replica did not continue after the cursor"
}
pass

step spread
sessions=()
spec3='{"id":"replicas-spread","steps":[],"final":"spread done"}'
body3="$(jq -nc --arg m "GATE-SPEC ${spec3}" '{profile_id: "claude-coding-local", repository_id: "sample-app", message: $m}')"
for i in $(seq 1 "$SPREAD_SESSIONS"); do
  port="$PORT_A"
  [ $((i % 2)) = 0 ] && port="$PORT_B"
  sessions+=("${port}:$(post "$port" /v1/sessions "$body3" | jq -r .session_id)")
done
for entry in "${sessions[@]}"; do
  port="${entry%%:*}"
  s="${entry#*:}"
  other="$PORT_A"
  [ "$port" = "$PORT_A" ] && other="$PORT_B"
  wait_turn "$other" "$s" 1
  reported="$(get "$port" "/v1/sessions/${s}/usage" | jq .cost.reported_turn_count)"
  printf 'created on :%s, completed read on :%s  %s  reported turns %s\n' "$port" "$other" "$s" "$reported"
  [ "$reported" = 1 ] || fail "session ${s} reported ${reported} turns"
done
pass

step proxy
installation="$(k get "deploy/${fullname}-scheduler" \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="EXECUTION_INSTALLATION_ID")].value}')"
k delete pod replicas-probe --ignore-not-found --wait >/dev/null
k apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: replicas-probe
  labels: {app.kubernetes.io/part-of: werft, app.kubernetes.io/component: worker, werft.installation: "${installation}"}
spec:
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 0
  restartPolicy: Never
  securityContext: {runAsNonRoot: true, runAsUser: 65534, runAsGroup: 65534}
  containers:
    - name: probe
      image: ${PROBE_IMAGE}
      command: ["sleep", "300"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: {drop: [ALL]}
EOF
k wait --for=condition=Ready pod/replicas-probe --timeout=120s >/dev/null
for pod in "${proxy_pods[@]}"; do
  ip="$(k get "pod/${pod}" -o jsonpath='{.status.podIP}')"
  # Any HTTP status proves this replica took the connection.
  k exec replicas-probe -- sh -c "http_proxy=http://${ip}:3128 wget -S -T 5 -O /dev/null http://localstack:4566/ 2>&1 | grep -q 'HTTP/'" ||
    fail "a worker-labelled Pod got no HTTP answer from ${pod} (${ip}:3128)"
  routes="$(k logs "pod/${pod}" | grep -c '"Credential route"' || true)"
  echo "${pod} (${ip}): answered the probe; served ${routes} provider/credential route request(s) in step spread"
  [ "$routes" -ge 1 ] || fail "${pod} served no credential route while ${SPREAD_SESSIONS} sessions ran"
done
pass

echo
echo "k8s-replicas: every step passed"
