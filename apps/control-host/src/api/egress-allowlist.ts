/**
 * One entry of an egress allowlist value (`host:port,[v6]:port`), read the
 * way the egress proxy's parseDestinations reads it: trimmed, empty entries
 * dropped, the host unbracketed, without a trailing dot and lowercased.
 * The proxy refuses to start on an entry without a port; here it is kept
 * with a null port.
 */
export type EgressAllowlistEntry = {
  readonly host: string;
  readonly port: number | null;
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
    .map((entry) => {
      const separator = entry.startsWith("[")
        ? entry.indexOf("]:") + 1
        : entry.lastIndexOf(":");
      if (separator <= 0)
        return { host: normalizeEgressHost(entry), port: null };
      return {
        host: normalizeEgressHost(entry.slice(0, separator)),
        port: Number(entry.slice(separator + 1)),
      };
    });
}

/** `host:port` as hostPortOf writes a URL's, IPv6 without brackets. */
export const entryHostPort = (entry: EgressAllowlistEntry): string =>
  entry.port === null ? entry.host : `${entry.host}:${entry.port}`;
