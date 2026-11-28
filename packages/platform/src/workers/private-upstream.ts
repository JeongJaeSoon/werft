import type { ConnectionNetwork, EgressUpstream } from "../catalog/index.ts";

/** What marking a registered private model endpoint takes from the host. */
export type PrivateUpstreamGate = {
  /**
   * The installation's own hosts, for the grant's deny list: read on every
   * grant by the process that answers it. Null when they cannot all be
   * told, and then no private grant is given.
   */
  deny: () => Promise<readonly string[] | null>;
  /** Whether the operator's private allowlist names the URL's host:port. */
  operatorListed: (url: string) => boolean;
};

export type PrivateUpstreamRefusal =
  | "egress_proxy_outdated"
  | "private_deny_unavailable";

export const PRIVATE_UPSTREAM_REFUSALS: Record<PrivateUpstreamRefusal, string> =
  {
    egress_proxy_outdated:
      "The egress proxy is older than the API and cannot reach this connection; upgrade the proxy",
    private_deny_unavailable:
      "The installation's own addresses could not be told, so no private endpoint is reached; try again",
  };

/**
 * The upstream as its grant carries it. A connection registered as private
 * gets the `private` mark and the installation's own hosts to deny, for a
 * proxy that said it reads the mark. A proxy that did not keeps to its own
 * lists, which is right only for a host the operator listed there; any
 * other is refused here, since that proxy would drop the mark and its rules
 * with it. Every other connection goes as it is.
 */
export async function registeredUpstream(
  upstream: EgressUpstream,
  network: ConnectionNetwork | undefined,
  proxyReadsMark: boolean,
  gate: PrivateUpstreamGate | undefined,
): Promise<EgressUpstream | PrivateUpstreamRefusal> {
  if (network !== "private" || gate === undefined) return upstream;
  if (!proxyReadsMark) {
    return gate.operatorListed(upstream.url)
      ? upstream
      : "egress_proxy_outdated";
  }
  const deny = await gate.deny();
  if (deny === null) return "private_deny_unavailable";
  return { ...upstream, allow: "private", deny: [...deny] };
}
