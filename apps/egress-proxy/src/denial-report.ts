import type { ProxyLogger } from "./logger.ts";
import { messageOf } from "./message-of.ts";

/** A destination the forward port refused, and the attempt that asked. */
export type EgressDenial = { token: string; host: string; port: number };

const BASIC = /^basic +([A-Za-z0-9+/]+={0,2})$/i;
const MAX_TOKEN_LENGTH = 512;

/**
 * The `egress_report` token in a refused request's `Proxy-Authorization`:
 * the password of its Basic credentials, which an HTTP client builds from
 * the userinfo of its proxy variable. Anything else is no token.
 */
export function reportTokenOf(field: string | undefined): string | undefined {
  if (field === undefined) return undefined;
  const encoded = BASIC.exec(field.trim())?.[1];
  if (encoded === undefined) return undefined;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return undefined;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return undefined;
  const token = decodeURIComponentOrNull(decoded.slice(colon + 1));
  return token !== null && token.length > 0 && token.length <= MAX_TOKEN_LENGTH
    ? token
    : undefined;
}

function decodeURIComponentOrNull(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
/** Reports past this many in flight are dropped, not queued. */
const DEFAULT_MAX_IN_FLIGHT = 16;

/**
 * Sends each refusal to the authorizer's denial path and forgets it. The
 * refusal is answered before and whatever happens here: a report that
 * fails, times out or finds too many ahead of it is logged and dropped.
 */
export function createDenialReporter(options: {
  authorizerUrl: string;
  token: string;
  logger: ProxyLogger;
  timeoutMs?: number;
  maxInFlight?: number;
}): (denial: EgressDenial) => void {
  const url = new URL("/egress-denials", options.authorizerUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  let inFlight = 0;
  return (denial) => {
    const destination = { host: denial.host, port: denial.port };
    if (inFlight >= maxInFlight) {
      options.logger.warn("Egress denial report dropped", {
        ...destination,
        reason: "too many in flight",
      });
      return;
    }
    inFlight += 1;
    void fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(denial),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then(async (response) => {
        await response.body?.cancel();
        if (!response.ok) {
          options.logger.warn("Egress denial report refused", {
            ...destination,
            status: response.status,
          });
        }
      })
      .catch((error: unknown) => {
        options.logger.warn("Egress denial report failed", {
          ...destination,
          error: messageOf(error),
        });
      })
      .finally(() => {
        inFlight -= 1;
      });
  };
}
