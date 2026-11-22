import type { OutboundHttp } from "@werft-ai/platform";
import { entryHostPort, parseEgressAllowlist } from "./egress-allowlist.ts";
import {
  createProviderRequest,
  hostPortOf,
  type PinnedRequest,
} from "./oidc/provider-http.ts";
import { outboundUnder } from "./outbound-http.ts";

const entriesOf = (raw: string | undefined): string[] =>
  parseEgressAllowlist(raw).map(entryHostPort);

/**
 * The egress proxy's credential allowlists as the api is given them: a
 * workspace server's host:port must be on one, and the console warns about a
 * model connection endpoint outside `credential`. Null when neither is set,
 * and then no workspace server can be registered.
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

/** Why a workspace admin may not register this URL; null when they may. */
export function workspaceMcpUrlProblem(
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
 * Requests control-host sends a workspace server and its authorization
 * server: https and public addresses only, but for the private allowlist's
 * hosts; no redirect followed, 10 seconds, 1 MB.
 */
export function workspaceMcpOutbound(
  hosts: WorkspaceMcpHosts | null,
  request: PinnedRequest = createProviderRequest(),
): OutboundHttp {
  return outboundUnder(
    { plainHttp: "refuse", privateHosts: hosts?.private ?? [] },
    request,
  );
}

/** The console page an authorization server sends the admin back to. */
export function workspaceMcpRedirectUri(
  consoleOrigin: string | null,
  serverId: string,
): string | null {
  if (consoleOrigin === null) return null;
  return `${consoleOrigin}/settings/workspace/mcp-servers/${serverId}/callback`;
}
