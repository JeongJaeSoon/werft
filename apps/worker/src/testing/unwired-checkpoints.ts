import type { WorkerCheckpointPort } from "../checkpoint.ts";

/**
 * Checkpoints nothing and restores nothing: a session that *has* a
 * checkpoint refuses to start rather than quietly opening a fresh engine
 * session on top of its workspace. For tests that run a host without an
 * object store; the composition root binds `SessionCheckpoints`.
 */
export const unwiredCheckpoints: WorkerCheckpointPort = {
  async restorePlan(claim) {
    const restore = claim.restore;
    if (restore === null) return { mode: "new" };
    throw new Error(
      `Session needs checkpoint revision ${restore.revision} restored, and this worker has no restorer bound`,
    );
  },
  async capture() {
    return null;
  },
};
