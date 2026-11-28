import { isIP } from "node:net";
import {
  classifyAddress,
  isMetadataName,
  isPrivateAddress,
} from "@werft-ai/system";

/**
 * A host in one spelling, the egress proxy's own (`hostKey` in its
 * credential routes, kept the same by this file's test): lower case, no
 * trailing dot, an address as the URL parser writes it, an IPv4-mapped
 * address as the IPv4 address a socket takes it to. null when the text is
 * not a host alone. A key's key is itself.
 */
export function hostKey(host: string): string | null {
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!/^[0-9A-Za-z._:-]+$/.test(bare)) return null;
  const v6 = bare.includes(":");
  if (v6 && isIP(bare) !== 6) return null;
  try {
    const key = new URL(
      `http://${v6 ? `[${bare}]` : bare.replace(/\.+$/, "")}/`,
    ).hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(key);
    if (mapped !== null) {
      const high = Number.parseInt(mapped[1] ?? "", 16);
      const low = Number.parseInt(mapped[2] ?? "", 16);
      return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
    }
    return key === "" ? null : key;
  } catch {
    return null;
  }
}

/** An address's key; a zone id is no part of what it is compared by. */
export function addressKey(address: string): string | null {
  const zone = address.indexOf("%");
  return hostKey(zone < 0 ? address : address.slice(0, zone));
}

/**
 * What the addresses a registered upstream's name resolves to make it:
 * `public` when every one is, `private` when every one is private as
 * written, null when it may not be registered or reached at all. The one
 * judgment for a model connection and a workspace MCP server, at
 * registration and whenever control-host itself calls the upstream; the
 * egress proxy holds a marked upstream to the same on every call.
 *
 * Never: a metadata name or address, loopback, link-local, multicast,
 * reserved or unspecified, an IPv4 address carried inside IPv6, one of the
 * installation's `own` hosts (keys), public and private answers mixed, or
 * no answer.
 */
export function registeredNetwork(
  host: string,
  addresses: readonly string[],
  own: ReadonlySet<string>,
): "public" | "private" | null {
  const name = host.replace(/^\[|\]$/g, "");
  if (isMetadataName(name.replace(/\.+$/, ""))) return null;
  const key = hostKey(name);
  if (key === null || own.has(key)) return null;
  let network: "public" | "private" | null = null;
  for (const address of addresses) {
    const at = addressKey(address);
    if (at === null || own.has(at)) return null;
    const kind = classifyAddress(address);
    const one =
      kind === "public"
        ? "public"
        : kind === "private" && isPrivateAddress(address)
          ? "private"
          : null;
    if (one === null || (network !== null && network !== one)) return null;
    network = one;
  }
  return network;
}
