# Sourced by down.sh, up.sh's failure path and janitor.sh. Names the Docker
# resources of ONE verify run, by exact label value or exact tag, never by
# prefix or glob: a long-lived stack's project name also starts with
# verify-ap-, so a prefix match would delete it.
#
#   teardown_guard <run id> <project> <installation id>   0 only when both equal verify-ap-<run id>
#   teardown_snapshot <project>                           print the targets, remember them
#   teardown_delete <project> [keep-volumes]              remove what the snapshot named

teardown_guard() {
  local want
  [ -n "${1:-}" ] || return 1
  want=verify-ap-$(printf '%s' "$1" | tr -cd 'a-z0-9-')
  [[ $want =~ ^verify-ap-[0-9]{8}-[0-9]{6}-[0-9]+$ ]] || return 1
  [ "${2:-}" = "$want" ] && [ "${3:-}" = "$want" ]
}

# Run-scoped lists, one name per line. Label filters compare the whole value.
teardown_containers() {
  { docker ps -aq --filter "label=com.docker.compose.project=$1"
    docker ps -aq --filter "label=werft.installation=$1"; } | sort -u
}

teardown_networks() {
  { docker network ls --filter "label=com.docker.compose.project=$1" --format '{{.Name}}'
    docker network ls --filter "label=werft.installation=$1" --format '{{.Name}}'; } | sort -u
}

# Labelled volumes plus the anonymous (64 hex) volumes the run's containers
# mounted. local.sh removes workers with `docker rm -f`, which keeps their
# anonymous volumes, and once the container is gone nothing links them to the
# run, so they are read from the containers before teardown.
teardown_volumes() {
  local ns=${EXECUTION_VOLUME_LABEL_NAMESPACE:-werft} ids
  ids=$(teardown_containers "$1")
  {
    docker volume ls -q --filter "label=com.docker.compose.project=$1"
    docker volume ls -q --filter "label=$ns.installation=$1"
    if [ -n "$ids" ]; then
      # shellcheck disable=SC2086 # one id per line, no spaces
      # No \n in the template: Docker rewrites it before parsing.
      docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' $ids |
        tr ' ' '\n' | grep -E '^[0-9a-f]{64}$'
    fi
  } | sort -u
}

# The three tags up.sh sets and the three compose names for services built
# without an image: line. Only those that exist are printed.
teardown_images() {
  local tag
  for tag in "werft-control-host:$1" "werft-worker:$1" "werft-egress-proxy:$1" \
    "$1-migrate:latest" "$1-fake-git:latest" "$1-gitea:latest"; do
    docker image inspect "$tag" >/dev/null 2>&1 && echo "$tag"
  done
  return 0
}

teardown_snapshot() {
  TEARDOWN_CONTAINERS=$(teardown_containers "$1")
  TEARDOWN_NETWORKS=$(teardown_networks "$1")
  TEARDOWN_VOLUMES=$(teardown_volumes "$1")
  TEARDOWN_IMAGES=$(teardown_images "$1")
}

teardown_print() {
  echo "teardown targets of $1:"
  echo "  containers: $(echo "$TEARDOWN_CONTAINERS" | grep -c .)"
  echo "$TEARDOWN_NETWORKS" | sed '/^$/d; s/^/  network /'
  echo "$TEARDOWN_VOLUMES" | sed '/^$/d; s/^/  volume  /'
  echo "$TEARDOWN_IMAGES" | sed '/^$/d; s/^/  image   /'
}

# No -f anywhere: a resource another run still uses refuses and is skipped.
# Networks and volumes are removed by the names the snapshot took.
teardown_delete() {
  local keep=${2:-} name
  for name in $TEARDOWN_CONTAINERS; do docker rm -v "$name" >/dev/null 2>&1 || true; done
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
