import { createHash, randomBytes } from "node:crypto";
import {
  isMcpToolName,
  WORKSPACE_MCP_TOOL_DESCRIPTION_MAX,
  WORKSPACE_MCP_TOOLS_MAX,
} from "@werft-ai/contracts";
import {
  type ClientAuthMethod,
  type OutboundHttp,
  OutboundRefusedError,
  type OutboundResponse,
  type WorkspaceMcpClient,
  type WorkspaceMcpOAuthPin,
  type WorkspaceMcpTokens,
  type WorkspaceMcpTool,
} from "./ports/workspace-mcp-store.ts";

// Everything control-host says to a remote MCP server and its authorization
// server itself. No upstream body is
// put in an error message: a reason code and, from a token endpoint, the
// OAuth `error` code are all that leave this module.

export type RemoteReason =
  | "address_not_allowed"
  | "unreachable"
  | "discovery_failed"
  | "resource_mismatch"
  | "issuer_mismatch"
  | "pkce_unsupported"
  | "endpoint_not_allowed"
  | "registration_failed"
  | "token_rejected"
  | "token_invalid"
  | "scope_widened"
  | "credential_reflected"
  | "unauthorized"
  | "mcp_failed";

export class WorkspaceMcpRemoteError extends Error {
  constructor(
    readonly reason: RemoteReason,
    message: string,
    /** A token endpoint's OAuth `error` code, when it sent one. */
    readonly oauthError: string | null = null,
  ) {
    super(message);
  }
}

const fail = (reason: RemoteReason, message: string) =>
  new WorkspaceMcpRemoteError(reason, message);

/** `allowsUrl`: whether control-host, or a browser, may be sent there. */
export type WorkspaceMcpRemoteDeps = {
  http: OutboundHttp;
  allowsUrl: (url: string) => boolean;
};

const MCP_PROTOCOL_VERSION = "2025-06-18";
const TOOLS_PAGES_MAX = 10;

async function send(
  deps: WorkspaceMcpRemoteDeps,
  request: Parameters<OutboundHttp>[0],
): Promise<OutboundResponse> {
  if (!deps.allowsUrl(request.url)) {
    throw fail(
      "endpoint_not_allowed",
      "The address is not one this server may call",
    );
  }
  try {
    return await deps.http(request);
  } catch (error) {
    if (error instanceof OutboundRefusedError) {
      throw fail(
        error.reason === "address_not_allowed"
          ? "address_not_allowed"
          : "unreachable",
        error.reason === "address_not_allowed"
          ? "The server resolves to an address this server may not call"
          : "The server could not be reached",
      );
    }
    throw error;
  }
}

/**
 * A response that carries back a secret this request sent is dropped
 * whole: nothing of it is stored, answered or logged (decision 5).
 */
function refuseReflection(
  response: OutboundResponse,
  sent: readonly string[],
): void {
  // The decoded JSON too: a `\u` escape hides a value from the raw text
  // and is back whole once parsed.
  refuseReflected(sent, [
    response.text,
    ...response.headers.values(),
    ...textsOf(bodiesOf(response)),
  ]);
}

function refuseReflected(
  sent: readonly string[],
  seen: readonly string[],
): void {
  if (
    sent.some(
      (secret) => secret !== "" && seen.some((text) => text.includes(secret)),
    )
  ) {
    throw fail("credential_reflected", "The server sent a credential back");
  }
}

/** Every string and key in parsed JSON, walked without recursion. */
function textsOf(values: readonly unknown[]): string[] {
  const texts: string[] = [];
  const pending = [...values];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") texts.push(value);
    else if (Array.isArray(value)) for (const item of value) pending.push(item);
    else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        texts.push(key);
        pending.push(item);
      }
    }
  }
  return texts;
}

/** The JSON messages of a body: one document, or each event of a stream. */
function bodiesOf(response: OutboundResponse): unknown[] {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) {
    const body = jsonOf(response.text);
    return Array.isArray(body) ? body : [body];
  }
  const messages: unknown[] = [];
  for (const event of response.text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data !== "") messages.push(jsonOf(data));
  }
  return messages;
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOf = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/** The URL without one trailing `/`, as resource identifiers compare. */
const withoutSlash = (url: string) => url.replace(/\/$/, "");

/** RFC 9728 / RFC 6750 parameters of a `WWW-Authenticate: Bearer` challenge. */
export function bearerChallengeOf(header: string | null): {
  resourceMetadata: string | null;
  scope: string | null;
} {
  const empty = { resourceMetadata: null, scope: null };
  if (header === null) return empty;
  const at = header.search(/\bbearer\b/i);
  if (at < 0) return empty;
  const params = new Map<string, string>();
  const pattern = /([a-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi;
  for (const match of header.slice(at + 6).matchAll(pattern)) {
    const key = match[1]?.toLowerCase();
    const value =
      match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : match[3];
    if (key && value !== undefined && !params.has(key)) params.set(key, value);
  }
  return {
    resourceMetadata: params.get("resource_metadata") ?? null,
    scope: params.get("scope") ?? null,
  };
}

function initializeBody(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "werft", version: "1" },
    },
  });
}

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

/** Well-known URLs in RFC 8414's order: path inserted, then at the root. */
function wellKnown(base: string, suffix: string): string[] {
  const url = new URL(base);
  const path = url.pathname.replace(/\/$/, "");
  const urls = [];
  if (path !== "") urls.push(`${url.origin}/.well-known/${suffix}${path}`);
  urls.push(`${url.origin}/.well-known/${suffix}`);
  return urls;
}

async function firstJson(
  deps: WorkspaceMcpRemoteDeps,
  urls: readonly string[],
): Promise<Record<string, unknown> | null> {
  for (const url of urls) {
    const response = await send(deps, {
      url,
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (response.status === 200) {
      const body = jsonOf(response.text);
      if (isRecord(body)) return body;
    }
  }
  return null;
}

export type Discovery = {
  url: string;
  /** Null when the server asks for no OAuth. */
  oauth: {
    pin: WorkspaceMcpOAuthPin;
    scopesSupported: string[];
    defaultScope: string | null;
  } | null;
};

/** Discovery as decision 3 steps 1–4 and 6 lay it out; the client is left for later. */
export async function discover(
  deps: WorkspaceMcpRemoteDeps,
  url: string,
): Promise<Discovery> {
  const probe = await send(deps, {
    url,
    method: "POST",
    headers: MCP_HEADERS,
    body: initializeBody(0),
  });
  const challenge =
    probe.status === 401
      ? bearerChallengeOf(probe.headers.get("www-authenticate"))
      : { resourceMetadata: null, scope: null };
  const resourceMetadata = await firstJson(
    deps,
    challenge.resourceMetadata !== null
      ? [challenge.resourceMetadata]
      : wellKnown(url, "oauth-protected-resource"),
  );
  // A server that publishes no resource metadata, even one that answered
  // 401, takes a static token or nothing.
  if (resourceMetadata === null) return { url, oauth: null };
  const resource = stringOf(resourceMetadata.resource);
  if (resource === null || withoutSlash(resource) !== withoutSlash(url)) {
    throw fail(
      "resource_mismatch",
      "The server's resource metadata names another resource",
    );
  }
  const issuer = stringsOf(resourceMetadata.authorization_servers)[0];
  if (issuer === undefined || !URL.canParse(issuer)) {
    throw fail(
      "discovery_failed",
      "The resource metadata names no authorization server",
    );
  }
  const issuerUrl = new URL(issuer);
  const metadata = await firstJson(deps, [
    ...wellKnown(issuer, "oauth-authorization-server"),
    `${withoutSlash(issuerUrl.href)}/.well-known/openid-configuration`,
  ]);
  if (metadata === null) {
    throw fail(
      "discovery_failed",
      "The authorization server publishes no metadata",
    );
  }
  if (stringOf(metadata.issuer) !== issuer) {
    throw fail(
      "issuer_mismatch",
      "The authorization server's metadata names another issuer",
    );
  }
  if (!stringsOf(metadata.code_challenge_methods_supported).includes("S256")) {
    throw fail(
      "pkce_unsupported",
      "The authorization server does not take PKCE with S256",
    );
  }
  const authorizationEndpoint = stringOf(metadata.authorization_endpoint);
  const tokenEndpoint = stringOf(metadata.token_endpoint);
  const revocationEndpoint = stringOf(metadata.revocation_endpoint);
  const registrationEndpoint = stringOf(metadata.registration_endpoint);
  for (const endpoint of [
    authorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint,
    registrationEndpoint,
  ]) {
    if (
      endpoint !== null &&
      (!URL.canParse(endpoint) || !deps.allowsUrl(endpoint))
    ) {
      throw fail(
        "endpoint_not_allowed",
        "The authorization server names an endpoint this server may not call",
      );
    }
  }
  if (authorizationEndpoint === null || tokenEndpoint === null) {
    throw fail(
      "discovery_failed",
      "The authorization server names no authorization or token endpoint",
    );
  }
  const scopesSupported = [
    ...stringsOf(resourceMetadata.scopes_supported),
    ...stringsOf(metadata.scopes_supported),
  ].filter((scope, at, all) => all.indexOf(scope) === at);
  const defaultScope =
    challenge.scope ??
    (scopesSupported.length > 0 ? scopesSupported.join(" ") : null);
  return {
    url,
    oauth: {
      pin: {
        issuer,
        authorizationEndpoint,
        tokenEndpoint,
        revocationEndpoint,
        registrationEndpoint,
        resource,
        scope: defaultScope,
        issParameterSupported:
          metadata.authorization_response_iss_parameter_supported === true,
        tokenEndpointAuthMethods: stringsOf(
          metadata.token_endpoint_auth_methods_supported,
        ),
        client: null,
      },
      scopesSupported,
      defaultScope,
    },
  };
}

/** RFC 7591, as decision 3 step 5 asks: a public client for this one callback. */
export async function registerClient(
  deps: WorkspaceMcpRemoteDeps,
  pin: WorkspaceMcpOAuthPin,
  redirectUri: string,
): Promise<{ client: WorkspaceMcpClient; clientSecret: string | null }> {
  if (pin.registrationEndpoint === null) {
    throw fail(
      "registration_failed",
      "The authorization server takes no client registration",
    );
  }
  const response = await send(deps, {
    url: pin.registrationEndpoint,
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Werft",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(pin.scope === null ? {} : { scope: pin.scope }),
    }),
  });
  const body = jsonOf(response.text);
  const clientId = isRecord(body) ? stringOf(body.client_id) : null;
  if (response.status !== 201 && response.status !== 200) {
    throw fail(
      "registration_failed",
      `Client registration answered ${response.status}`,
    );
  }
  if (!isRecord(body) || clientId === null) {
    throw fail(
      "registration_failed",
      "Client registration answered without a client id",
    );
  }
  const clientSecret = stringOf(body.client_secret);
  const method = stringOf(body.token_endpoint_auth_method);
  const authMethod: ClientAuthMethod =
    clientSecret === null
      ? "none"
      : method === "client_secret_basic"
        ? "client_secret_basic"
        : "client_secret_post";
  return {
    client: { registration: "dcr", clientId, authMethod },
    clientSecret,
  };
}

/** A hand-made client's method: what the server takes, a secret's by preference. */
export function manualAuthMethod(
  pin: WorkspaceMcpOAuthPin,
  hasSecret: boolean,
): ClientAuthMethod {
  if (!hasSecret) return "none";
  const methods = pin.tokenEndpointAuthMethods;
  // RFC 8414: absent means client_secret_basic.
  if (methods.length === 0 || methods.includes("client_secret_basic")) {
    return "client_secret_basic";
  }
  return "client_secret_post";
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizationUrl(input: {
  pin: WorkspaceMcpOAuthPin;
  client: WorkspaceMcpClient;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(input.pin.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.pin.resource);
  if (input.pin.scope !== null) url.searchParams.set("scope", input.pin.scope);
  return url.toString();
}

const scopeSet = (scope: string) =>
  new Set(scope.split(" ").filter((token) => token !== ""));

/** Whether `scope` holds a token `within` does not. */
export function scopeWidens(scope: string, within: string | null): boolean {
  if (within === null) return false;
  const allowed = scopeSet(within);
  return [...scopeSet(scope)].some((token) => !allowed.has(token));
}

type ClientCredentials = {
  client: WorkspaceMcpClient;
  clientSecret: string | null;
};

async function tokenRequest(
  deps: WorkspaceMcpRemoteDeps,
  pin: WorkspaceMcpOAuthPin,
  credentials: ClientCredentials,
  params: Record<string, string>,
  sent: readonly string[],
  now: Date,
): Promise<WorkspaceMcpTokens> {
  const form = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  const { client, clientSecret } = credentials;
  if (client.authMethod === "client_secret_basic" && clientSecret !== null) {
    const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
  } else {
    form.set("client_id", client.clientId);
    if (client.authMethod === "client_secret_post" && clientSecret !== null) {
      form.set("client_secret", clientSecret);
    }
  }
  form.set("resource", pin.resource);
  const response = await send(deps, {
    url: pin.tokenEndpoint,
    method: "POST",
    headers,
    body: form.toString(),
  });
  const body = jsonOf(response.text);
  if (response.status !== 200) {
    // A refresh token or client secret in an error body would otherwise
    // reach whoever reads the reason (decision 5).
    refuseReflection(response, [
      ...sent,
      ...(clientSecret === null ? [] : [clientSecret]),
    ]);
    const oauthError = isRecord(body) ? stringOf(body.error) : null;
    // RFC 6749 5.2's error characters; anything else is not repeated.
    const code =
      oauthError !== null &&
      /^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,64}$/.test(oauthError)
        ? oauthError
        : null;
    throw new WorkspaceMcpRemoteError(
      "token_rejected",
      `The token endpoint answered ${response.status}${code === null ? "" : ` (${code})`}`,
      code,
    );
  }
  if (!isRecord(body))
    throw fail("token_invalid", "The token endpoint answered without JSON");
  const accessToken = stringOf(body.access_token);
  const tokenType = stringOf(body.token_type);
  if (accessToken === null || tokenType?.toLowerCase() !== "bearer") {
    throw fail(
      "token_invalid",
      "The token endpoint answered without a bearer access token",
    );
  }
  // The scope is the field kept where people read it. The rest of a good
  // answer is not compared: a server may hand the same refresh token back.
  refuseReflected(
    [...sent, ...(clientSecret === null ? [] : [clientSecret])],
    textsOf([body.scope]),
  );
  const expiresIn = body.expires_in;
  const scope = stringOf(body.scope);
  return {
    accessToken,
    refreshToken: stringOf(body.refresh_token),
    expiresAt:
      typeof expiresIn === "number" &&
      Number.isFinite(expiresIn) &&
      expiresIn > 0
        ? new Date(now.getTime() + expiresIn * 1000)
        : null,
    scope,
  };
}

export function exchangeCode(
  deps: WorkspaceMcpRemoteDeps,
  input: ClientCredentials & {
    pin: WorkspaceMcpOAuthPin;
    code: string;
    verifier: string;
    redirectUri: string;
    now: Date;
  },
): Promise<WorkspaceMcpTokens> {
  return tokenRequest(
    deps,
    input.pin,
    input,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    },
    [input.code, input.verifier],
    input.now,
  );
}

export function refreshTokens(
  deps: WorkspaceMcpRemoteDeps,
  input: ClientCredentials & {
    pin: WorkspaceMcpOAuthPin;
    refreshToken: string;
    now: Date;
  },
): Promise<WorkspaceMcpTokens> {
  return tokenRequest(
    deps,
    input.pin,
    input,
    { grant_type: "refresh_token", refresh_token: input.refreshToken },
    [input.refreshToken],
    input.now,
  );
}

/** RFC 7009, best effort: true when the server took it. */
export async function revokeToken(
  deps: WorkspaceMcpRemoteDeps,
  input: ClientCredentials & {
    pin: WorkspaceMcpOAuthPin;
    token: string;
    hint: "refresh_token" | "access_token";
  },
): Promise<boolean> {
  if (input.pin.revocationEndpoint === null) return false;
  const form = new URLSearchParams({
    token: input.token,
    token_type_hint: input.hint,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (
    input.client.authMethod === "client_secret_basic" &&
    input.clientSecret !== null
  ) {
    const pair = `${encodeURIComponent(input.client.clientId)}:${encodeURIComponent(input.clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
  } else {
    form.set("client_id", input.client.clientId);
    if (
      input.client.authMethod === "client_secret_post" &&
      input.clientSecret !== null
    ) {
      form.set("client_secret", input.clientSecret);
    }
  }
  try {
    const response = await send(deps, {
      url: input.pin.revocationEndpoint,
      method: "POST",
      headers,
      body: form.toString(),
    });
    return response.status === 200;
  } catch (error) {
    if (error instanceof WorkspaceMcpRemoteError) return false;
    throw error;
  }
}

/** The JSON-RPC answer with `id`, from a JSON body or an event stream. */
function rpcResultOf(
  response: OutboundResponse,
  id: number,
): Record<string, unknown> {
  const answer = bodiesOf(response).find(
    (message) => isRecord(message) && message.id === id,
  );
  if (!isRecord(answer) || !isRecord(answer.result)) {
    throw fail("mcp_failed", "The server did not answer the MCP request");
  }
  return answer.result;
}

/**
 * initialize, notifications/initialized and tools/list (decision 5), with
 * the credential the agents will use. Names that fail the MCP tool name
 * check, and any past the limit, are counted and left out.
 */
export async function listTools(
  deps: WorkspaceMcpRemoteDeps,
  input: { url: string; serverName: string; token: string },
): Promise<{ tools: WorkspaceMcpTool[]; skipped: number }> {
  const headers: Record<string, string> = {
    ...MCP_HEADERS,
    Authorization: `Bearer ${input.token}`,
  };
  const call = async (body: string) => {
    const response = await send(deps, {
      url: input.url,
      method: "POST",
      headers,
      body,
    });
    refuseReflection(response, [input.token]);
    if (response.status === 401 || response.status === 403) {
      throw fail(
        "unauthorized",
        `The server refused the credential (${response.status})`,
      );
    }
    return response;
  };
  const initialized = await call(initializeBody(1));
  if (initialized.status !== 200) {
    throw fail("mcp_failed", `initialize answered ${initialized.status}`);
  }
  const result = rpcResultOf(initialized, 1);
  const session = initialized.headers.get("mcp-session-id");
  if (session !== null) headers["Mcp-Session-Id"] = session;
  const version = stringOf(result.protocolVersion);
  if (version !== null) headers["MCP-Protocol-Version"] = version;
  await call(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );

  const tools: WorkspaceMcpTool[] = [];
  let skipped = 0;
  let cursor: string | null = null;
  for (let page = 0; page < TOOLS_PAGES_MAX; page += 1) {
    const id = page + 2;
    const response = await call(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/list",
        ...(cursor === null ? {} : { params: { cursor } }),
      }),
    );
    if (response.status !== 200) {
      throw fail("mcp_failed", `tools/list answered ${response.status}`);
    }
    const listed = rpcResultOf(response, id);
    for (const tool of Array.isArray(listed.tools) ? listed.tools : []) {
      const name = isRecord(tool) ? stringOf(tool.name) : null;
      if (
        name === null ||
        tools.length >= WORKSPACE_MCP_TOOLS_MAX ||
        !isMcpToolName(`mcp__${input.serverName}__${name}`) ||
        tools.some((kept) => kept.name === name)
      ) {
        skipped += 1;
        continue;
      }
      const description = isRecord(tool) ? stringOf(tool.description) : null;
      tools.push({
        name,
        description:
          description === null
            ? null
            : description.slice(0, WORKSPACE_MCP_TOOL_DESCRIPTION_MAX),
      });
    }
    cursor = stringOf(listed.nextCursor);
    if (cursor === null) break;
  }
  return { tools, skipped };
}
