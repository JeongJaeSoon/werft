#!/usr/bin/env bash
# Check, read-only, that Docker's default address pools still fit <needed>
# more networks. Each network the daemon allocates takes one pool entry
# (2^(Size - base prefix) entries per pool), whether compose or the scheduler
# made it, so a full pool lets a stack come up and then fail at its first
# worker launch. Exit 1 with the counts, and the pool entries held
# by compose project or installation, when it is short; exit 2 when Docker
# cannot be read.
#
#   address-pool.sh <needed>
set -uo pipefail

needed=${1:?usage: address-pool.sh <needed>}
unreadable() {
  echo "address-pool.sh: cannot read $1; the pool was not checked" >&2
  exit 2
}
command -v jq >/dev/null || unreadable "anything: jq is not installed"

pools=$(docker info --format '{{json .DefaultAddressPools}}') || unreadable "Docker's address pools"
# A network removed between the listing and the inspect fails the inspect;
# a second try sees the listing without it.
for attempt in 1 2; do
  ids=$(docker network ls -q) || unreadable "Docker's networks"
  # shellcheck disable=SC2086 # one argument per network id
  networks=$(if [ -n "$ids" ]; then docker network inspect $ids; else echo '[]'; fi) && break
  [ "$attempt" = 1 ] || unreadable "Docker's networks"
done

# A daemon with no default-address-pools set reports none and allocates
# from its built-in ones: 172.17-31.0.0/16 whole, 192.168.0.0/16 in /20s.
report=$(jq -n -r --argjson pools "${pools:-null}" --argjson needed "$needed" --argjson networks "$networks" '
  def ip: split(".") | map(tonumber) | .[0] * 16777216 + .[1] * 65536 + .[2] * 256 + .[3];
  def cidr: split("/") | {start: (.[0] | ip), len: (.[1] | tonumber)};
  def ipv4: test("^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+/[0-9]+$");
  (if ($pools // []) == [] then [range(17; 32) | {Base: "172.\(.).0.0/16", Size: 16}] + [{Base: "192.168.0.0/16", Size: 20}] else $pools end) as $pools
  | [$pools[] | select(.Base | ipv4) | (.Base | cidr) + {size: .Size}
    | . + {end: (.start + pow(2; 32 - .len)), block: pow(2; 32 - .size)}] as $p
  | ([$p[] | pow(2; .size - .len)] | add // 0) as $capacity
  # Every pool entry a subnet overlaps, as "<pool>:<entry>": counted once
  # however many subnets share it, all of them when one subnet covers several.
  | [$networks[]
      | (.Labels // {}) as $l
      | ($l["com.docker.compose.project"] // $l["werft.installation"] // .Name) as $owner
      | (.IPAM.Config // [])[] | .Subnet // "" | select(ipv4) | cidr
      | {start, end: (.start + pow(2; 32 - .len))} as $s
      | range($p | length) as $i | $p[$i]
      | ([$s.start, .start] | max) as $lo | ([$s.end, .end] | min) as $hi
      | select($lo < $hi)
      | range(($lo - .start) / .block | floor; ($hi - 1 - .start) / .block | floor + 1)
      | {owner: $owner, entry: "\($i):\(.)"}
    ] as $used
  | ($used | map(.entry) | unique | length) as $taken
  | if $capacity - $taken >= $needed then "ok \($capacity - $taken) free of \($capacity), \($needed) needed"
    else
      "short \($capacity - $taken) free of \($capacity), \($needed) needed",
      ($used | group_by(.owner) | map({owner: .[0].owner, n: (map(.entry) | unique | length)}) | sort_by(-.n, .owner)[]
        | "  \(.n)\t\(.owner)")
    end
') || unreadable "Docker's answer"

case "$report" in
  ok*)
    echo "address-pool.sh: ${report#ok }" >&2 ;;
  *)
    {
      head=${report%%$'\n'*}
      echo "address-pool.sh: Docker's address pools are short: ${head#short }"
      echo "address-pool.sh: pool entries held, by compose project or installation:"
      echo "$report" | tail -n +2
    } >&2
    exit 1 ;;
esac
