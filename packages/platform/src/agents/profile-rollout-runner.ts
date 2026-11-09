import type { AgentStore } from "../ports/agent-store.ts";
import type {
  ClaimedRolloutItem,
  ProfileRolloutStore,
  RolloutItemResult,
} from "../ports/profile-rollout-store.ts";
import { judgeProfileRollout } from "../sessions/profile-rollout-policy.ts";

export const ROLLOUT_LEASE_MS = 60_000;
export const ROLLOUT_BATCH = 20;
export const ROLLOUT_POLL_INTERVAL_MS = 10_000;
// A change of mind under the agent's lock is judged again this many times.
const MAX_JUDGMENTS = 3;

export type RolloutStep =
  | { status: "applied" | "superseded" | "retry" }
  | { status: "failed"; reason: string };

export type RolloutRunnerLogger = {
  info(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
};

/**
 * Moves the agents that follow a profile onto its newest version, one item
 * at a time (design 2.3). The delivery is at least once and the apply is
 * idempotent: an item is judged from what the agent runs now, never from what
 * the item says, and the release it makes has a fixed id. Two replicas on one
 * item end with one release. A failed item is not taken again; only a
 * person's retry reopens it.
 */
export function createProfileRolloutRunner(deps: {
  rollouts: ProfileRolloutStore;
  agentStore: Pick<AgentStore, "get">;
  agents: {
    rolloutRelease(input: {
      workspaceId: string;
      agentId: string;
      actorUserId: string | null;
      targetProfileId: string;
    }): Promise<RolloutStep>;
  };
  logger: RolloutRunnerLogger;
  /**
   * Whether this replica also writes the items the insert-time write missed.
   * The store holds back until the one-time fill has run.
   */
  sweep?: boolean;
  leaseMs?: number;
  batch?: number;
}) {
  const { rollouts, agentStore, agents, logger } = deps;
  const leaseMs = deps.leaseMs ?? ROLLOUT_LEASE_MS;
  const batch = deps.batch ?? ROLLOUT_BATCH;
  // One warning per hold, not one per pass.
  let warnedHeld = false;

  async function judge(item: ClaimedRolloutItem): Promise<RolloutItemResult> {
    let last: RolloutStep = { status: "superseded" };
    for (let tries = 0; tries < MAX_JUDGMENTS; tries++) {
      const record = await agentStore.get(item.workspaceId, item.agentId);
      const active = record?.active_release ?? null;
      if (!record || !active) return { status: "superseded" };
      const seen = await rollouts.inspect({
        agentId: item.agentId,
        targetProfileId: item.targetProfileId,
        activeProfileId: active.runtime_profile_id,
      });
      const decision = judgeProfileRollout(seen);
      if (decision.status !== "release") return decision;
      last = await agents.rolloutRelease({
        workspaceId: item.workspaceId,
        agentId: item.agentId,
        actorUserId: item.actorUserId,
        targetProfileId: decision.profileId,
      });
      if (last.status === "applied") return { status: "applied" };
      if (last.status === "failed") {
        return { status: "failed", reasonCode: last.reason };
      }
    }
    return last.status === "retry"
      ? { status: "failed", reasonCode: "revision_conflict" }
      : { status: "superseded" };
  }

  /** One pass: the sweep when on, then one batch. Returns items settled. */
  async function runOnce(stopped: () => boolean = () => false) {
    if (deps.sweep === true) {
      const swept = await rollouts.sweep();
      if (swept.items > 0 || swept.rollouts > 0) {
        logger.info("Profile rollouts swept", swept);
      }
      const held = swept.held ?? 0;
      if (held > 0 && !warnedHeld) {
        logger.warn(
          "Profile rollout sweep is holding back: agents are behind their profile and the one-time fill has not recorded its completion (run the profile fill once; a fill made by the earlier code needs one more run)",
          { agents: held },
        );
      }
      warnedHeld = held > 0;
    }
    const items = await rollouts.claim({ leaseMs, limit: batch });
    let settled = 0;
    for (const [index, item] of items.entries()) {
      if (stopped()) {
        await rollouts.abandon(items.slice(index));
        break;
      }
      try {
        const result = await judge(item);
        if (await rollouts.settle(item, result)) settled++;
        else {
          logger.warn("Profile rollout lease was lost; result dropped", {
            agent: item.agentId,
            rollout: item.rolloutId,
          });
        }
      } catch (error) {
        logger.warn("Profile rollout item could not be applied", {
          agent: item.agentId,
          rollout: item.rolloutId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { claimed: items.length, settled };
  }

  function start(intervalMs = ROLLOUT_POLL_INTERVAL_MS) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();
    const tick = () => {
      running = (async () => {
        try {
          while (!stopped && (await runOnce(() => stopped)).claimed > 0) {}
        } catch (error) {
          logger.warn("Profile rollout runner could not claim", {
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

export type ProfileRolloutRunner = ReturnType<
  typeof createProfileRolloutRunner
>;
