#!/usr/bin/env bash
# The chart's default two replicas of the api and of the egress proxy, on
# kind: the session flow must come out right whichever replica a call lands
# on. The chart installs both Deployments with 2 replicas; this script talks
# to each api Pod by its own port-forward, so the replica is chosen, not left
# to the Service.
#
#   1. replicas    two Ready Pods of each Deployment, on two different Pods
#   2. flow        a session created on api A whose first turn asks four
#                  permission questions: api B's stream carries each within
#                  seconds of the worker publishing it (B's own LISTEN/NOTIFY
#                  wakeup, not its 15 s keepalive re-read); pending-requests
#                  on B; the answers sent to A (the first once more to B under
#                  the same Idempotency-Key: the same receipt); turn 1
#                  completes; a message on B runs turn 2, read back on A
#   3. resume      the full event list read on A and the list resumed on B
#                  from a cursor (Last-Event-ID) are the same events, in the
#                  same order, none twice; each turn's frames name one
#                  attempt, the one the turn names
#   4. spread      sessions created in pairs, one on A and one on B, complete
#                  once each (one reported turn, one attempt). Pairs, because
#                  a worker Pod holds a CPU and several GiB while its session
#                  idles. Two creates at once do not race one turn's claim:
#                  that stays out of this test's reach.
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
# They go in pairs, one on each replica.
if ! [[ "$SPREAD_SESSIONS" =~ ^[1-9][0-9]*$ ]] || [ $((SPREAD_SESSIONS % 2)) != 0 ]; then
  echo "SPREAD_SESSIONS must be an even number, not '${SPREAD_SESSIONS}'" >&2
  exit 1
fi

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
# Ready Pods of a component that are not being deleted, one name per line,
# into the array named $1 (bash 3.2 on macOS has no mapfile). up.sh restarts
# the api after importing the settings, so the old ReplicaSet's Pod can still
# be Running while it terminates.
running_pods() {
  local name="$1" component="$2" pod
  eval "${name}=()"
  while IFS= read -r pod; do
    [ -z "$pod" ] || eval "${name}+=(\"\$pod\")"
  done < <(k get pods -l "app.kubernetes.io/component=${component}" -o json |
    jq -r '.items[] | select(.metadata.deletionTimestamp == null)
      | select(any(.status.conditions[]?; .type == "Ready" and .status == "True")) | .metadata.name')
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
  --scopes sessions:read,sessions:write,sessions:control,sessions:approve 2>/dev/null)"
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
# Frames of an event stream with the time each line arrived, to the
# millisecond (perl is on macOS and on the runner).
sse_stamped() {
  curl -sSN --max-time "$3" "http://127.0.0.1:${1}/v1/sessions/${2}/events" -H @"$auth" 2>/dev/null |
    perl -MTime::HiRes=time -ne 'BEGIN { $| = 1 } printf "%.3f %s", time, $_' >"$4" || true
}
# The attempt ids the frames of one turn carry, one per line, each once.
attempts_of() {
  sed -n 's/^data: //p' "$1" | jq -r --arg t "$2" 'select(.turn_id == $t) | .attempt_id // empty' | sort -u
}
# assert_one_attempt <port> <sid> <turn> <sse file>: the turn has exactly one
# attempt, and it is the one its event frames name. A turn claimed and run
# twice would list a second attempt.
assert_one_attempt() {
  local ids attempts
  ids="$(attempts_of "$4" "$3")"
  attempts="$(get "$1" "/v1/sessions/$2/turns/$3" | jq -r '.attempts[].attempt_id')"
  [ "$(printf '%s\n' "$attempts" | grep -c .)" = 1 ] && [ "$ids" = "$attempts" ] ||
    fail "turn $3 of $2: the turn lists attempts [$(echo $attempts)], its frames name [$(echo $ids)]"
  echo "turn $3: one attempt ${attempts}"
}

# Four turns' worth of permission questions: each Bash step asks, the session
# waits, and the answer goes to the other replica than the one reading.
asks=4
spec="$(jq -nc --argjson n "$asks" '{id: "replicas-flow", final: "replicas flow done",
  steps: [range(0; $n) | {tool: "Bash", input: {command: ("echo replicas " + tostring + " | tee hello" + tostring + ".txt"), description: "write a file"}}]}')"
body="$(jq -nc --arg m "GATE-SPEC ${spec}" '{profile_id: "claude-coding-local", repository_id: "sample-app", message: $m}')"
created_session="$(post "$PORT_A" /v1/sessions "$body")"
sid="$(echo "$created_session" | jq -r .session_id)"
echo "created on A: ${sid} $(echo "$created_session" | jq -c '{turn_id, status}')"
# Read on B from the start. B re-reads on its 15 s keepalive too, so one
# question arriving at once proves little; each of the questions below must
# reach B within a few seconds of when the worker published it, and polling
# alone would manage that for all of them only by chance.
sse_stamped "$PORT_B" "$sid" 240 "$work/flow-b.sse" &
pids+=("$!")
last_request=""
for n in $(seq 1 "$asks"); do
  for _ in $(seq 1 90); do
    [ "$(grep -c ' event: question$' "$work/flow-b.sse" 2>/dev/null || true)" -ge "$n" ] && break
    sleep 1
  done
  [ "$(grep -c ' event: question$' "$work/flow-b.sse" 2>/dev/null || true)" -ge "$n" ] ||
    fail "api B's stream never carried permission question ${n}"
  pending="$(get "$PORT_B" "/v1/sessions/${sid}/pending-requests")"
  echo "question ${n}: $(echo "$pending" | jq -c '.items[] | {kind, tool, turn_id}')"
  [ "$(echo "$pending" | jq '.items | length')" = 1 ] || fail "B does not see exactly one pending request"
  request_id="$(echo "$pending" | jq -r '.items[0].request_id')"
  [ "$request_id" != "$last_request" ] || fail "question ${n} is the request already answered"
  last_request="$request_id"
  [ "$(get "$PORT_A" "/v1/sessions/${sid}" | jq -r .status)" = needs_input ] || fail "A does not say needs_input"
  answer="$(jq -nc --arg r "$request_id" '{request_id: $r, kind: "permission", action: "allow"}')"
  if [ "$n" = 1 ]; then
    # The same Idempotency-Key on the other replica: one answer, one receipt.
    idem="$(openssl rand -hex 16)"
    first="$(post "$PORT_A" "/v1/sessions/${sid}/answers" "$answer" "$idem")"
    second="$(post "$PORT_B" "/v1/sessions/${sid}/answers" "$answer" "$idem")"
    echo "answer on A: $(echo "$first" | jq -c .)  same key on B: $(echo "$second" | jq -c .)"
    receipt="$(echo "$first" | jq -r .receipt_id)"
    [ -n "$receipt" ] && [ "$receipt" != null ] && [ "$receipt" = "$(echo "$second" | jq -r .receipt_id)" ] ||
      fail "the same Idempotency-Key gave another receipt on the other replica"
  else
    post "$PORT_A" "/v1/sessions/${sid}/answers" "$answer" >/dev/null
  fi
done
# Seconds from a question's occurred_at (the worker's clock, on this node's
# clock) to its arrival on B's stream.
latencies="$(awk '$2 == "event:" && $3 == "question" { q = 1; next }
  q && $2 == "data:" { print $1 "\t" substr($0, index($0, "data: ") + 6); q = 0 }' "$work/flow-b.sse" |
  jq -Rr 'split("\t") as $p
    | ($p[1] | fromjson | .occurred_at | capture("^(?<a>[^.Z]+)(\\.(?<f>[0-9]+))?Z$")) as $c
    | (($c.a + "Z" | fromdateiso8601) + (("0." + ($c.f // "0")) | tonumber)) as $t
    | (($p[0] | tonumber) - $t)')"
echo "seconds from occurred_at to arrival on B:" $latencies
[ "$(echo "$latencies" | grep -c .)" = "$asks" ] || fail "B's stream carried $(echo "$latencies" | grep -c .) of ${asks} questions"
echo "$latencies" | jq -e -s 'all(. < 4 and . > -2)' >/dev/null ||
  fail "a question reached B later than the wakeup would take: B did not hear the NOTIFY"
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
# Four approvals and a second turn, and still one attempt per turn.
assert_one_attempt "$PORT_B" "$sid" 1 "$work/full-a.sse"
assert_one_attempt "$PORT_A" "$sid" 2 "$work/full-b.sse"
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
# A worker Pod stays while its session is idle and asks for a CPU and
# several GiB, so a small node holds two or three: the sessions go in pairs,
# one created on each replica, and each pair is terminated before the next.
terminate() {
  local revision
  revision="$(get "$1" "/v1/sessions/$2" | jq .revision)"
  post "$1" "/v1/sessions/$2/terminate" "$(jq -nc --argjson r "$revision" '{expected_revision: $r, reason: "replicas test"}')" >/dev/null
}
terminate "$PORT_A" "$sid"
spec3='{"id":"replicas-spread","steps":[],"final":"spread done"}'
body3="$(jq -nc --arg m "GATE-SPEC ${spec3}" '{profile_id: "claude-coding-local", repository_id: "sample-app", message: $m}')"
for pair in $(seq 1 $((SPREAD_SESSIONS / 2))); do
  on_a="$(post "$PORT_A" /v1/sessions "$body3" | jq -r .session_id)"
  on_b="$(post "$PORT_B" /v1/sessions "$body3" | jq -r .session_id)"
  for entry in "${PORT_A}:${PORT_B}:${on_a}" "${PORT_B}:${PORT_A}:${on_b}"; do
    port="${entry%%:*}"
    rest="${entry#*:}"
    other="${rest%%:*}"
    s="${rest#*:}"
    wait_turn "$other" "$s" 1
    reported="$(get "$port" "/v1/sessions/${s}/usage" | jq .cost.reported_turn_count)"
    printf 'pair %s: created on :%s, completed read on :%s  %s  reported turns %s\n' "$pair" "$port" "$other" "$s" "$reported"
    [ "$reported" = 1 ] || fail "session ${s} reported ${reported} turns"
    sse "$other" "$s" "$work/spread-${s}.sse" 3
    assert_one_attempt "$port" "$s" 1 "$work/spread-${s}.sse"
    terminate "$other" "$s"
  done
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
  echo "${pod} (${ip}): answered the probe; served ${routes} credential route request(s) since the install"
  [ "$routes" -ge 1 ] || fail "${pod} served no credential route while the sessions ran"
done
pass

echo
echo "k8s-replicas: every step passed"
