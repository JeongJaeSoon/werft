import type { AgentStore } from "../ports/agent-store.ts";
import {
  connectionOf,
  modelSuccessor,
  type SessionCatalogView,
} from "../sessions/catalog.ts";

export const MODEL_MOVE_POLL_INTERVAL_MS = 60_000;
export const MODEL_MOVE_PAGE = 200;
export const MODEL_MOVE_RETRY_MS = 15 * 60_000;

export type ModelMoveStep =
  | { status: "applied"; from: string; to: string }
  | { status: "skipped" | "superseded" }
  | {
      status: "failed";
      reason: string;
      from: string;
      to: string;
      releaseId: string;
      revision: number;
    };

export type ModelMoveRunnerLogger = {
  info(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
};

export function createModelMoveRunner(deps: {
  store: Pick<AgentStore, "modelMigrationCandidates"> &
    Pick<AgentStore, "notifyModelMigrationFailed">;
  catalog: SessionCatalogView;
  agents: {
    migrateModel(input: {
      workspaceId: string;
      agentId: string;
    }): Promise<ModelMoveStep>;
  };
  logger: ModelMoveRunnerLogger;
  page?: number;
  retryMs?: number;
  now?: () => number;
}) {
  const { store, agents, logger } = deps;
  const page = deps.page ?? MODEL_MOVE_PAGE;
  const retryMs = deps.retryMs ?? MODEL_MOVE_RETRY_MS;
  const now = deps.now ?? Date.now;
  const retryAt = new Map<string, number>();

  async function runOnce(stopped: () => boolean = () => false) {
    let moved = 0;
    let after: string | null = null;
    for (;;) {
      const rows = await store.modelMigrationCandidates({ after, limit: page });
      for (const row of rows) {
        if (stopped()) return moved;
        const connection = connectionOf(deps.catalog, row.connectionId);
        if (
          connection !== undefined &&
          modelSuccessor(connection, row.model) === null
        )
          continue;
        if ((retryAt.get(row.agentId) ?? 0) > now()) continue;
        try {
          const step = await agents.migrateModel({
            workspaceId: row.workspaceId,
            agentId: row.agentId,
          });
          if (step.status === "applied") {
            retryAt.delete(row.agentId);
            moved += 1;
            logger.info("Agent moved to the next model of its series", {
              agent: row.agentId,
              from: step.from,
              to: step.to,
            });
          } else if (step.status === "skipped") {
            retryAt.set(row.agentId, now() + retryMs);
          } else if (step.status === "failed") {
            retryAt.set(row.agentId, now() + retryMs);
            await store.notifyModelMigrationFailed({
              workspaceId: row.workspaceId,
              agentId: row.agentId,
              from: step.from,
              to: step.to,
              reason: step.reason,
              releaseId: step.releaseId,
              revision: step.revision,
            });
            logger.warn("Agent could not move to the next model", {
              agent: row.agentId,
              from: step.from,
              to: step.to,
              reason: step.reason,
            });
          }
        } catch (error) {
          retryAt.set(row.agentId, now() + retryMs);
          logger.warn("Agent model move failed", {
            agent: row.agentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (rows.length < page) return moved;
      after = rows[rows.length - 1]?.agentId ?? null;
    }
  }

  function start(intervalMs = MODEL_MOVE_POLL_INTERVAL_MS) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();
    const tick = () => {
      running = (async () => {
        try {
          await runOnce(() => stopped);
        } catch (error) {
          logger.warn("Model move runner could not read its candidates", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!stopped) timer = setTimeout(tick, intervalMs);
      })();
    };
    timer = setTimeout(tick, intervalMs);
    return {
      async stop() {
        stopped = true;
        clearTimeout(timer);
        await running;
      },
    };
  }

  return { runOnce, start };
}

export type ModelMoveRunner = ReturnType<typeof createModelMoveRunner>;
