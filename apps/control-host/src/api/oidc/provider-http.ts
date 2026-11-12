import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { OidcUnavailableError } from "./errors.ts";

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * `refuse`: https only, and never a loopback address. `loopback`: plain http
 * to a loopback host as well, for an installation whose console is itself on
 * loopback. `any`: plain http to whatever host the operator named; only the
 * environment-configured Google sign-in passes it, and it goes away with
 * that configuration.
 */
export type NetworkPolicy = { plainHttp: "refuse" | "loopback" | "any" };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
  if (policy.plainHttp === "any") return null;
  if (policy.plainHttp === "loopback" && LOOPBACK_HOSTS.has(url.hostname)) {
    return null;
  }
  return "insecure_endpoint";
}

export type AddressClass =
  | "public"
  | "private"
  | "loopback"
  | "link_local"
  | "multicast"
  | "reserved"
  | "unspecified";

function ipv4Bytes(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : -1,
  );
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}

function ipv6Bytes(address: string): number[] | null {
  const [head, tail, ...rest] = address.split("%")[0]?.split("::") ?? [];
  if (head === undefined || rest.length > 0) return null;
  const groups = (side: string): number[] | null => {
    if (side === "") return [];
    const out: number[] = [];
    const parts = side.split(":");
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1 && part.includes(".")) {
        const quad = ipv4Bytes(part);
        if (!quad) return null;
        out.push(...quad);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        const value = Number.parseInt(part, 16);
        out.push(value >> 8, value & 0xff);
      } else {
        return null;
      }
    }
    return out;
  };
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  if (!left || !right) return null;
  const missing = 16 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 2) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function classifyIpv4([a = 0, b = 0, c = 0]: number[]): AddressClass {
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link_local";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  if (
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return "reserved";
  }
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  ) {
    return "private";
  }
  return "public";
}

/** Null for text that is not an IP address. */
export function classifyAddress(address: string): AddressClass | null {
  const v4 = ipv4Bytes(address);
  if (v4) return classifyIpv4(v4);
  const bytes = ipv6Bytes(address);
  if (!bytes) return null;
  const zeroUntil = (end: number) =>
    bytes.slice(0, end).every((byte) => byte === 0);
  if (zeroUntil(16)) return "unspecified";
  if (zeroUntil(15) && bytes[15] === 1) return "loopback";
  // An IPv4 address carried inside IPv6 is judged as that IPv4 address, or a
  // metadata address would pass in IPv6 clothes.
  const mapped = zeroUntil(10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const nat64 =
    bytes[0] === 0 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  if (mapped || nat64) return classifyIpv4(bytes.slice(12));
  const [first = 0, second = 0, third = 0, fourth = 0] = bytes;
  if (first === 0xfe && (second & 0xc0) === 0x80) return "link_local";
  if (first === 0xff) return "multicast";
  if ((first & 0xfe) === 0xfc) return "private";
  // Only 2000::/3 is global unicast. The rest of the space is unassigned or
  // set aside (discard-only 100::/64, site-local fec0::/10, ...).
  if ((first & 0xe0) !== 0x20) return "reserved";
  if (first === 0x20 && second === 0x01) {
    // 2001::/23 is protocol assignments (Teredo, benchmarking, ORCHID) and
    // 2001:db8::/32 is documentation.
    if ((third & 0xfe) === 0 || (third === 0x0d && fourth === 0xb8)) {
      return "reserved";
    }
  }
  // 6to4 carries an IPv4 address that would go unjudged.
  if (first === 0x20 && second === 0x02) return "reserved";
  // 3fff::/20 is documentation.
  if (first === 0x3f && second === 0xff && (third & 0xf0) === 0) {
    return "reserved";
  }
  return "public";
}

export type ResolvedAddress = { address: string; family: number };
export type Lookup = (host: string) => Promise<readonly ResolvedAddress[]>;

export type ProviderRequestInit = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};
export type ProviderResponse = { status: number; text: string };
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

export function createProviderRequest(
  deps: {
    lookup?: Lookup;
    fetch?: typeof fetch;
    /** The signal that ends one request; a test passes its own. */
    deadline?: () => AbortSignal;
  } = {},
): ProviderRequest {
  const lookup: Lookup =
    deps.lookup ?? ((host) => dnsLookup(host, { all: true }));
  const send = deps.fetch ?? fetch;
  const startDeadline =
    deps.deadline ?? (() => AbortSignal.timeout(TIMEOUT_MS));

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
    const deadline = startDeadline();
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
      );
    }
    const [first] = answers;
    if (!first) {
      throw new OidcUnavailableError(
        "unreachable",
        "Provider name did not resolve",
      );
    }
    // Every answer is judged, not only the one used: a name that can resolve
    // to a refused address is refused.
    for (const { address } of answers) {
      const addressClass = classifyAddress(address);
      if (
        REFUSED_CLASSES.includes(addressClass) ||
        (addressClass === "loopback" && policy.plainHttp === "refuse")
      ) {
        throw new OidcUnavailableError(
          "address_not_allowed",
          `Provider resolves to a ${addressClass ?? "malformed"} address`,
        );
      }
    }

    // Connect to the address that was judged, so the name is not resolved a
    // second time between the check and the connection. TLS still verifies
    // the certificate for the original name.
    const pinned = isIP(host) === 0;
    let response: Response | undefined;
    let text = "";
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
        text = await readCapped(response);
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
      );
    }
    if (response.status >= 500) {
      throw new OidcUnavailableError(
        "answered",
        `Provider answered ${response.status}`,
      );
    }
    return { status: response.status, text };
  };
}

export const providerRequest: ProviderRequest = createProviderRequest();
