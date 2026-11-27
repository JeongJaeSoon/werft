import { isIP } from "node:net";
import type { OutboundHttp } from "@werft-ai/platform";
import { entryHostPort, parseEgressAllowlist } from "./egress-allowlist.ts";
import { OidcUnavailableError } from "./oidc/errors.ts";
import {
  createProviderRequest,
  defaultLookup,
  hostPortOf,
  judgedAddresses,
  type Lookup,
  type NetworkPolicy,
  type PinnedRequest,
} from "./oidc/provider-http.ts";
import { outboundUnder } from "./outbound-http.ts";

const entriesOf = (raw: string | undefined): string[] =>
  parseEgressAllowlist(raw).map(entryHostPort);

/**
 * The egress proxy's credential allowlists as the api is given them. A model
 * connection's endpoint must be on one, and the console warns about one
 * outside `credential`; null when neither is set. A workspace server needs
 * neither: only `private` opens plain http and private addresses to it.
 */
export type WorkspaceMcpHosts = {
  credential: readonly string[];
  private: readonly string[];
};

export function workspaceMcpHostsFromEnv(
  env: Record<string, string | undefined>,
): WorkspaceMcpHosts | null {
  const open = entriesOf(env.EGRESS_CREDENTIAL_ALLOWLIST);
  // The proxy holds a host on both lists to the public one; so does the api.
  const inside = entriesOf(env.EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST).filter(
    (entry) => !open.includes(entry),
  );
  if (open.length === 0 && inside.length === 0) return null;
  return { credential: [...open, ...inside], private: inside };
}

/** Why a model connection's endpoint may not be called; null when it may. */
export function connectionEndpointProblem(
  hosts: WorkspaceMcpHosts | null,
  value: string,
): string | null {
  if (hosts === null) return "credential_allowlist_unset";
  const url = new URL(value);
  const hostPort = hostPortOf(url);
  if (url.protocol !== "https:") {
    if (url.protocol !== "http:" || !hosts.private.includes(hostPort)) {
      return "url_insecure";
    }
  }
  return hosts.credential.includes(hostPort) ? null : "host_not_allowed";
}

/**
 * A model connection's model list: the private allowlist's hosts may be plain
 * http and resolve to any address but a metadata, link-local or reserved one.
 */
export function connectionModelsOutbound(
  hosts: WorkspaceMcpHosts | null,
  request: PinnedRequest = createProviderRequest(),
): OutboundHttp {
  return outboundUnder(
    { plainHttp: "refuse", privateHosts: hosts?.private ?? [] },
    request,
  );
}

/**
 * What a workspace server and its authorization server are held to: https
 * and public addresses, but the private allowlist's hosts, which may be plain
 * http and must resolve privately, as the egress proxy holds them.
 */
export function workspaceMcpPolicy(
  hosts: WorkspaceMcpHosts | null,
): NetworkPolicy {
  return {
    plainHttp: "refuse",
    privateHosts: hosts?.private ?? [],
    privateHostsStayPrivate: true,
  };
}

/**
 * Why a workspace admin may not register this server URL, before anything
 * is resolved: https, but plain http for a host on the private allowlist,
 * and an https host named, not an address, since the egress proxy checks a
 * certificate for a name only. Null when the URL may go on.
 */
export function workspaceMcpServerUrlProblem(
  hosts: WorkspaceMcpHosts | null,
  value: string,
): "url_insecure" | "url_invalid" | null {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    const inside = (hosts?.private ?? []).includes(hostPortOf(url));
    return url.protocol === "http:" && inside ? null : "url_insecure";
  }
  return isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0
    ? null
    : "url_invalid";
}

/**
 * Resolves the server's name and judges every address under
 * `workspaceMcpPolicy`: `unreachable` when it did not resolve in ten
 * seconds, `address_not_allowed` when an answer is refused.
 */
export function workspaceMcpAddressCheck(
  hosts: WorkspaceMcpHosts | null,
  lookup: Lookup = defaultLookup,
): (url: string) => Promise<"address_not_allowed" | "unreachable" | null> {
  const policy = workspaceMcpPolicy(hosts);
  return async (url) => {
    try {
      await judgedAddresses(
        new URL(url),
        policy,
        lookup,
        AbortSignal.timeout(10_000),
      );
      return null;
    } catch (error) {
      if (!(error instanceof OidcUnavailableError)) throw error;
      return error.kind === "address_not_allowed"
        ? "address_not_allowed"
        : "unreachable";
    }
  };
}

/**
 * Where the credential allowlists put a server URL's host:port: `private`
 * only on the private one, `public` on `EGRESS_CREDENTIAL_ALLOWLIST`, null on
 * neither.
 */
export function workspaceMcpListed(
  hosts: WorkspaceMcpHosts | null,
  url: string,
): "public" | "private" | null {
  const hostPort = hostPortOf(new URL(url));
  if (hosts?.private.includes(hostPort)) return "private";
  return hosts?.credential.includes(hostPort) ? "public" : null;
}

/**
 * Requests control-host sends a workspace server and its authorization
 * server under `workspaceMcpPolicy`; no redirect followed, 10 seconds, 1 MB.
 */
export function workspaceMcpOutbound(
  hosts: WorkspaceMcpHosts | null,
  request: PinnedRequest = createProviderRequest(),
): OutboundHttp {
  return outboundUnder(workspaceMcpPolicy(hosts), request);
}

/** The console page an authorization server sends the admin back to. */
export function workspaceMcpRedirectUri(
  consoleOrigin: string | null,
  serverId: string,
): string | null {
  if (consoleOrigin === null) return null;
  return `${consoleOrigin}/settings/workspace/mcp-servers/${serverId}/callback`;
}
