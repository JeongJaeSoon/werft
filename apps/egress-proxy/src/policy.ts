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

import {
  type AddressClass,
  classifyAddress,
  isMetadataName,
} from "./ip-address.ts";
import { messageOf } from "./message-of.ts";

export { type AddressClass, classifyAddress };

/** Never reachable, whichever list the destination came from. */
const ALWAYS_DENIED: ReadonlySet<AddressClass> = new Set<AddressClass>([
  "link_local",
  "metadata",
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
   * addresses pass here; link-local and metadata never do.
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
  if (isMetadataName(host)) {
    return {
      allowed: false,
      failure: "denied",
      reason: `${host} is a metadata service`,
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
