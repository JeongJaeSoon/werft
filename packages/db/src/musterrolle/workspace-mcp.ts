import type { SecretPurpose, WorkspaceRole } from "@werft-ai/contracts";
import {
  MANAGEMENT_ROLES,
  type Principal,
  type SecretKey,
  type SecretOwnerRef,
  type SecretSlot,
  secretOwnerRef,
  type WorkspaceMcpCredential,
  type WorkspaceMcpOAuthPin,
  type WorkspaceMcpRevocation,
  type WorkspaceMcpServerRecord,
  type WorkspaceMcpStore,
} from "@werft-ai/platform";
import { and, asc, count, eq, inArray, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  agentWorkspaceMcpServers,
  secretValues,
  users,
  workspaceMcpConnections,
  workspaceMcpServers,
} from "../schema.ts";
import {
  deleteSecretInTx,
  readSecretInTx,
  writeSecretInTx,
} from "../secrets/index.ts";
import { deletedBy, notDeleted } from "../soft-delete.ts";
import { writeSucceededReceipt } from "../succeeded-receipt.ts";
import { lockedRole } from "./api-keys.ts";

// Workspace MCP servers and their one connection. Every write by a person re-reads their role under
// lock and writes a receipt in the same transaction; no receipt or error
// carries a credential.

const SUBJECT = "workspace";
const MANAGERS: readonly WorkspaceRole[] =
  MANAGEMENT_ROLES["workspace.manage"] ?? [];
/** The person's: they go on disconnect and on a new client. */
const PERSON_PURPOSES = [
  "mcp_access_token",
  "mcp_refresh_token",
  "mcp_pkce_verifier",
] as const satisfies readonly SecretPurpose[];
const ALL_PURPOSES = [
  ...PERSON_PURPOSES,
  "mcp_client_secret",
  "mcp_bearer_token",
] as const satisfies readonly SecretPurpose[];

const ownerOf = (serverId: string) => ({
  kind: "workspace_mcp" as const,
  id: `${serverId.toLowerCase()}:${SUBJECT}`,
});
const slotOf = (
  workspaceId: string,
  serverId: string,
  purpose: SecretPurpose,
): SecretSlot => ({ workspaceId, owner: ownerOf(serverId), purpose });

async function stillManager(
  tx: Database,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const role = await lockedRole(tx, workspaceId, userId);
  return role !== null && MANAGERS.includes(role);
}

async function writeReceipt(
  tx: Database,
  principal: Principal,
  workspaceId: string,
  operation:
    | "create_workspace_mcp_server"
    | "delete_workspace_mcp_server"
    | "set_workspace_mcp_credential"
    | "connect_workspace_mcp_server"
    | "disconnect_workspace_mcp_server",
  result: Record<string, unknown>,
): Promise<void> {
  await writeSucceededReceipt(tx, principal, {
    operation,
    resource: { kind: "workspace", id: workspaceId },
    workspaceId,
    result,
  });
}

const creator = alias(users, "workspace_mcp_creator");
const connector = alias(users, "workspace_mcp_connector");

async function readRecords(
  db: Database,
  workspaceId: string,
  serverId: string | null,
): Promise<WorkspaceMcpServerRecord[]> {
  const ws = workspaceId.toLowerCase();
  const rows = await db
    .select({
      server: workspaceMcpServers,
      connection: workspaceMcpConnections,
      creatorName: creator.displayName,
      connectorName: connector.displayName,
    })
    .from(workspaceMcpServers)
    .leftJoin(
      workspaceMcpConnections,
      and(
        eq(workspaceMcpConnections.serverId, workspaceMcpServers.id),
        eq(workspaceMcpConnections.subject, SUBJECT),
      ),
    )
    .leftJoin(creator, eq(creator.id, workspaceMcpServers.createdByUserId))
    .leftJoin(
      connector,
      eq(connector.id, workspaceMcpConnections.connectedByUserId),
    )
    .where(
      and(
        eq(workspaceMcpServers.workspaceId, ws),
        serverId === null
          ? undefined
          : eq(workspaceMcpServers.id, serverId.toLowerCase()),
        notDeleted(workspaceMcpServers),
      ),
    )
    .orderBy(asc(workspaceMcpServers.name));
  if (rows.length === 0) return [];
  const refs = rows.map(
    (row) => secretOwnerRef(ownerOf(row.server.id)) as SecretOwnerRef,
  );
  const secrets = await db
    .select({
      ownerRef: secretValues.ownerRef,
      purpose: secretValues.purpose,
      last4: secretValues.last4,
    })
    .from(secretValues)
    .where(
      and(
        eq(secretValues.workspaceId, ws),
        inArray(secretValues.ownerRef, refs),
        inArray(secretValues.purpose, [
          "mcp_bearer_token",
          "mcp_client_secret",
        ]),
      ),
    );
  const secretOf = (serverId: string, purpose: SecretPurpose) =>
    secrets.find(
      (secret) =>
        secret.ownerRef === secretOwnerRef(ownerOf(serverId)) &&
        secret.purpose === purpose,
    );
  return rows.map(({ server, connection, creatorName, connectorName }) => ({
    id: server.id,
    workspaceId: server.workspaceId,
    name: server.name,
    url: server.url,
    authKind: server.authKind,
    oauth: server.oauth,
    tools: server.tools,
    toolsSkipped: server.toolsSkipped,
    toolsReadAt: server.toolsReadAt,
    createdBy:
      server.createdByUserId === null || creatorName === null
        ? null
        : { userId: server.createdByUserId, displayName: creatorName },
    createdAt: server.createdAt,
    connection: {
      state: connection?.state ?? "none",
      reauthReason: connection?.reauthReason ?? null,
      generation: connection?.generation ?? 0,
      connectedBy:
        connection?.connectedByUserId == null || connectorName === null
          ? null
          : {
              userId: connection.connectedByUserId,
              displayName: connectorName,
            },
      connectedAt: connection?.connectedAt ?? null,
      accessExpiresAt: connection?.accessExpiresAt ?? null,
      grantedScope: connection?.grantedScope ?? null,
      refreshFailedAt: connection?.refreshFailedAt ?? null,
    },
    bearerLast4: secretOf(server.id, "mcp_bearer_token")?.last4 ?? null,
    hasClientSecret: secretOf(server.id, "mcp_client_secret") !== undefined,
  }));
}

async function readRecord(
  db: Database,
  workspaceId: string,
  serverId: string,
): Promise<WorkspaceMcpServerRecord | null> {
  return (await readRecords(db, workspaceId, serverId))[0] ?? null;
}

/** The server row of the workspace, locked, or null. */
async function heldServer(tx: Database, workspaceId: string, serverId: string) {
  const [row] = await tx
    .select()
    .from(workspaceMcpServers)
    .where(
      and(
        eq(workspaceMcpServers.workspaceId, workspaceId.toLowerCase()),
        eq(workspaceMcpServers.id, serverId.toLowerCase()),
        notDeleted(workspaceMcpServers),
      ),
    )
    .for("update");
  return row ?? null;
}

async function heldConnection(tx: Database, serverId: string) {
  const [row] = await tx
    .select()
    .from(workspaceMcpConnections)
    .where(
      and(
        eq(workspaceMcpConnections.serverId, serverId),
        eq(workspaceMcpConnections.subject, SUBJECT),
      ),
    )
    .for("update");
  if (!row) throw new Error("a workspace MCP server has no connection row");
  return row;
}

const DISCONNECTED = {
  state: "none" as const,
  reauthReason: null,
  pendingFlowId: null,
  pendingStateSha256: null,
  pendingStartedByUserId: null,
  pendingExpiresAt: null,
  connectedByUserId: null,
  connectedAt: null,
  accessExpiresAt: null,
  grantedScope: null,
  refreshFailedAt: null,
};

/**
 * What to revoke once the person's tokens are gone: the refresh token, or
 * the access token without one. Read before they are deleted.
 */
async function revocationOf(
  tx: Database,
  key: SecretKey,
  workspaceId: string,
  serverId: string,
  oauth: WorkspaceMcpOAuthPin | null,
): Promise<WorkspaceMcpRevocation | null> {
  if (oauth === null || oauth.revocationEndpoint === null) return null;
  const refresh = await readSecretInTx(
    tx,
    key,
    slotOf(workspaceId, serverId, "mcp_refresh_token"),
  );
  const token =
    refresh ??
    (await readSecretInTx(
      tx,
      key,
      slotOf(workspaceId, serverId, "mcp_access_token"),
    ));
  if (token === null) return null;
  return {
    oauth,
    token,
    hint: refresh === null ? "access_token" : "refresh_token",
    clientSecret: await readSecretInTx(
      tx,
      key,
      slotOf(workspaceId, serverId, "mcp_client_secret"),
    ),
  };
}

async function deleteSecrets(
  tx: Database,
  workspaceId: string,
  serverId: string,
  purposes: readonly SecretPurpose[],
): Promise<void> {
  for (const purpose of purposes) {
    await deleteSecretInTx(tx, slotOf(workspaceId, serverId, purpose));
  }
}

/**
 * Disconnects every connection `userId` made, in one workspace or (null) all of
 * them, when their membership or account is disabled. The tokens are
 * dropped without revocation: there is no outbound call inside the
 * offboarding transaction.
 */
export async function disconnectWorkspaceMcpOf(
  tx: Database,
  userId: string,
  workspaceId: string | null,
): Promise<number> {
  const held = await tx
    .select({
      serverId: workspaceMcpConnections.serverId,
      workspaceId: workspaceMcpServers.workspaceId,
    })
    .from(workspaceMcpConnections)
    .innerJoin(
      workspaceMcpServers,
      eq(workspaceMcpServers.id, workspaceMcpConnections.serverId),
    )
    .where(
      and(
        or(
          and(
            eq(workspaceMcpConnections.connectedByUserId, userId),
            ne(workspaceMcpConnections.state, "none"),
          ),
          eq(workspaceMcpConnections.pendingStartedByUserId, userId),
        ),
        workspaceId === null
          ? undefined
          : eq(workspaceMcpServers.workspaceId, workspaceId),
        notDeleted(workspaceMcpServers),
      ),
    )
    .orderBy(asc(workspaceMcpConnections.serverId))
    .for("update", { of: workspaceMcpConnections });
  let disconnected = 0;
  for (const row of held) {
    const [connection] = await tx
      .select()
      .from(workspaceMcpConnections)
      .where(
        and(
          eq(workspaceMcpConnections.serverId, row.serverId),
          eq(workspaceMcpConnections.subject, SUBJECT),
        ),
      );
    if (!connection) continue;
    if (
      connection.connectedByUserId === userId &&
      connection.state !== "none"
    ) {
      await deleteSecrets(tx, row.workspaceId, row.serverId, [
        ...PERSON_PURPOSES,
        "mcp_bearer_token",
      ]);
      await tx
        .update(workspaceMcpConnections)
        .set({
          ...DISCONNECTED,
          generation: sql`${workspaceMcpConnections.generation} + 1`,
        })
        .where(eq(workspaceMcpConnections.serverId, row.serverId));
      disconnected += 1;
    } else {
      // Only a sign-in they started: it can no longer finish anyway.
      await deleteSecretInTx(
        tx,
        slotOf(row.workspaceId, row.serverId, "mcp_pkce_verifier"),
      );
      await tx
        .update(workspaceMcpConnections)
        .set({
          pendingFlowId: null,
          pendingStateSha256: null,
          pendingStartedByUserId: null,
          pendingExpiresAt: null,
        })
        .where(eq(workspaceMcpConnections.serverId, row.serverId));
    }
  }
  return disconnected;
}

export function createPostgresWorkspaceMcpStore(
  db: Database,
  /** Null when the secret store is off: only reads work. */
  key: SecretKey | null,
): WorkspaceMcpStore {
  const sealed = (): SecretKey => {
    if (key === null) throw new Error("the secret store is off");
    return key;
  };

  return {
    list: (workspaceId) => readRecords(db, workspaceId, null),
    get: (workspaceId, serverId) => readRecord(db, workspaceId, serverId),

    create(input) {
      const secretKey = sealed();
      const workspaceId = input.workspaceId.toLowerCase();
      const id = input.id.toLowerCase();
      return db.transaction(async (tx) => {
        if (!(await stillManager(tx, workspaceId, input.actorUserId))) {
          return { outcome: "actor_inactive" as const };
        }
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace_mcp_servers:${workspaceId}`}, 0))`,
        );
        const [same] = await tx
          .select({ id: workspaceMcpServers.id })
          .from(workspaceMcpServers)
          .where(
            and(
              eq(workspaceMcpServers.workspaceId, workspaceId),
              eq(workspaceMcpServers.name, input.name),
              notDeleted(workspaceMcpServers),
            ),
          )
          .limit(1);
        if (same) return { outcome: "name_taken" as const };
        const [held] = await tx
          .select({ n: count() })
          .from(workspaceMcpServers)
          .where(
            and(
              eq(workspaceMcpServers.workspaceId, workspaceId),
              notDeleted(workspaceMcpServers),
            ),
          );
        if ((held?.n ?? 0) >= input.max) {
          return { outcome: "quota_exceeded" as const };
        }
        await tx.insert(workspaceMcpServers).values({
          id,
          workspaceId,
          name: input.name,
          url: input.url,
          authKind: input.authKind,
          oauth: input.oauth,
          createdByUserId: input.actorUserId,
        });
        const bearer = input.authKind === "bearer" ? input.bearerToken : null;
        // A server that takes no credential is connected from the start, by
        // no one: nothing of a person goes with its calls.
        const connected = bearer !== null || input.authKind === "none";
        await tx.insert(workspaceMcpConnections).values({
          serverId: id,
          subject: SUBJECT,
          ...(connected
            ? {
                state: "active" as const,
                generation: 1,
                connectedByUserId: bearer === null ? null : input.actorUserId,
                connectedAt: DB_NOW,
              }
            : {}),
        });
        if (bearer !== null) {
          await writeSecretInTx(
            tx,
            secretKey,
            slotOf(workspaceId, id, "mcp_bearer_token"),
            bearer,
            input.actorUserId,
          );
        }
        await writeReceipt(
          tx,
          input.principal,
          workspaceId,
          "create_workspace_mcp_server",
          {
            server_id: id,
            name: input.name,
            url: input.url,
            auth_kind: input.authKind,
          },
        );
        const record = await readRecord(tx, workspaceId, id);
        if (record === null) throw new Error("the new server is not readable");
        return { outcome: "created" as const, record };
      });
    },

    delete(input) {
      const secretKey = sealed();
      const workspaceId = input.workspaceId.toLowerCase();
      return db.transaction(async (tx) => {
        if (!(await stillManager(tx, workspaceId, input.actorUserId))) {
          return { outcome: "actor_inactive" as const };
        }
        const server = await heldServer(tx, workspaceId, input.serverId);
        if (server === null) return { outcome: "not_found" as const };
        await heldConnection(tx, server.id);
        const revocation = await revocationOf(
          tx,
          secretKey,
          workspaceId,
          server.id,
          server.oauth,
        );
        await deleteSecrets(tx, workspaceId, server.id, ALL_PURPOSES);
        // What the row's foreign keys used to cascade to; the row itself
        // stays without its OAuth settings.
        await tx
          .delete(workspaceMcpConnections)
          .where(eq(workspaceMcpConnections.serverId, server.id));
        await tx
          .delete(agentWorkspaceMcpServers)
          .where(eq(agentWorkspaceMcpServers.serverId, server.id));
        await tx
          .update(workspaceMcpServers)
          .set({ oauth: null, ...deletedBy(input.actorUserId) })
          .where(eq(workspaceMcpServers.id, server.id));
        await writeReceipt(
          tx,
          input.principal,
          workspaceId,
          "delete_workspace_mcp_server",
          {
            server_id: server.id,
            name: server.name,
          },
        );
        return { outcome: "deleted" as const, revocation };
      });
    },

    setBearerToken(input) {
      const secretKey = sealed();
      const workspaceId = input.workspaceId.toLowerCase();
      return db.transaction(async (tx) => {
        if (!(await stillManager(tx, workspaceId, input.actorUserId))) {
          return { outcome: "actor_inactive" as const };
        }
        const server = await heldServer(tx, workspaceId, input.serverId);
        if (server === null) return { outcome: "not_found" as const };
        if (server.authKind === "none") {
          return { outcome: "no_credential" as const };
        }
        if (server.authKind !== "bearer")
          return { outcome: "not_bearer" as const };
        await heldConnection(tx, server.id);
        await writeSecretInTx(
          tx,
          secretKey,
          slotOf(workspaceId, server.id, "mcp_bearer_token"),
          input.token,
          input.actorUserId,
        );
        await tx
          .update(workspaceMcpConnections)
          .set({
            ...DISCONNECTED,
            state: "active",
            connectedByUserId: input.actorUserId,
            connectedAt: DB_NOW,
            generation: sql`${workspaceMcpConnections.generation} + 1`,
          })
          .where(eq(workspaceMcpConnections.serverId, server.id));
        await writeReceipt(
          tx,
          input.principal,
          workspaceId,
          "set_workspace_mcp_credential",
          {
            server_id: server.id,
            credential: "bearer_token",
          },
        );
        const record = await readRecord(tx, workspaceId, server.id);
        if (record === null) throw new Error("the server is not readable");
        return { outcome: "saved" as const, record };
      });
    },

    setOAuthClient(input) {
      const secretKey = sealed();
      const workspaceId = input.workspaceId.toLowerCase();
      return db.transaction(async (tx) => {
        if (!(await stillManager(tx, workspaceId, input.actorUserId))) {
          return { outcome: "actor_inactive" as const };
        }
        const server = await heldServer(tx, workspaceId, input.serverId);
        if (server === null) return { outcome: "not_found" as const };
        if (server.oauth === null) return { outcome: "not_oauth" as const };
        await heldConnection(tx, server.id);
        await tx
          .update(workspaceMcpServers)
          .set({ oauth: { ...server.oauth, client: input.client } })
          .where(eq(workspaceMcpServers.id, server.id));
        const secretSlot = slotOf(workspaceId, server.id, "mcp_client_secret");
        if (input.clientSecret === null) {
          await deleteSecretInTx(tx, secretSlot);
        } else {
          await writeSecretInTx(
            tx,
            secretKey,
            secretSlot,
            input.clientSecret,
            input.actorUserId,
          );
        }
        await deleteSecrets(tx, workspaceId, server.id, PERSON_PURPOSES);
        await tx
          .update(workspaceMcpConnections)
          .set({
            ...DISCONNECTED,
            generation: sql`${workspaceMcpConnections.generation} + 1`,
          })
          .where(eq(workspaceMcpConnections.serverId, server.id));
        await writeReceipt(
          tx,
          input.principal,
          workspaceId,
          "set_workspace_mcp_credential",
          {
            server_id: server.id,
            credential: "oauth_client",
            client_id: input.client.clientId,
            has_client_secret: input.clientSecret !== null,
          },
        );
        const record = await readRecord(tx, workspaceId, server.id);
        if (record === null) throw new Error("the server is not readable");
        return { outcome: "saved" as const, record };
      });
    },

    beginFlow(input) {
      const secretKey = sealed();
      const workspaceId = input.workspaceId.toLowerCase();
      return db.transaction(async (tx) => {
        if (!(await stillManager(tx, workspaceId, input.actorUserId))) {
          return { outcome: "actor_inactive" as const };
        }
        const server = await heldServer(tx, workspaceId, input.serverId);
        if (server === null || server.oauth === null) {
          return { outcome: "not_found" as const };
        }
        await heldConnection(tx, server.id);
        // The authorization URL names the client the service saw; a late
        // registration must not replace one that landed since, whose tokens
        // may already be in use.
        if (
          (server.oauth.client?.clientId ?? null) !== input.expectedClientId
        ) {
          return { outcome: "client_changed" as const };
        }
        const { registered } = input;
        if (registered !== null) {
          await tx
            .update(workspaceMcpServers)
            .set({ oauth: { ...server.oauth, client: registered.client } })
            .where(eq(workspaceMcpServers.id, server.id));
          const secretSlot = slotOf(
            workspaceId,
            server.id,
            "mcp_client_secret",
          );
          if (registered.clientSecret === null) {
            await deleteSecretInTx(tx, secretSlot);
          } else {
            await writeSecretInTx(
              tx,
              secretKey,
              secretSlot,
              registered.clientSecret,
              null,
            );
          }
        }
        await writeSecretInTx(
          tx,
          secretKey,
          slotOf(workspaceId, server.id, "mcp_pkce_verifier"),
          input.verifier,
          input.actorUserId,
        );
        await tx
          .update(workspaceMcpConnections)
          .set({
            pendingFlowId: input.flowId,
            pendingStateSha256: input.stateSha256,
            pendingStartedByUserId: input.actorUserId,
            pendingExpiresAt: input.expiresAt,
          })
          .where(eq(workspaceMcpConnections.serverId, server.id));
        return { outcome: "started" as const };
      });
    },

    readFlow(workspaceId, serverId) {
      const secretKey = sealed();
      const ws = workspaceId.toLowerCase();
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            server: workspaceMcpServers,
            connection: workspaceMcpConnections,
          })
          .from(workspaceMcpServers)
          .innerJoin(
            workspaceMcpConnections,
            and(
              eq(workspaceMcpConnections.serverId, workspaceMcpServers.id),
              eq(workspaceMcpConnections.subject, SUBJECT),
            ),
          )
          .where(
            and(
              eq(workspaceMcpServers.workspaceId, ws),
              eq(workspaceMcpServers.id, serverId.toLowerCase()),
              notDeleted(workspaceMcpServers),
            ),
          );
        const { server, connection } = row ?? {};
        if (
          !server ||
          !connection ||
          server.oauth === null ||
          connection.pendingFlowId === null ||
          connection.pendingStateSha256 === null ||
          connection.pendingStartedByUserId === null ||
          connection.pendingExpiresAt === null
        ) {
          return null;
        }
        const verifier = await readSecretInTx(
          tx,
          secretKey,
          slotOf(ws, server.id, "mcp_pkce_verifier"),
        );
        if (verifier === null) return null;
        return {
          flowId: connection.pendingFlowId,
          stateSha256: Buffer.from(connection.pendingStateSha256),
          startedByUserId: connection.pendingStartedByUserId,
          expiresAt: connection.pendingExpiresAt,
          verifier,
          oauth: server.oauth,
          clientSecret: await readSecretInTx(
            tx,
            secretKey,
            slotOf(ws, server.id, "mcp_client_secret"),
          ),
        };
      });
    },

    completeFlow(input) {
      const secretKey = sealed();
      const workspaceId = input.workspaceId.toLowerCase();
      return db.transaction(async (tx) => {
        // The person before the server and connection, the order every
        // writer here and the offboarding in members.ts take.
        if (!(await stillManager(tx, workspaceId, input.actorUserId))) {
          return { outcome: "actor_inactive" as const };
        }
        const server = await heldServer(tx, workspaceId, input.serverId);
        if (server === null) return { outcome: "flow_gone" as const };
        const connection = await heldConnection(tx, server.id);
        // The clock once the locks are held, so waiting for them counts.
        const at = Math.max(input.now.getTime(), Date.now());
        if (
          connection.pendingFlowId !== input.flowId ||
          connection.pendingExpiresAt === null ||
          connection.pendingExpiresAt.getTime() <= at
        ) {
          return { outcome: "flow_gone" as const };
        }
        if (connection.pendingStartedByUserId !== input.actorUserId) {
          return { outcome: "actor_inactive" as const };
        }
        const { tokens } = input;
        await writeSecretInTx(
          tx,
          secretKey,
          slotOf(workspaceId, server.id, "mcp_access_token"),
          tokens.accessToken,
          input.actorUserId,
        );
        const refreshSlot = slotOf(workspaceId, server.id, "mcp_refresh_token");
        if (tokens.refreshToken === null) {
          await deleteSecretInTx(tx, refreshSlot);
        } else {
          await writeSecretInTx(
            tx,
            secretKey,
            refreshSlot,
            tokens.refreshToken,
            input.actorUserId,
          );
        }
        await deleteSecretInTx(
          tx,
          slotOf(workspaceId, server.id, "mcp_pkce_verifier"),
        );
        const generation = connection.generation + 1;
        await tx
          .update(workspaceMcpConnections)
          .set({
            ...DISCONNECTED,
            state: "active",
            generation,
            connectedByUserId: input.actorUserId,
            connectedAt: DB_NOW,
            accessExpiresAt: tokens.expiresAt,
            grantedScope: tokens.scope,
          })
          .where(eq(workspaceMcpConnections.serverId, server.id));
        await writeReceipt(
          tx,
          input.principal,
          workspaceId,
          "connect_workspace_mcp_server",
          {
            server_id: server.id,
            name: server.name,
            generation,
            granted_scope: tokens.scope,
          },
        );
        const record = await readRecord(tx, workspaceId, server.id);
        if (record === null) throw new Error("the server is not readable");
        return { outcome: "connected" as const, record };
      });
    },

    disconnect(input) {
      const secretKey = sealed();
      const workspaceId = input.workspaceId.toLowerCase();
      return db.transaction(async (tx) => {
        if (!(await stillManager(tx, workspaceId, input.actorUserId))) {
          return { outcome: "actor_inactive" as const };
        }
        const server = await heldServer(tx, workspaceId, input.serverId);
        if (server === null) return { outcome: "not_found" as const };
        // Nothing to take out, and nothing would connect it again.
        if (server.authKind === "none") {
          return { outcome: "no_credential" as const };
        }
        // A kind this release does not know is a later release's to change:
        // disconnected here, it could be left in a state that release cannot
        // connect again.
        if (server.authKind !== "bearer" && server.authKind !== "oauth") {
          return { outcome: "unsupported_kind" as const };
        }
        const connection = await heldConnection(tx, server.id);
        const revocation = await revocationOf(
          tx,
          secretKey,
          workspaceId,
          server.id,
          server.oauth,
        );
        // A static token is the person's who put it in, as an OAuth
        // sign-in is: it goes with them.
        await deleteSecrets(tx, workspaceId, server.id, [
          ...PERSON_PURPOSES,
          "mcp_bearer_token",
        ]);
        const generation = connection.generation + 1;
        await tx
          .update(workspaceMcpConnections)
          .set({ ...DISCONNECTED, generation })
          .where(eq(workspaceMcpConnections.serverId, server.id));
        await writeReceipt(
          tx,
          input.principal,
          workspaceId,
          "disconnect_workspace_mcp_server",
          {
            server_id: server.id,
            name: server.name,
            generation,
          },
        );
        const record = await readRecord(tx, workspaceId, server.id);
        if (record === null) throw new Error("the server is not readable");
        return { outcome: "disconnected" as const, record, revocation };
      });
    },

    async credentialOf(
      workspaceId,
      serverId,
    ): Promise<WorkspaceMcpCredential | null> {
      const secretKey = sealed();
      const record = await readRecord(db, workspaceId, serverId);
      if (record === null || record.connection.state !== "active") return null;
      if (record.authKind === "none") return { kind: "none" };
      // A kind this release does not know sends nothing.
      if (record.authKind !== "bearer" && record.authKind !== "oauth") {
        return null;
      }
      const ws = record.workspaceId;
      return db.transaction(async (tx) => {
        if (record.authKind === "bearer") {
          const token = await readSecretInTx(
            tx,
            secretKey,
            slotOf(ws, record.id, "mcp_bearer_token"),
          );
          return token === null ? null : { kind: "bearer" as const, token };
        }
        const accessToken = await readSecretInTx(
          tx,
          secretKey,
          slotOf(ws, record.id, "mcp_access_token"),
        );
        if (accessToken === null) return null;
        const [refresh] = await tx
          .select({ id: secretValues.id })
          .from(secretValues)
          .where(
            and(
              eq(secretValues.workspaceId, ws),
              eq(secretValues.ownerRef, secretOwnerRef(ownerOf(record.id))),
              eq(secretValues.purpose, "mcp_refresh_token"),
            ),
          );
        return {
          kind: "oauth" as const,
          accessToken,
          expiresAt: record.connection.accessExpiresAt,
          hasRefreshToken: refresh !== undefined,
        };
      });
    },

    refresh(workspaceId, serverId, decide) {
      const secretKey = sealed();
      const ws = workspaceId.toLowerCase();
      return db.transaction(async (tx) => {
        const server = await heldServer(tx, ws, serverId);
        if (server === null || server.oauth === null) return null;
        const connection = await heldConnection(tx, server.id);
        if (connection.state !== "active") return null;
        const record = await readRecord(tx, ws, server.id);
        if (record === null) return null;
        const read = (purpose: SecretPurpose) =>
          readSecretInTx(tx, secretKey, slotOf(ws, server.id, purpose));
        const decision = await decide({
          server: record,
          oauth: server.oauth,
          refreshToken: await read("mcp_refresh_token"),
          accessToken: await read("mcp_access_token"),
          clientSecret: await read("mcp_client_secret"),
        });
        const where = eq(workspaceMcpConnections.serverId, server.id);
        switch (decision.kind) {
          case "keep":
            return record;
          case "backoff":
            await tx
              .update(workspaceMcpConnections)
              .set({ refreshFailedAt: DB_NOW })
              .where(where);
            break;
          case "store": {
            const { tokens } = decision;
            await writeSecretInTx(
              tx,
              secretKey,
              slotOf(ws, server.id, "mcp_access_token"),
              tokens.accessToken,
            );
            if (tokens.refreshToken !== null) {
              await writeSecretInTx(
                tx,
                secretKey,
                slotOf(ws, server.id, "mcp_refresh_token"),
                tokens.refreshToken,
              );
            }
            await tx
              .update(workspaceMcpConnections)
              .set({
                accessExpiresAt: tokens.expiresAt,
                grantedScope: decision.grantedScope,
                refreshFailedAt: null,
              })
              .where(where);
            break;
          }
          case "reauth": {
            await deleteSecrets(tx, ws, server.id, [
              "mcp_access_token",
              "mcp_refresh_token",
            ]);
            if (decision.dropClient) {
              await deleteSecretInTx(
                tx,
                slotOf(ws, server.id, "mcp_client_secret"),
              );
              await tx
                .update(workspaceMcpServers)
                .set({ oauth: { ...server.oauth, client: null } })
                .where(eq(workspaceMcpServers.id, server.id));
            }
            await tx
              .update(workspaceMcpConnections)
              .set({
                state: "needs_reauth",
                reauthReason: decision.reason,
                accessExpiresAt: null,
                refreshFailedAt: null,
              })
              .where(where);
            break;
          }
        }
        return readRecord(tx, ws, server.id);
      });
    },

    saveTools(input) {
      const ws = input.workspaceId.toLowerCase();
      return db.transaction(async (tx) => {
        if (!(await stillManager(tx, ws, input.actorUserId))) {
          return { outcome: "actor_inactive" as const };
        }
        const server = await heldServer(tx, ws, input.serverId);
        if (server === null) return { outcome: "not_found" as const };
        const connection = await heldConnection(tx, server.id);
        // Read with a credential since disconnected or replaced: the list
        // is not that connection's to set.
        if (
          connection.generation !== input.generation ||
          connection.state !== "active"
        ) {
          return { outcome: "stale" as const };
        }
        await tx
          .update(workspaceMcpServers)
          .set({
            tools: input.tools,
            toolsSkipped: input.skipped,
            toolsReadAt: input.readAt,
          })
          .where(eq(workspaceMcpServers.id, server.id));
        const record = await readRecord(tx, ws, server.id);
        if (record === null) throw new Error("the server is not readable");
        return { outcome: "saved" as const, record };
      });
    },
  };
}
