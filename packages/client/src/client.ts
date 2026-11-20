import createClient, { type Client, type Middleware } from "openapi-fetch";
import {
  type ContractOptions,
  type ContractPolicy,
  contractPolicy,
  type OperationKey,
} from "./contract.ts";
import type { paths } from "./schema.gen.ts";

export type ApiClient = Client<paths>;

/**
 * There is deliberately no API key option: a key never belongs in a browser,
 * and a server-side caller sets `authorization` through `headers` or `fetch`.
 */
export interface ApiClientOptions extends ContractOptions {
  readonly baseUrl?: string;
  /** Called with one Request, as openapi-fetch does; `fetch` itself fits. */
  readonly fetch?: (input: Request) => Promise<Response>;
  /** Defaults to same-origin, the web console's login cookie. */
  readonly credentials?: "omit" | "same-origin" | "include";
  /** Sent with every request and every event stream. */
  readonly headers?: Readonly<Record<string, string>>;
}

export const CSRF_HEADER_NAME = "x-requested-with";
export const CSRF_HEADER_VALUE = "werft-web";

type Credentials = NonNullable<ApiClientOptions["credentials"]>;

// The server asks for it on cookie requests only and ignores it elsewhere, so
// any request that may carry a cookie sends it.
const csrfHeader: Middleware = {
  onRequest({ request }) {
    request.headers.set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    return request;
  },
};
const noCsrfHeader: Middleware = {
  onRequest({ request }) {
    request.headers.delete(CSRF_HEADER_NAME);
    return request;
  },
};

const METHODS = [
  "GET",
  "PUT",
  "POST",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "PATCH",
  "TRACE",
] as const;
type Init = { credentials?: Credentials; middleware?: Middleware[] };

/**
 * A call may override the client's credentials, and middleware never sees
 * the call's options (Request.credentials is not reliable either: Bun reports
 * "include" for all), so the header is decided per call here.
 */
function csrfPerCall(client: ApiClient, fallback: Credentials): ApiClient {
  const withCsrf = (init: Init | undefined): Init => ({
    ...init,
    middleware: [
      ...(init?.middleware ?? []),
      (init?.credentials ?? fallback) === "omit" ? noCsrfHeader : csrfHeader,
    ],
  });
  const wrapped: Record<string, unknown> = { ...client };
  for (const method of METHODS) {
    const call = client[method] as (url: unknown, init?: Init) => unknown;
    wrapped[method] = (url: unknown, init?: Init) => call(url, withCsrf(init));
  }
  const request = client.request as (
    method: unknown,
    url: unknown,
    init?: Init,
  ) => unknown;
  wrapped.request = (method: unknown, url: unknown, init?: Init) =>
    request(method, url, withCsrf(init));
  return wrapped as unknown as ApiClient;
}

const policies = new WeakMap<ApiClient, ContractPolicy>();

/** The contract policy a client was made with; streams apply it too. */
export function policyOf(client: ApiClient): ContractPolicy {
  let policy: ContractPolicy | undefined;
  // A client derived with Object.create (a query scope) keeps its source's.
  for (
    let c: object | null = client;
    c && !policy;
    c = Object.getPrototypeOf(c)
  ) {
    policy = policies.get(c as ApiClient);
  }
  // Falling back to "off" would turn a strict test client into an unchecked
  // one without a word.
  if (!policy) throw new TypeError("client was not made by createApiClient");
  return policy;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const credentials = options.credentials ?? "same-origin";
  const base = createClient<paths>({
    baseUrl: options.baseUrl ?? "",
    credentials,
    ...(options.headers ? { headers: { ...options.headers } } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const client = csrfPerCall(base, credentials);
  const policy = contractPolicy(options);
  policies.set(client, policy);
  if (policy.mode !== "off") client.use(contractCheck(policy));
  return client;
}

const NDJSON_MEDIA_TYPE = "application/x-ndjson";

function contractCheck(policy: ContractPolicy): Middleware {
  return {
    async onResponse({ request, response, schemaPath }) {
      const operation = `${request.method} ${schemaPath}`;
      const validator =
        policy.validators.responses?.[operation as OperationKey];
      if (!validator || !response.ok || response.status === 204) return;
      // The schema is the JSON answer's; an NDJSON export asked for by name
      // is lines, read by its caller, and copying it here doubles its size.
      if (request.headers.get("accept")?.startsWith(NDJSON_MEDIA_TYPE)) return;
      const requestId = response.headers.get("x-request-id");
      // Parsed whatever the content type says, as openapi-fetch does: a
      // mislabelled body must not slip past the check.
      let body: unknown;
      try {
        body = JSON.parse(await response.clone().text());
      } catch {
        policy.report(
          { operation, issues: [{ path: "", message: "body is not JSON" }] },
          response.status,
          requestId,
        );
        return;
      }
      policy.check(operation, validator, body, response.status, requestId);
    },
  };
}
