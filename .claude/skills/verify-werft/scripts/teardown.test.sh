#!/usr/bin/env bash
# Tests for teardown-lib.sh, down.sh's name check and janitor.sh's dry run,
# against a fake `docker` that only logs. Nothing here touches a real Docker.
#   bash .claude/skills/verify-werft/scripts/teardown.test.sh
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
scratch_root=${TMPDIR:-/tmp}
scratch=$(mktemp -d "${scratch_root%/}/werft-verify-teardown-test.XXXXXX") || exit 1
trap 'rm -rf "${scratch:?}"' EXIT
mkdir -p "$scratch/bin"
log=$scratch/docker.log
: >"$log"
cat >"$scratch/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_DOCKER_LOG"
[ "$1" != "${FAKE_DOCKER_FAIL:-}" ] || exit 1
exit 0
EOF
chmod +x "$scratch/bin/docker"
export FAKE_DOCKER_LOG=$log PATH="$scratch/bin:$PATH"

pass=0
fail=0
check() { # name, expected exit, actual exit
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "ok   $1"; else fail=$((fail + 1)); echo "FAIL $1 (want exit $2, got $3)"; fi
}

# shellcheck disable=SC1091
. "$here/teardown-lib.sh"

id=20261109-101010-123
p=verify-ap-$id
teardown_guard "$id" "$p" "$p"; check "guard: exact match" 0 $?
teardown_guard "$id" "$p-extra" "$p-extra"; check "guard: same prefix, longer name" 1 $?
teardown_guard "$id" verify-ap-20261031-094644-90075 verify-ap-20261031-094644-90075; check "guard: another run id" 1 $?
teardown_guard "$id" "$p" verify-ap-20261031-094644-90075; check "guard: installation differs" 1 $?
teardown_guard "" "$p" "$p"; check "guard: empty run id" 1 $?
teardown_guard "x$id" "verify-ap-x$id" "verify-ap-x$id"; check "guard: run id with a stray character" 1 $?
teardown_guard "demo" verify-ap-demo verify-ap-demo; check "guard: not a run id shape" 1 $?
teardown_guard verify-ap-x verify-ap-verify-ap-x verify-ap-verify-ap-x; check "guard: project text as run id" 1 $?

: >"$log"
teardown_images "$p" >/dev/null
want=$(printf '%s\n' \
  "image ls -q werft-control-host:$p" "image ls -q werft-worker:$p" "image ls -q werft-egress-proxy:$p" \
  "image ls -q $p-migrate:latest" "image ls -q $p-fake-git:latest" "image ls -q $p-gitea:latest")
[ "$(cat "$log")" = "$want" ]; check "images: inspects exactly six tags of the project" 0 $?

TEARDOWN_CONTAINERS="c1"
TEARDOWN_NETWORKS="net1"
TEARDOWN_VOLUMES="vol1"
TEARDOWN_IMAGES="img1:t1"
: >"$log"
teardown_delete "$p" >/dev/null 2>&1
want=$(printf '%s\n' "rm -v c1" "network rm net1" "volume rm vol1" "image rm img1:t1")
[ "$(cat "$log")" = "$want" ]; check "delete: only the listed names, no -f" 0 $?
grep -Eq -- ' -f|prune|--force' "$log"; check "delete: no force or prune flag" 1 $?

: >"$log"
teardown_delete "$p" keep >/dev/null 2>&1
grep -q '^volume rm' "$log"; check "delete: --keep-volumes keeps volumes" 1 $?
grep -q '^rm -v' "$log"; check "delete: --keep-volumes never uses rm -v" 1 $?

FAKE_DOCKER_FAIL=ps teardown_snapshot "$p" >/dev/null 2>&1; check "snapshot: a failing docker ps is an error" 1 $?
FAKE_DOCKER_FAIL=network teardown_snapshot "$p" >/dev/null 2>&1; check "snapshot: a failing docker network ls is an error" 1 $?
teardown_snapshot "$p" >/dev/null 2>&1; check "snapshot: all answers empty is fine" 0 $?
grep -q '^image rm' "$log"; check "delete: --keep-volumes still removes images" 0 $?

# down.sh with a state that names another project: refuses before any docker call.
export VERIFY_AP_ROOT=$scratch/runs
mkdir -p "$VERIFY_AP_ROOT/$id/evidence"
printf 'export COMPOSE_PROJECT_NAME=%s\nexport EXECUTION_INSTALLATION_ID=%s\nVERIFY_REPO=%s\n' \
  verify-ap-20261031-094644-90075 verify-ap-20261031-094644-90075 "$scratch" >"$VERIFY_AP_ROOT/$id/state.env"
: >"$log"
bash "$here/down.sh" "$id" >/dev/null 2>&1; check "down.sh: another project's name refused" 1 $?
[ ! -s "$log" ]; check "down.sh: refusal ran no docker command" 0 $?

# janitor: a dry run issues no removing command.
: >"$log"
bash "$here/janitor.sh" >/dev/null 2>&1; check "janitor: dry run exits 0" 0 $?
grep -Eq '^(rm|network rm|volume rm|image rm|compose)' "$log"; check "janitor: dry run removes nothing" 1 $?
bash "$here/janitor.sh" --hours 0 >/dev/null 2>&1; check "janitor: bad --hours refused" 2 $?

echo "passed $pass, failed $fail"
[ "$fail" = 0 ]
