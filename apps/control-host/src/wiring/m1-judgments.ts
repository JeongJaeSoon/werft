import {
  createPostgresJudgmentBatchStore,
  createPostgresJudgmentContexts,
  createPostgresM1JudgmentStore,
} from "@werft-ai/db";
import {
  type AgentStore,
  createM1Judge,
  createM1JudgmentRunner,
  judgmentCallOf,
  type M1Release,
  type SessionCatalog,
} from "@werft-ai/platform";
import { wireConversationCallExecutor } from "./conversation-calls.ts";

type ExecutorDeps = Parameters<typeof wireConversationCallExecutor>[0];
type Deps = Omit<ExecutorDeps, "logger"> & {
  agents: Pick<AgentStore, "get">;
  catalog: Pick<SessionCatalog, "connections">;
  logger: ExecutorDeps["logger"] &
    Parameters<typeof createM1JudgmentRunner>[0]["logger"];
};

/**
 * M1's shadow judge over PostgreSQL (a1/J5): the buffer's batches and the
 * replies of bound or lately engaged threads, judged on the agent's active
 * release and recorded, never answered.
 */
export function wireM1JudgmentRunner(deps: Deps) {
  const store = createPostgresM1JudgmentStore(deps.db);
  const judge = createM1Judge({
    gate: (subject) => store.gateOpen(subject),
    async release(subject): Promise<M1Release> {
      const agent = await deps.agents.get(subject.workspaceId, subject.agentId);
      const release = agent?.active_release ?? null;
      if (release === null) return { outcome: "no_active_release" };
      const call = judgmentCallOf(deps.catalog, release);
      // The agent's instructions are not loaded yet: the fixed rules alone.
      return call.outcome === "ready"
        ? { ...call, instructions: "" }
        : { outcome: "unavailable", releaseId: release.id };
    },
    context: createPostgresJudgmentContexts(deps.db),
    executor: wireConversationCallExecutor(deps),
  });
  return createM1JudgmentRunner({
    batches: createPostgresJudgmentBatchStore(deps.db),
    store,
    judge,
    logger: deps.logger,
  });
}
