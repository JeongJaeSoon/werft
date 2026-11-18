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
#        SERVICES_PULL_STALL              seconds a pull may go without progress before it is cut (default 45)
#        DOCKER_CLI                       the docker command (tests replace it)
set -euo pipefail

export SERVICES_DIR=${SERVICES_DIR:-${RUNNER_TEMP:?}/ci-services}
dir=$SERVICES_DIR
docker=${DOCKER_CLI:-docker}
# A stalled daemon must not hold wait past its deadline by more than this.
bounded() { timeout "${SERVICES_CALL_TIMEOUT:-10}" "$docker" "$@"; }

. "$(dirname "${BASH_SOURCE[0]}")/../../tests/e2e/fetch-retry.sh"

# Pulls <image> into <out>, cutting a pull whose download has stopped (main
# run 44221838238: two layers sat for the whole 180s wait) with a line
# fetch_retried treats as a transfer failure. Without a terminal docker pull
# prints a line only when a layer changes state, so a large layer that is
# slow but moving would look stopped; on a terminal it redraws the progress
# of every layer as bytes arrive. The pull therefore runs on a pseudo-terminal
# (util-linux script), and SERVICES_PULL_STALL seconds without a redraw means
# no bytes came in. Where that script is missing nothing is cut. A cut layer
# is fetched from its start on the next try. The wait deadline still bounds
# every try together.
pull_cut() {
  local out=$1 image=$2 pid size last=-1 idle=0 status=0 grace
  if ! script --version 2>/dev/null | grep -q util-linux; then
    "$docker" pull "$image"
    return
  fi
  script -qfec "$(printf '%q ' "$docker" pull "$image")" /dev/null >"$out" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    size=$(wc -c <"$out")
    if [ "$size" = "$last" ]; then
      idle=$((idle + 1))
    else
      idle=0
      last=$size
    fi
    if [ "$idle" -ge "${SERVICES_PULL_STALL:-45}" ]; then
      kill "$pid" 2>/dev/null || true
      for ((grace = 0; grace < 10; grace++)); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      cat "$out"
      rm -f "$out"
      echo "transfer stalled: no pull progress for ${idle}s"
      return 1
    fi
  done
  wait "$pid" || status=$?
  cat "$out"
  rm -f "$out"
  return "$status"
}

# The end of a pull's output as plain lines, without the terminal's redraws.
pull_tail() {
  tr '\r' '\n' <"$1" | sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' | grep -v '^[[:space:]]*$' | tail -n 60
}

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
    set -- --publish 4566:4566 \
      --env SERVICES=s3 \
      --env AWS_DEFAULT_REGION=ap-northeast-1 \
      --env AWS_ACCESS_KEY_ID=test \
      --env AWS_SECRET_ACCESS_KEY=test \
      "${LOCALSTACK_SERVICE_IMAGE:?}"
    ;;
  esac
  echo "image pull" >"$dir/$service.step"
  fetch_retried "$dir/$service.pull" pull_cut "$dir/$service.pulling" "${!#}"
  echo "docker run" >"$dir/$service.step"
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
  echo "::group::${service}: image pull"
  [ ! -f "$dir/$service.pull" ] || pull_tail "$dir/$service.pull" || true
  if [ -f "$dir/$service.pulling" ]; then
    echo "-- the pull still running:"
    pull_tail "$dir/$service.pulling" || true
  fi
  echo "::endgroup::"
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
        step=$(cat "$dir/$service.step" 2>/dev/null || echo launch)
        report "$service" "could not be started (${step} exited ${rc})"
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
