import type { ProfileRollout } from "@werft-ai/contracts";

/** One agent's turn in a profile rollout (design 2.3). */
export type RolloutItemRef = {
  rolloutId: string;
  agentId: string;
  generation: number;
};

/** An item this replica holds the lease of. */
export type ClaimedRolloutItem = RolloutItemRef & {
  /** Unique to the claim call; only its holder may write the result. */
  claim: string;
  workspaceId: string;
  targetProfileId: string;
  /** The rollout's actor: the person who made the profile version. */
  actorUserId: string | null;
};

export type RolloutItemResult =
  | { status: "applied" | "superseded" }
  | { status: "failed"; reasonCode: string };

/** A profile row as a rollout judges it. */
export type RolloutProfile = {
  id: string;
  version: number;
  definition: Record<string, unknown>;
  /** The deny column; its `mcp__` names are part of what the profile runs. */
  deny: readonly string[] | null;
};

/** The profile an agent runs and the newest of the same lineage. */
export type RolloutInspection = {
  /** Null when the agent is gone. */
  tracking: "follow" | "pinned" | null;
  /** False when the two profiles are not versions of one profile. */
  sameLineage: boolean;
  latest: RolloutProfile | null;
  active: RolloutProfile | null;
};

export type BackfillReport = {
  dryRun: boolean;
  /** Following agents on a profile whose form is not the lineage's latest. */
  pinned: string[];
  /** Fixed-model agents whose model is their profile's default. */
  modelFollowsProfile: string[];
};

export interface ProfileRolloutStore {
  /**
   * Pending items whose lease is free or over, leased to one new claim token.
   * An item claimed too often is failed `retries_exhausted`, never retried.
   */
  claim(input: {
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedRolloutItem[]>;
  /**
   * Writes the result of a claimed item, only while that claim still holds a
   * live lease. False: the lease was lost and nothing was written.
   */
  settle(item: ClaimedRolloutItem, result: RolloutItemResult): Promise<boolean>;
  /**
   * Gives claimed items that were never started back at once (a stopping
   * replica). Only the items named: one that was tried keeps its attempt.
   */
  abandon(items: readonly ClaimedRolloutItem[]): Promise<number>;
  /** A failed item back to pending: the one way a person resumes it. */
  retry(item: RolloutItemRef): Promise<boolean>;
  /**
   * The same for one agent's failed items of a profile version, found by the
   * profile and the workspace the agent is in. False: none was failed.
   */
  retryFailed(input: {
    workspaceId: string;
    targetProfileId: string;
    agentId: string;
  }): Promise<boolean>;
  /** Each profile version's rollout in one workspace, for the screens. */
  summaries(workspaceId: string): Promise<Map<string, ProfileRollout>>;
  /**
   * Puts in the items the insert-time write missed (design 2.3, the sweep).
   * Writes the outbox, so it is run only once the writer is open.
   * Agents behind their profile in a lineage that has no rollout of its own,
   * before a recorded fill, belong to the one-time fill: nothing is written
   * for them (a rollout there would keep the fill from pinning them) and `held`
   * counts them.
   */
  sweep(): Promise<{ rollouts: number; items: number; held?: number }>;
  inspect(input: {
    agentId: string;
    targetProfileId: string;
    activeProfileId: string;
  }): Promise<RolloutInspection>;
  /**
   * The one-time fill of `profile_tracking` and `model_source` before the
   * outbox is written. Lineages that already have a rollout are the sweep's
   * and are left alone; a real run is refused when only those are behind.
   */
  backfill(input: {
    dryRun: boolean;
  }): Promise<BackfillReport | { refused: "rollouts_exist" }>;
}
