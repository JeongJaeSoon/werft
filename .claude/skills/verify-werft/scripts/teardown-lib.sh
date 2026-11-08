# Sourced by down.sh, up.sh's failure path and janitor.sh. Names the Docker
# resources of ONE verify run, by exact label value or exact tag, never by
# prefix or glob: a long-lived stack's project name also starts with
# verify-ap-, so a prefix match would delete it.
#
#   teardown_guard <run id> <project> <installation id>   0 only when both equal verify-ap-<run id>
#   teardown_snapshot <project>                           collect the targets; non-zero when Docker could not answer
#   teardown_print <project>                              print them
#   teardown_delete <project> [keep-volumes]              remove what the snapshot named

teardown_guard() {
  [[ ${1:-} =~ ^[0-9]{8}-[0-9]{6}-[0-9]+$ ]] || return 1
  [ "${2:-}" = "verify-ap-$1" ] && [ "${3:-}" = "verify-ap-$1" ]
}

# Run-scoped lists, one name per line. Label filters compare the whole value.
# A Docker error is an error, not an empty list: deleting on a partial list
# would lose the link between a container and its anonymous volumes.
teardown_containers() {
  local a b
  a=$(docker ps -aq --filter "label=com.docker.compose.project=$1") || return 1
  b=$(docker ps -aq --filter "label=werft.installation=$1") || return 1
  printf '%s\n%s\n' "$a" "$b" | sed '/^$/d' | sort -u
}

teardown_networks() {
  local a b
  a=$(docker network ls --filter "label=com.docker.compose.project=$1" --format '{{.Name}}') || return 1
  b=$(docker network ls --filter "label=werft.installation=$1" --format '{{.Name}}') || return 1
  printf '%s\n%s\n' "$a" "$b" | sed '/^$/d' | sort -u
}

# Labelled volumes plus the anonymous (64 hex) volumes the run's containers
# mounted. local.sh removes workers with `docker rm -f`, which keeps their
# anonymous volumes, and once the container is gone nothing links them to the
# run, so they are read from the containers before teardown.
teardown_volumes() {
  local ns=${EXECUTION_VOLUME_LABEL_NAMESPACE:-werft} ids id a b mounts="" one
  ids=$(teardown_containers "$1") || return 1
  a=$(docker volume ls -q --filter "label=com.docker.compose.project=$1") || return 1
  b=$(docker volume ls -q --filter "label=$ns.installation=$1") || return 1
  for id in $ids; do
    # No \n in the template: Docker rewrites it before parsing.
    if one=$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$id" 2>/dev/null); then
      mounts="$mounts $one"
    else
      # A worker that exited between the list and the inspect is fine; a
      # container that is still there and cannot be read is not.
      [ -z "$(docker ps -aq --filter "id=$id")" ] || return 1
    fi
  done
  # grep exits 1 on no match, which pipefail would turn into a failure.
  { printf '%s\n%s\n' "$a" "$b"; echo "$mounts" | tr ' ' '\n' | { grep -E '^[0-9a-f]{64}$' || true; }; } |
    sed '/^$/d' | sort -u
}

# The three tags up.sh sets and the three compose names for services built
# without an image: line. Only those that exist are printed.
teardown_images() {
  local tag found
  for tag in "werft-control-host:$1" "werft-worker:$1" "werft-egress-proxy:$1" \
    "$1-migrate:latest" "$1-fake-git:latest" "$1-gitea:latest"; do
    found=$(docker image ls -q "$tag") || return 1
    [ -z "$found" ] || echo "$tag"
  done
  return 0
}

teardown_snapshot() {
  TEARDOWN_CONTAINERS=$(teardown_containers "$1") || return 1
  TEARDOWN_NETWORKS=$(teardown_networks "$1") || return 1
  TEARDOWN_VOLUMES=$(teardown_volumes "$1") || return 1
  TEARDOWN_IMAGES=$(teardown_images "$1") || return 1
}

teardown_print() {
  echo "teardown targets of $1:"
  echo "  containers: $(echo "$TEARDOWN_CONTAINERS" | grep -c .)"
  echo "$TEARDOWN_NETWORKS" | sed '/^$/d; s/^/  network /'
  echo "$TEARDOWN_VOLUMES" | sed '/^$/d; s/^/  volume  /'
  echo "$TEARDOWN_IMAGES" | sed '/^$/d; s/^/  image   /'
}

# No -f anywhere: a resource another run still uses refuses and is skipped.
# Names come from the snapshot. With keep, a container that is somehow still
# here is removed without -v, so its anonymous volumes stay too.
teardown_delete() {
  local keep=${2:-} name
  for name in $TEARDOWN_CONTAINERS; do
    if [ -n "$keep" ]; then docker rm "$name" >/dev/null 2>&1 || true; else docker rm -v "$name" >/dev/null 2>&1 || true; fi
  done
  for name in $TEARDOWN_NETWORKS; do
    docker network rm "$name" >/dev/null 2>&1 || echo "kept network $name (in use?)" >&2
  done
  if [ -z "$keep" ]; then
    for name in $TEARDOWN_VOLUMES; do
      docker volume rm "$name" >/dev/null 2>&1 || echo "kept volume $name (in use?)" >&2
    done
  fi
  for name in $TEARDOWN_IMAGES; do
    docker image rm "$name" >/dev/null 2>&1 || echo "kept image $name (in use?)" >&2
  done
  return 0
}

# Snapshot volumes that still exist, by exact name (the label search cannot
# find an anonymous volume whose container is gone).
teardown_volumes_left() {
  local name
  for name in $TEARDOWN_VOLUMES; do
    docker volume inspect "$name" >/dev/null 2>&1 && echo "$name"
  done
  return 0
}
