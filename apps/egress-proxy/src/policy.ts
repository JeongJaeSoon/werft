/**
 * The destination allowlist a worker's egress is held to.
 *
 * A name-only filter is not enough: an allowlisted name that resolves into
 * the private plane — instance metadata at 169.254.169.254, a sibling
 * container, the daemon host — is exactly the escape this proxy exists to
 * stop. Every decision therefore resolves the name first and judges the
 * addresses, and the proxy connects to the address it judged, never to the
 * name again.
 */

import { messageOf } from "./message-of.ts";

export type AddressClass =
  | "link_local"
  | "loopback"
  | "multicast"
  | "private"
  | "public"
  | "reserved"
  | "unspecified";

/** Never reachable, whichever list the destination came from. */
const ALWAYS_DENIED: ReadonlySet<AddressClass> = new Set<AddressClass>([
  "link_local",
  "multicast",
  "reserved",
  "unspecified",
]);

export type EgressDestination = { host: string; port: number };

export type EgressPolicy = {
  /** Public destinations; every resolved address must be public unicast. */
  allow: readonly EgressDestination[];
  /**
   * Destinations deliberately inside the private plane — the worker gateway
   * on the daemon host, a self-hosted git remote. Private and loopback
   * addresses pass here; link-local never does.
   */
  allowPrivate: readonly EgressDestination[];
};

export type EgressResolver = (host: string) => Promise<string[]>;

/**
 * `denied` is the policy saying no. `unresolved` is an allowlisted name with
 * no answer right now — a restarting container drops out of Docker's DNS —
 * which is an outage the caller may retry, not a verdict on the destination.
 */
export type EgressDecision =
  | { addresses: string[]; allowed: true; scope: "private" | "public" }
  | { allowed: false; failure: "denied" | "unresolved"; reason: string };

export function normalizeHost(host: string): string {
  const unbracketed =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // A trailing dot is the same name to DNS but a different string to us.
  return unbracketed.replace(/\.$/, "").toLowerCase();
}

/** `host:port`, or `[::1]:port` for an IPv6 literal. */
export function parseDestination(
  entry: string,
  source: string,
): EgressDestination {
  const trimmed = entry.trim();
  const separator = trimmed.startsWith("[")
    ? trimmed.indexOf("]:") + 1
    : trimmed.lastIndexOf(":");
  if (separator <= 0) {
    throw new Error(`${source} entry ${entry} must be host:port`);
  }
  const host = normalizeHost(trimmed.slice(0, separator));
  const port = Number(trimmed.slice(separator + 1));
  if (host.length === 0) {
    throw new Error(`${source} entry ${entry} has no host`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source} entry ${entry} has no valid port`);
  }
  return { host, port };
}

export function parseDestinations(
  spec: string,
  source: string,
): EgressDestination[] {
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseDestination(entry, source));
}

function matches(
  list: readonly EgressDestination[],
  host: string,
  port: number,
): boolean {
  return list.some((entry) => entry.host === host && entry.port === port);
}

export async function decideEgress(
  policy: EgressPolicy,
  destination: EgressDestination,
  resolve: EgressResolver,
): Promise<EgressDecision> {
  const host = normalizeHost(destination.host);
  // A host on both lists is held to the stricter one.
  const scope = matches(policy.allow, host, destination.port)
    ? "public"
    : matches(policy.allowPrivate, host, destination.port)
      ? "private"
      : null;
  if (scope === null) {
    return {
      allowed: false,
      failure: "denied",
      reason: "destination is not allowlisted",
    };
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (error) {
    return {
      allowed: false,
      failure: "unresolved",
      reason: `host does not resolve: ${messageOf(error)}`,
    };
  }
  if (addresses.length === 0) {
    return {
      allowed: false,
      failure: "unresolved",
      reason: "host does not resolve",
    };
  }
  // All of them, not the first: a name that resolves to one good and one bad
  // address is a rebinding attempt, and the loser of that race is us.
  for (const address of addresses) {
    const kind = classifyAddress(address);
    if (kind === null) {
      return {
        allowed: false,
        failure: "denied",
        reason: `${address} is not an IP address`,
      };
    }
    if (ALWAYS_DENIED.has(kind)) {
      return {
        allowed: false,
        failure: "denied",
        reason: `${address} is ${kind}`,
      };
    }
    if (scope === "public" && kind !== "public") {
      return {
        allowed: false,
        failure: "denied",
        reason: `${address} is ${kind}, not public`,
      };
    }
  }
  return { addresses, allowed: true, scope };
}

/** null when the text is not an IP literal at all. */
export function classifyAddress(address: string): AddressClass | null {
  const v4 = parseIpv4(address);
  if (v4 !== null) return classifyIpv4(v4);
  const v6 = parseIpv6(address);
  if (v6 === null) return null;
  return classifyIpv6(v6);
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
  if (bytes.every((byte) => byte === 0)) return "unspecified";
  if (bytes.slice(0, 15).every((byte) => byte === 0) && at(15) === 1) {
    return "loopback";
  }
  const firstTwelveZero = bytes.slice(0, 10).every((byte) => byte === 0);
  // `::ffff:a.b.c.d` and the deprecated `::a.b.c.d` are the same host under
  // another spelling, so they are judged as the IPv4 address they carry.
  if (firstTwelveZero && at(10) === 0xff && at(11) === 0xff) {
    return classifyIpv4(bytes.slice(12));
  }
  if (firstTwelveZero && at(10) === 0 && at(11) === 0) {
    return classifyIpv4(bytes.slice(12));
  }
  // 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) carry an IPv4 destination
  // that the policy has to judge as the IPv4 address it really is.
  if (
    at(0) === 0x00 &&
    at(1) === 0x64 &&
    at(2) === 0xff &&
    at(3) === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0)
  ) {
    return classifyIpv4(bytes.slice(12));
  }
  if (at(0) === 0x20 && at(1) === 0x02) {
    return classifyIpv4(bytes.slice(2, 6));
  }
  // `::ffff:0:a.b.c.d` (IPv4-translated, ::ffff:0:0:0/96) is the same host
  // again, one prefix along from the mapped form handled above.
  if (
    bytes.slice(0, 8).every((byte) => byte === 0) &&
    at(8) === 0xff &&
    at(9) === 0xff &&
    at(10) === 0 &&
    at(11) === 0
  ) {
    return classifyIpv4(bytes.slice(12));
  }
  // 64:ff9b:1::/48 is NAT64 for local use, and RFC 6052 lets the embedded
  // IPv4 sit at any of six offsets inside it. Rather than guess which, the
  // whole prefix is refused: nothing legitimate for us lives behind it.
  if (
    at(0) === 0x00 &&
    at(1) === 0x64 &&
    at(2) === 0xff &&
    at(3) === 0x9b &&
    at(4) === 0x00 &&
    at(5) === 0x01
  ) {
    return "reserved";
  }
  if (at(0) === 0xff) return "multicast";
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return "link_local";
  // fec0::/10 is deprecated site-local, but a network that still routes it
  // is exactly the internal network this proxy must not reach.
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0xc0) return "private";
  if ((at(0) & 0xfe) === 0xfc) return "private";
  // 2001:db8::/32 documentation, 0100::/64 discard-only.
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x0d && at(3) === 0xb8) {
    return "reserved";
  }
  if (
    at(0) === 0x01 &&
    at(1) === 0x00 &&
    bytes.slice(2, 8).every((b) => b === 0)
  ) {
    return "reserved";
  }
  return "public";
}
