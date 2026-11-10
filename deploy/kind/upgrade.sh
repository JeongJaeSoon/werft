#!/usr/bin/env bash
# helm upgrade and helm rollback while sessions are alive, on kind. A session
# waiting for an approval and a paused one (it holds a checkpoint, no worker)
# are created on the installed release, carried through an upgrade and then a
# rollback, and must come out the other side as they went in.
#
#   1. install     up.sh with the fake model
#   2. sessions    S1 waits for an approval (its worker stays); S2 finishes
#                  turn 1 and is paused (checkpoint committed, no worker)
#   3. upgrade     helm upgrade that rolls api, scheduler and reconciler:
#                  upgrade-check says proceed; the hooks ran in order
#                  (upgrade-check, then migrate, then the new Pods); S1 still
#                  waits on the same request in the same worker Pod; S2
#                  resumes from the checkpoint it paused with and runs turn 2;
#                  the events each session had are still its first events
#   4. rollback    helm rollback to the first revision: no hook ran; the old
#                  Deployments are back; S1 is still waiting, is answered and
#                  completes; S2 runs a third turn
#
#   deploy/kind/upgrade.sh         run all of it; delete the cluster and
#                                  registry at the end if this run created them
#   deploy/kind/upgrade.sh down    delete them (up.sh down)
#
# Settings, besides up.sh's (REGISTRY_PORT, the CI mirror):
#   CLUSTER_NAME         default werft-upgrade
#   KEEP_CLUSTER=1       leave the cluster up for a look afterwards
#   REUSE_CLUSTER=1      run on a cluster of that name that already exists
#                        (refused otherwise; such a cluster is never deleted)
#   UPGRADE_API_PORT     local end of the api forward (13090)
#   UPGRADE_EXTRA_ARGS   more arguments for the helm upgrade of step 3, to
#                        check that the assertions can fail, for example
#                        '--set scheduler.enabled=false'
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
export CLUSTER_NAME="${CLUSTER_NAME:-werft-upgrade}"
export KIND_MODEL=fake
# The teardown deletes what this run installed; on OrbStack's shared cluster
# that is a namespace the run does not own.
if [ "${CLUSTER_PROVIDER:-kind}" != kind ]; then
  echo "upgrade.sh runs on kind only, not CLUSTER_PROVIDER=${CLUSTER_PROVIDER}" >&2
  exit 1
fi
export CLUSTER_PROVIDER=kind
export NAMESPACE="${NAMESPACE:-werft}"
export RELEASE="${RELEASE:-werft}"
if ! [[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]]; then
  echo "NAMESPACE must be a Kubernetes namespace name, not '${NAMESPACE}'" >&2
  exit 1
fi
export STATE_DIR="${STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/werft/kind/${CLUSTER_NAME}}"
export KUBECONFIG="${STATE_DIR}/kubeconfig"
API_PORT="${UPGRADE_API_PORT:-13090}"

if [ "${1:-}" = down ]; then
  exec "$here/up.sh" down
fi

fullname="$RELEASE"
case "$RELEASE" in *werft*) ;; *) fullname="${RELEASE}-werft" ;; esac
fullname="${fullname:0:50}"
fullname="${fullname%-}"
k() { kubectl -n "$NAMESPACE" "$@"; }
step() { current="$1"; echo; echo "== k8s-upgrade: $*"; }
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

forward_pid=""
auth="$STATE_DIR/upgrade-auth-header"
work="$STATE_DIR/upgrade-work"
finish() {
  local status=$?
  [ -z "$forward_pid" ] || kill "$forward_pid" 2>/dev/null || true
  rm -f "$auth"
  if [ "$status" != 0 ] && [ -f "$KUBECONFIG" ]; then
    echo "== k8s-upgrade: state after the failure" >&2
    helm history "$RELEASE" --namespace "$NAMESPACE" >&2 || true
    k get deploy,pods,jobs -o wide >&2 || true
    for app in scheduler api; do
      echo "-- logs ${app}" >&2
      k logs "deploy/${fullname}-${app}" --tail=100 --all-containers >&2 || true
    done
    for job in upgrade-check migrate; do
      echo "-- logs ${job}" >&2
      k logs "job/${fullname}-${job}" --tail=60 >&2 || true
    done
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
helm get values "$RELEASE" --namespace "$NAMESPACE" -o json >"$work/release-values.json"
# A reused cluster may not start at revision 1; the rollback target is this one.
base="$(helm status "$RELEASE" --namespace "$NAMESPACE" -o json | jq .version)"
pass

# A key for this run alone, in a 0600 header file, never in an argument or
# the log.
{ set +x; } 2>/dev/null
umask 077
key="$(k exec "deploy/${fullname}-api" -- bun run apps/control-host/src/api/keys.ts create kind-upgrade \
  --scopes sessions:read,sessions:write,sessions:control,sessions:approve 2>/dev/null)"
[ -n "$key" ] || fail "the key CLI printed no key"
printf 'Authorization: Bearer %s\n' "$key" >"$auth"
unset key
# Through the Service, and again after each rollout: a forward to a Pod ends
# with that Pod.
open_api() {
  # Wait for the old one, or it still holds the port when the new one binds.
  if [ -n "$forward_pid" ]; then
    kill "$forward_pid" 2>/dev/null || true
    wait "$forward_pid" 2>/dev/null || true
  fi
  # kubectl itself, not the k function: backgrounding a function forks a
  # subshell, and killing that leaves kubectl holding the port.
  kubectl -n "$NAMESPACE" port-forward --address 127.0.0.1 "svc/${fullname}-api" "${API_PORT}:3000" >"$work/forward.log" 2>&1 &
  forward_pid=$!
  local _
  for _ in $(seq 1 60); do
    kill -0 "$forward_pid" 2>/dev/null || fail "port-forward exited; set UPGRADE_API_PORT"
    grep -q "Forwarding from" "$work/forward.log" &&
      curl -s -o /dev/null --fail "http://127.0.0.1:${API_PORT}/readyz" && return
    sleep 1
  done
  fail "the api never answered /readyz through the Service"
}
get() { curl -sS --fail-with-body "http://127.0.0.1:${API_PORT}$1" -H @"$auth"; }
post() {
  curl -sS --fail-with-body "http://127.0.0.1:${API_PORT}$1" -H @"$auth" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(openssl rand -hex 16)" -d "$2"
}
open_api

wait_turn() {
  local sid="$1" turn="$2" status="" _
  for _ in $(seq 1 300); do
    status="$(get "/v1/sessions/${sid}/turns/${turn}" 2>/dev/null | jq -r .status || true)"
    case "$status" in completed) return 0 ;; failed | interrupted | cancelled | outcome_unknown) break ;; esac
    sleep 1
  done
  fail "turn ${turn} of ${sid} ended ${status:-nowhere}, not completed"
}
# wait_for <what> <jq filter on the session> <sid>: the session body matches.
wait_session() {
  local what="$1" filter="$2" sid="$3" _
  for _ in $(seq 1 120); do
    get "/v1/sessions/${sid}" 2>/dev/null | jq -e "$filter" >/dev/null && return 0
    sleep 1
  done
  fail "${sid}: ${what} never held ($(get "/v1/sessions/${sid}" | jq -c '{status, admission_state}'))"
}
# The event ids of a session as the stream gives them from the start.
event_ids() {
  curl -sSN --max-time 6 "http://127.0.0.1:${API_PORT}/v1/sessions/$1/events" -H @"$auth" 2>/dev/null |
    sed -n 's/^id: *//p' || true
}
# prefix_kept <name> <ids before file>: the ids read now begin with those.
prefix_kept() {
  local name="$1" before="$2" count
  event_ids "$name" >"$work/ids-now-${name}"
  count="$(wc -l <"$before" | tr -d ' ')"
  # An empty list (a failed read) would match anything.
  [ "$count" -ge 3 ] || fail "${name}: only ${count} events were read before, too few to compare"
  head -n "$count" "$work/ids-now-${name}" | cmp -s - "$before" ||
    fail "${name}: the first ${count} events are not the ones it had before"
  [ -z "$(sort "$work/ids-now-${name}" | uniq -d)" ] || fail "${name}: an event id appears twice"
  echo "${name}: first ${count} events kept, $(wc -l <"$work/ids-now-${name}" | tr -d ' ') now"
}
worker_pods() { k get pods -l "werft.session-id=$1" -o name | sort; }
settle_receipt() {
  local receipt="$1" what="$2" status="" _
  for _ in $(seq 1 120); do
    status="$(get "/v1/receipts/${receipt}" | jq -r .status)"
    [ "$status" = succeeded ] && return 0
    [ "$status" != failed ] || break
    sleep 1
  done
  fail "${what} receipt ended ${status}"
}

step sessions
new_session() {
  local spec="$1"
  post /v1/sessions "$(jq -nc --arg m "GATE-SPEC ${spec}" '{profile_id: "claude-coding-local", repository_id: "sample-app", message: $m}')" |
    jq -r .session_id
}
s1="$(new_session '{"id":"upgrade-wait","final":"approved turn done","steps":[{"tool":"Bash","input":{"command":"echo upgrade | tee up.txt","description":"write a file"}}]}')"
s2="$(new_session '{"id":"upgrade-paused","steps":[],"final":"turn one done"}')"
echo "S1 ${s1} waits for an approval; S2 ${s2} gets paused"
wait_session "waiting for input" '.status == "needs_input"' "$s1"
request_before="$(get "/v1/sessions/${s1}/pending-requests" | jq -r '.items[0].request_id')"
[ -n "$request_before" ] && [ "$request_before" != null ] || fail "S1 has no pending request"
worker_before="$(worker_pods "$s1")"
[ "$(echo "$worker_before" | grep -c .)" = 1 ] || fail "S1 does not have exactly one worker Pod: ${worker_before}"
echo "S1 waits on ${request_before} in ${worker_before}"
wait_turn "$s2" 1
revision="$(get "/v1/sessions/${s2}" | jq .revision)"
paused="$(post "/v1/sessions/${s2}/pause" "$(jq -nc --argjson r "$revision" '{expected_revision: $r, reason: "upgrade test"}')")"
settle_receipt "$(echo "$paused" | jq -r .receipt_id)" pause
wait_session "paused" '.admission_state == "paused"' "$s2"
checkpoint_before="$(get "/v1/sessions/${s2}" | jq '.durability.checkpoint_revision')"
get "/v1/sessions/${s2}" | jq -e '.durability.checkpoint_committed_at != null and .durability.checkpoint_revision != null' >/dev/null ||
  fail "S2 paused with no committed checkpoint"
[ -z "$(worker_pods "$s2")" ] || fail "S2 is paused and still has a worker Pod"
echo "S2 paused at checkpoint revision ${checkpoint_before}"
event_ids "$s1" >"$work/ids-s1-before"
event_ids "$s2" >"$work/ids-s2-before"
echo "events before: S1 $(wc -l <"$work/ids-s1-before" | tr -d ' '), S2 $(wc -l <"$work/ids-s2-before" | tr -d ' ')"
pass

# The rolled Deployments are told apart by this variable, which no chart
# default sets; rollback must take it away again.
marker() { k get "deploy/${fullname}-$1" -o json | jq -r '[.spec.template.spec.containers[0].env[]? | select(.name == "WERFT_UPGRADE_TEST") | .value] | first // "unset"'; }
# Pod names of the components that roll, one file per component.
snapshot_pods() {
  local tag="$1" component
  for component in api scheduler reconciler; do
    k get pods -l "app.kubernetes.io/component=${component}" -o name | sort >"$work/pods-${component}-${tag}"
  done
}
rollout() {
  local component
  for component in api egress-proxy reconciler scheduler; do
    k rollout status "deploy/${fullname}-${component}" --timeout=600s
  done
}
epoch() { jq -r "$2 | fromdateiso8601" <<<"$1"; }

step upgrade
snapshot_pods before-upgrade
[ "$(marker api)" = unset ] || fail "the marker is on the api before the upgrade"
# shellcheck disable=SC2086
helm upgrade "$RELEASE" "$root/deploy/helm/werft" --namespace "$NAMESPACE" \
  -f "$work/release-values.json" \
  --set api.extraEnv.WERFT_UPGRADE_TEST=1 \
  --set scheduler.extraEnv.WERFT_UPGRADE_TEST=1 \
  --set reconciler.extraEnv.WERFT_UPGRADE_TEST=1 \
  ${UPGRADE_EXTRA_ARGS:-} --wait --timeout 10m
rollout
helm history "$RELEASE" --namespace "$NAMESPACE"
[ "$(helm status "$RELEASE" --namespace "$NAMESPACE" -o json | jq .version)" = "$((base + 1))" ] || fail "the upgrade is not revision $((base + 1))"
check_job="$(k get "job/${fullname}-upgrade-check" -o json)" || fail "no upgrade-check Job ran"
migrate_job="$(k get "job/${fullname}-migrate" -o json)" || fail "no migrate Job ran"
verdict="$(k logs "job/${fullname}-upgrade-check" | jq -c 'select(.verdict)')"
echo "upgrade-check: ${verdict}"
echo "$verdict" | jq -e '.verdict == "proceed"' >/dev/null || fail "upgrade-check did not say proceed"
echo "$check_job" | jq -e '.status.succeeded == 1' >/dev/null || fail "the upgrade-check Job did not succeed"
# The chart's lookup of the running scheduler gave the Job the deployed image.
echo "$check_job" | jq -e '[.spec.template.spec.containers[0].env[] | select(.name == "UPGRADE_DEPLOYED_WORKER_IMAGE" or .name == "WORKER_IMAGE") | .value] | length == 2 and .[0] != "" and .[0] == .[1]' >/dev/null ||
  fail "the upgrade-check Job did not get the deployed worker image from the running scheduler"
echo "$migrate_job" | jq -e '.status.succeeded == 1' >/dev/null || fail "the migrate Job did not succeed"
check_done="$(epoch "$check_job" .status.completionTime)"
migrate_start="$(epoch "$migrate_job" .status.startTime)"
migrate_done="$(epoch "$migrate_job" .status.completionTime)"
echo "upgrade-check done ${check_done}, migrate started ${migrate_start} and done ${migrate_done} (epoch seconds)"
[ "$check_done" -le "$migrate_start" ] || fail "migrate started before upgrade-check finished"
snapshot_pods after-upgrade
for component in api scheduler reconciler; do
  [ "$(marker "$component")" = 1 ] || fail "the ${component} Deployment did not roll to the new values"
  first_new="$(k get pods -l "app.kubernetes.io/component=${component}" -o json |
    jq -r --rawfile old "$work/pods-${component}-before-upgrade" \
      '[.items[] | select(("pod/" + .metadata.name) as $n | ($old | split("\n") | index($n)) == null)
        | .metadata.creationTimestamp | fromdateiso8601] | min // empty')"
  [ -n "$first_new" ] || fail "no new ${component} Pod after the upgrade"
  echo "${component}: first new Pod created ${first_new}"
  [ "$migrate_done" -le "$first_new" ] || fail "a new ${component} Pod was created before migrate finished"
done
open_api
[ "$(get "/v1/sessions/${s1}" | jq -r .status)" = needs_input ] || fail "S1 no longer waits for input"
request_now="$(get "/v1/sessions/${s1}/pending-requests" | jq -r '.items[0].request_id')"
[ "$request_now" = "$request_before" ] || fail "S1 waits on ${request_now}, not ${request_before}"
[ "$(worker_pods "$s1")" = "$worker_before" ] || fail "S1's worker Pod changed: $(worker_pods "$s1")"
echo "S1 still waits on ${request_now} in ${worker_before}"
prefix_kept "$s1" "$work/ids-s1-before"
prefix_kept "$s2" "$work/ids-s2-before"
resumed="$(post "/v1/sessions/${s2}/resume" "$(jq -nc --argjson r "$(get "/v1/sessions/${s2}" | jq .revision)" '{expected_revision: $r}')")"
settle_receipt "$(echo "$resumed" | jq -r .receipt_id)" resume
wait_session "active" '.admission_state == "active"' "$s2"
restored="$(get "/v1/receipts/$(echo "$resumed" | jq -r .receipt_id)" | jq '.result.checkpoint_revision')"
echo "S2 resumed from checkpoint revision ${restored}, paused at ${checkpoint_before}"
[ "$restored" = "$checkpoint_before" ] || fail "S2 resumed from revision ${restored}, not the ${checkpoint_before} it paused at"
post "/v1/sessions/${s2}/messages" "$(jq -nc --arg m 'GATE-SPEC {"id":"upgrade-second","steps":[],"final":"turn two done"}' '{message: $m}')" >/dev/null
wait_turn "$s2" 2
# The turn's own checkpoint comes after the turn completes.
wait_session "a checkpoint newer than the paused one" \
  ".durability.checkpoint_revision > ${checkpoint_before} and .durability.last_checkpointed_turn_id == .durability.last_completed_turn_id" "$s2"
get "/v1/sessions/${s2}" | jq -c '.durability | {checkpoint_revision, last_completed_turn_id, last_checkpointed_turn_id, checkpoint_fallback_revision}'
# Matched in the raw stream, whatever shape the event has.
curl -sSN --max-time 4 "http://127.0.0.1:${API_PORT}/v1/sessions/${s2}/events" -H @"$auth" 2>/dev/null >"$work/s2-after-resume.sse" || true
# Without the second turn's own text the file could be empty or a failed read,
# and the absence check below would pass on it.
grep -q 'turn two done' "$work/s2-after-resume.sse" || fail "S2's stream has no text of turn 2"
! grep -E 'checkpoint_restore_failed|checkpoint_restore_fallback|checkpoint_objects_lost|context_gap_detected' "$work/s2-after-resume.sse" ||
  fail "S2's restore from the pause's checkpoint reported a failure"
echo "turn 2 of S2 completed on the new release from the paused checkpoint; no restore failure event"
event_ids "$s1" >"$work/ids-s1-mid"
event_ids "$s2" >"$work/ids-s2-mid"
pass

step rollback
check_uid="$(echo "$check_job" | jq -r .metadata.uid)"
migrate_uid="$(echo "$migrate_job" | jq -r .metadata.uid)"
helm rollback "$RELEASE" "$base" --namespace "$NAMESPACE" --wait --timeout 10m
rollout
helm history "$RELEASE" --namespace "$NAMESPACE"
[ "$(helm status "$RELEASE" --namespace "$NAMESPACE" -o json | jq .version)" = "$((base + 2))" ] || fail "the rollback is not revision $((base + 2))"
[ "$(k get "job/${fullname}-upgrade-check" -o jsonpath='{.metadata.uid}')" = "$check_uid" ] &&
  [ "$(k get "job/${fullname}-migrate" -o jsonpath='{.metadata.uid}')" = "$migrate_uid" ] ||
  fail "a hook Job was created by the rollback"
for component in api scheduler reconciler; do
  [ "$(marker "$component")" = unset ] || fail "the ${component} Deployment kept the upgrade's values"
done
echo "rollback ran no hook; api, scheduler and reconciler are back on the first revision's values"
open_api
[ "$(get "/v1/sessions/${s1}" | jq -r .status)" = needs_input ] || fail "S1 no longer waits for input after the rollback"
[ "$(get "/v1/sessions/${s1}/pending-requests" | jq -r '.items[0].request_id')" = "$request_before" ] ||
  fail "S1's pending request changed across the rollback"
[ "$(worker_pods "$s1")" = "$worker_before" ] || fail "S1's worker Pod changed: $(worker_pods "$s1")"
prefix_kept "$s1" "$work/ids-s1-mid"
prefix_kept "$s2" "$work/ids-s2-mid"
post "/v1/sessions/${s1}/answers" "$(jq -nc --arg r "$request_before" '{request_id: $r, kind: "permission", action: "allow"}')" >/dev/null
wait_turn "$s1" 1
echo "S1 answered after the upgrade and the rollback; turn 1 completed"
post "/v1/sessions/${s2}/messages" "$(jq -nc --arg m 'GATE-SPEC {"id":"upgrade-third","steps":[],"final":"turn three done"}' '{message: $m}')" >/dev/null
wait_turn "$s2" 3
echo "S2 ran turn 3 on the rolled-back release"
for sid in "$s1" "$s2"; do
  reported="$(get "/v1/sessions/${sid}/usage" | jq .cost.reported_turn_count)"
  echo "${sid}: reported turns ${reported}"
done
[ "$(get "/v1/sessions/${s1}/usage" | jq .cost.reported_turn_count)" = 1 ] || fail "S1's turn was not reported once"
[ "$(get "/v1/sessions/${s2}/usage" | jq .cost.reported_turn_count)" = 3 ] || fail "S2's three turns were not reported once each"
pass

echo
echo "k8s-upgrade: every step passed"
