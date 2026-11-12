import {
  DEFAULT_PAUSED_WORKSPACE_TTL_MS,
  DEFAULT_STOPPED_WORKSPACE_TTL_MS,
  type ReclaimOptions,
  type SchedulerLogger,
  type SchedulerRunSummary,
} from "./options.ts";
import { messageOf } from "./pass-context.ts";
import type {
  ManagedWorkspace,
  WorkspaceRemovalResult,
} from "./ports/execution-backend.ts";
import type {
  PendingWorkspaceReclaim,
  SchedulerStore,
  WorkspaceReclaimClaim,
  WorkspaceTtls,
} from "./ports/scheduler-store.ts";

/**
 * Reclaim the workspace volumes of sessions nothing will come back to, and
 * of sessions stopped or paused for longer than their TTL. Runs as the last step of a
 * pass, and on its own from `reclaimWorkspaces`.
 */
export async function collectWorkspaces(
  options: ReclaimOptions,
  summary: SchedulerRunSummary,
  lock: AbortSignal,
): Promise<void> {
  const { backend, logger, store } = options;
  const { listWorkspaces, removeWorkspace } = backend;
  // A backend whose workspaces it does not own leaves both out; there is
  // then nothing here to reclaim.
  if (!listWorkspaces || !removeWorkspace) return;
  const ttls: WorkspaceTtls = {
    stoppedTtlMs:
      options.stoppedWorkspaceTtlMs ?? DEFAULT_STOPPED_WORKSPACE_TTL_MS,
    pausedTtlMs:
      options.pausedWorkspaceTtlMs ?? DEFAULT_PAUSED_WORKSPACE_TTL_MS,
  };
  const removal: WorkspaceRemoval = {
    logger,
    remove: (id, sessionId) => removeWorkspace.call(backend, id, { sessionId }),
    store,
    summary,
  };
  let pending: PendingWorkspaceReclaim[];
  try {
    // A claim an earlier pass could not settle keeps its session from
    // resuming, and its volume may already be gone from any listing.
    pending = await store.listPendingWorkspaceReclaims();
  } catch (error) {
    summary.workspaceScanFailed = true;
    logger.error("Listing pending workspace reclaims failed; none reclaimed", {
      error: messageOf(error),
    });
    return;
  }
  for (const claim of pending) {
    lock.throwIfAborted();
    await removeClaimed(removal, claim);
  }
  let workspaces: ManagedWorkspace[];
  let retained: Set<string>;
  let closedLegacy: Set<string>;
  try {
    // Workspaces first, then the rows. A session created between the two
    // calls is in the retained set, so its brand-new workspace is kept;
    // asking the database first would make that same workspace look
    // unowned by the time it was listed.
    workspaces = await listWorkspaces.call(backend);
    if (workspaces.length === 0) return;
    const labelled: string[] = [];
    const named: string[] = [];
    for (const { sessionFrom, sessionId } of workspaces) {
      if (sessionId === null) continue;
      (sessionFrom === "name" ? named : labelled).push(sessionId);
    }
    retained =
      labelled.length === 0
        ? new Set<string>()
        : new Set(await store.filterRetainedSessions(labelled, ttls));
    closedLegacy =
      named.length === 0
        ? new Set<string>()
        : new Set(await store.filterClosedLegacySessions(named));
  } catch (error) {
    // Nothing was removed, so nothing is inconsistent; the next pass
    // reclaims whatever this one could not even look at. It is still a
    // failure, and a pass that keeps failing here keeps leaking disk.
    summary.workspaceScanFailed = true;
    logger.error("Listing workspaces for reclaim failed; none reclaimed", {
      error: messageOf(error),
    });
    return;
  }
  for (const workspace of workspaces) {
    const { id, sessionId } = workspace;
    if (sessionId === null) {
      // Fail-safe, as with an unparseable container: a workspace whose
      // owner cannot be read is left in place and reported, never guessed
      // at from its name.
      logger.warn("Workspace carries no session; left in place", {
        created_at: workspace.createdAt.toISOString(),
        workspace_id: id,
      });
      continue;
    }
    if (workspace.sessionFrom === "name") {
      // A name is only a nomination: anything short of a closed row stays,
      // a stopped one included — the TTL is for workspaces a label proves.
      // Closed is final, so there is no resume for a claim to hold off.
      if (!closedLegacy.has(sessionId)) continue;
      lock.throwIfAborted();
      await removeUnclaimed(removal, sessionId, id);
      continue;
    }
    if (retained.has(sessionId)) continue;
    lock.throwIfAborted();
    // The listing's verdict was read without a lock; this one is taken
    // under the session's, which is what a resume waits on.
    let claim: WorkspaceReclaimClaim;
    try {
      claim = await store.claimWorkspaceReclaim({
        sessionId,
        workspaceId: id,
        ...ttls,
      });
    } catch (error) {
      summary.workspacesFailed.push(id);
      logger.error("Claiming workspace for reclaim failed", {
        error: messageOf(error),
        session_id: sessionId,
        workspace_id: id,
      });
      continue;
    }
    if (claim.kind === "retained") continue;
    if (claim.kind === "claimed") {
      await removeClaimed(removal, {
        sessionId,
        claimId: claim.claimId,
        workspaceId: id,
      });
      continue;
    }
    await removeUnclaimed(removal, sessionId, id);
  }
}

/** A removal nothing can race: the session is closed or has no row. */
async function removeUnclaimed(
  removal: WorkspaceRemoval,
  sessionId: string,
  id: string,
): Promise<void> {
  let outcome: WorkspaceRemovalResult["outcome"];
  try {
    outcome = (await removal.remove(id, sessionId)).outcome;
  } catch (error) {
    removal.summary.workspacesFailed.push(id);
    removal.logger.error("Reclaiming workspace failed", {
      error: messageOf(error),
      session_id: sessionId,
      workspace_id: id,
    });
    return;
  }
  recordRemoval(removal, sessionId, id, outcome);
}

type WorkspaceRemoval = {
  logger: SchedulerLogger;
  remove: (id: string, sessionId: string) => Promise<WorkspaceRemovalResult>;
  store: SchedulerStore;
  summary: SchedulerRunSummary;
};

/**
 * Removes a claimed workspace and settles the claim. A removal that threw
 * keeps the claim, and with it the session's resume on hold: whether the
 * volume is still there is unknown, and the next pass finds out.
 */
async function removeClaimed(
  removal: WorkspaceRemoval,
  claim: PendingWorkspaceReclaim,
): Promise<void> {
  const { logger, store, summary } = removal;
  const { claimId, sessionId, workspaceId } = claim;
  let outcome: WorkspaceRemovalResult["outcome"];
  try {
    outcome = (await removal.remove(workspaceId, sessionId)).outcome;
  } catch (error) {
    summary.workspacesFailed.push(workspaceId);
    logger.error("Reclaiming claimed workspace failed; claim kept for retry", {
      error: messageOf(error),
      session_id: sessionId,
      workspace_id: workspaceId,
    });
    return;
  }
  try {
    await store.finishWorkspaceReclaim({
      outcome:
        outcome === "removed" || outcome === "absent" ? "removed" : "released",
      claimId,
      sessionId,
    });
  } catch (error) {
    summary.workspacesFailed.push(workspaceId);
    logger.error("Settling workspace reclaim failed; claim kept for retry", {
      error: messageOf(error),
      outcome,
      session_id: sessionId,
      workspace_id: workspaceId,
    });
    return;
  }
  recordRemoval(removal, sessionId, workspaceId, outcome);
}

function recordRemoval(
  { logger, summary }: WorkspaceRemoval,
  sessionId: string,
  id: string,
  outcome: WorkspaceRemovalResult["outcome"],
): void {
  if (outcome === "removed" || outcome === "absent") {
    summary.workspacesReclaimed.push(id);
    logger.info("Workspace reclaimed", {
      outcome,
      session_id: sessionId,
      workspace_id: id,
    });
    return;
  }
  summary.workspacesUnresolved.push(id);
  logger.warn("Workspace was not reclaimed", {
    outcome,
    session_id: sessionId,
    workspace_id: id,
  });
}
