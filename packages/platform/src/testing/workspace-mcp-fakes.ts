import type {
  OutboundHttp,
  OutboundRequest,
  OutboundResponse,
  WorkspaceMcpCredential,
  WorkspaceMcpFlow,
  WorkspaceMcpPerson,
  WorkspaceMcpRevocation,
  WorkspaceMcpServerRecord,
  WorkspaceMcpStore,
} from "../workspace-mcp/ports/workspace-mcp-store.ts";

export const FAKE_MCP_URL = "https://mcp.example.com/v1/mcp";
export const FAKE_ISSUER = "https://auth.example.com";
const RESOURCE_METADATA =
  "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp";

type Answer = {
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
};

export type FakeRemoteOptions = {
  /** False: the server asks for no OAuth and takes the static tokens in `accepted`. */
  oauth?: boolean;
  resource?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  token?: (form: URLSearchParams) => Answer;
  registration?: () => Answer;
  toolPages?: unknown[][];
  /** Answer MCP requests as an event stream. */
  sse?: boolean;
  accepted?: string[];
  /**
   * A public server, as DeepWiki is: a request with no Authorization is
   * answered, and one with any is refused.
   */
  anonymous?: boolean;
};

function answer({ status, json, text, headers }: Answer): OutboundResponse {
  const body = json === undefined ? (text ?? "") : JSON.stringify(json);
  return {
    status,
    text: body,
    headers: new Headers({
      ...(json === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    }),
  };
}

/**
 * A remote MCP server and its authorization server, as control-host's
 * outbound client sees them. Every request is kept in `requests`.
 */
export function fakeRemote(options: FakeRemoteOptions = {}) {
  const oauth = options.oauth ?? true;
  const requests: OutboundRequest[] = [];
  const accepted = new Set(options.accepted ?? []);
  const revoked: string[] = [];
  let issued = 0;

  const issue = (scope: string | null): Answer => {
    issued += 1;
    const access = `fake-access-${issued}`;
    accepted.add(access);
    return {
      status: 200,
      json: {
        access_token: access,
        token_type: "Bearer",
        refresh_token: `fake-refresh-${issued}`,
        expires_in: 3600,
        ...(scope === null ? {} : { scope }),
      },
    };
  };
  const tokenAnswer =
    options.token ??
    ((form: URLSearchParams) =>
      form.get("grant_type") === "authorization_code" ||
      form.get("grant_type") === "refresh_token"
        ? issue("read:issues")
        : { status: 400, json: { error: "unsupported_grant_type" } });

  const mcp = (request: OutboundRequest): Answer => {
    const bearer = request.headers?.Authorization?.replace(/^Bearer /, "");
    const open = options.anonymous === true && bearer === undefined;
    if (
      !open &&
      (options.anonymous === true ||
        bearer === undefined ||
        !accepted.has(bearer))
    ) {
      return {
        status: 401,
        text: "",
        headers: oauth
          ? {
              "WWW-Authenticate": `Bearer resource_metadata="${RESOURCE_METADATA}", scope="read:issues"`,
            }
          : {},
      };
    }
    const message = JSON.parse(request.body ?? "{}") as {
      id?: number;
      method: string;
      params?: { cursor?: string };
    };
    const reply = (
      result: unknown,
      headers: Record<string, string> = {},
    ): Answer => {
      const payload = { jsonrpc: "2.0", id: message.id, result };
      return options.sse
        ? {
            status: 200,
            text: `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
            headers: { "Content-Type": "text/event-stream", ...headers },
          }
        : { status: 200, json: payload, headers };
    };
    if (message.method === "initialize") {
      return reply(
        {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake" },
        },
        { "Mcp-Session-Id": "fake-session" },
      );
    }
    if (message.method === "notifications/initialized")
      return { status: 202, text: "" };
    if (message.method === "tools/list") {
      const pages = options.toolPages ?? [
        [{ name: "search_issues", description: "Find issues" }],
      ];
      const at = Number(message.params?.cursor ?? "0");
      return reply({
        tools: pages[at] ?? [],
        ...(at + 1 < pages.length ? { nextCursor: String(at + 1) } : {}),
      });
    }
    return {
      status: 400,
      json: { jsonrpc: "2.0", id: message.id, error: { code: -32601 } },
    };
  };

  const routes: Record<string, (request: OutboundRequest) => Answer> = {
    [`POST ${FAKE_MCP_URL}`]: mcp,
    [`GET ${RESOURCE_METADATA}`]: () =>
      oauth
        ? {
            status: 200,
            json: {
              resource: FAKE_MCP_URL,
              authorization_servers: [FAKE_ISSUER],
              scopes_supported: ["read:issues", "write:issues"],
              ...options.resource,
            },
          }
        : { status: 404, text: "" },
    [`GET ${FAKE_ISSUER}/.well-known/oauth-authorization-server`]: () => ({
      status: 200,
      json: {
        issuer: FAKE_ISSUER,
        authorization_endpoint: `${FAKE_ISSUER}/authorize`,
        token_endpoint: `${FAKE_ISSUER}/token`,
        registration_endpoint: `${FAKE_ISSUER}/register`,
        revocation_endpoint: `${FAKE_ISSUER}/revoke`,
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        ...options.metadata,
      },
    }),
    [`POST ${FAKE_ISSUER}/register`]:
      options.registration ??
      (() => ({ status: 201, json: { client_id: "fake-dcr-client" } })),
    [`POST ${FAKE_ISSUER}/token`]: (request) =>
      tokenAnswer(new URLSearchParams(request.body ?? "")),
    [`POST ${FAKE_ISSUER}/revoke`]: (request) => {
      const token = new URLSearchParams(request.body ?? "").get("token");
      if (token !== null) {
        revoked.push(token);
        accepted.delete(token);
      }
      return { status: 200, text: "" };
    },
  };

  const http: OutboundHttp = async (request) => {
    requests.push(request);
    const route = routes[`${request.method} ${request.url}`];
    return answer(route ? route(request) : { status: 404, text: "" });
  };
  return {
    http,
    allowsUrl: (url: string) => url.startsWith("https://"),
    requests,
    revoked,
    accepted,
  };
}

type Stored = {
  record: WorkspaceMcpServerRecord;
  access: string | null;
  refresh: string | null;
  bearer: string | null;
  clientSecret: string | null;
  flow: WorkspaceMcpFlow | null;
};

const NO_CONNECTION: WorkspaceMcpServerRecord["connection"] = {
  state: "none",
  reauthReason: null,
  generation: 0,
  connectedBy: null,
  connectedAt: null,
  accessExpiresAt: null,
  grantedScope: null,
  refreshFailedAt: null,
};

/**
 * A WorkspaceMcpStore in memory. It does not re-read roles: a user in
 * `inactive` stands for one whose role was taken away under the lock.
 */
export function memoryWorkspaceMcpStore(
  people: Record<string, string> = {},
  now: () => Date = () => new Date(),
) {
  const rows = new Map<string, Stored>();
  const inactive = new Set<string>();
  const personOf = (userId: string): WorkspaceMcpPerson => ({
    userId,
    displayName: people[userId] ?? userId,
  });
  const copy = (stored: Stored): WorkspaceMcpServerRecord => ({
    ...stored.record,
    bearerLast4: stored.bearer?.slice(-4) ?? null,
    hasClientSecret: stored.clientSecret !== null,
  });
  const held = (workspaceId: string, serverId: string) => {
    const stored = rows.get(serverId);
    return stored?.record.workspaceId === workspaceId ? stored : null;
  };
  const revocationOf = (stored: Stored): WorkspaceMcpRevocation | null => {
    const oauth = stored.record.oauth;
    if (oauth === null || oauth.revocationEndpoint === null) return null;
    const token = stored.refresh ?? stored.access;
    if (token === null) return null;
    return {
      oauth,
      token,
      hint: stored.refresh !== null ? "refresh_token" : "access_token",
      clientSecret: stored.clientSecret,
    };
  };
  const dropConnection = (stored: Stored, dropBearer: boolean) => {
    stored.access = null;
    stored.refresh = null;
    if (dropBearer) stored.bearer = null;
    stored.record.connection = {
      ...NO_CONNECTION,
      generation: stored.record.connection.generation + 1,
    };
  };

  const store: WorkspaceMcpStore = {
    async list(workspaceId) {
      return [...rows.values()]
        .filter((stored) => stored.record.workspaceId === workspaceId)
        .map(copy);
    },
    async get(workspaceId, serverId) {
      const stored = held(workspaceId, serverId);
      return stored ? copy(stored) : null;
    },
    async create(input) {
      if (inactive.has(input.actorUserId)) return { outcome: "actor_inactive" };
      const mine = [...rows.values()].filter(
        (s) => s.record.workspaceId === input.workspaceId,
      );
      if (mine.some((s) => s.record.name === input.name))
        return { outcome: "name_taken" };
      if (mine.length >= input.max) return { outcome: "quota_exceeded" };
      const bearer = input.bearerToken;
      const stored: Stored = {
        record: {
          id: input.id,
          workspaceId: input.workspaceId,
          name: input.name,
          url: input.url,
          authKind: input.authKind,
          oauth: input.oauth,
          tools: [],
          toolsSkipped: 0,
          toolsReadAt: null,
          createdBy: personOf(input.actorUserId),
          createdAt: new Date("2026-11-15T00:00:00.000Z"),
          connection:
            bearer === null && input.authKind !== "none"
              ? { ...NO_CONNECTION }
              : {
                  ...NO_CONNECTION,
                  state: "active",
                  generation: 1,
                  connectedBy:
                    bearer === null ? null : personOf(input.actorUserId),
                  connectedAt: new Date("2026-11-15T00:00:00.000Z"),
                },
          bearerLast4: null,
          hasClientSecret: false,
        },
        access: null,
        refresh: null,
        bearer,
        clientSecret: null,
        flow: null,
      };
      rows.set(input.id, stored);
      return { outcome: "created", record: copy(stored) };
    },
    async delete(input) {
      if (inactive.has(input.actorUserId)) return { outcome: "actor_inactive" };
      const stored = held(input.workspaceId, input.serverId);
      if (!stored) return { outcome: "not_found" };
      rows.delete(input.serverId);
      return { outcome: "deleted", revocation: revocationOf(stored) };
    },
    async setBearerToken(input) {
      if (inactive.has(input.actorUserId)) return { outcome: "actor_inactive" };
      const stored = held(input.workspaceId, input.serverId);
      if (!stored) return { outcome: "not_found" };
      if (stored.record.authKind === "none")
        return { outcome: "no_credential" };
      if (stored.record.authKind !== "bearer") return { outcome: "not_bearer" };
      stored.bearer = input.token;
      stored.record.connection = {
        ...NO_CONNECTION,
        state: "active",
        generation: stored.record.connection.generation + 1,
        connectedBy: personOf(input.actorUserId),
        connectedAt: now(),
      };
      return { outcome: "saved", record: copy(stored) };
    },
    async setOAuthClient(input) {
      if (inactive.has(input.actorUserId)) return { outcome: "actor_inactive" };
      const stored = held(input.workspaceId, input.serverId);
      if (!stored) return { outcome: "not_found" };
      const oauth = stored.record.oauth;
      if (oauth === null) return { outcome: "not_oauth" };
      stored.record.oauth = { ...oauth, client: input.client };
      stored.clientSecret = input.clientSecret;
      stored.flow = null;
      dropConnection(stored, false);
      return { outcome: "saved", record: copy(stored) };
    },
    async beginFlow(input) {
      if (inactive.has(input.actorUserId)) return { outcome: "actor_inactive" };
      const stored = held(input.workspaceId, input.serverId);
      const oauth = stored?.record.oauth;
      if (!stored || !oauth) return { outcome: "not_found" };
      if ((oauth.client?.clientId ?? null) !== input.expectedClientId) {
        return { outcome: "client_changed" };
      }
      if (input.registered !== null) {
        stored.record.oauth = { ...oauth, client: input.registered.client };
        stored.clientSecret = input.registered.clientSecret;
      }
      const pinned = stored.record.oauth;
      if (pinned === null) return { outcome: "not_found" };
      stored.flow = {
        flowId: input.flowId,
        stateSha256: Buffer.from(input.stateSha256),
        startedByUserId: input.actorUserId,
        expiresAt: input.expiresAt,
        verifier: input.verifier,
        oauth: pinned,
        clientSecret: stored.clientSecret,
      };
      return { outcome: "started" };
    },
    async readFlow(workspaceId, serverId) {
      return held(workspaceId, serverId)?.flow ?? null;
    },
    async completeFlow(input) {
      if (inactive.has(input.actorUserId)) return { outcome: "actor_inactive" };
      const stored = held(input.workspaceId, input.serverId);
      const flow = stored?.flow;
      if (
        !stored ||
        !flow ||
        flow.flowId !== input.flowId ||
        flow.expiresAt <= input.now ||
        flow.startedByUserId !== input.actorUserId
      ) {
        return { outcome: "flow_gone" };
      }
      stored.flow = null;
      stored.access = input.tokens.accessToken;
      stored.refresh = input.tokens.refreshToken;
      stored.record.connection = {
        ...NO_CONNECTION,
        state: "active",
        generation: stored.record.connection.generation + 1,
        connectedBy: personOf(input.actorUserId),
        connectedAt: input.now,
        accessExpiresAt: input.tokens.expiresAt,
        grantedScope: input.tokens.scope,
      };
      return { outcome: "connected", record: copy(stored) };
    },
    async disconnect(input) {
      if (inactive.has(input.actorUserId)) return { outcome: "actor_inactive" };
      const stored = held(input.workspaceId, input.serverId);
      if (!stored) return { outcome: "not_found" };
      if (stored.record.authKind === "none")
        return { outcome: "no_credential" };
      const revocation = revocationOf(stored);
      dropConnection(stored, true);
      return { outcome: "disconnected", record: copy(stored), revocation };
    },
    async credentialOf(
      workspaceId,
      serverId,
    ): Promise<WorkspaceMcpCredential | null> {
      const stored = held(workspaceId, serverId);
      if (!stored || stored.record.connection.state !== "active") return null;
      if (stored.record.authKind === "none") return { kind: "none" };
      if (
        stored.record.authKind !== "bearer" &&
        stored.record.authKind !== "oauth"
      ) {
        return null;
      }
      if (stored.record.authKind === "bearer") {
        return stored.bearer === null
          ? null
          : { kind: "bearer", token: stored.bearer };
      }
      if (stored.access === null) return null;
      return {
        kind: "oauth",
        accessToken: stored.access,
        expiresAt: stored.record.connection.accessExpiresAt,
        hasRefreshToken: stored.refresh !== null,
      };
    },
    async refresh(workspaceId, serverId, decide) {
      const stored = held(workspaceId, serverId);
      const oauth = stored?.record.oauth;
      if (!stored || !oauth || stored.record.connection.state !== "active")
        return null;
      const decision = await decide({
        server: copy(stored),
        oauth,
        refreshToken: stored.refresh,
        accessToken: stored.access,
        clientSecret: stored.clientSecret,
      });
      const connection = stored.record.connection;
      switch (decision.kind) {
        case "keep":
          break;
        case "backoff":
          stored.record.connection = { ...connection, refreshFailedAt: now() };
          break;
        case "store":
          stored.access = decision.tokens.accessToken;
          stored.refresh = decision.tokens.refreshToken ?? stored.refresh;
          stored.record.connection = {
            ...connection,
            accessExpiresAt: decision.tokens.expiresAt,
            grantedScope: decision.grantedScope,
            refreshFailedAt: null,
          };
          break;
        case "reauth":
          stored.access = null;
          stored.refresh = null;
          if (decision.dropClient) {
            stored.record.oauth = { ...oauth, client: null };
            stored.clientSecret = null;
          }
          stored.record.connection = {
            ...connection,
            state: "needs_reauth",
            reauthReason: decision.reason,
          };
          break;
      }
      return copy(stored);
    },
    async saveTools(input) {
      if (inactive.has(input.actorUserId)) return { outcome: "actor_inactive" };
      const stored = held(input.workspaceId, input.serverId);
      if (!stored) return { outcome: "not_found" };
      const { connection } = stored.record;
      if (
        connection.generation !== input.generation ||
        connection.state !== "active"
      ) {
        return { outcome: "stale" };
      }
      stored.record.tools = input.tools;
      stored.record.toolsSkipped = input.skipped;
      stored.record.toolsReadAt = input.readAt;
      return { outcome: "saved", record: copy(stored) };
    },
  };

  return {
    store,
    inactive,
    /** What the store holds for a server, credentials included, for assertions. */
    stored: (serverId: string) => rows.get(serverId),
  };
}
