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
  /** Listed, but nothing launches on it, so it restores nothing. */
  readonly retracted?: boolean;
};

type Images<I> = readonly [I, ...I[]];

/** A session holding an uncollected checkpoint, as the database reads it. */
export type UpgradeSession = {
  readonly sessionId: string;
  readonly pointer: PointerRuntime;
  /**
   * The engine a session not closed runs on (null: its runtime kind is none
   * this host runs). Left out, only its checkpoint is judged.
   */
  readonly engine?: string | null;
};

export type UnresumableReason =
  /** Its pointer's runtime runs on neither target image. */
  | "no_image"
  /** Its pointer was committed before runtimes were recorded. */
  | "unrecorded"
  /** No target image runs its engine: it would wait without a slot. */
  | "no_engine_image";

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
 * not by this release. A retracted image restores nothing, deployed or
 * target, and new sessions start on the newest unretracted one.
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
  const deployedNewest = newestLaunchable(deployed);
  const targetNewest = newestLaunchable(target);
  // New sessions start on each engine's newest image. A deployed image
  // nothing declared a runtime for (one image, unpinned) has no engine to
  // group by, so the whole list is one group, as with one engine.
  const groups: readonly (string | undefined)[] = deployed.some(
    ({ runtime }) => runtime === null,
  )
    ? [undefined]
    : [
        ...new Set(
          [...deployed, ...target].map(({ runtime }) => runtime?.engine ?? ""),
        ),
      ];
  const ofGroup = <I extends UpgradeImage>(
    images: readonly I[],
    engine: string | undefined,
  ) =>
    engine === undefined
      ? images
      : images.filter(({ runtime }) => runtime?.engine === engine);
  const changed = deployed
    .filter((image) => !kept(image, target))
    .map(({ image }) => image);
  if (
    changed.length === 0 &&
    groups.every((engine) => {
      const before = newestLaunchable(ofGroup(deployed, engine));
      const after = newestLaunchable(ofGroup(target, engine));
      // Both undefined: every image of it retracted on either side, so no
      // session of it launches before or after.
      return before === undefined
        ? after === undefined
        : after !== undefined && kept(before, [after]);
    })
  ) {
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
  const restorers = {
    deployed: deployed.filter((image) => !image.retracted),
    target: target.filter((image) => !image.retracted),
  };
  const stranded = (writers: readonly UpgradeImage[]) => [
    ...new Set(
      writers
        .filter(
          (writer) =>
            resumesOn(writer, restorers.deployed) &&
            !resumesOn(writer, restorers.target),
        )
        .map(({ image }) => image),
    ),
  ];
  // New sessions start on each until the rollout, so no wait ends this. An
  // engine the target lists no image of is dropped instead: its open
  // sessions are affected above, and its slot holders refused below.
  for (const engine of groups) {
    const newest = newestLaunchable(ofGroup(deployed, engine));
    if (
      newest !== undefined &&
      (engine === undefined || ofGroup(target, engine).length > 0) &&
      stranded([newest]).length > 0
    ) {
      const named = groups.length > 1 && engine !== undefined;
      return {
        verdict: "refused",
        affected,
        approved,
        reason: `workers on ${newest.image}, the deployed newest image${named ? ` of the ${engine} engine` : ""}, keep sealing checkpoints after this check and no unretracted target image restores them, so no approval covers them: keep that image unretracted in the target release, or list beside it one that restores its checkpoints (a fixed build of the same engine, SDK and CLI)${named ? `, or drop every ${engine} image from the target` : ""}`,
      };
    }
  }
  // A launch of a dropped engine is refused even when what it seals was
  // stranded already (its image retracted): no image of its engine is left
  // to take its session once it goes.
  const dropped = groups.filter(
    (engine): engine is string =>
      engine !== undefined && ofGroup(target, engine).length === 0,
  );
  const ofDropped = input.writers.filter(({ image, runtime }) =>
    dropped.some((engine) =>
      runtime === null
        ? ofGroup(deployed, engine).some((d) => d.image === image)
        : runtime.engine === engine,
    ),
  );
  const launches = [
    ...new Set([
      ...stranded(input.writers),
      ...ofDropped.map(({ image }) => image),
    ]),
  ].sort();
  if (launches.length > 0) {
    return {
      verdict: "refused",
      affected,
      approved,
      reason: `workers on ${launches.join(" ")} still hold a slot and keep sealing checkpoints no unretracted target image restores, so no approval covers them: list an unretracted image that restores them in the target release (the image itself, or a fixed build of the same engine, SDK and CLI), or run the upgrade once no launch on it holds a slot`,
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
      reason: `${ids.length} session(s) could resume on no unretracted target image (deployed images dropped, redeclared or retracted: ${changed.join(" ") || "none"}; newest ${deployedNewest?.image ?? "none"} → ${targetNewest?.image ?? "none"}); approve exactly this list in upgrade.approvedSessions${ids.length === 0 ? " (empty)" : ""} — not approved: ${missing.join(" ") || "none"}; no longer affected: ${extra.join(" ") || "none"}`,
    };
  }
  return { verdict: "proceed", affected, approved };
}

/** What new sessions start on; none when every image is retracted. */
export function newestLaunchable<I extends { readonly retracted?: boolean }>(
  images: readonly I[],
): I | undefined {
  return images.find((image) => !image.retracted);
}

// Only what image choice reads counts: a runtime nothing declared was never
// compared, so the same digest is all that can be asked of it.
function kept(
  deployed: UpgradeImage,
  target: readonly WorkerImageCandidate<string>[],
): boolean {
  return target.some(
    ({ image, runtime, retracted }) =>
      image === deployed.image &&
      Boolean(retracted) === Boolean(deployed.retracted) &&
      (deployed.runtime === null ||
        (sameCombination(deployed.runtime, runtime) &&
          schemeSet(deployed.runtime) === schemeSet(runtime))),
  );
}

function schemeSet(runtime: ImageRuntime): string {
  return [...new Set(restorableSchemesOf(runtime))]
    .sort((a, b) => a - b)
    .join();
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
  { pointer, engine }: UpgradeSession,
  target: Images<WorkerImageCandidate<string>>,
): UnresumableReason | null {
  if (pointer.kind === "unrecorded") return "unrecorded";
  const selection = selectWorkerImage(pointer, target, engine);
  if (selection.kind === "selected") return null;
  if (selection.reason === "engine_unavailable") return "no_engine_image";
  // With no checkpoint it waits for an unretracted image, holding nothing.
  return pointer.kind === "none" ? null : "no_image";
}
