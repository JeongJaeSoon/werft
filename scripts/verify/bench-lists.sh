# Response times of list routes, for P-LIST-SCALE. Source after lib.sh:
#   . scripts/lib.sh <run id>; . scripts/bench-lists.sh; ap_as owner
#   ap_bench 20 '/v1/agents?limit=50&include=summary'
#   ap_bench_pages '/v1/agents?include=summary'
# Both go through the cookie, as the console does.

# ap_bench <runs> <path>: p50/p95 of time_total in ms over the 200 answers,
# how many were not 200, and how many items the last answer held. Returns 1
# when any answer was not 200, so a failing route never reads as fast.
ap_bench() {
  local runs=$1 route=$2 out times failed items
  out=$(mktemp)
  times=$(for _ in $(seq "$runs"); do
    ap_curl cookie -o "$out" -w '%{http_code} %{time_total}\n' "$API$route" ||
      echo "000 0"
  done)
  failed=$(printf '%s\n' "$times" | awk '$1 != 200' | wc -l | tr -d ' ')
  items=$(jq '(.items // .calls // []) | length' "$out" 2>/dev/null)
  rm -f "$out"
  printf '%s\n' "$times" | awk '$1 == 200 { print $2 * 1000 }' | sort -n |
    awk -v r="$route" -v f="$failed" -v i="$items" '
      { v[NR] = $1 }
      END {
        if (NR == 0) { printf "%-60s failed=%s of %s, no 200 answer\n", r, f, f; exit }
        p50 = v[int((NR + 1) * 0.50)]; p95 = v[int((NR * 0.95) + 0.999)]
        printf "%-60s failed=%s items=%-4s p50=%6.1fms p95=%6.1fms n=%d\n", r, f, i, p50, p95, NR
      }'
  [ "$failed" -eq 0 ]
}

# ap_bench_pages <path>: every page at limit=100 one after another, as a
# list read to its end does; prints pages, items and the total time. Stops
# with 1 at the first answer that is not 200 or has no `items`.
ap_bench_pages() {
  local route=$1 sep cursor="" pages=0 items=0 total=0 out line code t
  out=$(mktemp)
  case $route in *\?*) sep='&' ;; *) sep='?' ;; esac
  while :; do
    line=$(ap_curl cookie -o "$out" -w '%{http_code} %{time_total}' \
      "$API$route${sep}limit=100${cursor:+&cursor=$cursor}") || line="000 0"
    code=${line%% *}
    t=${line#* }
    if [ "$code" != 200 ] || ! jq -e '.items | type == "array"' "$out" >/dev/null 2>&1; then
      printf '%-60s page %d answered %s\n' "$route" "$((pages + 1))" "$code"
      rm -f "$out"
      return 1
    fi
    total=$(awk -v a="$total" -v b="$t" 'BEGIN { print a + b }')
    pages=$((pages + 1))
    items=$((items + $(jq '.items | length' "$out")))
    cursor=$(jq -r '.next_cursor // empty' "$out")
    [ -z "$cursor" ] && break
  done
  rm -f "$out"
  awk -v r="$route" -v p="$pages" -v i="$items" -v t="$total" \
    'BEGIN { printf "%-60s pages=%-4d items=%-6d total=%8.1fms\n", r, p, i, t * 1000 }'
}
