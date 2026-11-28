import type { WorkspaceMcpStart } from "@werft-ai/contracts";
import type {
  AgentWorkspaceMcpServerRow,
  AgentWorkspaceMcpStore,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { lockAgentToChange } from "../../agents.ts";
import type { Database } from "../../queries.ts";
import {
  agentReleases,
  agents,
  agentWorkspaceMcpServers,
  users,
  workspaceMcpConnections,
  workspaceMcpServers,
} from "../../schema.ts";
import { notDeleted } from "../../soft-delete.ts";
import { writeSucceededReceipt } from "../../succeeded-receipt.ts";

const SUBJECT = "workspace";

/**
 * The workspace servers the release's agent has on, with their URLs and
 * tools now, for `sessions.workspace_mcp_start`. Called with the agent row held FOR
 * SHARE (a save holds it FOR UPDATE), so the set cannot move; the server
 * rows are held FOR SHARE so a delete waits for the session row. Null when
 * the agent has none on.
 */
export async function captureWorkspaceMcpStart(
  tx: Database,
  releaseId: string,
): Promise<WorkspaceMcpStart | null> {
  const rows = await tx
    .select({
      id: workspaceMcpServers.id,
      name: workspaceMcpServers.name,
      url: workspaceMcpServers.url,
      tools: workspaceMcpServers.tools,
    })
    .from(agentReleases)
    .innerJoin(
      agentWorkspaceMcpServers,
      eq(agentWorkspaceMcpServers.agentId, agentReleases.agentId),
    )
    .innerJoin(
      workspaceMcpServers,
      and(
        eq(
          workspaceMcpServers.workspaceId,
          agentWorkspaceMcpServers.workspaceId,
        ),
        eq(workspaceMcpServers.id, agentWorkspaceMcpServers.serverId),
      ),
    )
    .where(
      and(eq(agentReleases.id, releaseId), notDeleted(workspaceMcpServers)),
    )
    .orderBy(asc(workspaceMcpServers.name))
    .for("share", { of: workspaceMcpServers });
  if (rows.length === 0) return null;
  return {
    servers: rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      tools: row.tools.map((tool) => `mcp__${row.name}__${tool.name}`),
    })),
  };
}

async function listOf(
  db: Database,
  workspaceId: string,
  agentId: string,
): Promise<AgentWorkspaceMcpServerRow[]> {
  const rows = await db
    .select({
      id: workspaceMcpServers.id,
      name: workspaceMcpServers.name,
      tools: workspaceMcpServers.tools,
      on: agentWorkspaceMcpServers.serverId,
      state: workspaceMcpConnections.state,
      connectedByUserId: workspaceMcpConnections.connectedByUserId,
      connectorName: users.displayName,
    })
    .from(workspaceMcpServers)
    .leftJoin(
      agentWorkspaceMcpServers,
      and(
        eq(agentWorkspaceMcpServers.serverId, workspaceMcpServers.id),
        eq(agentWorkspaceMcpServers.agentId, agentId),
      ),
    )
    .leftJoin(
      workspaceMcpConnections,
      and(
        eq(workspaceMcpConnections.serverId, workspaceMcpServers.id),
        eq(workspaceMcpConnections.subject, SUBJECT),
      ),
    )
    .leftJoin(users, eq(users.id, workspaceMcpConnections.connectedByUserId))
    .where(
      and(
        eq(workspaceMcpServers.workspaceId, workspaceId),
        notDeleted(workspaceMcpServers),
      ),
    )
    .orderBy(asc(workspaceMcpServers.name));
  return rows.map((row) => ({
    serverId: row.id,
    name: row.name,
    on: row.on !== null,
    state: row.state ?? "none",
    connectedBy:
      row.connectedByUserId === null ||
      row.connectedByUserId === undefined ||
      row.connectorName === null
        ? null
        : { userId: row.connectedByUserId, displayName: row.connectorName },
    toolCount: row.tools.length,
  }));
}

export function createPostgresAgentWorkspaceMcpStore(
  db: Database,
): AgentWorkspaceMcpStore {
  return {
    async list(workspaceId, agentId) {
      const ws = workspaceId.toLowerCase();
      const id = agentId.toLowerCase();
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, ws), eq(agents.id, id)))
        .limit(1);
      if (agent === undefined) return null;
      return listOf(db, ws, id);
    },

    put(input) {
      return db.transaction(async (tx) => {
        const ws = input.workspaceId.toLowerCase();
        const agentId = input.agentId.toLowerCase();
        // Agent row first, then the servers: the order a session start takes.
        const locked = await lockAgentToChange(tx, input, agentId);
        if ("outcome" in locked) return locked;
        const named =
          input.serverIds.length === 0
            ? []
            : await tx
                .select({
                  id: workspaceMcpServers.id,
                  name: workspaceMcpServers.name,
                })
                .from(workspaceMcpServers)
                .where(
                  and(
                    eq(workspaceMcpServers.workspaceId, ws),
                    inArray(workspaceMcpServers.id, [...input.serverIds]),
                    notDeleted(workspaceMcpServers),
                  ),
                )
                .for("share");
        const nameOf = new Map(named.map((row) => [row.id, row.name]));
        const unknown = input.serverIds.findIndex((id) => !nameOf.has(id));
        if (unknown >= 0) {
          return { outcome: "server_unknown" as const, at: unknown };
        }
        const before = await tx
          .select({
            id: workspaceMcpServers.id,
            name: workspaceMcpServers.name,
          })
          .from(agentWorkspaceMcpServers)
          .innerJoin(
            workspaceMcpServers,
            and(
              eq(workspaceMcpServers.id, agentWorkspaceMcpServers.serverId),
              notDeleted(workspaceMcpServers),
            ),
          )
          .where(eq(agentWorkspaceMcpServers.agentId, agentId))
          .orderBy(asc(workspaceMcpServers.name));
        const after = [...nameOf]
          .map(([id, name]) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const same =
          before.length === after.length &&
          before.every((row) => nameOf.has(row.id));
        if (same) return { outcome: "saved" as const, receiptId: null };
        await tx.delete(agentWorkspaceMcpServers).where(
          and(
            eq(agentWorkspaceMcpServers.agentId, agentId),
            after.length === 0
              ? undefined
              : notInArray(
                  agentWorkspaceMcpServers.serverId,
                  after.map((row) => row.id),
                ),
          ),
        );
        if (after.length > 0) {
          await tx
            .insert(agentWorkspaceMcpServers)
            .values(
              after.map((row) => ({
                agentId,
                workspaceId: ws,
                serverId: row.id,
                addedByUserId: input.userId,
              })),
            )
            .onConflictDoNothing();
        }
        const receiptId = await writeSucceededReceipt(tx, input.principal, {
          operation: "set_agent_workspace_mcp",
          resource: { kind: "agent", id: agentId },
          workspaceId: ws,
          result: { agent_id: agentId, before, after },
        });
        return { outcome: "saved" as const, receiptId };
      });
    },
  };
}
