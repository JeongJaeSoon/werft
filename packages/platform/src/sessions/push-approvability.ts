import type {
  PushApprovabilityVerdict,
  PushRequestOrigin,
  PushRequestState,
} from "@werft-ai/contracts";
import type { PushSource } from "./push-request-service.ts";

// The verdict's shape is contracts', so every surface words the same reasons.
export type {
  PushApprovabilityVerdict,
  PushUnapprovableReason,
} from "@werft-ai/contracts";

export type PushApprovabilitySession = {
  id: string;
  checkpointRevision: number | null;
};

export type PushApprovabilityRequest = {
  state: PushRequestState;
  checkpointRevision: number;
  gitCommit: string;
  /** Absent means a direct request. */
  origin?: PushRequestOrigin;
};

/** The commit a pinned revision holds as its snapshot or as a kept branch's tip. */
export function pinnedCarries(
  pinned: {
    gitCommit: string;
    sources?: ReadonlyArray<{ commit: string }> | undefined;
  },
  commit: string,
): boolean {
  return (
    pinned.gitCommit === commit ||
    (pinned.sources ?? []).some((source) => source.commit === commit)
  );
}

/**
 * Whether an approval of `request` would pass the server's decision check
 * (push-requests.ts decide, push-request-service.ts decide), judged the same
 * way and never stricter: the canonical rule for every surface that shows
 * a push as awaiting approval.
 *
 * An intent request is pinned to the revision its turn ended on, so the
 * pointer moving is no reason: it stays approvable while that revision still
 * verifies and carries the request's commit (`pinned_source_invalid` else).
 *
 * Without a `source` (the slack role holds no checkpoint store) a moved
 * revision counts as approvable: the commit is unknown there, and showing
 * a push as approvable that the server would refuse costs less than hiding
 * one it would take.
 */
export async function pushApprovability(
  session: PushApprovabilitySession,
  request: PushApprovabilityRequest,
  source?: PushSource,
): Promise<PushApprovabilityVerdict> {
  if (request.state !== "requested") {
    return { approvable: false, reason: "not_requested" };
  }
  if (request.origin === "intent") {
    if (source === undefined) return { approvable: true };
    const pinned = await source
      .readPushSourceAt(session.id, request.checkpointRevision)
      .catch(() => null);
    return pinned?.status === "ready" &&
      pinnedCarries(pinned, request.gitCommit)
      ? { approvable: true }
      : { approvable: false, reason: "pinned_source_invalid" };
  }
  if (session.checkpointRevision === request.checkpointRevision) {
    return { approvable: true };
  }
  if (source === undefined) return { approvable: true };
  // The approval service reads the manifest the same way and, unless it is
  // ready, leaves only the exact-revision rule standing.
  const latest = await source.readPushSource(session.id).catch(() => null);
  if (
    latest?.status === "ready" &&
    latest.revision === session.checkpointRevision &&
    latest.gitCommit === request.gitCommit
  ) {
    return { approvable: true };
  }
  return { approvable: false, reason: "checkpoint_moved" };
}
