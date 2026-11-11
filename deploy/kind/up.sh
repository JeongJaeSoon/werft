#!/usr/bin/env bash
# Installs the chart on a local kind cluster with its default values, over
# the development stand-ins in deps.yaml, and checks what a fresh install
# must reach: the migrate Job complete, the api answering /readyz and /docs,
# the egress proxy, the reconciler, the scheduler and slack Ready.
#
#   deploy/kind/up.sh        create (or reuse) the cluster and registry, build,
#                            push, install, check
#   deploy/kind/up.sh down   delete the cluster and the registry container
#                            (with CLUSTER_PROVIDER=orbstack, NAMESPACE alone)
#
# Images go through a registry container connected to the kind network (the
# kind + registry:2 pattern), so they have the digests the chart requires.
# The kubeconfig is written to $STATE_DIR, never to ~/.kube/config.
#
# KIND_MODEL (default none) also installs what a session needs; smoke.sh
# sets it and runs one:
#   none  an empty installation: no session runs
#   fake  tests/fixtures/settings/fake-model.json, its fake Messages API and
#         Secrets Manager (deps-fake-model.yaml), and the sample repository
#   real  tests/fixtures/settings/real-model.json and the sample repository,
#         with ANTHROPIC_API_KEY read by scripts/lib/real-model-key.sh
#         (the shell's, else the AGENT_PLATFORM_DOTENV file's line). The
#         key goes into the Secret from a file descriptor: never printed,
#         never in an argument. A fresh cluster only.
#
# CLUSTER_PROVIDER=orbstack uses OrbStack's built-in cluster (`orb start k8s`)
# instead of kind: it shares the Docker engine, so the images are built
# locally and referenced by their local digest, with no registry container.
# `down` then deletes only NAMESPACE; the cluster stays as OrbStack keeps it.
# STATE_DIR defaults to ~/.cache/werft/orbstack/<namespace>.
# The images are tagged IMAGE_TAG (default kind-dev), apart from the tags
# the compose stacks give the same repositories.
#
# EXTRA_VALUES names one more values file, laid over all the others (for example
# fewer replicas on a laptop).
#
# CHART_PACKAGE names a packaged chart (.github/scripts/chart-package.ts) to
# install instead of the checkout's, with the images its values name: nothing
# is built. KIND_MODEL stays none.
#
# CI pulls nothing from Docker Hub (docs/contributing/ci.md § 서드파티 이미지 미러):
#   KIND_NODE_IMAGE, REGISTRY_IMAGE  the node and registry images
#   KIND_IMAGE_MIRROR                prefix the stand-ins' images are pulled
#                                    from instead, by the same digest
#   BUN_IMAGE, BUILDKIT_SYNTAX       build args of the app images
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-werft-dev}"
REGISTRY_NAME="${REGISTRY_NAME:-${CLUSTER_NAME}-registry}"
REGISTRY_PORT="${REGISTRY_PORT:-5001}"
# Local end of the api port-forward the check below reads through.
FORWARD_PORT="${FORWARD_PORT:-13000}"
NAMESPACE="${NAMESPACE:-werft}"
RELEASE="${RELEASE:-werft}"
KIND_MODEL="${KIND_MODEL:-none}"
CLUSTER_PROVIDER="${CLUSTER_PROVIDER:-kind}"
REGISTRY_IMAGE="${REGISTRY_IMAGE:-registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373}"

case "$CLUSTER_PROVIDER" in
  kind | orbstack) ;;
  *) echo "CLUSTER_PROVIDER must be kind or orbstack, not '${CLUSTER_PROVIDER}'" >&2; exit 1 ;;
esac
# It names the one namespace `down` deletes, and a path below.
if ! [[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]]; then
  echo "NAMESPACE must be a Kubernetes namespace name, not '${NAMESPACE}'" >&2
  exit 1
fi
# Per user, not a shared /tmp path another user could create first. The
# OrbStack cluster is shared, so there it is per namespace, and never the
# kind cluster's: its kubeconfig would point a later kind run at OrbStack.
if [ "$CLUSTER_PROVIDER" = orbstack ]; then
  STATE_DIR="${STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/werft/orbstack/${NAMESPACE}}"
else
  STATE_DIR="${STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/werft/kind/${CLUSTER_NAME}}"
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
export KUBECONFIG="${STATE_DIR}/kubeconfig"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if [ "$CLUSTER_PROVIDER" = orbstack ]; then
  # OrbStack writes its context to the default kubeconfig.
  env -u KUBECONFIG kubectl config view --raw --minify --context orbstack >"$KUBECONFIG"
  chmod 600 "$KUBECONFIG"
  if [ "${1:-}" = down ]; then
    kubectl delete namespace "$NAMESPACE" --ignore-not-found --wait
    exit 0
  fi
fi

if [ "${1:-}" = down ]; then
  kind delete cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG"
  docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
  exit 0
fi

case "$KIND_MODEL" in
  none | fake | real) ;;
  *) echo "KIND_MODEL must be none, fake or real, not '${KIND_MODEL}'" >&2; exit 1 ;;
esac
if [ -n "${CHART_PACKAGE:-}" ] && [ "$KIND_MODEL" != none ]; then
  echo "CHART_PACKAGE needs KIND_MODEL=none: a session needs the images this script builds" >&2
  exit 1
fi
# It goes into a sed replacement below.
if ! [[ "${KIND_IMAGE_MIRROR:-}" =~ ^[a-z0-9./:-]*$ ]]; then
  echo "KIND_IMAGE_MIRROR must be a registry path, not '${KIND_IMAGE_MIRROR}'" >&2
  exit 1
fi

# The manifest with each image moved to the mirror: `<path>/<name>:<tag>@<digest>`
# becomes `$KIND_IMAGE_MIRROR/<name>@<digest>`, the mirror's naming.
manifest() {
  if [ -n "${KIND_IMAGE_MIRROR:-}" ]; then
    sed -E "s#^( *image: )([^ ]*/)?([a-z0-9-]+):[^@ ]+@#\\1${KIND_IMAGE_MIRROR}/\\3@#" "$1"
  else
    cat "$1"
  fi
}

if [ "$CLUSTER_PROVIDER" = kind ]; then
if [ -z "$(docker ps -q --filter "name=^${REGISTRY_NAME}$")" ]; then
  docker run -d --restart=always -p "127.0.0.1:${REGISTRY_PORT}:5000" \
    --network bridge --name "$REGISTRY_NAME" "$REGISTRY_IMAGE" >/dev/null
fi

if ! kind get clusters | grep -qx "$CLUSTER_NAME"; then
  kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" \
    ${KIND_NODE_IMAGE:+--image "$KIND_NODE_IMAGE"} --config - <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"
EOF
fi
# Pods pull localhost:<port>/... from the registry container by its name.
for node in $(kind get nodes --name "$CLUSTER_NAME"); do
  dir="/etc/containerd/certs.d/localhost:${REGISTRY_PORT}"
  docker exec "$node" mkdir -p "$dir"
  printf '[host."http://%s:5000"]\n' "$REGISTRY_NAME" | docker exec -i "$node" cp /dev/stdin "$dir/hosts.toml"
done
docker network connect kind "$REGISTRY_NAME" 2>/dev/null || true
fi

image_repo="localhost:${REGISTRY_PORT}/werft"
[ "$CLUSTER_PROVIDER" = kind ] || image_repo="werft"
# Builds one app image and prints the digest the chart pins it by: the
# registry's after a push on kind; on OrbStack, whose cluster pulls from the
# Docker engine's own store, the manifest digest the containerd image store
# gives a local build.
publish() {
  local ref="${image_repo}-$1:dev"
  [ "$CLUSTER_PROVIDER" = kind ] || ref="${image_repo}-$1:${IMAGE_TAG:-kind-dev}"
  # The control host's fake-git runs testkit from this image, so a stack takes
  # its `local` target. A head from before the target existed (a preview of an
  # older PR runs this script against that PR's tree) has none: its default
  # image still carries testkit.
  local target=()
  if [ "$1" = control-host ] && grep -q '^FROM .* AS local$' "$root/apps/$1/Dockerfile"; then
    target=(--target local)
  fi
  docker build -q -f "$root/apps/$1/Dockerfile" -t "$ref" \
    ${target[@]+"${target[@]}"} \
    ${BUN_IMAGE:+--build-arg "BUN_IMAGE=$BUN_IMAGE"} \
    ${BUILDKIT_SYNTAX:+--build-arg "BUILDKIT_SYNTAX=$BUILDKIT_SYNTAX"} \
    "$root" >/dev/null || return
  if [ "$CLUSTER_PROVIDER" = orbstack ]; then
    local digest
    digest="$(docker images --digests --format '{{.Digest}}' "$ref")"
    # The classic image store has no digest for an image never pushed.
    if ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "no manifest digest for ${ref} ('${digest}'): the Docker engine must use the containerd image store" >&2
      return 1
    fi
    echo "$digest"
    return
  fi
  docker push -q "$ref" >/dev/null || return
  docker inspect --format '{{index .RepoDigests 0}}' "$ref" | sed 's/.*@//'
}
image_values=()
if [ -z "${CHART_PACKAGE:-}" ]; then
  # The three builds share nothing but their base images, so they run side by
  # side: one after another they took ~130s of a CI k8s-smoke run, most of it
  # each image's own apt and download layers. Each writes its digest to a
  # file; a build that fails is named and stops the install.
  built="$(mktemp -d)"
  pids=()
  apps=(control-host egress-proxy worker)
  for app in "${apps[@]}"; do
    publish "$app" >"$built/$app" &
    pids+=("$!")
  done
  failed=()
  for i in "${!apps[@]}"; do
    wait "${pids[$i]}" || failed+=("${apps[$i]}")
  done
  if [ "${#failed[@]}" -gt 0 ]; then
    rm -rf "$built"
    echo "image build failed: ${failed[*]}" >&2
    exit 1
  fi
  control_host_digest="$(<"$built/control-host")"
  egress_proxy_digest="$(<"$built/egress-proxy")"
  worker_digest="$(<"$built/worker")"
  rm -rf "$built"
  for digest in "$control_host_digest" "$egress_proxy_digest" "$worker_digest"; do
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || {
      echo "an image build printed no digest: '${digest}'" >&2
      exit 1
    }
  done
  image_values=(
    --set "images.controlHost.repository=${image_repo}-control-host"
    --set "images.controlHost.digest=${control_host_digest}"
    --set "images.egressProxy.repository=${image_repo}-egress-proxy"
    --set "images.egressProxy.digest=${egress_proxy_digest}"
    --set "images.worker.repository=${image_repo}-worker"
    --set "images.worker.digest=${worker_digest}"
  )
fi

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" create configmap localstack-init \
  --from-file=10-create-resources.sh="$root/infra/localstack/init/10-create-resources.sh" \
  --dry-run=client -o yaml | kubectl apply -f -
manifest "$root/deploy/kind/deps.yaml" | kubectl -n "$NAMESPACE" apply -f -
deps=(postgres localstack)
values=(-f "$root/deploy/kind/values.yaml")

if [ "$KIND_MODEL" != none ]; then
  kubectl -n "$NAMESPACE" create configmap secrets-init \
    --from-file=10-seed-secrets.sh="$root/infra/localstack/secrets-init/10-seed-secrets.sh" \
    --dry-run=client -o yaml | kubectl apply -f -
  manifest "$root/deploy/kind/deps-secrets.yaml" | kubectl -n "$NAMESPACE" apply -f -
  deps+=(secrets)
  manifest "$root/deploy/kind/deps-session.yaml" |
    sed "s#CONTROL_HOST_IMAGE#${image_repo}-control-host@${control_host_digest}#" |
    kubectl -n "$NAMESPACE" apply -f -
  deps+=(fake-git)
  values+=(-f "$root/deploy/kind/values-${KIND_MODEL}-model.yaml")
fi
if [ "$KIND_MODEL" = fake ]; then
  testkit="$root/packages/testkit/src"
  kubectl -n "$NAMESPACE" create configmap fake-messages-source \
    --from-file="$testkit/fake-messages-main.ts" \
    --from-file="$testkit/fake-anthropic.ts" \
    --from-file="$testkit/scripted-messages.ts" \
    --dry-run=client -o yaml | kubectl apply -f -
  manifest "$root/deploy/kind/deps-fake-model.yaml" | kubectl -n "$NAMESPACE" apply -f -
  deps+=(fake-messages)
fi

# The Secret the chart reads. The authorizer token is random per cluster,
# never printed and never on a command line, and so is the master key; the
# rest are the stand-ins' local defaults. The chart names ANTHROPIC_API_KEY,
# which only has to resolve unless KIND_MODEL is real.
if [ "$KIND_MODEL" = real ]; then
  if kubectl -n "$NAMESPACE" get secret werft >/dev/null 2>&1; then
    echo "KIND_MODEL=real needs a fresh cluster: the Secret already holds another key (up.sh down first)" >&2
    exit 1
  fi
  set +x
  # shellcheck source=../../scripts/lib/real-model-key.sh
  . "$root/scripts/lib/real-model-key.sh"
  if ! real_model_key_from_dotenv; then
    echo "KIND_MODEL=real: no ANTHROPIC_API_KEY in the shell or in ${AGENT_PLATFORM_DOTENV:-.env}" >&2
    exit 1
  fi
  provider_key() { printf '%s' "$ANTHROPIC_API_KEY"; }
else
  provider_key() { printf kind-check-no-key; }
fi
if ! kubectl -n "$NAMESPACE" get secret werft >/dev/null 2>&1; then
  kubectl -n "$NAMESPACE" create secret generic werft \
    --from-literal=DATABASE_URL=postgresql://postgres:dev@postgres:5432/sessions \
    --from-file=EGRESS_AUTHORIZER_TOKEN=<(openssl rand -hex 32 | tr -d '\n') \
    --from-file=PLATFORM_SECRET_KEY=<(openssl rand -hex 32 | tr -d '\n') \
    --from-file=BOOTSTRAP_TOKEN=<(openssl rand -hex 32 | tr -d '\n') \
    --from-literal=AWS_ACCESS_KEY_ID=test \
    --from-literal=AWS_SECRET_ACCESS_KEY=test \
    --from-file=ANTHROPIC_API_KEY=<(provider_key) >/dev/null
elif [ "$(kubectl -n "$NAMESPACE" get secret werft -o 'go-template={{if .data.PLATFORM_SECRET_KEY}}set{{end}}')" != set ]; then
  key_patch="$(mktemp)"
  printf '{"data":{"PLATFORM_SECRET_KEY":"%s"}}' "$(openssl rand -hex 32 | tr -d '\n' | base64 | tr -d '\n')" >"$key_patch"
  kubectl -n "$NAMESPACE" patch secret werft --patch-file "$key_patch" >/dev/null
  rm -f "${key_patch:?}"
fi
# The first owner's token: the checks release their agent as that owner
# (release-key.sh). A Secret from before it gets one.
if [ "$(kubectl -n "$NAMESPACE" get secret werft -o 'go-template={{if .data.BOOTSTRAP_TOKEN}}set{{end}}')" != set ]; then
  token_patch="$(mktemp)"
  printf '{"data":{"BOOTSTRAP_TOKEN":"%s"}}' "$(openssl rand -hex 32 | tr -d '\n' | base64 | tr -d '\n')" >"$token_patch"
  kubectl -n "$NAMESPACE" patch secret werft --patch-file "$token_patch" >/dev/null
  rm -f "${token_patch:?}"
fi
unset ANTHROPIC_API_KEY

for dep in "${deps[@]}"; do
  kubectl -n "$NAMESPACE" rollout status "deploy/$dep" --timeout=300s
done

# preview.sh runs this copy over older heads, whose chart has another name
# and another default Secret, and may keep the chart in another directory.
chart="$(dirname "$(printf '%s\n' "$root"/deploy/helm/*/Chart.yaml | head -n 1)")"
chart_name="$(sed -n 's/^name: //p' "$chart/Chart.yaml")"

# Helm waits for the migrate hook, and the rollouts below for the rest.
helm upgrade --install "$RELEASE" "${CHART_PACKAGE:-$chart}" \
  --namespace "$NAMESPACE" \
  "${values[@]}" \
  ${EXTRA_VALUES:+-f "$EXTRA_VALUES"} \
  --set "secrets.name=werft" \
  ${image_values[@]+"${image_values[@]}"} \
  --timeout 10m

fullname="$RELEASE"
case "$RELEASE" in *"$chart_name"*) ;; *) fullname="${RELEASE}-${chart_name}" ;; esac
fullname="${fullname:0:50}"
fullname="${fullname%-}"
# preview.sh points its Ingress at this name.
echo "$fullname" >"$STATE_DIR/fullname"

kubectl -n "$NAMESPACE" wait --for=condition=complete "job/${fullname}-migrate" --timeout=60s
for deploy in api egress-proxy reconciler scheduler slack; do
  kubectl -n "$NAMESPACE" rollout status "deploy/${fullname}-${deploy}" --timeout=600s
done

if [ "$KIND_MODEL" != none ]; then
  NAMESPACE="$NAMESPACE" RELEASE="$RELEASE" "$root/scripts/k8s-api.sh" \
    settings import --document - <"$root/tests/fixtures/settings/${KIND_MODEL}-model.json"
  kubectl -n "$NAMESPACE" rollout restart "deploy/${fullname}-api"
  kubectl -n "$NAMESPACE" rollout status "deploy/${fullname}-api" --timeout=600s
fi

kubectl -n "$NAMESPACE" port-forward "svc/${fullname}-api" "${FORWARD_PORT}:3000" >"$STATE_DIR/port-forward.log" 2>&1 &
forward=$!
trap 'kill "$forward" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:${FORWARD_PORT}/healthz" && break
  sleep 1
done
status=0
for path in /readyz /docs; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${FORWARD_PORT}${path}")"
  echo "GET ${path} -> ${code}"
  [ "$code" = 200 ] || status=1
done

kubectl -n "$NAMESPACE" get jobs,deploy,pods -o wide
exit "$status"
