import type { AgentStore } from "../ports/agent-store.ts";
import {
  catalogProfile,
  modelSuccessor,
  type SessionCatalogView,
} from "../sessions/catalog.ts";

export const MODEL_MOVE_POLL_INTERVAL_MS = 60_000;
export const MODEL_MOVE_PAGE = 200;
// A failed move is tried again after this long, not at every pass.
export const MODEL_MOVE_RETRY_MS = 15 * 60_000;

export type ModelMoveStep =
  | { status: "applied"; from: string; to: string }
  | { status: "skipped" | "superseded" }
  | { status: "failed"; reason: string; from: string; to: string };

export type ModelMoveRunnerLogger = {
  info(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
};

/**
 * Moves each agent whose active release runs a model that left its profile's
 * list onto the same-family successor (94S-1475). The candidates are read from
 * the catalog at every pass, so nothing is queued: a move that lost a race
 * is found again, one that worked is gone from the list. A failed move
 * tells the administrators once per activation revision and waits
 * `retryMs` before it is tried again.
 */
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
  // Per replica and in memory: a restart tries a failed move once more, and
  // the notice's key keeps that from telling anyone twice.
  const retryAt = new Map<string, number>();

  /** One pass over every candidate. Returns how many agents moved. */
  async function runOnce(stopped: () => boolean = () => false) {
    let moved = 0;
    let after: string | null = null;
    for (;;) {
      const rows = await store.modelMigrationCandidates({ after, limit: page });
      for (const row of rows) {
        if (stopped()) return moved;
        const profile = catalogProfile(deps.catalog, row.profileId);
        // A workspace profile is not in this view until a request reads it;
        // the service looks it up again and skips what it cannot.
        if (
          profile !== undefined &&
          modelSuccessor(profile, row.model) === null
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
