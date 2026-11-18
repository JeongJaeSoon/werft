import {
  type WorkspaceMcpStart,
  workspaceMcpStartSchema,
} from "@werft-ai/contracts";
import {
  deniedMcpTools,
  type SessionWorkspaceMcp,
  visibleMcpTools,
  type WorkspaceMcpCallRecord,
  type WorkspaceMcpEgressStore,
  type WorkspaceMcpRefusalRecord,
  type WorkspaceMcpSessionState,
} from "@werft-ai/platform";
import { and, eq, inArray } from "drizzle-orm";
import { creatorOf, releaseMcpOf } from "../github/index.ts";
import type { Database } from "../queries.ts";
import {
  agentWorkspaceMcpServers,
  receipts,
  sessions,
  turns,
  workspaceMcpConnections,
  workspaceMcpServers,
} from "../schema.ts";
import { notDeleted } from "../soft-delete.ts";

const SUBJECT = "workspace";

/** A stored snapshot this image cannot read names no server. */
function snapshotOf(value: unknown): WorkspaceMcpStart["servers"] {
  return workspaceMcpStartSchema.safeParse(value).data?.servers ?? [];
}

/** The release's own MCP denies: its `deny` pins and snapshot `mcp_deny`. */
async function releaseDenyOf(
  executor: Database,
  releaseId: string,
): Promise<{ agentId: string; deny: string[] } | null> {
  const release = await releaseMcpOf(executor, releaseId);
  if (release === null) return null;
  return {
    agentId: release.agentId,
    deny: [...release.deny, ...deniedMcpTools(release.perTool)],
  };
}

/**
 * The workspace servers a claimed session started with, at the snapshot's
 * URL with its tools less the release's denies; a server left with none is
 * not claimed. A server deleted or moved since stays, for its egress to
 * refuse: the checkpoint fingerprint names every entry, so every claim of
 * the session hands the worker the same ones. A snapshot without URLs takes
 * each from the row, and leaves out a server deleted since.
 */
export async function sessionWorkspaceMcpOf(
  executor: Database,
  session: {
    agentReleaseId: string | null;
    workspaceId: string | null;
    workspaceMcpStart: unknown;
  },
): Promise<SessionWorkspaceMcp[]> {
  const snapshot = snapshotOf(session.workspaceMcpStart);
  if (
    snapshot.length === 0 ||
    session.agentReleaseId === null ||
    session.workspaceId === null
  ) {
    return [];
  }
  const release = await releaseDenyOf(executor, session.agentReleaseId);
  if (release === null) return [];
  const unkept = snapshot.filter((server) => server.url === undefined);
  const rows =
    unkept.length === 0
      ? []
      : await executor
          .select({ id: workspaceMcpServers.id, url: workspaceMcpServers.url })
          .from(workspaceMcpServers)
          .where(
            and(
              eq(workspaceMcpServers.workspaceId, session.workspaceId),
              inArray(
                workspaceMcpServers.id,
                unkept.map((server) => server.id),
              ),
              notDeleted(workspaceMcpServers),
            ),
          );
  const urls = new Map(rows.map((row) => [row.id, row.url]));
  return snapshot.flatMap((server) => {
    const url = server.url ?? urls.get(server.id);
    const tools = visibleMcpTools(server.name, server.tools, release.deny);
    return url === undefined || tools.length === 0
      ? []
      : [
          {
            releaseId: session.agentReleaseId as string,
            serverId: server.id,
            name: server.name,
            url,
            tools,
          },
        ];
  });
}

export function createPostgresWorkspaceMcpEgressStore(
  db: Database,
): WorkspaceMcpEgressStore {
  return {
    async sessionState(input): Promise<WorkspaceMcpSessionState | null> {
      const [session] = await db
        .select({
          ownerId: sessions.ownerId,
          workspaceId: sessions.workspaceId,
          agentReleaseId: sessions.agentReleaseId,
          createdByUserId: sessions.createdByUserId,
          createdByApiKeyId: sessions.createdByApiKeyId,
          workspaceMcpStart: sessions.workspaceMcpStart,
        })
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .limit(1);
      if (
        !session ||
        session.agentReleaseId === null ||
        session.workspaceId === null
      ) {
        return null;
      }
      const started = snapshotOf(session.workspaceMcpStart).find(
        (server) => server.name === input.server,
      );
      if (started === undefined) return null;
      const release = await releaseDenyOf(db, session.agentReleaseId);
      if (release === null) return null;
      const [row] = await db
        .select({
          name: workspaceMcpServers.name,
          url: workspaceMcpServers.url,
          tools: workspaceMcpServers.tools,
          on: agentWorkspaceMcpServers.serverId,
          state: workspaceMcpConnections.state,
          generation: workspaceMcpConnections.generation,
        })
        .from(workspaceMcpServers)
        .leftJoin(
          agentWorkspaceMcpServers,
          and(
            eq(agentWorkspaceMcpServers.serverId, workspaceMcpServers.id),
            eq(agentWorkspaceMcpServers.workspaceId, session.workspaceId),
            eq(agentWorkspaceMcpServers.agentId, release.agentId),
          ),
        )
        .leftJoin(
          workspaceMcpConnections,
          and(
            eq(workspaceMcpConnections.serverId, workspaceMcpServers.id),
            eq(workspaceMcpConnections.subject, SUBJECT),
          ),
        )
        .where(
          and(
            eq(workspaceMcpServers.workspaceId, session.workspaceId),
            eq(workspaceMcpServers.id, started.id),
            notDeleted(workspaceMcpServers),
          ),
        )
        .limit(1);
      const stored = new Set(
        (row?.tools ?? []).map((tool) => `mcp__${started.name}__${tool.name}`),
      );
      const tools = visibleMcpTools(
        started.name,
        started.tools.filter((tool) => stored.has(tool)),
        release.deny,
      );
      const [turn] = await db
        .select({ sequence: turns.sequence })
        .from(turns)
        .where(
          and(
            eq(turns.sessionId, input.sessionId),
            eq(turns.attemptId, input.attemptId),
            eq(turns.status, "running"),
          ),
        )
        .limit(1);
      return {
        ownerId: session.ownerId,
        workspaceId: session.workspaceId,
        agentId: release.agentId,
        releaseId: session.agentReleaseId,
        serverId: started.id,
        available:
          row !== undefined &&
          row.name === started.name &&
          (started.url === undefined || row.url === started.url) &&
          row.on !== null,
        url: row?.url ?? null,
        connection:
          row === undefined
            ? null
            : {
                state: row.state ?? "none",
                generation: row.generation ?? 0,
              },
        tools,
        turnId: turn === undefined ? null : String(turn.sequence),
        actor: creatorOf(session, release.agentId),
      };
    },

    async recordRefusal(record: WorkspaceMcpRefusalRecord): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .insert(receipts)
          .values({
            id: record.id,
            ownerId: record.ownerId,
            operation: "call_mcp",
            targetRef: {
              session_id: record.sessionId,
              turn_id: record.turnId,
              request_id: null,
            },
            status: record.status,
            result: record.result,
            error: { code: "CREDENTIAL_UNBOUND", message: record.message },
            actor: record.actor,
          })
          .onConflictDoNothing({ target: receipts.id });
      });
    },

    async recordCall(record: WorkspaceMcpCallRecord): Promise<boolean> {
      return await db.transaction(async (tx) => {
        // Held until the receipt is in: a reconnect waits, so the
        // generation named is the one whose credential was read.
        const [connection] = await tx
          .select({ generation: workspaceMcpConnections.generation })
          .from(workspaceMcpConnections)
          .where(
            and(
              eq(
                workspaceMcpConnections.serverId,
                record.result.workspace_server_id,
              ),
              eq(workspaceMcpConnections.subject, SUBJECT),
              eq(workspaceMcpConnections.state, "active"),
              eq(
                workspaceMcpConnections.generation,
                record.result.connection_generation,
              ),
            ),
          )
          .for("share");
        if (connection === undefined) return false;
        await tx.insert(receipts).values({
          id: record.id,
          ownerId: record.ownerId,
          operation: "call_mcp",
          targetRef: {
            session_id: record.sessionId,
            turn_id: record.turnId,
            request_id: null,
          },
          status: "accepted",
          result: record.result,
          actor: record.actor,
        });
        return true;
      });
    },
  };
}
