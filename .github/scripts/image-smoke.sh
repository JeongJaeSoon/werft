#!/usr/bin/env bash
# Smoke for one app image: `image-smoke.sh <control-host|worker|worker-codex|egress-proxy> <image ref>`.
# Shared by images.yml's build (loaded image) and publish (the digest that
# was actually pushed) jobs so both check the same things.
set -euo pipefail

app="$1"
image="$2"

# Only containers this run started carry this label, so cleanup never
# touches anything else on the daemon.
smoke_label="werft.image-smoke=$$-${RANDOM}"
cleanup() {
  ids="$(docker ps -aq --filter "label=${smoke_label}")"
  [ -z "$ids" ] || docker rm -f $ids >/dev/null
}
config_dir=""
trap 'cleanup; [ -z "$config_dir" ] || rm -rf "$config_dir"' EXIT

# Times git out five times the way the checkpoint verifier does (own process
# group, SIGKILL to the group) and prints how many zombies the container
# holds afterwards. The alias makes git fork a shell that forks again, so
# every kill orphans processes that only PID 1 can reap.
zombie_probe='
const { defaultGitRunner } = await import("/app/packages/storage/src/git-runner.ts");
const { readdirSync, readFileSync } = await import("node:fs");
for (let i = 0; i < 5; i++) {
  const r = await defaultGitRunner(
    ["-c", "alias.hang=!sleep 30 & sleep 30", "hang"],
    { env: {}, timeoutMs: 500 },
  );
  if (!r.timedOut) throw new Error("git was expected to time out");
}
await Bun.sleep(1000);
let zombies = 0;
for (const pid of readdirSync("/proc").filter((d) => /^[0-9]+$/.test(d))) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) zombies++;
  } catch {}
}
console.log(zombies);
'

# the API image must reap what the verifier orphans wherever it
# runs, not only under compose's `init: true`.
api_init_smoke() {
  local image="$1" cid
  local key=0000000000000000000000000000000000000000000000000000000000000001
  local refused status
  refused="$(timeout 60 docker run --rm --label "$smoke_label" \
    -e DATABASE_URL=postgres://smoke:smoke@127.0.0.1:1/smoke \
    -e CHECKPOINT_OBJECT_STORE=disabled \
    -e EXECUTION_SLOT_LIMIT=1 -e QUEUED_INPUT_LIMIT_PER_SESSION=1 \
    -e STORAGE_LIMIT_BYTES=1000000 -e MAX_TURN_SECONDS=60 \
    -e SESSION_COST_LIMIT_USD=1 -e PROVIDER_MAX_RETRIES=0 \
    "$image" 2>&1)" && status=0 || status=$?
  # A pattern match, not `| grep -q`: under pipefail grep's early exit can
  # fail the printf with SIGPIPE.
  if [ "$status" = 0 ] || [ "$status" = 124 ] || [[ "$refused" != *"PLATFORM_SECRET_KEY is required"* ]]; then
    printf '%s\n' "$refused" >&2
    echo "expected the API to refuse to start without the master key (exit $status)" >&2
    exit 1
  fi
  echo "without the master key: exit $status"
  refused="$(timeout 60 docker run --rm --label "$smoke_label" \
    -e DATABASE_URL=postgres://smoke:smoke@127.0.0.1:1/smoke \
    -e CHECKPOINT_OBJECT_STORE=disabled \
    -e EXECUTION_SLOT_LIMIT=1 -e QUEUED_INPUT_LIMIT_PER_SESSION=1 \
    -e STORAGE_LIMIT_BYTES=1000000 -e MAX_TURN_SECONDS=60 \
    -e SESSION_COST_LIMIT_USD=1 -e PROVIDER_MAX_RETRIES=0 \
    -e "PLATFORM_SECRET_KEY=$key" \
    -e PLATFORM_CONFIG_DIR=/config \
    "$image" 2>&1)" && status=0 || status=$?
  if [ "$status" = 0 ] || [ "$status" = 124 ] || [[ "$refused" != *"PLATFORM_CONFIG_DIR no longer read"* ]]; then
    printf '%s\n' "$refused" >&2
    echo "expected the API to refuse a leftover PLATFORM_CONFIG_DIR (exit $status)" >&2
    exit 1
  fi
  echo "with PLATFORM_CONFIG_DIR: exit $status"
  # The default command, with a database that is never reached: the server
  # stays up (readiness answers 503) and nothing here needs it. The
  # installation limits have no code default.
  cid="$(docker run -d --label "$smoke_label" \
    -e DATABASE_URL=postgres://smoke:smoke@127.0.0.1:1/smoke \
    -e CHECKPOINT_OBJECT_STORE=disabled \
    -e EXECUTION_SLOT_LIMIT=1 -e QUEUED_INPUT_LIMIT_PER_SESSION=1 \
    -e STORAGE_LIMIT_BYTES=1000000 -e MAX_TURN_SECONDS=60 \
    -e SESSION_COST_LIMIT_USD=1 -e PROVIDER_MAX_RETRIES=0 \
    -e "PLATFORM_SECRET_KEY=$key" \
    "$image")"
  sleep 3
  if [ "$(docker inspect -f '{{.State.Running}}' "$cid")" != true ]; then
    docker logs "$cid" >&2
    echo "API container exited" >&2
    exit 1
  fi
  assert_init_reaps "$image" "$cid"
}

# for the API, for the worker: tini is PID 1, the app is its
# child, and the orphans a timed-out git leaves behind are reaped. `cid` is a
# running container of the image started with its own ENTRYPOINT.
assert_init_reaps() {
  local image="$1" cid="$2" pid1 app_ppid zombies control
  pid1="$(docker exec "$cid" cat /proc/1/comm)"
  echo "PID 1: $pid1"
  [ "$pid1" = tini ] || { echo "expected tini as PID 1, not $pid1" >&2; exit 1; }
  # The app is the only bun in the container at this point.
  app_ppid="$(docker exec "$cid" sh -c 'for d in /proc/[0-9]*; do awk "/^Name:/ { n = \$2 } /^PPid:/ && n == \"bun\" { print \$2 }" "$d/status" 2>/dev/null; done')"
  echo "app parent: $app_ppid"
  [ "$app_ppid" = 1 ] || { echo "expected the app to be tini's child" >&2; exit 1; }
  zombies="$(docker exec "$cid" bun -e "$zombie_probe")"
  echo "zombies after 5 git timeouts under tini: $zombies"
  [ "$zombies" = 0 ] || { echo "expected no zombies" >&2; exit 1; }

  # Negative control: with bun as PID 1 the same probe must find zombies,
  # or the check above proves nothing.
  cid="$(docker run -d --label "$smoke_label" --entrypoint /usr/local/bin/bun \
    "$image" -e 'setInterval(() => {}, 1 << 30)')"
  control="$(docker exec "$cid" bun -e "$zombie_probe")"
  echo "zombies after 5 git timeouts under bun as PID 1: $control"
  [ "$control" -gt 0 ] || { echo "the zombie probe found none without an init" >&2; exit 1; }
}

# the proxy boots from its own image with no source mounted, runs
# unprivileged over code it cannot rewrite, refuses what is not allowlisted,
# and stops on SIGTERM as PID 1.
egress_proxy_smoke() {
  local image="$1" cid status code exit_code
  cid="$(docker run -d --label "$smoke_label" \
    -e EGRESS_ALLOWLIST=allowed.example.invalid:443 "$image")"
  for _ in $(seq 1 30); do
    status="$(docker exec "$cid" bun -e "const r = await fetch('http://127.0.0.1:3128/healthz'); console.log(r.status)" 2>/dev/null || true)"
    [ "$status" = 200 ] && break
    sleep 1
  done
  if [ "$status" != 200 ]; then
    docker logs "$cid" >&2
    echo "egress proxy never answered /healthz" >&2
    exit 1
  fi
  docker exec "$cid" sh -c 'test "$(id -u)" = 1000 && test ! -w /app/src/main.ts && test ! -w /app/src'
  code="$(docker exec "$cid" bun -e "const r = await fetch('http://denied.example.invalid/', { proxy: 'http://127.0.0.1:3128' }); console.log(r.status)")"
  echo "absolute-form request to a host off the allowlist: $code"
  [ "$code" = 403 ] || { echo "expected 403 from the proxy" >&2; exit 1; }
  docker stop -t 10 "$cid" >/dev/null
  exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$cid")"
  echo "exit code after SIGTERM: $exit_code"
  [ "$exit_code" = 0 ] || { echo "expected the proxy to exit 0 on SIGTERM, not be killed" >&2; exit 1; }
}

# A published image holds no test source, testkit or demo tool.
# Two counts: scripts/image-prune.sh's own list run inside the image, and the
# names the release checklist is written in, spelled out here so a list that
# is too narrow cannot vouch for itself. Neither may print anything.
assert_published_tree() {
  local image="$1" listed named
  listed="$(docker run --rm --entrypoint sh \
    -v "$(cd "$(dirname "$0")/../.." && pwd)/scripts/image-prune.sh:/tmp/image-prune.sh:ro" \
    "$image" /tmp/image-prune.sh --list /app)"
  # A dependency's own tests (zod's) are not ours: node_modules is skipped.
  named="$(docker run --rm --entrypoint find "$image" /app -name node_modules -prune -o \
    \( -name '*.test.ts' -o -name '*.test.tsx' \
       -o -name '*.snap' -o -name __snapshots__ -o -name pglite-release.ts \
       -o -name testkit -o -name demo-accounts.ts -o -name demo-data.ts \) -print)"
  echo "test sources and demo files in the image: $(printf '%s' "${listed}${named}" | grep -c . || true)"
  if [ -n "${listed}${named}" ]; then
    printf '%s\n%s\n' "$listed" "$named" >&2
    echo "the published image still holds test or demo files" >&2
    exit 1
  fi
}
assert_published_tree "$image"

case "$app" in
  worker|worker-codex)
    # The ticket's check: the bundled executable resolves and is the version
    # the engine pin promises. Also non-root, git, git-lfs and gh present,
    # workspace mount point.
    if [ "$app" = worker ]; then
      version="$(docker run --rm "$image" claude --version)"
      echo "claude --version: $version"
      echo "$version" | grep -q '^2\.1\.319 ' || { echo "expected 2.1.319"; exit 1; }
      # One image holds one engine: the other's package is not here.
      docker run --rm "$image" test ! -e node_modules/@openai
    else
      # image:verify resolves the executable the way the runtime does and
      # prints its own version (the build log shows the same line).
      version="$(docker run --rm "$image" bun run --filter @werft-ai/runtime-registry image:verify 2>&1)"
      echo "$version"
      echo "$version" | grep -q 'codex-cli 0\.167\.0$' || { echo "expected codex-cli 0.167.0"; exit 1; }
      docker run --rm "$image" test ! -e node_modules/@anthropic-ai
    fi
    docker run --rm "$image" sh -c 'test "$(id -u)" = 1000 && git --version && git lfs version && gh --version && test -d /workspace'
    docker run --rm "$image" bun build --target=bun --outdir=/tmp/resolve apps/worker/src/main.ts >/dev/null
    # a commit in a fresh repository needs no identity of its own
    # and carries the one the site page operate/images-and-supply-chain names.
    ident="$(docker run --rm "$image" sh -c 'cd "$(mktemp -d)" && git init -q && git commit -q --allow-empty -m smoke && git log -1 --format="%an <%ae>|%cn <%ce>"')"
    echo "default commit identity: $ident"
    expected="Werft <noreply@werft.invalid>"
    [ "$ident" = "$expected|$expected" ] || { echo "expected $expected as author and committer" >&2; exit 1; }
    # the App bot identity the worker writes (git-trailers.ts) wins over it
    bot="smoke[bot] <1+smoke[bot]@users.noreply.github.com>"
    ident="$(docker run --rm "$image" sh -c 'mkdir -p "$HOME/.werft" && printf "[user]\n\tname = \"smoke[bot]\"\n\temail = 1+smoke[bot]@users.noreply.github.com\n" >"$HOME/.werft/git-identity" && cd "$(mktemp -d)" && git init -q && git commit -q --allow-empty -m smoke && git log -1 --format="%an <%ae>|%cn <%ce>"')"
    echo "App bot commit identity: $ident"
    [ "$ident" = "$bot|$bot" ] || { echo "expected $bot as author and committer" >&2; exit 1; }
    # Its own ENTRYPOINT, a command standing in for the worker's: the
    # scheduler overrides Cmd only when it launches a worker.
    assert_init_reaps "$image" "$(docker run -d --label "$smoke_label" \
      "$image" bun -e 'setInterval(() => {}, 1 << 30)')"
    # The workspace inode helper runs from this image with its own
    # entrypoint: every tool its script calls must be here.
    docker run --rm --entrypoint /bin/sh "$image" -c \
      'xfs_io -V && xfs_quota -V && command -v awk sed stat mknod mkdir >/dev/null'
    ;;
  control-host)
    # git: the checkpoint bundle verifier spawns it.
    docker run --rm "$image" sh -c 'test "$(id -u)" = 1000 && test ! -e node_modules/@anthropic-ai && git --version && bun --version'
    api_init_smoke "$image"
    # Every import of the pruned tree resolves: bundling the role entry point
    # follows them all, so one into a removed file fails the build here.
    docker run --rm "$image" bun build --target=bun --outdir=/tmp/resolve apps/control-host/src/main.ts >/dev/null
    # DEMO_ACCOUNTS=local has nothing to run in a published image: the CLI is
    # absent, and bun says so. Any other failure (a refusal exits 2 with
    # "demo accounts refused") would mean the file is there.
    demo="$(docker run --rm -e DEMO_ACCOUNTS=local "$image" bun run apps/control-host/src/api/demo-accounts.ts 2>&1)" && {
      echo "expected the demo-account CLI to be absent" >&2; exit 1
    }
    [[ "$demo" == *"Module not found"* ]] || { printf '%s\n' "$demo" >&2; echo "expected a missing-module error from the demo-account CLI" >&2; exit 1; }
    echo "demo-account CLI in the published image: absent"
    # One executable for every role; it refuses to guess one.
    if docker run --rm "$image" bun run apps/control-host/src/main.ts >/dev/null 2>&1; then
      echo "expected the executable to refuse a missing role" >&2; exit 1
    fi
    ;;
  egress-proxy)
    egress_proxy_smoke "$image"
    ;;
  *)
    echo "unknown app: $app" >&2
    exit 2
    ;;
esac
