import { type ImageRuntime, restorableSchemesOf } from "@werft-ai/runtime-core";
import {
  canRestoreCheckpoint,
  type PointerRuntime,
  sameCombination,
  selectWorkerImage,
  type WorkerImageCandidate,
} from "./worker-images.ts";

/**
 * A worker image as a release configures it, or as a launch still holding a
 * slot runs it. A null runtime is one nothing declared: an image configured
 * without one, or a launch reserved without one.
 */
export type UpgradeImage = {
  readonly image: string;
  readonly runtime: ImageRuntime | null;
};

type Images<I> = readonly [I, ...I[]];

/** A session holding an uncollected checkpoint, as the database reads it. */
export type UpgradeSession = {
  readonly sessionId: string;
  readonly pointer: PointerRuntime;
};

export type UnresumableReason =
  /** Its pointer's runtime runs on neither target image. */
  | "no_image"
  /** Its pointer was committed before runtimes were recorded. */
  | "unrecorded";

export type AffectedSession = {
  readonly sessionId: string;
  readonly reason: UnresumableReason;
};

export type UpgradeAssessment = {
  readonly verdict: "proceed" | "refused";
  readonly affected: readonly AffectedSession[];
  readonly approved: readonly string[];
  readonly reason?: string;
};

/**
 * An upgrade that replaces no worker image, `because` naming why. Approvals
 * stay in the release values, so a stale list must be cleared before any
 * upgrade: carried to a later one it could approve sessions the operator
 * never read.
 */
export function assessNothingReplaced(
  approvedSessions: readonly string[],
  because: string,
): UpgradeAssessment {
  const approved = [...new Set(approvedSessions)].sort();
  return approved.length === 0
    ? { verdict: "proceed", affected: [], approved: [] }
    : {
        verdict: "refused",
        affected: [],
        approved,
        reason: `${because}, so upgrade.approvedSessions must be empty — no longer affected: ${approved.join(" ")}`,
      };
}

/**
 * Whether a release may change the worker images the cluster runs. It goes
 * ahead with nothing approved when the newest image stays and every deployed
 * image stays under the runtime it was declared with: no session then runs
 * elsewhere than it does now. Otherwise every session the target images
 * cannot resume must be approved, exactly: one more or one fewer means the
 * list the operator read is not the one that would break.
 *
 * No approval covers a worker that is still running: it keeps sealing
 * checkpoints after this check. So what it seals must stay restorable, both
 * on the deployed newest image, which new sessions start on until the
 * rollout, and on every launch still holding a slot. A writer whose
 * checkpoints the deployed images cannot restore either is stranded already,
 * not by this release.
 */
export function assessUpgrade(input: {
  /** Newest first, as the cluster runs them now. */
  readonly deployed: Images<UpgradeImage>;
  /** Newest first, as the target release configures them. */
  readonly target: Images<WorkerImageCandidate<string>>;
  /** What the launches that have not released their slot run. */
  readonly writers: readonly UpgradeImage[];
  readonly sessions: readonly UpgradeSession[];
  readonly approved: readonly string[];
}): UpgradeAssessment {
  const { deployed, target } = input;
  const changed = deployed
    .filter((image) => !kept(image, target))
    .map(({ image }) => image);
  if (changed.length === 0 && kept(deployed[0], [target[0]])) {
    return assessNothingReplaced(
      input.approved,
      "the worker images do not change",
    );
  }
  const approved = [...new Set(input.approved)].sort();
  const affected = input.sessions
    .flatMap((session): AffectedSession[] => {
      const reason = unresumable(session, target);
      return reason === null ? [] : [{ sessionId: session.sessionId, reason }];
    })
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const stranded = [
    ...new Set(
      [deployed[0], ...input.writers]
        .filter(
          (writer) => resumesOn(writer, deployed) && !resumesOn(writer, target),
        )
        .map(({ image }) => image),
    ),
  ].sort();
  if (stranded.length > 0) {
    return {
      verdict: "refused",
      affected,
      approved,
      reason: `workers on ${stranded.join(" ")} keep sealing checkpoints after this check and no target image restores them, so no approval covers them: keep the image in the target release, or wait until no launch on it holds a slot`,
    };
  }
  const ids = affected.map((session) => session.sessionId);
  const missing = ids.filter((id) => !approved.includes(id));
  const extra = approved.filter((id) => !ids.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    return {
      verdict: "refused",
      affected,
      approved,
      reason: `${ids.length} session(s) could resume on no target image (deployed images dropped or redeclared: ${changed.join(" ") || "none"}; newest ${deployed[0].image} → ${target[0].image}); approve exactly this list in upgrade.approvedSessions${ids.length === 0 ? " (empty)" : ""} — not approved: ${missing.join(" ") || "none"}; no longer affected: ${extra.join(" ") || "none"}`,
    };
  }
  return { verdict: "proceed", affected, approved };
}

// Only what image choice reads counts: a runtime nothing declared was never
// compared, so the same digest is all that can be asked of it.
function kept(
  deployed: UpgradeImage,
  target: readonly WorkerImageCandidate<string>[],
): boolean {
  return target.some(
    ({ image, runtime }) =>
      image === deployed.image &&
      (deployed.runtime === null ||
        (sameCombination(deployed.runtime, runtime) &&
          restorableSchemesOf(deployed.runtime).join() ===
            restorableSchemesOf(runtime).join())),
  );
}

// A writer with no runtime recorded seals whatever its image runs, which only
// the same digest is known to restore.
function resumesOn(
  writer: UpgradeImage,
  images: readonly UpgradeImage[],
): boolean {
  return images.some(({ image, runtime }) =>
    writer.runtime === null || runtime === null
      ? image === writer.image
      : canRestoreCheckpoint(runtime, writer.runtime),
  );
}

// A launch runs an unrecorded pointer on the newest image and lets the
// restore judge it; before an upgrade that judgement is not available, so
// it counts as affected.
function unresumable(
  { pointer }: UpgradeSession,
  target: Images<WorkerImageCandidate<string>>,
): UnresumableReason | null {
  if (pointer.kind === "unrecorded") return "unrecorded";
  return selectWorkerImage(pointer, target).kind === "none" ? "no_image" : null;
}
