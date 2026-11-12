#!/usr/bin/env bash
# The service containers of an integration job (PostgreSQL, LocalStack),
# started by a step instead of `services:`. The runner starts
# `services:` before the first step, one after another, and waits out each
# health check on a 2·4·8s backoff; here the pulls run side by side while the
# job installs its dependencies, and readiness is probed every second.
#
# usage: ci-services.sh start    launch the enabled services in the background
#        ci-services.sh wait     block until each is ready; fail with its logs
#        ci-services.sh stop     remove the containers
#
# env:   POSTGRES, LOCALSTACK             "true" enables that service
#        POSTGRES_SERVICE_IMAGE, LOCALSTACK_SERVICE_IMAGE
#        SERVICES_DIR                     launch records (default $RUNNER_TEMP/ci-services)
#        SERVICES_WAIT_SECONDS            wait's deadline, pull included (default 180)
#        SERVICES_CALL_TIMEOUT            seconds one docker call may take in wait (default 10)
#        DOCKER_CLI                       the docker command (tests replace it)
set -euo pipefail

export SERVICES_DIR=${SERVICES_DIR:-${RUNNER_TEMP:?}/ci-services}
dir=$SERVICES_DIR
docker=${DOCKER_CLI:-docker}
# A stalled daemon must not hold wait past its deadline by more than this.
bounded() { timeout "${SERVICES_CALL_TIMEOUT:-10}" "$docker" "$@"; }

enabled() {
  [ "${POSTGRES:-}" = true ] && echo postgres
  [ "${LOCALSTACK:-}" = true ] && echo localstack
  return 0
}

# Same ports, variables and probes the `services:` blocks had.
launch() {
  local service=$1
  case "$service" in
  postgres)
    set -- --publish 5432:5432 \
      --env POSTGRES_DB=sessions \
      --env POSTGRES_PASSWORD=dev \
      --env POSTGRES_USER=postgres \
      "${POSTGRES_SERVICE_IMAGE:?}"
    ;;
  localstack)
    # secretsmanager: the catalog's secret_id references.
    set -- --publish 4566:4566 \
      --env SERVICES=s3,secretsmanager \
      --env AWS_DEFAULT_REGION=ap-northeast-1 \
      --env AWS_ACCESS_KEY_ID=test \
      --env AWS_SECRET_ACCESS_KEY=test \
      "${LOCALSTACK_SERVICE_IMAGE:?}"
    ;;
  esac
  "$docker" run --detach --name "ci-$service" "$@"
}

probe() {
  case "$1" in
  # Over TCP, not the socket: the image's entrypoint first runs a temporary
  # server on the socket alone to initialize the database, then restarts it.
  # A socket probe can answer that one, and the first test then meets "the
  # database system is starting up" (main runs 43172293397, 43201768981).
  postgres) bounded exec ci-postgres pg_isready -q -h 127.0.0.1 -U postgres -d sessions ;;
  localstack) bounded exec ci-localstack curl -fsS http://localhost:4566/_localstack/health ;;
  esac
}

# Shows why a service is not ready; the caller fails the step.
report() {
  local service=$1 reason=$2
  echo "::error::${service} service ${reason}"
  echo "::group::${service}: docker run"
  cat "$dir/$service.out" 2>/dev/null || true
  echo "::endgroup::"
  echo "::group::${service}: container log"
  bounded logs --tail 200 "ci-$service" 2>&1 || true
  echo "::endgroup::"
}

case "${1:-}" in
start)
  mkdir -p "$dir"
  for service in $(enabled); do
    # Detached from the step's output, which the runner would otherwise wait
    # to close. `.rc` appears only once `docker run` has returned.
    nohup bash -c '
      set +e
      service=$1; shift
      "$@" launch-one "$service" >"$SERVICES_DIR/$service.out" 2>&1
      echo $? >"$SERVICES_DIR/$service.rc.tmp"
      mv "$SERVICES_DIR/$service.rc.tmp" "$SERVICES_DIR/$service.rc"
    ' _ "$service" bash "$0" </dev/null >/dev/null 2>&1 &
    echo "starting ${service}"
  done
  ;;
launch-one)
  service=$2
  launch "$service"
  ;;
wait)
  deadline=$((SECONDS + ${SERVICES_WAIT_SECONDS:-180}))
  pending=$(enabled)
  while [ -n "$pending" ]; do
    still=""
    for service in $pending; do
      if [ ! -f "$dir/$service.rc" ]; then
        still="$still $service"
        continue
      fi
      rc=$(cat "$dir/$service.rc")
      if [ "$rc" != 0 ]; then
        report "$service" "could not be started (docker run exited ${rc})"
        exit 1
      fi
      state=$(bounded inspect --format '{{.State.Status}}' "ci-$service" 2>/dev/null || echo missing)
      if [ "$state" != running ]; then
        report "$service" "container is ${state}, not running"
        exit 1
      fi
      if probe "$service" >/dev/null 2>&1; then
        echo "${service} ready ${SECONDS}s into the wait"
      else
        still="$still $service"
      fi
    done
    pending=${still# }
    [ -n "$pending" ] || break
    if [ "$SECONDS" -ge "$deadline" ]; then
      for service in $pending; do
        report "$service" "not ready after ${SERVICES_WAIT_SECONDS:-180}s"
      done
      exit 1
    fi
    sleep 1
  done
  ;;
stop)
  for service in postgres localstack; do
    "$docker" rm --force --volumes "ci-$service" >/dev/null 2>&1 || true
  done
  ;;
*)
  echo "usage: $0 start|wait|stop" >&2
  exit 2
  ;;
esac
