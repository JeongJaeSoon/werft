import { z } from "zod";

import {
  AGENT_WORKSPACE_MCP_SERVERS_MAX,
  MCP_RESERVED_SERVER_NAMES,
  mcpServerIdSchema,
  WERFT_MCP_SERVER,
} from "../kollegium/agents.ts";
import { displayNameSchema } from "../musterrolle/workspaces.ts";
import {
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";

// Remote MCP servers a workspace registers and authenticates once; every
// agent that turns one on calls it with that one credential. No value of a credential is ever in a response.

export const WORKSPACE_MCP_SERVERS_MAX = 20;
export const WORKSPACE_MCP_TOOLS_MAX = 200;
export const WORKSPACE_MCP_TOOL_DESCRIPTION_MAX = 1024;
/** An OAuth access token is often a JWT, longer than other stored secrets. */
export const WORKSPACE_MCP_SECRET_MAX_LENGTH = 16 * 1024;
export const WORKSPACE_MCP_URL_MAX = 2048;
export const WORKSPACE_MCP_SCOPE_MAX = 1024;
export const WORKSPACE_MCP_OAUTH_FLOW_TTL_SECONDS = 600;
/**
 * Names a new workspace server may not take. `memory` and the built-in
 * `werft` are refused at registration only, so a server that already holds
 * one keeps its row; a session leaves a workspace server named `werft` out,
 * since that name is the built-in server's there.
 */
export const WORKSPACE_MCP_RESERVED_NAMES = [
  ...MCP_RESERVED_SERVER_NAMES,
  "memory",
  WERFT_MCP_SERVER,
] as const;

export const workspaceMcpServerIdSchema = z.uuid();
export const workspaceMcpAuthKindSchema = z.enum(["oauth", "bearer"]);
/**
 * A server's kind as a response reports it. A later release may store a kind
 * this one does not know: the server still lists, its kind as stored, and
 * this release offers no credential change for it.
 */
export const workspaceMcpServerAuthKindSchema = z.union([
  workspaceMcpAuthKindSchema,
  z.string().min(1),
]);
export const workspaceMcpConnectionStateSchema = z.enum([
  "none",
  "active",
  "needs_reauth",
]);
/** Why a connection needs a new sign-in. */
export const workspaceMcpReauthReasonSchema = z.enum([
  "invalid_grant",
  "invalid_client",
  "scope_widened",
  "expired",
]);

const workspaceMcpSecretSchema = z
  .string()
  .min(8)
  .max(WORKSPACE_MCP_SECRET_MAX_LENGTH)
  .regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces");

const workspaceMcpUrlSchema = z.string().min(1).max(WORKSPACE_MCP_URL_MAX);

const scopeSchema = z
  .string()
  .max(WORKSPACE_MCP_SCOPE_MAX)
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/, {
    message: "must be space-separated scope tokens",
  });

const personSchema = z
  .object({ user_id: userIdSchema, display_name: displayNameSchema })
  .strict();

export const workspaceMcpToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().max(WORKSPACE_MCP_TOOL_DESCRIPTION_MAX).nullable(),
  })
  .strict();

export const workspaceMcpServerSchema = z
  .object({
    id: workspaceMcpServerIdSchema,
    name: mcpServerIdSchema,
    url: z.string(),
    auth_kind: workspaceMcpServerAuthKindSchema,
    /** Where the authorization server sends the browser back; oauth only. */
    redirect_uri: z.string().nullable(),
    oauth: z
      .object({
        issuer: z.string(),
        scope: z.string().nullable(),
        client_registration: z.enum(["dcr", "manual"]).nullable(),
        client_id: z.string().nullable(),
        has_client_secret: z.boolean(),
        /** The authorization server takes dynamic client registration. */
        dcr_supported: z.boolean(),
      })
      .strict()
      .nullable(),
    bearer: z.object({ last4: z.string().nullable() }).strict().nullable(),
    connection: z
      .object({
        state: workspaceMcpConnectionStateSchema,
        reauth_reason: workspaceMcpReauthReasonSchema.nullable(),
        /**
         * The console user who connected it. Agents' calls run as the
         * external account that person signed in with (or the token they
         * put in), and are recorded under it.
         */
        connected_by: personSchema.nullable(),
        connected_at: timestampSchema.nullable(),
        granted_scope: z.string().nullable(),
        access_expires_at: timestampSchema.nullable(),
      })
      .strict(),
    tools: z.array(workspaceMcpToolSchema),
    /** Tools the server listed that were left out: a bad name or past the limit. */
    tools_skipped: z.number().int().nonnegative(),
    tools_read_at: timestampSchema.nullable(),
    created_by: personSchema.nullable(),
    created_at: timestampSchema,
  })
  .strict();
export type WorkspaceMcpServer = z.infer<typeof workspaceMcpServerSchema>;

export const workspaceMcpServerListSchema = z
  .object({
    items: z.array(workspaceMcpServerSchema),
    limit: z.number().int().positive(),
  })
  .strict();
export type WorkspaceMcpServerList = z.infer<
  typeof workspaceMcpServerListSchema
>;

export const workspaceMcpServerParamsSchema = z
  .object({ id: workspaceMcpServerIdSchema })
  .strict();

export const discoverWorkspaceMcpServerRequestSchema = z
  .object({ url: workspaceMcpUrlSchema })
  .strict();
export type DiscoverWorkspaceMcpServerRequest = z.infer<
  typeof discoverWorkspaceMcpServerRequestSchema
>;

/** `oauth` is null when the server asks for no OAuth: register it with a token. */
export const discoverWorkspaceMcpServerResponseSchema = z
  .object({
    url: z.string(),
    oauth: z
      .object({
        issuer: z.string(),
        scopes_supported: z.array(z.string()),
        default_scope: z.string().nullable(),
        dcr_supported: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type DiscoverWorkspaceMcpServerResponse = z.infer<
  typeof discoverWorkspaceMcpServerResponseSchema
>;

export const createWorkspaceMcpServerRequestSchema = z.discriminatedUnion(
  "auth_kind",
  [
    z
      .object({
        name: mcpServerIdSchema,
        url: workspaceMcpUrlSchema,
        auth_kind: z.literal("bearer"),
        token: workspaceMcpSecretSchema,
      })
      .strict(),
    z
      .object({
        name: mcpServerIdSchema,
        url: workspaceMcpUrlSchema,
        auth_kind: z.literal("oauth"),
        /** Narrower than discovery offered, or left out for its default. */
        scope: scopeSchema.optional(),
      })
      .strict(),
  ],
);
export type CreateWorkspaceMcpServerRequest = z.infer<
  typeof createWorkspaceMcpServerRequestSchema
>;

export const putWorkspaceMcpBearerTokenRequestSchema = z
  .object({ token: workspaceMcpSecretSchema })
  .strict();
export type PutWorkspaceMcpBearerTokenRequest = z.infer<
  typeof putWorkspaceMcpBearerTokenRequestSchema
>;

/** A client registered by hand at the authorization server for `redirect_uri`. */
export const putWorkspaceMcpOAuthClientRequestSchema = z
  .object({
    client_id: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/),
    client_secret: workspaceMcpSecretSchema.optional(),
  })
  .strict();
export type PutWorkspaceMcpOAuthClientRequest = z.infer<
  typeof putWorkspaceMcpOAuthClientRequestSchema
>;

export const startWorkspaceMcpOAuthResponseSchema = z
  .object({
    authorization_url: z.string(),
    expires_at: timestampSchema,
  })
  .strict();
export type StartWorkspaceMcpOAuthResponse = z.infer<
  typeof startWorkspaceMcpOAuthResponseSchema
>;

/** What the callback page read from its URL. */
export const completeWorkspaceMcpOAuthRequestSchema = z
  .object({
    code: z.string().min(1).max(4096),
    state: z.string().min(1).max(256),
    iss: z.string().min(1).max(WORKSPACE_MCP_URL_MAX).optional(),
  })
  .strict();
export type CompleteWorkspaceMcpOAuthRequest = z.infer<
  typeof completeWorkspaceMcpOAuthRequestSchema
>;

export const disconnectWorkspaceMcpServerResponseSchema = z
  .object({
    server: workspaceMcpServerSchema,
    /** Null when there was nothing to revoke or no revocation endpoint. */
    revoked: z.boolean().nullable(),
  })
  .strict();
export type DisconnectWorkspaceMcpServerResponse = z.infer<
  typeof disconnectWorkspaceMcpServerResponseSchema
>;

export const deleteWorkspaceMcpServerResponseSchema = z
  .object({ id: workspaceMcpServerIdSchema })
  .strict();
export type DeleteWorkspaceMcpServerResponse = z.infer<
  typeof deleteWorkspaceMcpServerResponseSchema
>;

/** One workspace server as an agent's MCP tab shows it. */
export const agentWorkspaceMcpServerSchema = z
  .object({
    server_id: workspaceMcpServerIdSchema,
    name: mcpServerIdSchema,
    /** The agent's next sessions may call it. */
    on: z.boolean(),
    /** Tools stay hidden from sessions until the connection is active. */
    state: workspaceMcpConnectionStateSchema,
    /** Whose external account the agent's calls run as. */
    connected_by: personSchema.nullable(),
    tool_count: z.number().int().nonnegative(),
  })
  .strict();
export type AgentWorkspaceMcpServer = z.infer<
  typeof agentWorkspaceMcpServerSchema
>;

/** Every server of the workspace, by name; `on` marks the agent's own. */
export const agentWorkspaceMcpServerListSchema = z
  .object({
    items: z.array(agentWorkspaceMcpServerSchema),
    limit: z.number().int().positive(),
  })
  .strict();
export type AgentWorkspaceMcpServerList = z.infer<
  typeof agentWorkspaceMcpServerListSchema
>;

/** The whole set, replaced. */
export const putAgentWorkspaceMcpServersRequestSchema = z
  .object({
    server_ids: z
      .array(workspaceMcpServerIdSchema)
      .max(AGENT_WORKSPACE_MCP_SERVERS_MAX),
  })
  .strict();
export type PutAgentWorkspaceMcpServersRequest = z.infer<
  typeof putAgentWorkspaceMcpServersRequestSchema
>;

/** `receipt_id` is null when the agent already had this set. */
export const putAgentWorkspaceMcpServersResponseSchema = z
  .object({
    servers: agentWorkspaceMcpServerListSchema,
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();
export type PutAgentWorkspaceMcpServersResponse = z.infer<
  typeof putAgentWorkspaceMcpServersResponseSchema
>;
