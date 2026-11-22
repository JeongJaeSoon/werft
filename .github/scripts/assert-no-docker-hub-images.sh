#!/usr/bin/env bash
# Fails when a Docker daemon holds an image from Docker Hub: CI pulls those
# from its ghcr.io mirror (ci-image-mirror.yml). It looks at what
# was actually pulled, so it catches a Docker Hub pull however it was made —
# a service, a `docker run` in a step, or a suite calling the Engine API with
# a name no static check recognizes.
#
# The rule is "not Docker Hub", not "only the mirror": the runner image ships
# images of its own (ghcr.io/github/..., ghcr.io/dependabot/...) that no step
# pulled.
#
# usage: assert-no-docker-hub-images.sh <docker command...>
#   e.g. assert-no-docker-hub-images.sh docker
#        assert-no-docker-hub-images.sh env DOCKER_HOST=unix:///tmp/apq/docker.sock docker
set -euo pipefail

# Judged by where each image was pulled from, i.e. its RepoDigests. An image
# built on the daemon has none and is skipped. What it was built FROM is not
# reliably listed (BuildKit need not register the base as an image), so a
# build step must name its base by a mirror reference itself.
#
# Assignments, so a daemon that cannot answer fails here rather than
# reading as an empty, clean list.
ids=$("$@" images --quiet --no-trunc | sort -u)
listing=""
if [ -n "$ids" ]; then
  # shellcheck disable=SC2086 # one argument per id
  listing=$("$@" image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' $ids)
fi
echo "pulled images on this daemon:"
echo "${listing:-(none)}" | sed 's/^/  /'

failed=0
while IFS= read -r pulled; do
  [ -n "$pulled" ] || continue
  repository=${pulled%@*}
  first=${repository%%/*}
  # Docker's own rule: a first component is a registry host only when it has
  # a dot or a port, or is localhost; otherwise the name is on Docker Hub.
  if [ "$first" != "$repository" ] && { [[ "$first" == *[.:]* ]] || [ "$first" = localhost ]; }; then
    case "$first" in
    docker.io | index.docker.io | registry-1.docker.io) ;;
    *) continue ;;
    esac
  fi
  echo "::error::${repository} came from Docker Hub; mirror it in ci-image-mirror.yml and pull it from there"
  failed=1
done <<<"$listing"
exit "$failed"
