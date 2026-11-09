#!/usr/bin/env bash
# Tests for teardown-lib.sh, down.sh, rm-volumes.sh and janitor.sh's dry run,
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

TEARDOWN_VOLUMES="vol1"
FAKE_DOCKER_FAIL=volume teardown_volumes_left >/dev/null 2>&1; check "volumes_left: a failing docker volume ls is an error" 1 $?
teardown_volumes_left >/dev/null 2>&1; check "volumes_left: absent volume is not an error" 0 $?
grep -q '^image rm' "$log"; check "delete: --keep-volumes still removes images" 0 $?

# down.sh with a state that names another project: refuses before any docker call.
export VERIFY_AP_ROOT=$scratch/runs
mkdir -p "$VERIFY_AP_ROOT/$id/evidence"
printf 'export COMPOSE_PROJECT_NAME=%s\nexport EXECUTION_INSTALLATION_ID=%s\nVERIFY_REPO=%s\n' \
  verify-ap-20261031-094644-90075 verify-ap-20261031-094644-90075 "$scratch" >"$VERIFY_AP_ROOT/$id/state.env"
: >"$log"
bash "$here/down.sh" "$id" >/dev/null 2>&1; check "down.sh: another project's name refused" 1 $?
[ ! -s "$log" ]; check "down.sh: refusal ran no docker command" 0 $?

# down.sh on this run's own project: containers go, volumes never do.
mkdir -p "$scratch/scripts" "$VERIFY_AP_ROOT/$id/evidence"
printf '#!/usr/bin/env bash\necho "local.sh $*" >>"$FAKE_DOCKER_LOG"\n' >"$scratch/scripts/local.sh"
chmod +x "$scratch/scripts/local.sh"
: >"$scratch/compose.yaml"
mkdir -p "$scratch/infra"
: >"$scratch/infra/compose.fake-model.yml"
: >"$VERIFY_AP_ROOT/$id/ports.yml"
printf 'export COMPOSE_PROJECT_NAME=%s\nexport EXECUTION_INSTALLATION_ID=%s\nVERIFY_REPO=%s\n' \
  "$p" "$p" "$scratch" >"$VERIFY_AP_ROOT/$id/state.env"
: >"$log"
bash "$here/down.sh" "$id" >/dev/null 2>&1; check "down.sh: own project exits 0" 0 $?
grep -q '^local.sh down --keep-volumes$' "$log"; check "down.sh: asks local.sh to keep volumes" 0 $?
grep -Eq '^compose .* down .*(-v|--volumes)( |$)|^volume rm|prune' "$log"; check "down.sh: no -v, no volume rm, no prune" 1 $?
[ -f "$VERIFY_AP_ROOT/$id/ports.yml" ]; check "down.sh: run stays for rm-volumes.sh" 0 $?
bash "$here/down.sh" "$id" --keep-volumes >/dev/null 2>&1; check "down.sh: old --keep-volumes argument is a usage error" 2 $?

# rm-volumes.sh: exact names with the run's prefix only.
mkdir -p "$VERIFY_AP_ROOT/$id/evidence"
anon=$(printf 'a%.0s' $(seq 1 64))
printf '  volume  %s_pgdata\n  volume  %s\n  volume  werft-ws-1\n  volume  verify-ap-20261031-094644-90075_pgdata\n' "$p" "$anon" \
  >"$VERIFY_AP_ROOT/$id/evidence/teardown-targets.txt"
: >"$log"
: >"$VERIFY_AP_ROOT/$id/cookie"; : >"$VERIFY_AP_ROOT/$id/cookie.owner"; : >"$VERIFY_AP_ROOT/$id/cookie.member"
bash "$here/rm-volumes.sh" "$id" >/dev/null 2>&1; check "rm-volumes.sh: own project exits 0" 0 $?
[ -z "$(find "$VERIFY_AP_ROOT/$id" -maxdepth 1 -name 'cookie*')" ]; check "rm-volumes.sh: cookie and cookie.<who> removed" 0 $?
[ "$(grep -c '^volume rm' "$log")" = 1 ] && grep -qx "volume rm ${p}_pgdata" "$log"; check "rm-volumes.sh: removes only the run's own prefixed name" 0 $?
grep -Eq -- ' -f|prune|--force' "$log"; check "rm-volumes.sh: no force or prune flag" 1 $?
[ ! -f "$VERIFY_AP_ROOT/$id/ports.yml" ]; check "rm-volumes.sh: ports.yml removed after success" 0 $?
bash "$here/rm-volumes.sh" >/dev/null 2>&1; check "rm-volumes.sh: no argument is a usage error" 2 $?
: >"$VERIFY_AP_ROOT/$id/ports.yml"
: >"$log"
FAKE_DOCKER_FAIL=volume bash "$here/rm-volumes.sh" "$id" >/dev/null 2>&1; check "rm-volumes.sh: a failing docker volume command exits 1" 1 $?
[ -f "$VERIFY_AP_ROOT/$id/ports.yml" ]; check "rm-volumes.sh: failure keeps ports.yml" 0 $?
printf 'export COMPOSE_PROJECT_NAME=%s\nexport EXECUTION_INSTALLATION_ID=%s\nVERIFY_REPO=%s\n' \
  verify-ap-20261031-094644-90075 verify-ap-20261031-094644-90075 "$scratch" >"$VERIFY_AP_ROOT/$id/state.env"
: >"$log"
bash "$here/rm-volumes.sh" "$id" >/dev/null 2>&1; check "rm-volumes.sh: another project's name refused" 1 $?
grep -q '^volume rm' "$log"; check "rm-volumes.sh: refusal removed nothing" 1 $?

# The skill never tells the agent to build ids.sh from Bash (Write tool only).
grep -rEq '>>? *"?\$(\{VERIFY_RUN\}|VERIFY_RUN)/ids\.sh' "$here/.." --include='*.md' --include='*.sh'; check "skill docs: no redirect into ids.sh" 1 $?

# janitor: a dry run issues no removing command.
: >"$log"
bash "$here/janitor.sh" >/dev/null 2>&1; check "janitor: dry run exits 0" 0 $?
grep -Eq '^(rm|network rm|volume rm|image rm|compose)' "$log"; check "janitor: dry run removes nothing" 1 $?
bash "$here/janitor.sh" --hours 0 >/dev/null 2>&1; check "janitor: bad --hours refused" 2 $?

echo "passed $pass, failed $fail"
[ "$fail" = 0 ]
