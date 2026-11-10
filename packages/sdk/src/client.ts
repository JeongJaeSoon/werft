import { createApiClient } from "@werft-ai/client";
import {
  call,
  checkHeaders,
  type RequestOptions,
  type RetryPolicy,
} from "./core/request.ts";
import type { Context } from "./resources/context.ts";
import { type Sessions, sessions } from "./resources/sessions.ts";
import type {
  ApiRoot,
  AuthMe,
  Connections,
  InstallationLimits,
  Receipt,
  ReceiptId,
} from "./types.ts";

export interface ClientOptions {
  /** e.g. "https://agents.example.com". Default env WERFT_BASE_URL; there is no hosted default. */
  baseUrl?: string;
  /** Sent as `Authorization: Bearer <key>`. Default env WERFT_API_KEY. Never echoed. */
  apiKey?: string;
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** Longest single wait, Retry-After included; a longer Retry-After fails at once. Default 60_000. */
  maxRetryDelayMs?: number;
  /** Per attempt. Default 60_000. Not applied to an open event stream. */
  timeoutMs?: number;
  /** Can never set Authorization or Idempotency-Key. */
  defaultHeaders?: Record<string, string>;
  /** Called with one Request; `fetch` itself fits, and so does a plain wrapper. */
  fetch?: (input: Request) => Promise<Response>;
  /** Construction throws where `window` exists unless true: an API key in a page leaks. */
  dangerouslyAllowBrowser?: boolean;
  /** Construction throws for http:// to a non-loopback host unless true: the key would cross the wire in clear text. */
  allowInsecureHttp?: boolean;
}

// Kept off the instance so the key never shows in inspect, JSON or a log.
const settings = new WeakMap<Werft, ClientOptions>();

function environment(): Record<string, string | undefined> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env ?? {}
  );
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

function count(name: string, value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

export class Werft {
  readonly sessions: Sessions;
  readonly receipts: {
    get(id: ReceiptId, options?: RequestOptions): Promise<Receipt>;
  };
  /** This key's owner and scopes. */
  readonly auth: { me(options?: RequestOptions): Promise<AuthMe> };
  readonly limits: {
    get(options?: RequestOptions): Promise<InstallationLimits>;
  };
  /** The provider connections a release may run on, with their models. */
  readonly connections: {
    list(options?: RequestOptions): Promise<Connections>;
  };
  readonly root: { get(options?: RequestOptions): Promise<ApiRoot> };

  constructor(options: ClientOptions = {}) {
    const env = environment();
    const apiKey = options.apiKey ?? env.WERFT_API_KEY;
    const baseUrl = options.baseUrl ?? env.WERFT_BASE_URL;
    if (!apiKey)
      throw new TypeError("No API key: pass apiKey or set WERFT_API_KEY");
    if (!baseUrl)
      throw new TypeError("No base URL: pass baseUrl or set WERFT_BASE_URL");
    if (
      typeof (globalThis as { window?: unknown }).window !== "undefined" &&
      !options.dangerouslyAllowBrowser
    )
      throw new Error(
        "Werft runs on servers and scripts: an API key in a browser page leaks. Set dangerouslyAllowBrowser to override.",
      );
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new TypeError("baseUrl is not a URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new TypeError("baseUrl must be http or https");
    if (
      url.protocol === "http:" &&
      !isLoopback(url.hostname) &&
      !options.allowInsecureHttp
    )
      throw new Error(
        "baseUrl is plain http to a remote host: the API key would cross the wire in clear text. Use https or set allowInsecureHttp.",
      );

    const policy: RetryPolicy = {
      maxRetries: count("maxRetries", options.maxRetries, 2),
      maxRetryDelayMs: count(
        "maxRetryDelayMs",
        options.maxRetryDelayMs,
        60_000,
      ),
      timeoutMs: count("timeoutMs", options.timeoutMs, 60_000),
    };
    const api = createApiClient({
      baseUrl: url.href.replace(/\/+$/, ""),
      credentials: "omit",
      headers: {
        ...checkHeaders(options.defaultHeaders),
        authorization: `Bearer ${apiKey}`,
      },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const context: Context = { api, policy };
    settings.set(this, { ...options, apiKey, baseUrl });

    this.sessions = sessions(context);
    this.receipts = {
      get: (id, o) =>
        call(
          policy,
          "read",
          ({ signal, headers }) =>
            api.GET("/v1/receipts/{id}", {
              params: { path: { id } },
              signal,
              headers,
            }),
          o,
        ),
    };
    this.auth = {
      me: (o) =>
        call(
          policy,
          "read",
          ({ signal, headers }) => api.GET("/v1/auth/me", { signal, headers }),
          o,
        ),
    };
    this.limits = {
      get: async (o) => {
        const limits = await call(
          policy,
          "read",
          ({ signal, headers }) =>
            api.GET("/v1/limits", {
              params: { query: { scope: "installation" } },
              signal,
              headers,
            }),
          o,
        );
        if (limits.scope !== "installation") {
          throw new TypeError(`unexpected limits scope ${limits.scope}`);
        }
        return limits;
      },
    };
    this.connections = {
      list: (o) =>
        call(
          policy,
          "read",
          ({ signal, headers }) =>
            api.GET("/v1/connections", { signal, headers }),
          o,
        ),
    };
    this.root = {
      get: (o) =>
        call(
          policy,
          "read",
          ({ signal, headers }) => api.GET("/v1", { signal, headers }),
          o,
        ),
    };
  }

  /** A second client with some options changed, e.g. an approve-scoped key. */
  withOptions(overrides: ClientOptions): Werft {
    return new Werft({ ...settings.get(this), ...overrides });
  }
}
