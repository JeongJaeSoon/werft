import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  type CompleteWorkspaceMcpOAuthRequest,
  type CreateWorkspaceMcpServerRequest,
  type DeleteWorkspaceMcpServerResponse,
  type DisconnectWorkspaceMcpServerResponse,
  type DiscoverWorkspaceMcpServerResponse,
  type PutWorkspaceMcpBearerTokenRequest,
  type PutWorkspaceMcpOAuthClientRequest,
  type StartWorkspaceMcpOAuthResponse,
  WORKSPACE_MCP_OAUTH_FLOW_TTL_SECONDS,
  WORKSPACE_MCP_RESERVED_NAMES,
  WORKSPACE_MCP_SERVERS_MAX,
  type WorkspaceMcpServer,
  type WorkspaceMcpServerList,
} from "@werft-ai/contracts";
import {
  ACTOR_INACTIVE,
  type AuthorizationPolicy,
  type Caller,
  NOT_FOUND,
  requirePermitted,
  SECRET_STORE_OFF,
  SessionServiceError,
} from "../musterrolle/index.ts";
import { hashToken } from "../token-hash.ts";
import type {
  ManagerCheck,
  WorkspaceMcpCredential,
  WorkspaceMcpOAuthPin,
  WorkspaceMcpRefreshDecision,
  WorkspaceMcpRefreshInput,
  WorkspaceMcpRevocation,
  WorkspaceMcpServerRecord,
  WorkspaceMcpStore,
} from "./ports/workspace-mcp-store.ts";
import {
  authorizationUrl,
  discover,
  exchangeCode,
  listTools,
  manualAuthMethod,
  pkcePair,
  refreshTokens,
  registerClient,
  revokeToken,
  scopeWidens,
  type WorkspaceMcpRemoteDeps,
  WorkspaceMcpRemoteError,
} from "./remote.ts";

// Workspace MCP servers: owners and admins
// register, connect and disconnect them from a console session; any member
// reads them. No message or detail below carries a credential or an
// upstream body.

/** Refresh when the access token has less than this left (decision 3). */
const REFRESH_AHEAD_MS = 60_000;
/** A failed refresh is not tried again for this long (decision 3). */
const REFRESH_BACKOFF_MS = 30_000;

export type WorkspaceMcpServiceDeps = {
  authorization: AuthorizationPolicy;
  store: WorkspaceMcpStore;
  /** False when the API runs without PLATFORM_SECRET_KEY: nothing can be connected. */
  secretStoreOn: boolean;
  remote: WorkspaceMcpRemoteDeps;
  /**
   * Why a server URL may not be registered before anything is resolved
   * (https unless the host is on the operator's private list, an https host
   * named rather than an address), or null when it may.
   */
  serverUrlProblem: (url: string) => string | null;
  /**
   * Resolves the server's name and judges every address: public, or private
   * for a host on the operator's private list. A bearer server is checked
   * with it before it is stored; discovery checks an OAuth one on its own.
   */
  serverAddressProblem: (
    url: string,
  ) => Promise<"address_not_allowed" | "unreachable" | null>;
  /** The console callback for a server; null when the console origin is unset. */
  redirectUriFor: (serverId: string) => string | null;
  now?: () => Date;
  newId?: () => string;
};

const refused = (reasonCode: string, message: string) =>
  new SessionServiceError("BAD_REQUEST", message, undefined, {
    reason_code: reasonCode,
  });

/** A refusal from the remote server, by what the admin can do about it. */
function remoteRefusal(error: WorkspaceMcpRemoteError): SessionServiceError {
  if (error.reason === "unreachable" || error.reason === "mcp_failed") {
    return new SessionServiceError(
      "BACKEND_UNAVAILABLE",
      error.message,
      undefined,
      {
        reason_code: `mcp_${error.reason === "unreachable" ? "unreachable" : "failed"}`,
      },
    );
  }
  return new SessionServiceError("BAD_REQUEST", error.message, undefined, {
    reason_code: error.reason,
    ...(error.oauthError === null ? {} : { oauth_error: error.oauthError }),
  });
}

/** Asked of a server that takes no credential: a token, OAuth, a disconnect. */
const NO_CREDENTIAL = () =>
  refused(
    "no_credential",
    "This server takes no credential: there is nothing to set or take out",
  );

/** What a call goes with; null for a server that takes no credential. */
const tokenOf = (credential: WorkspaceMcpCredential): string | null =>
  credential.kind === "none"
    ? null
    : credential.kind === "bearer"
      ? credential.token
      : credential.accessToken;

const notDone = (outcome: "not_found" | "actor_inactive") =>
  outcome === "not_found" ? NOT_FOUND() : ACTOR_INACTIVE();

const CONNECTION_CHANGED = () =>
  refused(
    "connection_changed",
    "The server's connection changed while this was under way; try again",
  );

async function remoteCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof WorkspaceMcpRemoteError) throw remoteRefusal(error);
    throw error;
  }
}

const person = (value: { userId: string; displayName: string } | null) =>
  value === null
    ? null
    : { user_id: value.userId, display_name: value.displayName };

export function workspaceMcpServerViewOf(
  record: WorkspaceMcpServerRecord,
  redirectUri: string | null,
): WorkspaceMcpServer {
  const { oauth, connection } = record;
  return {
    id: record.id,
    name: record.name,
    url: record.url,
    auth_kind: record.authKind,
    redirect_uri: record.authKind === "oauth" ? redirectUri : null,
    oauth:
      oauth === null
        ? null
        : {
            issuer: oauth.issuer,
            scope: oauth.scope,
            client_registration: oauth.client?.registration ?? null,
            client_id: oauth.client?.clientId ?? null,
            has_client_secret: record.hasClientSecret,
            dcr_supported: oauth.registrationEndpoint !== null,
          },
    bearer: record.authKind === "bearer" ? { last4: record.bearerLast4 } : null,
    connection: {
      state: connection.state,
      reauth_reason: connection.reauthReason,
      connected_by: person(connection.connectedBy),
      connected_at: connection.connectedAt?.toISOString() ?? null,
      granted_scope: connection.grantedScope,
      access_expires_at: connection.accessExpiresAt?.toISOString() ?? null,
    },
    tools: record.tools,
    tools_skipped: record.toolsSkipped,
    tools_read_at: record.toolsReadAt?.toISOString() ?? null,
    created_by: person(record.createdBy),
    created_at: record.createdAt.toISOString(),
  };
}

export function createWorkspaceMcpService(deps: WorkspaceMcpServiceDeps) {
  const { authorization, store, remote } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  const view = (record: WorkspaceMcpServerRecord) =>
    workspaceMcpServerViewOf(record, deps.redirectUriFor(record.id));

  async function manager(caller: Caller): Promise<ManagerCheck> {
    await requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: caller.ownerId,
    });
    const userId = caller.actor?.userId;
    if (
      caller.subject.surface.kind !== "web" ||
      caller.subject.principal?.kind !== "user" ||
      !userId
    ) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Workspace MCP servers are changed from a signed-in console session, not with an API key",
        undefined,
        { reason_code: "web_session_required" },
      );
    }
    if (!deps.secretStoreOn) throw SECRET_STORE_OFF();
    return { principal: caller, actorUserId: userId };
  }

  async function existing(caller: Caller, serverId: string) {
    const record = await store.get(caller.ownerId, serverId);
    if (record === null) throw NOT_FOUND();
    return record;
  }

  function checkUrl(url: string): void {
    if (!URL.canParse(url))
      throw refused("url_invalid", "The URL is not a URL");
    const parsed = new URL(url);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== "" ||
      url.includes("#")
    ) {
      throw refused(
        "url_invalid",
        "The URL may hold no user name, password or fragment",
      );
    }
    const problem = deps.serverUrlProblem(url);
    if (problem !== null) {
      throw refused(
        problem,
        problem === "url_insecure"
          ? "The URL must be https"
          : "The URL must name its host, not an address",
      );
    }
  }

  async function checkAddress(url: string): Promise<void> {
    const problem = await deps.serverAddressProblem(url);
    if (problem === "unreachable") {
      throw new SessionServiceError(
        "BACKEND_UNAVAILABLE",
        "The server's name did not resolve",
        undefined,
        { reason_code: "mcp_unreachable" },
      );
    }
    if (problem !== null) {
      throw refused(
        "address_not_allowed",
        "The server resolves to an address this server may not call",
      );
    }
  }

  function oauthOf(record: WorkspaceMcpServerRecord): WorkspaceMcpOAuthPin {
    if (record.authKind === "none") throw NO_CREDENTIAL();
    if (record.oauth === null) {
      throw refused("not_oauth", "This server takes a static token, not OAuth");
    }
    return record.oauth;
  }

  function redirectUri(serverId: string): string {
    const uri = deps.redirectUriFor(serverId);
    if (uri === null) {
      throw new SessionServiceError(
        "BACKEND_UNAVAILABLE",
        "CONSOLE_ORIGIN is not set, so no OAuth callback can be named",
        undefined,
        { reason_code: "console_origin_unset" },
      );
    }
    return uri;
  }

  /** Best effort, after the commit that took the token out. */
  async function revoke(
    revocation: WorkspaceMcpRevocation | null,
  ): Promise<boolean | null> {
    if (revocation === null || revocation.oauth.revocationEndpoint === null)
      return null;
    const client = revocation.oauth.client;
    if (client === null) return null;
    return revokeToken(remote, {
      pin: revocation.oauth,
      client,
      clientSecret: revocation.clientSecret,
      token: revocation.token,
      hint: revocation.hint,
    });
  }

  function decideRefresh(at: Date) {
    return async (
      input: WorkspaceMcpRefreshInput,
    ): Promise<WorkspaceMcpRefreshDecision> => {
      const { connection } = input.server;
      const expiresAt = connection.accessExpiresAt;
      if (
        expiresAt === null ||
        expiresAt.getTime() - at.getTime() > REFRESH_AHEAD_MS
      ) {
        return { kind: "keep" };
      }
      if (input.refreshToken === null || input.oauth.client === null) {
        return expiresAt.getTime() <= at.getTime()
          ? { kind: "reauth", reason: "expired", dropClient: false }
          : { kind: "keep" };
      }
      const failedAt = connection.refreshFailedAt;
      // Waiting out an earlier failure writes nothing, so the retry stays
      // due 30 s after that failure however often the route asks.
      if (
        failedAt !== null &&
        at.getTime() - failedAt.getTime() < REFRESH_BACKOFF_MS
      ) {
        return { kind: "keep" };
      }
      try {
        const tokens = await refreshTokens(remote, {
          pin: input.oauth,
          client: input.oauth.client,
          clientSecret: input.clientSecret,
          refreshToken: input.refreshToken,
          now: at,
        });
        if (
          tokens.scope !== null &&
          scopeWidens(tokens.scope, connection.grantedScope)
        ) {
          return { kind: "reauth", reason: "scope_widened", dropClient: false };
        }
        return {
          kind: "store",
          tokens,
          grantedScope: tokens.scope ?? connection.grantedScope,
        };
      } catch (error) {
        if (!(error instanceof WorkspaceMcpRemoteError)) throw error;
        if (error.oauthError === "invalid_grant") {
          return { kind: "reauth", reason: "invalid_grant", dropClient: false };
        }
        if (error.oauthError === "invalid_client") {
          return {
            kind: "reauth",
            reason: "invalid_client",
            dropClient: input.oauth.client.registration === "dcr",
          };
        }
        return { kind: "backoff" };
      }
    };
  }

  /**
   * The credential to send a server's calls with, refreshed first when the
   * access token is about to expire. Null when there is none to use.
   */
  async function credentialFor(
    workspaceId: string,
    serverId: string,
  ): Promise<WorkspaceMcpCredential | null> {
    const credential = await store.credentialOf(workspaceId, serverId);
    if (credential?.kind !== "oauth") return credential;
    const at = now();
    if (
      credential.expiresAt === null ||
      credential.expiresAt.getTime() - at.getTime() > REFRESH_AHEAD_MS
    ) {
      return credential;
    }
    await store.refresh(workspaceId, serverId, decideRefresh(at));
    const fresh = await store.credentialOf(workspaceId, serverId);
    if (
      fresh?.kind === "oauth" &&
      fresh.expiresAt !== null &&
      fresh.expiresAt <= at
    ) {
      return null;
    }
    return fresh;
  }

  /**
   * Reads the tool list with the stored credential; a failure, or a
   * connection that changed meanwhile, leaves the list as it was.
   */
  async function readTools(
    record: WorkspaceMcpServerRecord,
    check: ManagerCheck,
  ): Promise<WorkspaceMcpServerRecord> {
    const credential = await credentialFor(record.workspaceId, record.id);
    if (credential === null) return record;
    const token = tokenOf(credential);
    try {
      const { tools, skipped } = await listTools(remote, {
        url: record.url,
        serverName: record.name,
        token,
      });
      const saved = await store.saveTools({
        ...check,
        workspaceId: record.workspaceId,
        serverId: record.id,
        generation: record.connection.generation,
        tools,
        skipped,
        readAt: now(),
      });
      return saved.outcome === "saved" ? saved.record : record;
    } catch (error) {
      if (error instanceof WorkspaceMcpRemoteError) return record;
      throw error;
    }
  }

  return {
    credentialFor,

    async list(caller: Caller): Promise<WorkspaceMcpServerList> {
      await requirePermitted(authorization, caller, "workspace.read", {
        kind: "workspace",
        id: caller.ownerId,
      });
      const records = await store.list(caller.ownerId);
      return { items: records.map(view), limit: WORKSPACE_MCP_SERVERS_MAX };
    },

    async discover(
      caller: Caller,
      url: string,
    ): Promise<DiscoverWorkspaceMcpServerResponse> {
      await manager(caller);
      checkUrl(url);
      const found = await remoteCall(() => discover(remote, url));
      return {
        url: found.url,
        oauth:
          found.oauth === null
            ? null
            : {
                issuer: found.oauth.pin.issuer,
                scopes_supported: found.oauth.scopesSupported,
                default_scope: found.oauth.defaultScope,
                dcr_supported: found.oauth.pin.registrationEndpoint !== null,
              },
      };
    },

    async create(
      caller: Caller,
      body: CreateWorkspaceMcpServerRequest,
    ): Promise<WorkspaceMcpServer> {
      const check = await manager(caller);
      if (
        (WORKSPACE_MCP_RESERVED_NAMES as readonly string[]).includes(body.name)
      ) {
        throw refused(
          "name_reserved",
          "The platform uses that server name itself",
        );
      }
      checkUrl(body.url);
      // Nothing calls a bearer or credential-free server before it is
      // stored; an OAuth one's discovery below resolves and judges it on its
      // own.
      if (body.auth_kind !== "oauth") await checkAddress(body.url);
      let oauth: WorkspaceMcpOAuthPin | null = null;
      if (body.auth_kind === "oauth") {
        const found = await remoteCall(() => discover(remote, body.url));
        if (found.oauth === null) {
          throw refused(
            "oauth_unavailable",
            "The server publishes no OAuth metadata; register it with a token",
          );
        }
        const pin = found.oauth.pin;
        if (body.scope !== undefined && scopeWidens(body.scope, pin.scope)) {
          throw refused(
            "scope_widened",
            "The scope asks for more than the server offers",
          );
        }
        oauth = { ...pin, scope: body.scope ?? pin.scope };
      }
      const result = await store.create({
        ...check,
        workspaceId: caller.ownerId,
        id: newId(),
        name: body.name,
        url: body.url,
        authKind: body.auth_kind,
        oauth,
        bearerToken: body.auth_kind === "bearer" ? body.token : null,
        max: WORKSPACE_MCP_SERVERS_MAX,
      });
      switch (result.outcome) {
        case "created":
          return view(
            body.auth_kind !== "oauth"
              ? await readTools(result.record, check)
              : result.record,
          );
        case "name_taken":
          throw new SessionServiceError(
            "ALREADY_EXISTS",
            "Another MCP server already has that name",
            undefined,
            { reason_code: "name_taken" },
          );
        case "quota_exceeded":
          throw new SessionServiceError(
            "MCP_SERVER_QUOTA_EXCEEDED",
            `The workspace holds its limit of ${WORKSPACE_MCP_SERVERS_MAX} MCP servers`,
          );
        default:
          throw ACTOR_INACTIVE();
      }
    },

    async delete(
      caller: Caller,
      serverId: string,
    ): Promise<DeleteWorkspaceMcpServerResponse> {
      const check = await manager(caller);
      const result = await store.delete({
        ...check,
        workspaceId: caller.ownerId,
        serverId,
      });
      if (result.outcome !== "deleted") throw notDone(result.outcome);
      await revoke(result.revocation);
      return { id: serverId };
    },

    async putBearerToken(
      caller: Caller,
      serverId: string,
      body: PutWorkspaceMcpBearerTokenRequest,
    ): Promise<WorkspaceMcpServer> {
      const check = await manager(caller);
      const result = await store.setBearerToken({
        ...check,
        workspaceId: caller.ownerId,
        serverId,
        token: body.token,
      });
      if (result.outcome === "no_credential") throw NO_CREDENTIAL();
      if (result.outcome === "not_bearer") {
        throw refused(
          "not_bearer",
          "This server signs in with OAuth, not a static token",
        );
      }
      if (result.outcome !== "saved") throw notDone(result.outcome);
      return view(await readTools(result.record, check));
    },

    async putOAuthClient(
      caller: Caller,
      serverId: string,
      body: PutWorkspaceMcpOAuthClientRequest,
    ): Promise<WorkspaceMcpServer> {
      const check = await manager(caller);
      const pin = oauthOf(await existing(caller, serverId));
      const clientSecret = body.client_secret ?? null;
      const result = await store.setOAuthClient({
        ...check,
        workspaceId: caller.ownerId,
        serverId,
        client: {
          registration: "manual",
          clientId: body.client_id,
          authMethod: manualAuthMethod(pin, clientSecret !== null),
        },
        clientSecret,
      });
      if (result.outcome === "not_oauth") {
        throw refused(
          "not_oauth",
          "This server takes a static token, not OAuth",
        );
      }
      if (result.outcome !== "saved") throw notDone(result.outcome);
      return view(result.record);
    },

    async startOAuth(
      caller: Caller,
      serverId: string,
    ): Promise<StartWorkspaceMcpOAuthResponse> {
      const check = await manager(caller);
      const pin = oauthOf(await existing(caller, serverId));
      const callback = redirectUri(serverId);
      let client = pin.client;
      let registered: {
        client: NonNullable<typeof client>;
        clientSecret: string | null;
      } | null = null;
      if (client === null) {
        if (pin.registrationEndpoint === null) {
          throw refused(
            "client_registration_required",
            "This server needs a client registered by hand; enter its client id first",
          );
        }
        registered = await remoteCall(() =>
          registerClient(remote, pin, callback),
        );
        client = registered.client;
      }
      const state = randomBytes(32).toString("base64url");
      const { verifier, challenge } = pkcePair();
      const expiresAt = new Date(
        now().getTime() + WORKSPACE_MCP_OAUTH_FLOW_TTL_SECONDS * 1000,
      );
      const result = await store.beginFlow({
        ...check,
        workspaceId: caller.ownerId,
        serverId,
        flowId: newId(),
        stateSha256: hashToken(state),
        expiresAt,
        verifier,
        expectedClientId: pin.client?.clientId ?? null,
        registered,
      });
      if (result.outcome === "client_changed") throw CONNECTION_CHANGED();
      if (result.outcome !== "started") throw notDone(result.outcome);
      return {
        authorization_url: authorizationUrl({
          pin,
          client,
          redirectUri: callback,
          state,
          challenge,
        }),
        expires_at: expiresAt.toISOString(),
      };
    },

    async completeOAuth(
      caller: Caller,
      serverId: string,
      body: CompleteWorkspaceMcpOAuthRequest,
    ): Promise<WorkspaceMcpServer> {
      const check = await manager(caller);
      const flowGone = () =>
        refused(
          "oauth_state_invalid",
          "This sign-in is not the one in progress; start it again",
        );
      const flow = await store.readFlow(caller.ownerId, serverId);
      if (flow === null) throw flowGone();
      const sent = hashToken(body.state);
      if (
        sent.length !== flow.stateSha256.length ||
        !timingSafeEqual(sent, flow.stateSha256)
      ) {
        throw flowGone();
      }
      const at = now();
      if (flow.expiresAt <= at) {
        throw refused(
          "oauth_flow_expired",
          "The sign-in took too long; start it again",
        );
      }
      if (flow.startedByUserId !== check.actorUserId) {
        throw new SessionServiceError(
          "FORBIDDEN",
          "Another person started this sign-in",
          undefined,
          { reason_code: "oauth_flow_other_user" },
        );
      }
      const { oauth } = flow;
      if (
        body.iss !== undefined
          ? body.iss !== oauth.issuer
          : oauth.issParameterSupported
      ) {
        throw refused(
          "issuer_mismatch",
          "The sign-in came back from another authorization server",
        );
      }
      const client = oauth.client;
      if (client === null) throw flowGone();
      const tokens = await remoteCall(() =>
        exchangeCode(remote, {
          pin: oauth,
          client,
          clientSecret: flow.clientSecret,
          code: body.code,
          verifier: flow.verifier,
          redirectUri: redirectUri(serverId),
          now: at,
        }),
      );
      const revokeReceived = () =>
        revokeToken(remote, {
          pin: oauth,
          client,
          clientSecret: flow.clientSecret,
          token: tokens.refreshToken ?? tokens.accessToken,
          hint: tokens.refreshToken === null ? "access_token" : "refresh_token",
        });
      if (tokens.scope !== null && scopeWidens(tokens.scope, oauth.scope)) {
        await revokeReceived();
        throw refused(
          "scope_widened",
          "The server granted more than was asked for",
        );
      }
      const result = await store.completeFlow({
        ...check,
        workspaceId: caller.ownerId,
        serverId,
        flowId: flow.flowId,
        tokens: { ...tokens, scope: tokens.scope ?? oauth.scope },
        // After the exchange: one that ran past the expiry does not count.
        now: now(),
      });
      if (result.outcome !== "connected") {
        await revokeReceived();
        if (result.outcome === "actor_inactive") throw ACTOR_INACTIVE();
        throw flowGone();
      }
      return view(await readTools(result.record, check));
    },

    async disconnect(
      caller: Caller,
      serverId: string,
    ): Promise<DisconnectWorkspaceMcpServerResponse> {
      const check = await manager(caller);
      const result = await store.disconnect({
        ...check,
        workspaceId: caller.ownerId,
        serverId,
      });
      if (result.outcome === "no_credential") throw NO_CREDENTIAL();
      if (result.outcome !== "disconnected") throw notDone(result.outcome);
      return {
        server: view(result.record),
        revoked: await revoke(result.revocation),
      };
    },

    async refreshTools(
      caller: Caller,
      serverId: string,
    ): Promise<WorkspaceMcpServer> {
      const check = await manager(caller);
      const record = await existing(caller, serverId);
      const credential = await credentialFor(record.workspaceId, record.id);
      if (credential === null) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          "The server is not connected",
          undefined,
          { reason_code: "not_connected" },
        );
      }
      const token = tokenOf(credential);
      const { tools, skipped } = await remoteCall(() =>
        listTools(remote, { url: record.url, serverName: record.name, token }),
      );
      const saved = await store.saveTools({
        ...check,
        workspaceId: record.workspaceId,
        serverId: record.id,
        generation: record.connection.generation,
        tools,
        skipped,
        readAt: now(),
      });
      if (saved.outcome === "stale") throw CONNECTION_CHANGED();
      if (saved.outcome !== "saved") throw notDone(saved.outcome);
      return view(saved.record);
    },
  };
}

export type WorkspaceMcpService = ReturnType<typeof createWorkspaceMcpService>;
