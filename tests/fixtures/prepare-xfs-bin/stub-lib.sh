# Sourced by every stub: logs the call and fails when STUB_FAIL (every
# match) or STUB_FAIL_ONCE (the first match) has a line "<name> <regex>"
# matching the stub's arguments. Mounts live in $STUB_STATE/mounts as
# "<target>|<fstype> <options>" lines.
name="$(basename "$0")"
printf '%s %s\n' "$name" "$*" >>"$STUB_STATE/calls"
matches() {
  printf '%s\n' "$1" | awk -v n="$name" -v a="$2" '$1 == n { p = substr($0, length(n) + 2); if (a ~ p) found = 1 } END { exit !found }'
}
if [ -n "${STUB_FAIL:-}" ] && matches "$STUB_FAIL" "$*"; then
  echo "$name: stub failure" >&2
  exit 1
fi
if [ -n "${STUB_FAIL_ONCE:-}" ] && [ ! -e "$STUB_STATE/once-$name" ] && matches "$STUB_FAIL_ONCE" "$*"; then
  : >"$STUB_STATE/once-$name"
  echo "$name: stub failure" >&2
  exit 1
fi
mounts="$STUB_STATE/mounts"
touch "$mounts"
lookup() { awk -F'|' -v t="$1" '$1 == t { print $2; found = 1 } END { exit !found }' "$mounts"; }
