import type { Principal } from "../musterrolle/policy.ts";

export type WorkspaceMcpAuthKind = "oauth" | "bearer";
export type WorkspaceMcpConnectionState = "none" | "active" | "needs_reauth";
export type WorkspaceMcpReauthReason =
  | "invalid_grant"
  | "invalid_client"
  | "scope_widened"
  | "expired";
export type ClientAuthMethod =
  | "none"
  | "client_secret_post"
  | "client_secret_basic";

export type WorkspaceMcpClient = {
  registration: "dcr" | "manual";
  clientId: string;
  authMethod: ClientAuthMethod;
};

/**
 * What discovery found, pinned at registration (decision 3): the server's
 * metadata is not followed again, so a server that later turns hostile
 * cannot move the token endpoint.
 */
export type WorkspaceMcpOAuthPin = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  registrationEndpoint: string | null;
  resource: string;
  scope: string | null;
  issParameterSupported: boolean;
  tokenEndpointAuthMethods: string[];
  client: WorkspaceMcpClient | null;
};

export type WorkspaceMcpTool = { name: string; description: string | null };

export type WorkspaceMcpPerson = { userId: string; displayName: string };

export type WorkspaceMcpConnectionRecord = {
  state: WorkspaceMcpConnectionState;
  reauthReason: WorkspaceMcpReauthReason | null;
  generation: number;
  connectedBy: WorkspaceMcpPerson | null;
  connectedAt: Date | null;
  accessExpiresAt: Date | null;
  grantedScope: string | null;
  refreshFailedAt: Date | null;
};

export type WorkspaceMcpServerRecord = {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  authKind: WorkspaceMcpAuthKind;
  oauth: WorkspaceMcpOAuthPin | null;
  tools: WorkspaceMcpTool[];
  toolsSkipped: number;
  toolsReadAt: Date | null;
  createdBy: WorkspaceMcpPerson | null;
  createdAt: Date;
  connection: WorkspaceMcpConnectionRecord;
  /** Last four characters of a static token; null when none is stored. */
  bearerLast4: string | null;
  hasClientSecret: boolean;
};

/** Tokens as received, already checked (decision 3). */
export type WorkspaceMcpTokens = {
  accessToken: string;
  /** Null: the server sent none; on a refresh the old one stays. */
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
};

/** What a disconnect or a delete took out, to revoke after commit. */
export type WorkspaceMcpRevocation = {
  oauth: WorkspaceMcpOAuthPin;
  token: string;
  hint: "refresh_token" | "access_token";
  clientSecret: string | null;
};

/** What control-host sends a server's calls with, read under no lock. */
export type WorkspaceMcpCredential =
  | { kind: "bearer"; token: string }
  | {
      kind: "oauth";
      accessToken: string;
      expiresAt: Date | null;
      hasRefreshToken: boolean;
    };

export type WorkspaceMcpFlow = {
  flowId: string;
  stateSha256: Buffer;
  startedByUserId: string;
  expiresAt: Date;
  verifier: string;
  oauth: WorkspaceMcpOAuthPin;
  clientSecret: string | null;
};

/** Under the connection's row lock: the stored refresh material. */
export type WorkspaceMcpRefreshInput = {
  server: WorkspaceMcpServerRecord;
  oauth: WorkspaceMcpOAuthPin;
  refreshToken: string | null;
  accessToken: string | null;
  clientSecret: string | null;
};

/** What a refresh decided, stored in the same transaction. */
export type WorkspaceMcpRefreshDecision =
  | { kind: "keep" }
  | { kind: "store"; tokens: WorkspaceMcpTokens; grantedScope: string | null }
  | { kind: "reauth"; reason: WorkspaceMcpReauthReason; dropClient: boolean }
  | { kind: "backoff" };

export type ManagerCheck = { principal: Principal; actorUserId: string };

export type CreateWorkspaceMcpServerResult =
  | { outcome: "created"; record: WorkspaceMcpServerRecord }
  | { outcome: "name_taken" | "quota_exceeded" | "actor_inactive" };

export interface WorkspaceMcpStore {
  list(workspaceId: string): Promise<WorkspaceMcpServerRecord[]>;
  get(
    workspaceId: string,
    serverId: string,
  ): Promise<WorkspaceMcpServerRecord | null>;
  create(
    input: ManagerCheck & {
      workspaceId: string;
      id: string;
      name: string;
      url: string;
      authKind: WorkspaceMcpAuthKind;
      oauth: WorkspaceMcpOAuthPin | null;
      bearerToken: string | null;
      /** Servers a workspace may hold. */
      max: number;
    },
  ): Promise<CreateWorkspaceMcpServerResult>;
  /** Drops the row, its connection and every secret of it. */
  delete(
    input: ManagerCheck & { workspaceId: string; serverId: string },
  ): Promise<
    | { outcome: "deleted"; revocation: WorkspaceMcpRevocation | null }
    | { outcome: "not_found" | "actor_inactive" }
  >;
  setBearerToken(
    input: ManagerCheck & {
      workspaceId: string;
      serverId: string;
      token: string;
    },
  ): Promise<
    | { outcome: "saved"; record: WorkspaceMcpServerRecord }
    | { outcome: "not_found" | "actor_inactive" | "not_bearer" }
  >;
  /**
   * Replaces the server's client. The person's tokens were issued to the
   * old one, so they go too and the connection needs a new sign-in.
   */
  setOAuthClient(
    input: ManagerCheck & {
      workspaceId: string;
      serverId: string;
      client: WorkspaceMcpClient;
      clientSecret: string | null;
    },
  ): Promise<
    | { outcome: "saved"; record: WorkspaceMcpServerRecord }
    | { outcome: "not_found" | "actor_inactive" | "not_oauth" }
  >;
  /** Writes the pending flow (and a client DCR just registered). */
  beginFlow(
    input: ManagerCheck & {
      workspaceId: string;
      serverId: string;
      flowId: string;
      stateSha256: Buffer;
      expiresAt: Date;
      verifier: string;
      registered: WorkspaceMcpClient | null;
    },
  ): Promise<{ outcome: "started" } | { outcome: "not_found" | "actor_inactive" }>;
  readFlow(workspaceId: string, serverId: string): Promise<WorkspaceMcpFlow | null>;
  /**
   * Stores the tokens only if, under the connection's lock, the flow is
   * still this one and unexpired and its starter still manages the
   * workspace (decision 3).
   */
  completeFlow(
    input: ManagerCheck & {
      workspaceId: string;
      serverId: string;
      flowId: string;
      tokens: WorkspaceMcpTokens;
      now: Date;
    },
  ): Promise<
    | { outcome: "connected"; record: WorkspaceMcpServerRecord }
    | { outcome: "flow_gone" | "actor_inactive" }
  >;
  disconnect(
    input: ManagerCheck & { workspaceId: string; serverId: string },
  ): Promise<
    | {
        outcome: "disconnected";
        record: WorkspaceMcpServerRecord;
        revocation: WorkspaceMcpRevocation | null;
      }
    | { outcome: "not_found" | "actor_inactive" }
  >;
  credentialOf(
    workspaceId: string,
    serverId: string,
  ): Promise<WorkspaceMcpCredential | null>;
  /**
   * Runs `decide` under the connection's row lock, with what is stored now,
   * and stores its decision in the same transaction. Null when the server
   * is gone or not an OAuth connection that is active.
   */
  refresh(
    workspaceId: string,
    serverId: string,
    decide: (
      input: WorkspaceMcpRefreshInput,
    ) => Promise<WorkspaceMcpRefreshDecision>,
  ): Promise<WorkspaceMcpServerRecord | null>;
  saveTools(input: {
    workspaceId: string;
    serverId: string;
    tools: WorkspaceMcpTool[];
    skipped: number;
    readAt: Date;
  }): Promise<WorkspaceMcpServerRecord | null>;
}

/** One request control-host sends a server itself, under the outbound policy. */
export type OutboundRequest = {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};
export type OutboundResponse = {
  status: number;
  headers: Headers;
  text: string;
};
/**
 * Throws WorkspaceMcpOutboundError when the request may not be sent, did
 * not complete, or answered 5xx; any other answer is the caller's to read.
 */
export type OutboundHttp = (request: OutboundRequest) => Promise<OutboundResponse>;

export class WorkspaceMcpOutboundError extends Error {
  constructor(
    readonly reason: "address_not_allowed" | "unreachable" | "answered",
    message: string,
  ) {
    super(message);
  }
}
