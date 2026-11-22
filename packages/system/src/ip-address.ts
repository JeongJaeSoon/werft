/**
 * What an IP address is, for every caller that decides whether to reach it:
 * the egress proxy, the control plane's provider requests, and the catalog's
 * private-endpoint check. Where a spelling is ambiguous the answer is the one
 * that refuses more.
 *
 * No imports, so the egress proxy, whose image installs nothing, runs the
 * same rules: apps/egress-proxy/src/ip-address.ts is a byte-for-byte copy,
 * and apps/egress-proxy/src/policy.test.ts fails when the two differ.
 */

export type AddressClass =
  | "link_local"
  | "loopback"
  | "multicast"
  | "private"
  | "public"
  | "reserved"
  | "unspecified";

/** null when the text is not an IP literal at all. */
export function classifyAddress(address: string): AddressClass | null {
  const v4 = parseIpv4(address);
  if (v4 !== null) return classifyIpv4(v4);
  const v6 = parseIpv6(address);
  if (v6 === null) return null;
  return classifyIpv6(v6);
}

/**
 * Only the operator's own network reaches it, written as itself: IPv4
 * private or loopback, IPv6 `::1` or fc00::/7. An IPv4 address carried
 * inside IPv6 (`::ffff:10.0.0.1`, NAT64) is not, nor is link-local.
 */
export function isPrivateAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4 !== null) {
    const kind = classifyIpv4(v4);
    return kind === "private" || kind === "loopback";
  }
  const v6 = parseIpv6(address);
  if (v6 === null) return false;
  const loopback = v6.slice(0, 15).every((byte) => byte === 0) && v6[15] === 1;
  return loopback || ((v6[0] ?? 0) & 0xfe) === 0xfc;
}

/** Rejects leading zeros, which some resolvers read as octal. */
const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/;

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

function parseIpv6(value: string): number[] | null {
  const zone = value.indexOf("%");
  const text = zone < 0 ? value : value.slice(0, zone);
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = groupsOf(halves[0] ?? "");
  if (head === null) return null;
  if (halves.length === 1) {
    return head.length === 8 ? bytesOf(head) : null;
  }
  const tail = groupsOf(halves[1] ?? "");
  if (tail === null) return null;
  // `::` stands for at least one group of zeros.
  if (head.length + tail.length > 7) return null;
  const zeros = Array.from({ length: 8 - head.length - tail.length }, () => 0);
  return bytesOf([...head, ...zeros, ...tail]);
}

const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;

function groupsOf(part: string): number[] | null {
  if (part.length === 0) return [];
  const tokens = part.split(":");
  const groups: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.includes(".")) {
      // Only the last group may be the dotted-quad tail of `::ffff:1.2.3.4`.
      if (index !== tokens.length - 1) return null;
      const v4 = parseIpv4(token);
      if (v4 === null) return null;
      groups.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0));
      groups.push(((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
      continue;
    }
    if (!IPV6_GROUP.test(token)) return null;
    groups.push(Number.parseInt(token, 16));
  }
  return groups;
}

function bytesOf(groups: number[]): number[] {
  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

function classifyIpv4(octets: number[]): AddressClass {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  // Carrier-grade NAT: another network's hosts, not the public internet.
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 169 && b === 254) return "link_local";
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (a === 192 && b === 0 && c === 2) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return "public";
}

function classifyIpv6(bytes: number[]): AddressClass {
  const at = (index: number): number => bytes[index] ?? 0;
  const zeroUntil = (end: number): boolean =>
    bytes.slice(0, end).every((byte) => byte === 0);
  if (zeroUntil(16)) return "unspecified";
  if (zeroUntil(15) && at(15) === 1) return "loopback";
  // `::ffff:a.b.c.d` and 64:ff9b::/96 (NAT64) carry an IPv4 destination,
  // judged as that address, or metadata would pass in IPv6 clothes.
  const mapped = zeroUntil(10) && at(10) === 0xff && at(11) === 0xff;
  const nat64 =
    at(0) === 0x00 &&
    at(1) === 0x64 &&
    at(2) === 0xff &&
    at(3) === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  if (mapped || nat64) return classifyIpv4(bytes.slice(12));
  if (at(0) === 0xff) return "multicast";
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return "link_local";
  if ((at(0) & 0xfe) === 0xfc) return "private";
  // Only 2000::/3 is global unicast. The rest is unassigned or set aside:
  // the deprecated `::a.b.c.d`, `::ffff:0:a.b.c.d`, local NAT64
  // 64:ff9b:1::/48, discard-only 100::/64, site-local fec0::/10.
  if ((at(0) & 0xe0) !== 0x20) return "reserved";
  // 2001::/23 is protocol assignments (Teredo, benchmarking, ORCHID) and
  // 2001:db8::/32 is documentation.
  if (
    at(0) === 0x20 &&
    at(1) === 0x01 &&
    ((at(2) & 0xfe) === 0 || (at(2) === 0x0d && at(3) === 0xb8))
  ) {
    return "reserved";
  }
  // 6to4 tunnels to an IPv4 address through a relay we do not choose.
  if (at(0) === 0x20 && at(1) === 0x02) return "reserved";
  // 3fff::/20 is documentation.
  if (at(0) === 0x3f && at(1) === 0xff && (at(2) & 0xf0) === 0) {
    return "reserved";
  }
  return "public";
}
