#!/usr/bin/env bash
# helm upgrade and helm rollback while sessions are alive, on kind. A session
# waiting for an approval and a paused one (it holds a checkpoint, no worker)
# are created on the installed release, carried through an upgrade and then a
# rollback, and must come out the other side as they went in.
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

# shellcheck source=lib.sh
. "$here/lib.sh"
kind_suite k8s-upgrade
fullname="$(kind_fullname)"
kind_claim_cluster

forward_pid=""
auth="$STATE_DIR/upgrade-auth-header"
work="$STATE_DIR/upgrade-work"
finish() {
  local status=$?
  [ -z "$forward_pid" ] || kill "$forward_pid" 2>/dev/null || true
  rm -f "$auth" "$auth.approve"
  if [ "$status" != 0 ] && [ -f "$KUBECONFIG" ]; then
    echo "== k8s-upgrade: state after the failure" >&2
    helm history "$RELEASE" --namespace "$NAMESPACE" >&2 || true
    k get deploy,pods,jobs -o wide >&2 || true
    echo "-- events" >&2
    k get events --sort-by=.lastTimestamp >&2 || true
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

# up.sh with the fake model.
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

{ set +x; } 2>/dev/null
umask 077
# shellcheck source=release-key.sh
. "$here/release-key.sh"
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
# An answer goes under the owner's second key: the one that started the
# session is refused (`self_approval`).
post() {
  local header="$auth"
  case "$1" in */answers) header="${auth}.approve" ;; esac
  curl -sS --fail-with-body "http://127.0.0.1:${API_PORT}$1" -H @"$header" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(openssl rand -hex 16)" -d "$2"
}
open_api
# Every session runs an agent release: the first owner releases the checks'
# agent and its key, in a 0600 header file, starts the sessions.
kind_release_key "http://127.0.0.1:${API_PORT}" "$auth" || fail "the checks' agent was not released"

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

# S1 waits for an approval (its worker stays); S2 finishes turn 1 and is paused
# (checkpoint committed, no worker).
step sessions
new_session() {
  local spec="$1"
  post /v1/sessions "$(jq -nc --arg m "GATE-SPEC ${spec}" --arg r "$KIND_RELEASE_ID" '{agent_release_id: $r, repository_id: "sample-app", message: $m}')" |
    jq -r .session_id
}
s1="$(new_session '{"id":"upgrade-wait","final":"approved turn done","steps":[{"tool":"Bash","input":{"command":"echo upgrade | sed -n \"w up.txt\"","description":"write a file"}}]}')"
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

# A helm upgrade that rolls api, scheduler and reconciler: upgrade-check says
# proceed; the hooks ran in order (upgrade-check, then migrate, then the new
# Pods); S1 still waits on the same request in the same worker Pod; S2 resumes
# from the checkpoint it paused with and runs turn 2; the events each session
# had are still its first events.
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

# helm rollback to the first revision: no hook ran; the old Deployments are
# back; S1 is still waiting, is answered and completes; S2 runs a third turn.
step rollback
check_uid="$(echo "$check_job" | jq -r .metadata.uid)"
migrate_uid="$(echo "$migrate_job" | jq -r .metadata.uid)"
# S2 goes through the rollback paused, as it went through the upgrade: with a
# second worker holding a CPU the rollout's surge Pod has no room on a
# runner-sized node and the rollback never finishes.
paused="$(post "/v1/sessions/${s2}/pause" "$(jq -nc --argjson r "$(get "/v1/sessions/${s2}" | jq .revision)" '{expected_revision: $r, reason: "rollback test"}')")"
settle_receipt "$(echo "$paused" | jq -r .receipt_id)" pause
wait_session "paused" '.admission_state == "paused"' "$s2"
checkpoint_mid="$(get "/v1/sessions/${s2}" | jq '.durability.checkpoint_revision')"
echo "S2 paused again at checkpoint revision ${checkpoint_mid}"
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
resumed="$(post "/v1/sessions/${s2}/resume" "$(jq -nc --argjson r "$(get "/v1/sessions/${s2}" | jq .revision)" '{expected_revision: $r}')")"
settle_receipt "$(echo "$resumed" | jq -r .receipt_id)" resume
wait_session "active" '.admission_state == "active"' "$s2"
restored="$(get "/v1/receipts/$(echo "$resumed" | jq -r .receipt_id)" | jq '.result.checkpoint_revision')"
echo "S2 resumed on the rolled-back release from checkpoint revision ${restored}, paused at ${checkpoint_mid}"
[ "$restored" = "$checkpoint_mid" ] || fail "S2 resumed from revision ${restored}, not the ${checkpoint_mid} it paused at"
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

# The images.workers procedure of the upgrade docs, with the chart's own
# files/next-workers.jq: the single-image install goes to a list, then to the
# next list. The release images stand in for packaged ones: B and D are A
# rebuilt with another label (another digest, the same runtime), C is the
# Codex image. Nothing launches a Codex session here (kind has no fake
# Responses API); the compose two_engines conformance runs both engines.
#
# The single worker image A becomes images.workers [B, A, C] through
# files/next-workers.jq (B: A rebuilt, C: Codex); S3 waits on A in the same
# Pod; S2 resumes on B.
step list
image_repo="localhost:${REGISTRY_PORT:-5001}/werft"
# deployed_values <file>: the values of the deployed revision, as the docs read them.
deployed_values() {
  local revision
  revision="$(helm history "$RELEASE" --namespace "$NAMESPACE" -o json | jq '[.[] | select(.status == "deployed")] | last.revision')"
  helm get values "$RELEASE" --namespace "$NAMESPACE" --all --revision "$revision" -o json >"$1"
}
env_of() { k get "deploy/${fullname}-$1" -o json | jq -r --arg n "$2" '[.spec.template.spec.containers[0].env[]? | select(.name == $n) | .value] | first // ""'; }
pod_image() { k get pods -l "werft.session-id=$1" -o json | jq -r '[.items[].spec.containers[0].image] | unique | join(",")'; }
runtime_of() {
  docker run --rm -i --network none --entrypoint bun "$1" run apps/worker/src/image-runtime.ts <<<'{}' | jq -c 'del(.profiles)'
}
# push <local ref>: the registry digest the cluster pulls it by.
# errexit is off inside $(...): every step returns its failure, or a stale tag
# from an earlier run would pass for the new image.
push() {
  docker push -q "$1" >/dev/null || return
  docker inspect --format '{{index .RepoDigests 0}}' "$1" | sed 's/.*@//'
}
rebuild() {
  printf 'FROM %s\nLABEL werft.kind-rebuild=%s\n' "${image_repo}-worker:dev" "$1" |
    docker build -q -t "${image_repo}-worker:rebuild-$1" - >/dev/null || return
  push "${image_repo}-worker:rebuild-$1"
}
# upgrade_to <values file>: helm upgrade of the checkout's chart over up.sh's
# values; the hook verdict must be proceed with an empty approval list.
upgrade_to() {
  helm upgrade "$RELEASE" "$root/deploy/helm/werft" --namespace "$NAMESPACE" \
    -f "$work/release-values.json" -f "$1" \
    --set-json 'upgrade.approvedSessions=[]' --wait --timeout 10m
  rollout
  verdict="$(k logs "job/${fullname}-upgrade-check" | jq -c 'select(.verdict)')"
  echo "upgrade-check: ${verdict}"
  echo "$verdict" | jq -e '.verdict == "proceed"' >/dev/null || fail "upgrade-check did not say proceed"
}
hook_env() { k get "job/${fullname}-upgrade-check" -o json | jq -r --arg n "$1" '[.spec.template.spec.containers[0].env[] | select(.name == $n) | .value] | first // ""'; }
# same_list <expected WORKER_IMAGES>: api, scheduler and the hook carry it.
same_list() {
  local component
  for component in api scheduler; do
    [ "$(env_of "$component" WORKER_IMAGES)" = "$1" ] || fail "${component} WORKER_IMAGES is $(env_of "$component" WORKER_IMAGES), not $1"
    [ -z "$(env_of "$component" WORKER_IMAGE)" ] || fail "${component} still sets WORKER_IMAGE beside the list"
  done
  [ "$(hook_env WORKER_IMAGES)" = "$1" ] || fail "the upgrade-check Job judged $(hook_env WORKER_IMAGES), not the list that rolled out"
}
rendered() { jq -c '[.images.workers[] | {image: "\(.repository)@\(.digest)", released_at: .releasedAt, runtime} + (if .retracted then {retracted: true} else {} end)]' "$1"; }
# The list as WORKER_IMAGES spells it: the chart's toJson sorts the keys.
as_env() { jq -cS . <<<"$1"; }

# pause_session <id>: paused, and its worker Pod gone.
pause_session() {
  local paused _
  paused="$(post "/v1/sessions/$1/pause" "$(jq -nc --argjson r "$(get "/v1/sessions/$1" | jq .revision)" '{expected_revision: $r, reason: "list test"}')")"
  settle_receipt "$(echo "$paused" | jq -r .receipt_id)" pause
  wait_session "paused" '.admission_state == "paused"' "$1"
  for _ in $(seq 1 60); do
    [ -z "$(worker_pods "$1")" ] && return
    sleep 1
  done
  fail "$1 is paused and still has a worker Pod"
}
# S1 is done but its idle worker still holds memory a runner-sized node needs
# for S3's worker and S2's next one.
pause_session "$s1"
pause_session "$s2"
checkpoint_list="$(get "/v1/sessions/${s2}" | jq '.durability.checkpoint_revision')"
s3="$(new_session '{"id":"list-wait","final":"list turn done","steps":[{"tool":"Bash","input":{"command":"echo list | sed -n \"w list.txt\"","description":"write a file"}}]}')"
wait_session "waiting for input" '.status == "needs_input"' "$s3"
request_s3="$(get "/v1/sessions/${s3}/pending-requests" | jq -r '.items[0].request_id')"
worker_s3="$(worker_pods "$s3")"
[ "$(echo "$worker_s3" | grep -c .)" = 1 ] || fail "S3 does not have exactly one worker Pod: ${worker_s3}"
echo "S2 paused at checkpoint revision ${checkpoint_list}; S3 ${s3} waits on ${request_s3} in ${worker_s3}"

deployed_values "$work/deployed-single.json"
single_revision="$(helm status "$RELEASE" --namespace "$NAMESPACE" -o json | jq .version)"
digest_a="$(jq -r .images.worker.digest "$work/deployed-single.json")"
[ "$(pod_image "$s3")" = "${image_repo}-worker@${digest_a}" ] || fail "S3 runs $(pod_image "$s3"), not A"
runtime_a="$(runtime_of "${image_repo}-worker:dev")"
digest_b="$(rebuild b)"
digest_d="$(rebuild d)"
docker build -q -f "$root/apps/worker/Dockerfile" -t "${image_repo}-worker-codex:dev" \
  --build-arg WORKER_RUNTIME=codex_app_server \
  ${BUN_IMAGE:+--build-arg "BUN_IMAGE=$BUN_IMAGE"} \
  ${BUILDKIT_SYNTAX:+--build-arg "BUILDKIT_SYNTAX=$BUILDKIT_SYNTAX"} \
  "$root" >/dev/null
digest_c="$(push "${image_repo}-worker-codex:dev")"
runtime_c="$(runtime_of "${image_repo}-worker-codex:dev")"
jq -e '.engine == "codex"' <<<"$runtime_c" >/dev/null || fail "the Codex image runs ${runtime_c}"
for digest in "$digest_a" "$digest_b" "$digest_c" "$digest_d"; do
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "an image has no registry digest: '${digest}'"
done
[ "$digest_b" != "$digest_a" ] && [ "$digest_d" != "$digest_b" ] || fail "the rebuilds kept A's digest"
echo "A ${digest_a}, B ${digest_b}, C ${digest_c}, D ${digest_d}"
# release_images <claude digest> <claude time> <codex time>: files/release-images.json of a package.
release_images() {
  jq -n --arg repo "${image_repo}-worker" --arg d "$1" --arg t "$2" --argjson r "$runtime_a" \
    --arg crepo "${image_repo}-worker-codex" --arg cd "$digest_c" --arg ct "$3" --argjson cr "$runtime_c" \
    '[{repository: $repo, digest: $d, runtime: $r, releasedAt: $t},
      {repository: $crepo, digest: $cd, runtime: $cr, releasedAt: $ct}]'
}
next_workers() {
  jq -n -f "$root/deploy/helm/werft/files/next-workers.jq" --arg phase "$1" \
    --slurpfile deployed "$2" --slurpfile release "$3" --argjson known "$4"
}
release_images "$digest_b" 2026-01-02T00:00:00Z 2026-01-02T00:00:00Z >"$work/release-1.json"
next_workers final "$work/deployed-single.json" "$work/release-1.json" \
  "$(jq -n --arg a "$digest_a" --argjson r "$runtime_a" '{($a): {runtime: $r, releasedAt: "2026-01-01T00:00:00Z"}}')" \
  >"$work/workers-1.json"
jq -e --arg a "$digest_a" --arg b "$digest_b" --arg c "$digest_c" \
  '[.images.workers[].digest] == [$b, $a, $c]' "$work/workers-1.json" >/dev/null ||
  fail "next-workers gave $(jq -c '[.images.workers[].digest]' "$work/workers-1.json") for the first list"
single_image="$(env_of scheduler WORKER_IMAGE)"
upgrade_to "$work/workers-1.json"
list_1="$(as_env "$(rendered "$work/workers-1.json")")"
same_list "$list_1"
[ "$(hook_env UPGRADE_DEPLOYED_WORKER_IMAGE)" = "$single_image" ] && [ -z "$(hook_env UPGRADE_DEPLOYED_WORKER_IMAGES)" ] ||
  fail "the upgrade-check Job did not get the single image deployed before it"
echo "single image ${single_image} -> list ${list_1}"
open_api
[ "$(get "/v1/sessions/${s3}/pending-requests" | jq -r '.items[0].request_id')" = "$request_s3" ] || fail "S3's pending request changed"
[ "$(worker_pods "$s3")" = "$worker_s3" ] || fail "S3's worker Pod changed: $(worker_pods "$s3")"
resumed="$(post "/v1/sessions/${s2}/resume" "$(jq -nc --argjson r "$(get "/v1/sessions/${s2}" | jq .revision)" '{expected_revision: $r}')")"
settle_receipt "$(echo "$resumed" | jq -r .receipt_id)" resume
wait_session "active" '.admission_state == "active"' "$s2"
[ "$(get "/v1/receipts/$(echo "$resumed" | jq -r .receipt_id)" | jq '.result.checkpoint_revision')" = "$checkpoint_list" ] ||
  fail "S2 did not resume from the checkpoint it paused at"
post "/v1/sessions/${s2}/messages" "$(jq -nc --arg m 'GATE-SPEC {"id":"list-fourth","steps":[],"final":"turn four done"}' '{message: $m}')" >/dev/null
wait_turn "$s2" 4
# The compatible rebuild is the newest Claude image: the session moves to it.
[ "$(pod_image "$s2")" = "${image_repo}-worker@${digest_b}" ] || fail "S2 runs $(pod_image "$s2"), not B"
echo "S2 resumed on B and ran turn 4; S3 still waits on A in ${worker_s3}"
paused="$(post "/v1/sessions/${s2}/pause" "$(jq -nc --argjson r "$(get "/v1/sessions/${s2}" | jq .revision)" '{expected_revision: $r, reason: "next list test"}')")"
settle_receipt "$(echo "$paused" | jq -r .receipt_id)" pause
wait_session "paused" '.admission_state == "paused"' "$s2"
checkpoint_next="$(get "/v1/sessions/${s2}" | jq '.durability.checkpoint_revision')"
pass

# The control phase keeps that list, then [D, B, C] drops A: refused for a
# stale approval alone, the rerun gives the same file, and it proceeds while
# S3's launch on A holds a slot (B restores what A seals); S3 completes on A
# and pauses; S2 (paused on B) and S3 (paused on A) resume on D.
step next-list
deployed_values "$work/deployed-list.json"
next_workers control "$work/deployed-list.json" "$work/release-1.json" '{}' >"$work/control-phase.json"
upgrade_to "$work/control-phase.json"
same_list "$list_1"
[ "$(hook_env UPGRADE_DEPLOYED_WORKER_IMAGES)" = "$list_1" ] || fail "the upgrade-check Job did not get the deployed list"
echo "the control phase kept the list"
deployed_values "$work/deployed-list.json"
release_images "$digest_d" 2026-01-03T00:00:00Z 2026-01-02T00:00:00Z >"$work/release-2.json"
next_workers final "$work/deployed-list.json" "$work/release-2.json" '{}' >"$work/workers-2.json"
jq -e --arg b "$digest_b" --arg c "$digest_c" --arg d "$digest_d" \
  '[.images.workers[].digest] == [$d, $b, $c]' "$work/workers-2.json" >/dev/null ||
  fail "next-workers gave $(jq -c '[.images.workers[].digest]' "$work/workers-2.json") for the next list"
# S3 launched on A before any runtime was declared for it, so its launch
# record has none. The list declares A's runtime, under which B (A rebuilt)
# restores what A seals: dropping A goes ahead while that launch holds a
# slot. A stale approval is refused first, which a check that still held
# S3's slot against A would refuse before reaching the approvals.
if helm upgrade "$RELEASE" "$root/deploy/helm/werft" --namespace "$NAMESPACE" \
  -f "$work/release-values.json" -f "$work/workers-2.json" \
  --set-json 'upgrade.approvedSessions=["stale-approval"]' --wait --timeout 10m; then
  fail "dropping A passed with a stale approval"
fi
verdict="$(k logs "job/${fullname}-upgrade-check" | jq -c 'select(.verdict)')"
echo "upgrade-check: ${verdict}"
echo "$verdict" | jq -e '.verdict == "refused" and (.reason | endswith("no longer affected: stale-approval"))' >/dev/null ||
  fail "dropping A was not refused for the stale approval alone"
# The failed revision is not the deployed one: the procedure gives the same file.
deployed_values "$work/deployed-retry.json"
next_workers final "$work/deployed-retry.json" "$work/release-2.json" '{}' >"$work/workers-2-retry.json"
cmp -s "$work/workers-2.json" "$work/workers-2-retry.json" || fail "the rerun after the refusal gave another list"
upgrade_to "$work/workers-2.json"
list_2="$(as_env "$(rendered "$work/workers-2.json")")"
same_list "$list_2"
[ "$(hook_env UPGRADE_DEPLOYED_WORKER_IMAGES)" = "$list_1" ] || fail "the upgrade-check Job did not get the list deployed before it"
echo "list -> next list ${list_2}, S3's launch on A holding a slot"
open_api
# A left the list, but the worker started on it finishes its turn there.
[ "$(worker_pods "$s3")" = "$worker_s3" ] || fail "S3's worker Pod changed: $(worker_pods "$s3")"
[ "$(pod_image "$s3")" = "${image_repo}-worker@${digest_a}" ] || fail "S3 runs $(pod_image "$s3"), not A"
post "/v1/sessions/${s3}/answers" "$(jq -nc --arg r "$request_s3" '{request_id: $r, kind: "permission", action: "allow"}')" >/dev/null
wait_turn "$s3" 1
pause_session "$s3"
checkpoint_s3="$(get "/v1/sessions/${s3}" | jq '.durability.checkpoint_revision')"
echo "S3 completed on A after A left the list and paused"
resumed="$(post "/v1/sessions/${s2}/resume" "$(jq -nc --argjson r "$(get "/v1/sessions/${s2}" | jq .revision)" '{expected_revision: $r}')")"
settle_receipt "$(echo "$resumed" | jq -r .receipt_id)" resume
wait_session "active" '.admission_state == "active"' "$s2"
[ "$(get "/v1/receipts/$(echo "$resumed" | jq -r .receipt_id)" | jq '.result.checkpoint_revision')" = "$checkpoint_next" ] ||
  fail "S2 did not resume from the checkpoint it paused at on B"
post "/v1/sessions/${s2}/messages" "$(jq -nc --arg m 'GATE-SPEC {"id":"list-fifth","steps":[],"final":"turn five done"}' '{message: $m}')" >/dev/null
wait_turn "$s2" 5
[ "$(pod_image "$s2")" = "${image_repo}-worker@${digest_d}" ] || fail "S2 runs $(pod_image "$s2"), not D"
# What A sealed for S3 restores on D, though A left the list.
resumed="$(post "/v1/sessions/${s3}/resume" "$(jq -nc --argjson r "$(get "/v1/sessions/${s3}" | jq .revision)" '{expected_revision: $r}')")"
settle_receipt "$(echo "$resumed" | jq -r .receipt_id)" resume
wait_session "active" '.admission_state == "active"' "$s3"
[ "$(get "/v1/receipts/$(echo "$resumed" | jq -r .receipt_id)" | jq '.result.checkpoint_revision')" = "$checkpoint_s3" ] ||
  fail "S3 did not resume from the checkpoint it paused at on A"
post "/v1/sessions/${s3}/messages" "$(jq -nc --arg m 'GATE-SPEC {"id":"list-s3-second","steps":[],"final":"S3 turn two done"}' '{message: $m}')" >/dev/null
wait_turn "$s3" 2
[ "$(pod_image "$s3")" = "${image_repo}-worker@${digest_d}" ] || fail "S3 runs $(pod_image "$s3"), not D"
echo "S2 resumed on D from B and ran turn 5; S3 resumed on D from A and ran turn 2"
[ "$(get "/v1/sessions/${s2}/usage" | jq .cost.reported_turn_count)" = 5 ] || fail "S2's five turns were not reported once each"
[ "$(get "/v1/sessions/${s3}/usage" | jq .cost.reported_turn_count)" = 2 ] || fail "S3's two turns were not reported once each"
pass

# helm rollback from that list to the single image A: no hook ran; api and
# scheduler are back on WORKER_IMAGE; S2 (paused on D) resumes on A and a new
# S4 launches on A; then a list that keeps A: S4's worker, started before it,
# runs turn 2 in the same Pod.
step list-rollback
# launch_images <sid>: the image of each of its launches, oldest first.
launch_images() {
  k exec deploy/postgres -- psql -U postgres -d sessions -Atc \
    "SELECT coalesce(image, '') FROM worker_launches WHERE session_id = '$1' ORDER BY generation"
}
pause_session "$s2"
pause_session "$s3"
checkpoint_rollback="$(get "/v1/sessions/${s2}" | jq '.durability.checkpoint_revision')"
check_uid="$(k get "job/${fullname}-upgrade-check" -o jsonpath='{.metadata.uid}')"
# No hook judges a rollback: the docs' direct check, from a list deployment
# (the running scheduler's WORKER_IMAGES), against the target revision's image.
# The api Pod of a list carries WORKER_IMAGES itself, which the check refuses
# beside a single target image.
direct="$(k exec "deploy/${fullname}-api" -- env -u WORKER_IMAGES \
  UPGRADE_DEPLOYED_WORKER_IMAGES="$(env_of scheduler WORKER_IMAGES)" \
  WORKER_IMAGE="$single_image" WORKER_IMAGE_RUNTIME="$runtime_a" \
  bun run apps/control-host/src/api/upgrade-check.ts 2>&1 | jq -c 'select(.verdict?)' 2>/dev/null || true)"
echo "direct check before the rollback: ${direct}"
echo "$direct" | jq -e '.verdict == "proceed" and .affected == []' >/dev/null ||
  fail "the direct check from the list to A did not say proceed"
helm rollback "$RELEASE" "$single_revision" --namespace "$NAMESPACE" --wait --timeout 10m
rollout
helm history "$RELEASE" --namespace "$NAMESPACE"
[ "$(k get "job/${fullname}-upgrade-check" -o jsonpath='{.metadata.uid}')" = "$check_uid" ] ||
  fail "a hook Job was created by the rollback"
# A single-image install gives the image to the scheduler only.
[ "$(env_of scheduler WORKER_IMAGE)" = "$single_image" ] ||
  fail "scheduler WORKER_IMAGE is '$(env_of scheduler WORKER_IMAGE)', not ${single_image}"
for component in api scheduler; do
  [ -z "$(env_of "$component" WORKER_IMAGES)" ] || fail "${component} still sets WORKER_IMAGES after the rollback"
done
echo "rollback to revision ${single_revision} ran no hook; the scheduler is back on ${single_image}, no WORKER_IMAGES left"
open_api
s4="$(new_session '{"id":"rollback-new","steps":[],"final":"rollback turn one done"}')"
wait_turn "$s4" 1
worker_s4="$(worker_pods "$s4")"
[ "$(echo "$worker_s4" | grep -c .)" = 1 ] || fail "S4 does not have exactly one worker Pod: ${worker_s4}"
[ "$(pod_image "$s4")" = "$single_image" ] || fail "S4 runs $(pod_image "$s4"), not A"
[ "$(launch_images "$s4")" = "$single_image" ] || fail "S4's launches are $(launch_images "$s4" | tr '\n' ' '), not one on A"
echo "S4 ${s4} launched on A after the rollback and idles in ${worker_s4}"
resumed="$(post "/v1/sessions/${s2}/resume" "$(jq -nc --argjson r "$(get "/v1/sessions/${s2}" | jq .revision)" '{expected_revision: $r}')")"
settle_receipt "$(echo "$resumed" | jq -r .receipt_id)" resume
wait_session "active" '.admission_state == "active"' "$s2"
[ "$(get "/v1/receipts/$(echo "$resumed" | jq -r .receipt_id)" | jq '.result.checkpoint_revision')" = "$checkpoint_rollback" ] ||
  fail "S2 did not resume from the checkpoint it paused at on D"
post "/v1/sessions/${s2}/messages" "$(jq -nc --arg m 'GATE-SPEC {"id":"rollback-sixth","steps":[],"final":"turn six done"}' '{message: $m}')" >/dev/null
wait_turn "$s2" 6
[ "$(pod_image "$s2")" = "$single_image" ] || fail "S2 runs $(pod_image "$s2"), not A"
[ "$(launch_images "$s2" | tail -n 1)" = "$single_image" ] || fail "S2's newest launch is not on A"
echo "S2 resumed on A from D after the rollback and ran turn 6"
# S4's idle worker is the one the next upgrade carries; S2's would leave the
# rollout's surge Pod no room on a runner-sized node.
pause_session "$s2"

deployed_values "$work/deployed-rolled-back.json"
[ "$(jq -r .images.worker.digest "$work/deployed-rolled-back.json")" = "$digest_a" ] ||
  fail "the deployed revision after the rollback is not the single image A"
release_images "$digest_a" 2026-01-01T00:00:00Z 2026-01-02T00:00:00Z >"$work/release-same.json"
next_workers final "$work/deployed-rolled-back.json" "$work/release-same.json" \
  "$(jq -n --arg a "$digest_a" --argjson r "$runtime_a" '{($a): {runtime: $r, releasedAt: "2026-01-01T00:00:00Z"}}')" \
  >"$work/workers-same.json"
jq -e --arg a "$digest_a" --arg c "$digest_c" '[.images.workers[].digest] == [$a, $c]' "$work/workers-same.json" >/dev/null ||
  fail "next-workers gave $(jq -c '[.images.workers[].digest]' "$work/workers-same.json") for the list that keeps A"
upgrade_to "$work/workers-same.json"
list_same="$(as_env "$(rendered "$work/workers-same.json")")"
same_list "$list_same"
[ "$(hook_env UPGRADE_DEPLOYED_WORKER_IMAGE)" = "$single_image" ] && [ -z "$(hook_env UPGRADE_DEPLOYED_WORKER_IMAGES)" ] ||
  fail "the upgrade-check Job did not get the single image the rollback deployed"
echo "single image ${single_image} -> list ${list_same}"
open_api
[ "$(worker_pods "$s4")" = "$worker_s4" ] || fail "S4's worker Pod changed: $(worker_pods "$s4")"
post "/v1/sessions/${s4}/messages" "$(jq -nc --arg m 'GATE-SPEC {"id":"rollback-new-second","steps":[],"final":"S4 turn two done"}' '{message: $m}')" >/dev/null
wait_turn "$s4" 2
[ "$(worker_pods "$s4")" = "$worker_s4" ] || fail "S4 ran turn 2 in another Pod: $(worker_pods "$s4")"
[ "$(launch_images "$s4")" = "$single_image" ] || fail "S4's launches are $(launch_images "$s4" | tr '\n' ' '), not the one on A"
echo "S4's worker, started on the single image, ran turn 2 in ${worker_s4} after the list upgrade"
[ "$(get "/v1/sessions/${s2}/usage" | jq .cost.reported_turn_count)" = 6 ] || fail "S2's six turns were not reported once each"
[ "$(get "/v1/sessions/${s4}/usage" | jq .cost.reported_turn_count)" = 2 ] || fail "S4's two turns were not reported once each"
pass

echo
echo "k8s-upgrade: every step passed"
