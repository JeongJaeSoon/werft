import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type AddressClass, classifyAddress } from "@werft-ai/system";
import { OidcUnavailableError } from "./errors.ts";

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * `refuse`: https only, and never a loopback address. `loopback`: plain http
 * to a loopback host as well, for an installation whose console is itself on
 * loopback.
 *
 * `privateHosts` set: a narrower policy, for URLs a workspace admin rather
 * than the operator chose. Only those host:port entries may be plain http or
 * resolve to a private or loopback address; every other host must be https
 * and public. `plainHttp` is not read then.
 */
export type NetworkPolicy = {
  plainHttp: "refuse" | "loopback";
  privateHosts?: readonly string[];
  /**
   * A `privateHosts` entry must then resolve to private or loopback
   * addresses only, as the egress proxy holds a credential route's private
   * host: one whose name now answers a public address is not sent a token.
   */
  privateHostsStayPrivate?: boolean;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `host:port` as the egress allowlists write it, the port always present. */
export function hostPortOf(url: URL): string {
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${host}:${port}`;
}

const insidePrivate = (url: URL, policy: NetworkPolicy): boolean =>
  policy.privateHosts?.includes(hostPortOf(url)) ?? false;

/** Null when the URL is one this client may send a request or a browser to. */
export function endpointProblem(
  value: unknown,
  policy: NetworkPolicy,
): "invalid_url" | "insecure_endpoint" | null {
  if (typeof value !== "string" || !URL.canParse(value)) return "invalid_url";
  const url = new URL(value);
  if (url.username !== "" || url.password !== "" || value.includes("#")) {
    return "invalid_url";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:") return "invalid_url";
  if (policy.privateHosts !== undefined) {
    return insidePrivate(url, policy) ? null : "insecure_endpoint";
  }
  if (policy.plainHttp === "loopback" && LOOPBACK_HOSTS.has(url.hostname)) {
    return null;
  }
  return "insecure_endpoint";
}

// Cloud instance metadata services on addresses that otherwise classify as
// private, so the private-host exception would let them through. Compared in
// URL's canonical form, which also spells an IPv4 address carried in IPv6
// (mapped, NAT64) one way. 169.254.169.254 is refused by class.
const METADATA_HOSTS = new Set([
  "100.100.100.200",
  "[fd00:ec2::254]",
  "[::ffff:6464:64c8]",
  "[64:ff9b::6464:64c8]",
]);

export function isMetadataAddress(address: string): boolean {
  const literal =
    isIP(address.split("%")[0] ?? "") === 6
      ? `[${address.split("%")[0]}]`
      : address;
  const host = URL.parse(`http://${literal}/`)?.hostname;
  return host !== undefined && METADATA_HOSTS.has(host);
}

export type ResolvedAddress = { address: string; family: number };
export type Lookup = (host: string) => Promise<readonly ResolvedAddress[]>;

export type ProviderRequestInit = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Ten seconds when absent. */
  timeoutMs?: number;
};
export type ProviderResponse = { status: number; text: string };
export type PinnedResponse = ProviderResponse & { headers: Headers };
export type PinnedRequest = (
  url: string,
  init: ProviderRequestInit,
  policy: NetworkPolicy,
) => Promise<PinnedResponse>;
/**
 * One request to a provider endpoint. Throws OidcUnavailableError when it
 * did not complete, answered 5xx, or may not be sent; any other answer,
 * a redirect included, is the caller's to read.
 */
export type ProviderRequest = (
  url: string,
  init: ProviderRequestInit,
  policy: NetworkPolicy,
) => Promise<ProviderResponse>;

const REFUSED_CLASSES: readonly (AddressClass | null)[] = [
  null,
  "link_local",
  "multicast",
  "reserved",
  "unspecified",
];

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("response body is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Every address `url`'s name resolves to, each judged under `policy`, not
 * only the one a request would use: a name that can resolve to a refused
 * address is refused. Throws OidcUnavailableError `unreachable` when the
 * name did not resolve before `deadline`, `address_not_allowed` when an
 * answer is refused.
 */
export async function judgedAddresses(
  url: URL,
  policy: NetworkPolicy,
  lookup: Lookup,
  deadline: AbortSignal,
): Promise<readonly [ResolvedAddress, ...ResolvedAddress[]]> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const timedOut = new Promise<never>((_, reject) => {
    deadline.addEventListener("abort", () => reject(deadline.reason), {
      once: true,
    });
  });
  timedOut.catch(() => {});
  let answers: readonly ResolvedAddress[];
  try {
    // A lookup cannot be cancelled; one that answers late is not used.
    answers = await Promise.race([lookup(host), timedOut]);
  } catch (error) {
    throw new OidcUnavailableError(
      "unreachable",
      `Provider name did not resolve: ${error instanceof Error ? error.name : "error"}`,
      { timedOut: deadline.aborted },
    );
  }
  const [first, ...rest] = answers;
  if (!first) {
    throw new OidcUnavailableError(
      "unreachable",
      "Provider name did not resolve",
    );
  }
  const narrow = policy.privateHosts !== undefined;
  const inside = insidePrivate(url, policy);
  for (const { address } of answers) {
    const addressClass = classifyAddress(address);
    if (
      REFUSED_CLASSES.includes(addressClass) ||
      isMetadataAddress(address) ||
      (narrow
        ? inside
          ? policy.privateHostsStayPrivate === true && addressClass === "public"
          : addressClass === "private" || addressClass === "loopback"
        : addressClass === "loopback" && policy.plainHttp === "refuse")
    ) {
      throw new OidcUnavailableError(
        "address_not_allowed",
        `Provider resolves to a ${addressClass ?? "malformed"} address`,
      );
    }
  }
  return [first, ...rest];
}

export const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true });

export function createProviderRequest(
  deps: {
    lookup?: Lookup;
    fetch?: typeof fetch;
    /** The signal that ends one request; a test passes its own. */
    deadline?: (timeoutMs: number) => AbortSignal;
  } = {},
): PinnedRequest {
  const lookup = deps.lookup ?? defaultLookup;
  const send = deps.fetch ?? fetch;
  const startDeadline =
    deps.deadline ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs));

  return async (url, init, policy) => {
    if (endpointProblem(url, policy) !== null) {
      throw new OidcUnavailableError(
        "address_not_allowed",
        "Provider endpoint URL is not allowed",
      );
    }
    const original = new URL(url);
    const host = original.hostname.replace(/^\[|\]$/g, "");
    // One deadline for the whole request, name resolution included.
    const deadline = startDeadline(init.timeoutMs ?? TIMEOUT_MS);
    const answers = await judgedAddresses(original, policy, lookup, deadline);
    const [first] = answers;

    // Connect to the address that was judged, so the name is not resolved a
    // second time between the check and the connection. TLS still verifies
    // the certificate for the original name.
    const pinned = isIP(host) === 0;
    let response: Response | undefined;
    let failure: unknown;
    // A name with several addresses (IPv6 and IPv4, say) may have one this
    // host cannot reach. Each was judged above, so the next one is as safe.
    for (const { address, family } of pinned ? answers : [first]) {
      const target = new URL(url);
      if (pinned) target.hostname = family === 6 ? `[${address}]` : address;
      try {
        response = await send(target, {
          method: init.method ?? "GET",
          headers: {
            ...init.headers,
            ...(pinned ? { Host: original.host } : {}),
          },
          ...(init.body === undefined ? {} : { body: init.body }),
          redirect: "manual",
          signal: deadline,
          ...(pinned && original.protocol === "https:"
            ? { tls: { serverName: host } }
            : {}),
        });
        break;
      } catch (error) {
        response = undefined;
        failure = error;
        if (deadline.aborted) break;
      }
    }
    if (!response) {
      throw new OidcUnavailableError(
        "unreachable",
        `Provider unreachable: ${failure instanceof Error ? failure.name : "error"}`,
        { timedOut: deadline.aborted },
      );
    }
    // Read once the server has answered, and never retried on another
    // address: the request was delivered, and sending it again could run it
    // twice. A body that fails keeps an error answer's status.
    let text = "";
    let unread: unknown = null;
    try {
      text = await readCapped(response);
    } catch (error) {
      unread = error;
    }
    if (response.status >= 500) {
      throw new OidcUnavailableError(
        "answered",
        `Provider answered ${response.status}`,
        { status: response.status },
      );
    }
    if (unread !== null && response.status >= 200 && response.status < 300) {
      throw new OidcUnavailableError(
        "unreachable",
        `Provider answer unread: ${unread instanceof Error ? unread.name : "error"}`,
        { timedOut: deadline.aborted },
      );
    }
    return { status: response.status, text, headers: response.headers };
  };
}

export const providerRequest: ProviderRequest = createProviderRequest();
