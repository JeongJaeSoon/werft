#!/usr/bin/env bash
# Tests for teardown-lib.sh, down.sh, rm-volumes.sh and janitor.sh's dry run,
# against a fake `docker` that only logs. Nothing here touches a real Docker.
#   bash scripts/verify/teardown.test.sh
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
# FAKE_DOCKER_IN_USE names a volume that `ps --filter volume=` reports a container for.
[ -z "${FAKE_DOCKER_IN_USE:-}" ] || [ "$*" != "ps -aq --filter volume=$FAKE_DOCKER_IN_USE" ] || echo c-in-use
# FAKE_DOCKER_PS_VOLUME_FAIL fails only the in-use check, after every listing succeeded.
[ -z "${FAKE_DOCKER_PS_VOLUME_FAIL:-}" ] || case "$*" in "ps -aq --filter volume="*) exit 1 ;; esac
# A file per existing volume in FAKE_DOCKER_VOLS holds its labels as JSON.
case "$*" in
  "volume ls -q --filter name=^"*) n="$*"; n=${n##*name=^}; n=${n%\$}; [ ! -f "$FAKE_DOCKER_VOLS/$n" ] || echo "$n" ;;
  "volume inspect --format "*) cat "$FAKE_DOCKER_VOLS/${!#}" ;;
  "volume rm "*) rm -f "$FAKE_DOCKER_VOLS/$3" ;;
esac
exit 0
EOF
chmod +x "$scratch/bin/docker"
mkdir -p "$scratch/vols"
export FAKE_DOCKER_VOLS=$scratch/vols
export FAKE_DOCKER_LOG=$log PATH="$scratch/bin:$PATH"
unset EXECUTION_VOLUME_LABEL_NAMESPACE EXECUTION_VOLUME_NAME_PREFIX

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
  "image ls -q werft-worker-deps:$p" \
  "image ls -q $p-migrate:latest" "image ls -q $p-fake-git:latest" "image ls -q $p-gitea:latest")
[ "$(cat "$log")" = "$want" ]; check "images: inspects exactly seven tags of the project" 0 $?

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
printf 'export COMPOSE_PROJECT_NAME=\nexport EXECUTION_INSTALLATION_ID=\nVERIFY_REPO=%s\n' "$scratch" >"$VERIFY_AP_ROOT/$id/state.env"
printf '  volume  werft-ws--s1-aaaa\n' >"$VERIFY_AP_ROOT/$id/evidence/teardown-targets.txt"
: >"$log"
bash "$here/rm-volumes.sh" "$id" >/dev/null 2>&1; check "rm-volumes.sh: empty project name refused" 1 $?
grep -q '^volume rm' "$log"; check "rm-volumes.sh: empty project name removed nothing" 1 $?

# rm-volumes.sh: the run's session workspaces, by the exact werft-ws-<project>- prefix.
printf 'export COMPOSE_PROJECT_NAME=%s\nexport EXECUTION_INSTALLATION_ID=%s\nVERIFY_REPO=%s\n' \
  "$p" "$p" "$scratch" >"$VERIFY_AP_ROOT/$id/state.env"
printf '  volume  werft-ws-%s-s1-aaaa\n  volume  werft-ws-%s9-s1-bbbb\n  volume  werft-ws-%s-s2-cccc\n  volume  werft-ws-%s\n' \
  "$p" "$p" "$p" "$p" >"$VERIFY_AP_ROOT/$id/evidence/teardown-targets.txt"
: >"$VERIFY_AP_ROOT/$id/ports.yml"
: >"$log"
FAKE_DOCKER_IN_USE="werft-ws-$p-s2-cccc" bash "$here/rm-volumes.sh" "$id" >"$scratch/rm.out" 2>&1; check "rm-volumes.sh: workspaces exit 0" 0 $?
[ "$(grep -c '^volume rm' "$log")" = 1 ] && grep -qx "volume rm werft-ws-$p-s1-aaaa" "$log"; check "rm-volumes.sh: removes only its own unused workspace" 0 $?
grep -q "volume rm werft-ws-${p}9-" "$log"; check "rm-volumes.sh: another run whose id extends this one is left" 1 $?
grep -q "left (a container still uses it): werft-ws-$p-s2-cccc" "$scratch/rm.out"; check "rm-volumes.sh: a workspace in use is named and left" 0 $?
grep -q "volume rm werft-ws-$p\$" "$log"; check "rm-volumes.sh: the bare prefix without its - is left" 1 $?
: >"$VERIFY_AP_ROOT/$id/ports.yml"
: >"$log"
FAKE_DOCKER_PS_VOLUME_FAIL=1 bash "$here/rm-volumes.sh" "$id" >"$scratch/rm.out" 2>&1; check "rm-volumes.sh: a failing in-use check exits 1" 1 $?
grep -q "ps -aq --filter volume=werft-ws-$p-s1-aaaa" "$log"; check "rm-volumes.sh: the in-use check ran" 0 $?
grep -q "could not tell whether a container uses werft-ws-$p-s1-aaaa; left" "$scratch/rm.out"; check "rm-volumes.sh: a failing in-use check names the volume" 0 $?
grep -q '^volume rm werft-ws-' "$log"; check "rm-volumes.sh: a failing in-use check removes no workspace" 1 $?
[ -f "$VERIFY_AP_ROOT/$id/ports.yml" ]; check "rm-volumes.sh: a failing in-use check keeps ports.yml" 0 $?

# rm-volumes.sh: anonymous volumes, proven by the run's container labels, not by name.
hex() { printf "$1%.0s" $(seq 1 64); }
a_ok=$(hex a); a_demo=$(hex b); a_plain=$(hex c); a_busy=$(hex d); a_unlisted=$(hex e); a_ok2=$(hex f)
demo=verify-ap-20261031-094644-90075
printf '{"com.docker.volume.anonymous":""}' >"$scratch/vols/$a_ok"
printf '{"com.docker.volume.anonymous":""}' >"$scratch/vols/$a_ok2"
printf '{"com.docker.compose.project":"%s","com.docker.volume.anonymous":""}' "$demo" >"$scratch/vols/$a_demo"
printf '{}' >"$scratch/vols/$a_plain"
printf '{"com.docker.volume.anonymous":""}' >"$scratch/vols/$a_busy"
printf '{"com.docker.volume.anonymous":""}' >"$scratch/vols/$a_unlisted"
printf '  volume  %s\n  volume  %s\n  volume  %s\n  volume  %s\n  volume  %s_pgdata\n  volume  werft-fresh-data\n  volume  %s\n' \
  "$a_ok" "$a_demo" "$a_plain" "$a_busy" "$demo" "$a_ok2" >"$VERIFY_AP_ROOT/$id/evidence/teardown-targets.txt"
: >"$VERIFY_AP_ROOT/$id/ports.yml"
: >"$log"
bash "$here/rm-volumes.sh" --dry-run "$id" >"$scratch/rm.out" 2>&1; check "rm-volumes.sh: dry run exits 0" 0 $?
grep -q '^volume rm' "$log"; check "rm-volumes.sh: dry run removes nothing" 1 $?
grep -q "would remove: $a_ok" "$scratch/rm.out"; check "rm-volumes.sh: dry run lists the anonymous volume it would remove" 0 $?
[ -f "$VERIFY_AP_ROOT/$id/ports.yml" ]; check "rm-volumes.sh: dry run keeps ports.yml" 0 $?
: >"$log"
FAKE_DOCKER_IN_USE=$a_busy bash "$here/rm-volumes.sh" "$id" >"$scratch/rm.out" 2>&1; check "rm-volumes.sh: anonymous volumes exit 0" 0 $?
grep -qx "volume rm $a_ok" "$log"; check "rm-volumes.sh: removes an anonymous volume the run's containers mounted" 0 $?
grep -qx "volume rm $a_ok2" "$log"; check "rm-volumes.sh: removes a second anonymous volume" 0 $?
[ "$(grep -c '^volume rm' "$log")" = 2 ]; check "rm-volumes.sh: removes only those two" 0 $?
grep -q "labelled for another project): $a_demo" "$scratch/rm.out"; check "rm-volumes.sh: a volume labelled for the 4620 demo is left" 0 $?
grep -q "not marked anonymous): $a_plain" "$scratch/rm.out"; check "rm-volumes.sh: a volume without the anonymous marker is left" 0 $?
grep -q "a container still uses it): $a_busy" "$scratch/rm.out"; check "rm-volumes.sh: an anonymous volume in use is left" 0 $?
grep -q "$a_unlisted" "$log"; check "rm-volumes.sh: an anonymous volume no container of the run mounted is never touched" 1 $?
grep -Eq "^volume rm (werft-fresh|$demo)" "$log"; check "rm-volumes.sh: demo and werft-fresh names are never removed" 1 $?
grep -Eq -- ' -f|prune|--force|--context|-H |machine' "$log"; check "rm-volumes.sh: no force, prune, context or machine flag" 1 $?

# The skill never tells the agent to build ids.sh from Bash (Write tool only).
grep -rEq '>>? *"?\$(\{VERIFY_RUN\}|VERIFY_RUN)/ids\.sh' "$here" "$here/../../.claude/skills/verify-werft" --include='*.md' --include='*.sh'; check "skill docs: no redirect into ids.sh" 1 $?

# janitor: a dry run issues no removing command.
: >"$log"
bash "$here/janitor.sh" >/dev/null 2>&1; check "janitor: dry run exits 0" 0 $?
grep -Eq '^(rm|network rm|volume rm|image rm|compose)' "$log"; check "janitor: dry run removes nothing" 1 $?
bash "$here/janitor.sh" --hours 0 >/dev/null 2>&1; check "janitor: bad --hours refused" 2 $?

echo "passed $pass, failed $fail"
[ "$fail" = 0 ]
