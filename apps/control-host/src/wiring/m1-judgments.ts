import { type AgentRelease, judgmentInstructionsOf } from "@werft-ai/contracts";
import {
  createPostgresConversationCalls,
  createPostgresConversationTurnQueue,
  createPostgresJudgmentBatchStore,
  createPostgresJudgmentContexts,
  createPostgresM1JudgmentStore,
  createPostgresM1SpeakStore,
  createPostgresMentionTurnStatuses,
  createPostgresSummaryFoldContexts,
  createPostgresSummaryFoldStore,
} from "@werft-ai/db";
import {
  type AgentStore,
  createConversationCalls,
  createM1Judge,
  createM1JudgmentRunner,
  createM1SpeakEffect,
  createSummaryFolder,
  judgmentCallOf,
  type M1Release,
  type SessionCatalog,
} from "@werft-ai/platform";
import { createUnsolicitedConversationTurns } from "../api/conversation-runtime.ts";
import { wireConversationCallExecutor } from "./conversation-calls.ts";

type ExecutorDeps = Parameters<typeof wireConversationCallExecutor>[0];
type Deps = Omit<ExecutorDeps, "logger"> & {
  agents: Pick<AgentStore, "get">;
  catalog: Pick<SessionCatalog, "connections">;
  /** Seals the turns a `speak` queues (v1-b/U1). */
  secretKey: Parameters<typeof createPostgresConversationTurnQueue>[1];
  logger: ExecutorDeps["logger"] &
    Parameters<typeof createM1JudgmentRunner>[0]["logger"];
};

/**
 * The release as M1 calls it, with the instructions its snapshot holds. A
 * release without one (no repository, a failed read, made before snapshots)
 * is judged on the fixed rules alone.
 */
export function m1ReleaseOf(
  catalog: Pick<SessionCatalog, "connections">,
  release: Pick<
    AgentRelease,
    "id" | "connection_id" | "runtime_config_snapshot" | "instructions_snapshot"
  >,
): M1Release {
  const call = judgmentCallOf(catalog, release);
  return call.outcome === "ready"
    ? {
        ...call,
        instructions:
          judgmentInstructionsOf(release.instructions_snapshot) ?? "",
      }
    : { outcome: "unavailable", releaseId: release.id };
}

/**
 * M1's judge over PostgreSQL (a1/J5): the buffer's batches and the replies
 * of bound or lately engaged threads, judged on the agent's active release
 * and recorded. Under the agent's rollout on, a `speak` takes effect
 * (v1-b/U1): the agent's own turn answers the post, or a held reply goes on
 * to its thread's work; under shadow it is recorded only. A summary a
 * batch's line takes past its cap is folded on the same release's judgment
 * model (a1/J10).
 */
export function wireM1JudgmentRunner(deps: Deps) {
  const store = createPostgresM1JudgmentStore(deps.db);
  const executor = wireConversationCallExecutor(deps);
  const gate = (subject: Parameters<typeof store.gateOpen>[0]) =>
    store.gateOpen(subject);
  async function release(subject: {
    workspaceId: string;
    agentId: string;
  }): Promise<M1Release> {
    const agent = await deps.agents.get(subject.workspaceId, subject.agentId);
    const active = agent?.active_release ?? null;
    if (active === null) return { outcome: "no_active_release" };
    return m1ReleaseOf(deps.catalog, active);
  }
  const judge = createM1Judge({
    gate,
    release,
    context: createPostgresJudgmentContexts(deps.db),
    executor,
  });
  return createM1JudgmentRunner({
    batches: createPostgresJudgmentBatchStore(deps.db),
    store,
    judge,
    speak: createM1SpeakEffect({
      store: createPostgresM1SpeakStore(deps.db),
      startTurn: createUnsolicitedConversationTurns({
        calls: createConversationCalls({
          store: createPostgresConversationCalls(deps.db),
          catalog: deps.catalog,
        }),
        queue: createPostgresConversationTurnQueue(deps.db, deps.secretKey),
        statuses: createPostgresMentionTurnStatuses(deps.db),
        agents: deps.agents,
        catalog: deps.catalog,
      }).start,
    }),
    folder: createSummaryFolder({
      gate,
      release,
      context: createPostgresSummaryFoldContexts(deps.db),
      store: createPostgresSummaryFoldStore(deps.db),
      executor,
    }),
    logger: deps.logger,
  });
}
