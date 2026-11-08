#!/usr/bin/env bash
# List, and with --apply delete, the Docker resources of verify runs that
# nobody tore down: verify-ap-<date>-<time>-<pid> projects older than N hours
# with no running container. Dry run by default.
#
#   janitor.sh                       list candidates older than 24h
#   janitor.sh --hours 6             a different age
#   janitor.sh --exclude <run id>    never touch this run (repeatable; a project name also works)
#   janitor.sh --apply               delete what the list shows
#
# Safety, in this order:
#   - a project is judged by its exact name, never by a prefix;
#   - a project with a running container is skipped (a stack in use);
#   - a project with any resource labelled werft.keep is skipped;
#   - --exclude names the rest. A long-lived stack that is currently stopped
#     looks like an old run: read the dry run before --apply and exclude it.
# The age is the newest creation time among the project's containers, images,
# networks and volumes. Anonymous volumes are found through containers, so
# those of a project whose containers are already gone are not listed.
set -uo pipefail

hours=24
apply=
excludes=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) apply=1 ;;
    --hours) shift; hours=${1:-} ;;
    --exclude) shift; excludes+=("${1:-}") ;;
    *) echo "usage: janitor.sh [--hours N] [--exclude <run id>]... [--apply]" >&2; exit 2 ;;
  esac
  shift
done
case "$hours" in '' | 0* | *[!0-9]*) echo "janitor.sh: --hours must be a positive integer" >&2; exit 2 ;; esac

# shellcheck disable=SC1091
. "$(dirname "$0")/teardown-lib.sh"
docker info >/dev/null 2>&1 || { echo "janitor.sh: Docker does not answer; nothing was listed" >&2; exit 1; }

# RFC 3339 → seconds; empty when unreadable. Containers, images and networks
# report Z, volumes the daemon's local offset (+09:00), so the offset counts.
epoch() {
  local base off=0 sign sec
  [[ ${1:-} =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2} ]] || return 1
  base=${1:0:19}
  if [[ $1 =~ ([+-])([0-9]{2}):([0-9]{2})$ ]]; then
    sign=${BASH_REMATCH[1]}
    off=$((10#${BASH_REMATCH[2]} * 3600 + 10#${BASH_REMATCH[3]} * 60))
    [ "$sign" = "+" ] || off=$((-off))
  fi
  sec=$(date -u -j -f '%Y-%m-%dT%H:%M:%S' "$base" +%s 2>/dev/null || date -u -d "$base" +%s 2>/dev/null) || return 1
  echo $((sec - off))
}

pattern='^verify-ap-[0-9]{8}-[0-9]{6}-[0-9]+$'
projects=$(
  {
    # Docker rewrites a literal \n in --format before the template parses, so
    # the two labels are split on a space instead.
    docker ps -a --format '{{.Label "com.docker.compose.project"}} {{.Label "werft.installation"}}'
    docker network ls --format '{{.Label "com.docker.compose.project"}} {{.Label "werft.installation"}}'
    docker volume ls --format '{{.Label "com.docker.compose.project"}} {{.Label "werft.installation"}}'
    docker image ls --format '{{.Repository}}:{{.Tag}}' |
      sed -n -E 's/^werft-(control-host|worker|egress-proxy):(verify-ap-.*)$/\2/p; s/^(verify-ap-.*)-(migrate|fake-git|gitea):latest$/\1/p'
  } | tr ' ' '\n' | grep -E "$pattern" | sort -u
)

now=$(date -u +%s)
limit=$((hours * 3600))
listed=0
skipped=0
for project in $projects; do
  skip=
  for ex in ${excludes[@]+"${excludes[@]}"}; do
    [ "$ex" = "$project" ] || [ "verify-ap-$ex" = "$project" ] && skip="excluded"
  done
  if [ -z "$skip" ]; then
    up=$({ docker ps -q --filter "label=com.docker.compose.project=$project"
           docker ps -q --filter "label=werft.installation=$project"; } | sort -u | grep -c .)
    [ "$up" = 0 ] || skip="$up running container(s)"
  fi
  if [ -z "$skip" ]; then
    kept=$({ docker ps -aq --filter "label=werft.keep" --filter "label=com.docker.compose.project=$project"
             docker volume ls -q --filter "label=werft.keep" --filter "label=com.docker.compose.project=$project"
             docker network ls -q --filter "label=werft.keep" --filter "label=com.docker.compose.project=$project"; } | grep -c .)
    [ "$kept" = 0 ] || skip="labelled werft.keep"
  fi
  if [ -n "$skip" ]; then
    echo "skip  $project  ($skip)"
    skipped=$((skipped + 1))
    continue
  fi

  teardown_guard "${project#verify-ap-}" "$project" "$project" || { echo "skip  $project  (name check)"; continue; }
  teardown_snapshot "$project"
  newest=0
  while read -r kind name; do
    [ -n "$name" ] || continue
    case "$kind" in
      container) stamp=$(docker inspect --format '{{.Created}}' "$name" 2>/dev/null) ;;
      network) stamp=$(docker network inspect --format '{{.Created}}' "$name" 2>/dev/null) ;;
      volume) stamp=$(docker volume inspect --format '{{.CreatedAt}}' "$name" 2>/dev/null) ;;
      image) stamp=$(docker image inspect --format '{{.Created}}' "$name" 2>/dev/null) ;;
    esac
    t=$(epoch "${stamp:-}") || t=
    [ -z "$t" ] || [ "$t" -le "$newest" ] || newest=$t
  done < <(
    echo "$TEARDOWN_CONTAINERS" | sed '/^$/d; s/^/container /'
    echo "$TEARDOWN_NETWORKS" | sed '/^$/d; s/^/network /'
    echo "$TEARDOWN_VOLUMES" | sed '/^$/d; s/^/volume /'
    echo "$TEARDOWN_IMAGES" | sed '/^$/d; s/^/image /'
  )
  # Unreadable times count as new: such a project is never listed.
  if [ "$newest" = 0 ] || [ $((now - newest)) -le "$limit" ]; then
    echo "skip  $project  (newer than ${hours}h or age unreadable)"
    skipped=$((skipped + 1))
    continue
  fi
  echo "stale $project  (newest resource $(((now - newest) / 3600))h old)"
  teardown_print "$project" | sed 's/^/      /'
  listed=$((listed + 1))
  if [ -n "$apply" ]; then
    teardown_delete "$project"
    echo "      deleted (anything still in use was kept, see above)"
  fi
done

if [ -n "$apply" ]; then
  echo "janitor: $listed project(s) deleted, $skipped skipped"
else
  echo "janitor: dry run, nothing deleted: $listed project(s) would go, $skipped skipped (add --apply to delete)"
fi
