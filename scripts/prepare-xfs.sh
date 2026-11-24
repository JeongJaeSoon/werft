#!/usr/bin/env bash
# Put Docker's data-root on an XFS loop image mounted with prjquota, the disk
# the single-server installation needs (docs: run-server/self-hosting/prepare-xfs).
#
#   sudo bash scripts/prepare-xfs.sh [--dry-run] [--size <N>G]
#
# The preflight changes nothing: root, the commands, Docker running under
# systemd with its data-root at /var/lib/docker and not a mount point, none of
# the paths this run creates already there, an fstab that findmnt --verify
# accepts and that has no entry for the data-root, room for the image, kernel XFS support, and a trial loop mount with prjquota
# of a small temporary image (removed again), so a host that cannot mount the
# image stops here, before Docker is touched. When the data-root is already on
# XFS with prjquota and the quota probe passes, there is nothing to do.
# --dry-run stops after the preflight and prints the steps.
#
# The steps: stop Docker, move /var/lib/docker to /var/lib/docker.old, create
# and format /var/lib/docker.xfs.img (60G sparse unless --size), mount it on
# /var/lib/docker, copy the old data in, back up /etc/fstab to
# /etc/fstab.before-prepare-xfs and add the mount, start Docker, check the
# data-root and run the quota probe. When a step fails, the steps before it are
# undone in reverse and Docker starts again on the original data-root; the
# image is kept when Docker already ran on it, since what it wrote is there.
# After success the original stays in /var/lib/docker.old.
#
# Exit: 0 prepared or already prepared; 1 refused by the preflight, nothing
# changed; 2 usage; 3 a step failed and everything was undone; 4 a step failed
# and an undo failed too: the messages above name what is left. Docker is then
# left stopped only when its data-root is not back in place, because starting
# it would run on an empty data-root.
#
# PREPARE_XFS_ROOT prefixes every host path (the tests run it on a scratch
# directory with stub commands); the fstab entry names the real paths.
set -euo pipefail

root="${PREPARE_XFS_ROOT:-}"
data="${root}/var/lib/docker"
old="${data}.old"
image="${data}.xfs.img"
fstab="${root}/etc/fstab"
fstab_backup="${fstab}.before-prepare-xfs"
entry="/var/lib/docker.xfs.img /var/lib/docker xfs loop,prjquota 0 0"
size=60G
dry_run=0

usage() {
  echo "usage: prepare-xfs.sh [--dry-run] [--size <N>G]" >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --size)
      [ $# -ge 2 ] || usage
      size="$2"
      shift
      ;;
    *) usage ;;
  esac
  shift
done
[[ "$size" =~ ^[1-9][0-9]*G$ ]] || { echo "prepare-xfs: --size takes whole gigabytes, such as 60G" >&2; exit 2; }

note() { printf 'prepare-xfs: %s\n' "$*"; }
refuse() {
  printf 'prepare-xfs: refused: %s\n' "$*" >&2
  printf 'prepare-xfs: nothing was changed\n' >&2
  exit 1
}

# findmnt -no FSTYPE,OPTIONS output of an XFS mount with project quotas on.
is_quota_xfs() {
  local fstype="" opts=""
  read -r fstype opts <<<"$1" || true
  [ "$fstype" = xfs ] && [[ ",$opts," == *,prjquota,* ]]
}

quota_probe() {
  local probe
  probe="quota-probe-$(date +%s)-$$"
  docker volume create --driver local --opt size=64m "$probe" >/dev/null || return 1
  docker volume rm "$probe" >/dev/null
}

trial=""
mutating=0
finished=0
step=""
units="docker.service"
stopped=0 moved=0 image_made=0 dir_made=0 mounted=0 backing=0 fstab_changed=0 started=0

undo() {
  note "undo: $*"
  "$@" || { printf 'prepare-xfs: undo failed: %s\n' "$*" >&2; failed=1; return 1; }
}

rollback() {
  set +e
  failed=0
  # Flags are set before their command, so each undo checks what is really there.
  local restored=1
  if [ "$started" = 1 ]; then
    # shellcheck disable=SC2086 # unit names
    undo systemctl stop $units
  fi
  if [ "$fstab_changed" = 1 ]; then
    if undo cp -p "$fstab_backup" "$fstab"; then
      undo rm -f "$fstab_backup"
      undo systemctl daemon-reload
    else
      # Putting the original back now would let the next boot mount the image over it.
      printf 'prepare-xfs: %s still mounts %s at boot, so the rest is left as it is; copy %s over %s, then undo the rest by hand\n' "$fstab" "$image" "$fstab_backup" "$fstab" >&2
      restored=0
    fi
  elif [ "$backing" = 1 ]; then
    undo rm -f "$fstab_backup"
  fi
  if [ "$restored" = 1 ] && [ "$mounted" = 1 ] && mountpoint -q "$data"; then
    undo umount "$data" || restored=0
  fi
  if [ "$restored" = 1 ] && [ "$dir_made" = 1 ] && [ -d "$data" ]; then
    undo rmdir "$data" || restored=0
  fi
  if [ "$restored" = 1 ] && [ "$moved" = 1 ] && [ -e "$old" ]; then
    if [ -e "$data" ] || [ -L "$data" ]; then
      printf 'prepare-xfs: %s is there again, so %s is not moved back over it\n' "$data" "$old" >&2
      failed=1
      restored=0
    else
      undo mv "$old" "$data" || restored=0
    fi
  fi
  # Kept once Docker may have written to it, and whenever anything above is left.
  if [ "$image_made" = 1 ]; then
    if [ "$started" = 1 ]; then
      printf 'prepare-xfs: kept %s: Docker ran on it, and what it wrote since is there\n' "$image" >&2
    elif [ "$restored" = 1 ]; then
      undo rm -f "$image"
    fi
  fi
  if [ "$stopped" = 1 ]; then
    if [ "$restored" = 1 ]; then
      undo systemctl start docker.service
    else
      printf 'prepare-xfs: Docker stays stopped: %s is not back in place and starting Docker now would run it on the wrong data-root\n' "$data" >&2
      [ ! -e "$old" ] || printf 'prepare-xfs: the original data is in %s\n' "$old" >&2
      failed=1
    fi
  fi
  return "$failed"
}

on_exit() {
  local rc=$?
  trap - EXIT
  trap '' INT TERM HUP
  if [ -n "$trial" ]; then trial_cleanup || rc=1; fi
  if [ "$mutating" = 0 ] || [ "$finished" = 1 ]; then exit "$rc"; fi
  printf 'prepare-xfs: failed at "%s" (exit %s); undoing the steps before it\n' "$step" "$rc" >&2
  if rollback; then
    printf 'prepare-xfs: undone: Docker runs on the original %s again\n' "$data" >&2
    exit 3
  fi
  printf 'prepare-xfs: could not undo everything (above); fix that by hand before running this again\n' >&2
  exit 4
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

# --- preflight: nothing below changes the host until "stop Docker" ---------

note "preflight (changes nothing)"
[ "$(id -u)" = 0 ] || refuse "run it as root: sudo bash scripts/prepare-xfs.sh"
missing=""
for tool in docker systemctl findmnt mountpoint mkfs.xfs rsync truncate df; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
[ -z "$missing" ] || refuse "missing commands:$missing (mkfs.xfs comes with xfsprogs; install xfsprogs and rsync with the distribution's package manager)"

current="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null)" \
  || refuse "docker info failed: start Docker first; its data-root is read from the running daemon"
if is_quota_xfs "$(findmnt -no FSTYPE,OPTIONS -T "$current" 2>/dev/null)"; then
  if quota_probe; then
    note "already prepared: $current is on XFS with prjquota and the quota probe passes; nothing to do"
    exit 0
  fi
  refuse "$current is on XFS with prjquota but the quota probe failed (above); inspect Docker before going on"
fi
[ "$current" = "$data" ] || refuse "Docker's data-root is $current; this script moves only $data"
systemctl is-active --quiet docker.service \
  || refuse "docker.service is not active under systemd; this script stops and starts Docker with systemctl"
if systemctl cat docker.socket >/dev/null 2>&1; then units="docker.socket docker.service"; fi
[ ! -L "$data" ] || refuse "$data is a symbolic link; inspect it"
if mountpoint -q "$data"; then refuse "$data is already a mount point, not XFS with prjquota; inspect it"; fi
for path in "$old" "$image" "$fstab_backup"; do
  if [ -e "$path" ] || [ -L "$path" ]; then refuse "$path already exists (an earlier run?); inspect it"; fi
done
[ -f "$fstab" ] || refuse "$fstab is missing"
if awk '$1 !~ /^#/ && $2 == "/var/lib/docker" { found = 1 } END { exit !found }' "$fstab"; then
  refuse "$fstab already has an entry for /var/lib/docker; inspect it"
fi
if ! verify="$(findmnt --verify --tab-file "$fstab" 2>&1)"; then
  printf '%s\n' "$verify" >&2
  refuse "findmnt --verify finds errors in $fstab as it is (above); fix them first"
fi
parent="$(dirname "$image")"
avail_kb="$(df -Pk "$parent" | awk 'NR == 2 { print $4 }')"
need_kb=$(( ${size%G} * 1024 * 1024 ))
if ! [[ "$avail_kb" =~ ^[0-9]+$ ]] || [ "$avail_kb" -lt "$need_kb" ]; then
  refuse "$parent has ${avail_kb:-unknown} KiB free and the $size image needs $need_kb KiB; free space or pass a smaller --size"
fi
if ! grep -qw xfs "${root}/proc/filesystems" 2>/dev/null && ! modprobe -n -q xfs 2>/dev/null; then
  refuse "this kernel has no XFS support (no xfs in /proc/filesystems and no xfs module to load)"
fi

trial_mount() {
  local fs
  truncate -s 512M "$trial/img" && mkfs.xfs -q "$trial/img" && mkdir "$trial/mnt" || return 1
  mount -o loop,prjquota "$trial/img" "$trial/mnt" || return 1
  fs="$(findmnt -no FSTYPE,OPTIONS "$trial/mnt" || true)"
  umount "$trial/mnt" || return 1
  is_quota_xfs "$fs" || { printf 'prepare-xfs: the trial image mounted as "%s", without prjquota\n' "$fs" >&2; return 1; }
}
# Removes the trial directory, never while its mount is still there.
trial_cleanup() {
  if [ -d "$trial/mnt" ] && mountpoint -q "$trial/mnt" && ! umount "$trial/mnt"; then
    printf 'prepare-xfs: the trial mount %s/mnt is still mounted; unmount it, then remove %s\n' "$trial" "$trial" >&2
    trial=""
    return 1
  fi
  rm -rf "$trial"
  trial=""
}
note "trial loop mount of a temporary 512M XFS image with prjquota"
trial="$(mktemp -d "${data}.xfs-trial.XXXXXX")" || refuse "could not create a trial directory in $parent"
if ! trial_mount; then
  trial_cleanup || exit 1
  refuse "the trial XFS loop mount with prjquota failed (above): this host needs loop devices and XFS with project quotas (container-type servers often have neither)"
fi
trial_cleanup || exit 1

if [ "$dry_run" = 1 ]; then
  note "preflight passed; --dry-run changes nothing. These steps would run, and a failing one undoes the steps before it:"
  echo "  1. systemctl stop $units"
  if [ -d "$data" ]; then echo "  2. mv $data $old"; else echo "  2. (no $data to move)"; fi
  echo "  3. create $image ($size, sparse) and mkfs.xfs -q it"
  echo "  4. mkdir $data; mount -o loop,prjquota $image $data"
  if [ -d "$data" ]; then echo "  5. rsync -aHAX $old/ $data/"; else echo "  5. (nothing to copy)"; fi
  echo "  6. cp -p $fstab $fstab_backup; append \"$entry\" to $fstab; findmnt --verify; systemctl daemon-reload"
  echo "  7. systemctl start docker.service; check the data-root, the mount and the quota probe"
  exit 0
fi

# --- the steps; on_exit undoes them when one fails -------------------------

mutating=1
begin() {
  step="$1"
  note "$1"
}

begin "stop Docker"
stopped=1
# shellcheck disable=SC2086 # unit names
systemctl stop $units

if [ -d "$data" ]; then
  begin "move $data to $old"
  moved=1
  mv "$data" "$old"
fi

begin "create the $size image $image"
image_made=1
# noclobber: a file that appeared since the preflight is not ours to remove.
(set -C; : >"$image") || { image_made=0; exit 1; }
truncate -s "$size" "$image"
mkfs.xfs -q "$image"

begin "mount $image on $data"
dir_made=1
mkdir "$data"
mounted=1
mount -o loop,prjquota "$image" "$data"
fs="$(findmnt -no FSTYPE,OPTIONS "$data")"
is_quota_xfs "$fs" || { printf 'prepare-xfs: %s mounted as "%s", not XFS with prjquota\n' "$data" "$fs" >&2; exit 1; }

if [ "$moved" = 1 ]; then
  begin "copy $old into the new filesystem"
  rsync -aHAX "$old/" "$data/"
fi

begin "add the mount to $fstab"
backing=1
cp -p "$fstab" "$fstab_backup"
fstab_changed=1
# A last line without its newline (a comment, say) would swallow the entry.
if [ -s "$fstab" ] && [ -n "$(tail -c 1 "$fstab")" ]; then printf '\n' >>"$fstab"; fi
printf '%s\n' "$entry" >>"$fstab"
findmnt --verify --tab-file "$fstab"
systemctl daemon-reload

begin "start Docker on the new data-root"
started=1
systemctl start docker.service

begin "check the data-root, the mount and the quota probe"
now="$(docker info -f '{{.DockerRootDir}}')"
[ "$now" = "$data" ] || { printf 'prepare-xfs: Docker came up on %s, not %s\n' "$now" "$data" >&2; exit 1; }
is_quota_xfs "$(findmnt -no FSTYPE,OPTIONS -T "$data")" || { echo "prepare-xfs: $data is no longer XFS with prjquota" >&2; exit 1; }
quota_probe || { echo "prepare-xfs: the quota probe failed (above)" >&2; exit 1; }
finished=1

note "done: $data is XFS with prjquota and the quota probe passes"
if [ "$moved" = 1 ]; then
  note "the original data stays in $old; check your containers and volumes (docker ps -a, docker volume ls) before you remove it"
fi
note "the previous fstab is in $fstab_backup"
