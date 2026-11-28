import {
  type EndpointNetwork,
  type OutboundHttp,
  OutboundRefusedError,
} from "@werft-ai/platform";
import {
  createProviderRequest,
  defaultLookup,
  hostPortOf,
  type Lookup,
  type PinnedRequest,
} from "./oidc/provider-http.ts";
import { outboundUnder } from "./outbound-http.ts";
import { registeredNetwork } from "./registered-network.ts";

const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Resolves a new model connection's endpoint and judges every address with
 * `registeredNetwork`. `own` is the installation's hosts as keys; when
 * they cannot be told (null) a private endpoint is not registered, since
 * nothing says it is not one of them.
 */
export function connectionNetworkCheck(
  own: () => Promise<readonly string[] | null>,
  lookup: Lookup = defaultLookup,
): (endpoint: string) => Promise<EndpointNetwork> {
  return async (endpoint) => {
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
    const deadline = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
    let addresses: string[];
    try {
      // A lookup cannot be cancelled; one that answers late is not used.
      const answers = await Promise.race([
        lookup(host),
        new Promise<never>((_, reject) => {
          deadline.addEventListener("abort", () => reject(deadline.reason), {
            once: true,
          });
        }),
      ]);
      addresses = answers.map(({ address }) => address);
    } catch {
      return { problem: "unreachable" };
    }
    if (addresses.length === 0) return { problem: "unreachable" };
    const hosts = await own();
    const network = registeredNetwork(host, addresses, new Set(hosts ?? []));
    if (network === null) return { problem: "address_not_allowed" };
    if (network === "private" && hosts === null) {
      return { problem: "installation_hosts_unavailable" };
    }
    return { network };
  };
}

/**
 * Requests control-host itself sends a connection registered as private
 * (its model list): plain http allowed, every address private and none the
 * installation's own, as the egress proxy holds the connection's calls.
 */
export function privateConnectionOutbound(
  own: () => Promise<readonly string[] | null>,
  request: PinnedRequest = createProviderRequest(),
): OutboundHttp {
  return async (outbound) => {
    const hosts = await own();
    if (hosts === null) {
      throw new OutboundRefusedError(
        "unreachable",
        "The installation's own addresses could not be told",
      );
    }
    return outboundUnder(
      { plainHttp: "refuse", registeredPrivate: { own: new Set(hosts) } },
      request,
    )(outbound);
  };
}

/**
 * Once at start: a connection from before the network column whose
 * host:port is on the operator's private allowlist, and whose name resolves
 * as a registered private endpoint may now, is kept as `private`. The
 * operator allowed it, so no one is asked again. One the rules for a
 * registered endpoint refuse (loopback, one of the installation's own
 * hosts) is left as it is, on the proxy's own lists, and named in the
 * result for the operator to move. Ids only.
 */
export async function carryOperatorPrivateConnections(deps: {
  rows: () => Promise<
    ReadonlyArray<{ id: string; entry: unknown; network?: string | null }>
  >;
  carry: (id: string) => Promise<{ outcome: "carried" | "unchanged" }>;
  privateHosts: readonly string[];
  network: (endpoint: string) => Promise<EndpointNetwork>;
}): Promise<{ carried: string[]; left: string[] }> {
  const carried: string[] = [];
  const left: string[] = [];
  if (deps.privateHosts.length === 0) return { carried, left };
  for (const row of await deps.rows()) {
    if (row.network === "public" || row.network === "private") continue;
    const endpoint = (row.entry as { endpoint?: unknown } | null)?.endpoint;
    const url = typeof endpoint === "string" ? URL.parse(endpoint) : null;
    if (url === null || !deps.privateHosts.includes(hostPortOf(url))) continue;
    const judged = await deps.network(url.href);
    if ("network" in judged && judged.network === "private") {
      if ((await deps.carry(row.id)).outcome === "carried")
        carried.push(row.id);
    } else {
      left.push(row.id);
    }
  }
  return { carried, left };
}
