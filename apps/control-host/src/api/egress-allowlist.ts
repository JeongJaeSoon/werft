/**
 * One entry of an egress allowlist value (`host:port,[v6]:port`), read the
 * way the egress proxy's parseDestinations reads it: trimmed, empty entries
 * dropped, the host unbracketed, without a trailing dot and lowercased.
 * The proxy refuses to start on an entry without a host or a valid port;
 * here such an entry is dropped, so it allows nothing.
 */
export type EgressAllowlistEntry = {
  readonly host: string;
  readonly port: number;
};

export function normalizeEgressHost(host: string): string {
  return host
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
}

export function parseEgressAllowlist(
  raw: string | undefined,
): EgressAllowlistEntry[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .flatMap((entry) => {
      const separator = entry.startsWith("[")
        ? entry.indexOf("]:") + 1
        : entry.lastIndexOf(":");
      if (separator <= 0) return [];
      const host = normalizeEgressHost(entry.slice(0, separator));
      const port = Number(entry.slice(separator + 1));
      if (host === "" || !Number.isInteger(port) || port < 1 || port > 65_535) {
        return [];
      }
      return [{ host, port }];
    });
}

/** `host:port` as hostPortOf writes a URL's, IPv6 without brackets. */
export const entryHostPort = (entry: EgressAllowlistEntry): string =>
  `${entry.host}:${entry.port}`;
