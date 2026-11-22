import {
  type OutboundHttp,
  WorkspaceMcpOutboundError,
} from "@werft-ai/platform";
import { OidcUnavailableError } from "./oidc/errors.ts";
import {
  createProviderRequest,
  hostPortOf,
  type NetworkPolicy,
  type PinnedRequest,
} from "./oidc/provider-http.ts";

/** Requests under `policy`: no redirect followed, 1 MB, ten seconds unless the request says. */
export function outboundUnder(
  policy: NetworkPolicy,
  request: PinnedRequest = createProviderRequest(),
): OutboundHttp {
  return async ({ url, method, headers, body, timeoutMs }) => {
    try {
      return await request(
        url,
        {
          method,
          ...(headers ? { headers } : {}),
          ...(body === undefined ? {} : { body }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
        policy,
      );
    } catch (error) {
      if (error instanceof OidcUnavailableError) {
        throw new WorkspaceMcpOutboundError(
          error.kind,
          error.message,
          error.detail,
        );
      }
      throw new WorkspaceMcpOutboundError(
        "unreachable",
        `Request failed: ${error instanceof Error ? error.name : "error"}`,
      );
    }
  };
}

/**
 * Requests to the one host:port of `base`, a URL the operator set. Any other
 * host is refused before anything is sent. `private` lets that host be plain
 * http or resolve to a private or loopback address (the egress proxy, a
 * GitHub Enterprise Server); without it the host is held to https and public.
 * Metadata, link-local and reserved addresses are refused either way.
 */
export function oneHostOutbound(
  base: string,
  options: { private: boolean },
  request: PinnedRequest = createProviderRequest(),
): OutboundHttp {
  const allowed = hostPortOf(new URL(base));
  const send = outboundUnder(
    { plainHttp: "refuse", privateHosts: options.private ? [allowed] : [] },
    request,
  );
  return async (outbound) => {
    const url = URL.parse(outbound.url);
    if (url === null || hostPortOf(url) !== allowed) {
      throw new WorkspaceMcpOutboundError(
        "address_not_allowed",
        "Request URL is not the configured host",
      );
    }
    return send(outbound);
  };
}
