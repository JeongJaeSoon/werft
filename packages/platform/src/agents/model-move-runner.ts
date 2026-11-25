import { messageOf } from "@werft-ai/runtime-core";
import {
  connectionOf,
  modelSuccessor,
  type SessionCatalogView,
} from "../catalog/index.ts";
import { startPolling } from "../polling.ts";
import type { AgentStore } from "./ports/agent-store.ts";

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
  store: Pick<AgentStore, "modelMigrationCandidates">;
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
            error: messageOf(error),
          });
        }
      }
      if (rows.length < page) return moved;
      after = rows[rows.length - 1]?.agentId ?? null;
    }
  }

  function start(intervalMs = MODEL_MOVE_POLL_INTERVAL_MS) {
    return startPolling(intervalMs, runOnce, (error) =>
      logger.warn("Model move runner could not read its candidates", {
        error: messageOf(error),
      }),
    );
  }

  return { runOnce, start };
}
