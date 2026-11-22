# shellcheck shell=bash
# Sourced by netpol.sh, smoke.sh, replicas.sh and upgrade.sh after they set
# NAMESPACE and RELEASE. up.sh keeps its own copy of the fullname: preview.sh
# copies up.sh alone into older checkouts, which have no lib.sh.

# kind_suite <name>: `step` prints "== <name>: <step>", `pass` and `fail`
# name the current step.
kind_suite() { suite="$1"; }
k() { kubectl -n "$NAMESPACE" "$@"; }
step() { current="$1"; echo; echo "== ${suite}: $*"; }
pass() { echo "PASS ${current}"; }
fail() { echo "FAIL ${current}: $*" >&2; exit 1; }

# The chart's werft.fullname for RELEASE.
kind_fullname() {
  local name="$RELEASE"
  case "$RELEASE" in *werft*) ;; *) name="${RELEASE}-werft" ;; esac
  name="${name:0:50}"
  printf '%s\n' "${name%-}"
}

# Sets created=1 when no kind cluster named CLUSTER_NAME exists, and refuses
# one that does unless REUSE_CLUSTER=1. A kind or docker error must not read
# as "no cluster": the teardown would then delete a cluster this run did not
# create.
kind_claim_cluster() {
  local clusters
  clusters="$(kind get clusters)"
  created=""
  if printf '%s\n' "$clusters" | grep -qx "$CLUSTER_NAME"; then
    [ "${REUSE_CLUSTER:-}" = 1 ] || {
      echo "a cluster named ${CLUSTER_NAME} already exists; set CLUSTER_NAME, or REUSE_CLUSTER=1 to run on it" >&2
      exit 1
    }
  else
    # shellcheck disable=SC2034 # the caller's teardown reads it
    created=1
  fi
}

# probe_pod <name> <labels> <sleep seconds>: a busybox Pod (PROBE_IMAGE) with
# those labels, Ready. Callers dial addresses, not names: the probes
# themselves must not need DNS.
probe_pod() {
  local name="$1" labels="$2" sleep="$3"
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
      command: ["sleep", "${sleep}"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: {drop: [ALL]}
EOF
  k wait --for=condition=Ready "pod/${name}" --timeout=120s >/dev/null
}
