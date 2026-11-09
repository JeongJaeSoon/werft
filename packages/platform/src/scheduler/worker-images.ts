import {
  FIRST_PROFILE_DIGEST_SCHEME,
  type ImageRuntime,
  imageRuntimeVersions,
  parseImageRuntime,
  type RuntimeFingerprint,
  restorableSchemesOf,
} from "@werft-ai/runtime-core";
import type { RuntimeVersions } from "../sessions/catalog.ts";

export type WorkerImagesEnvironment = {
  WORKER_IMAGE_PREVIOUS_RUNTIME?: string | undefined;
  WORKER_IMAGE_RUNTIME?: string | undefined;
};

/**
 * What the configured worker images stamp: the current one new sessions
 * start on, and the release before it, which sessions sealed on it resume
 * on. Each value is the image's own `imageFingerprint()` output, carried
 * from its build (images.yml) rather than written by hand.
 */
export type WorkerImageRuntimes = {
  readonly current: ImageRuntime;
  readonly previous: ImageRuntime | null;
};

/**
 * Null when no image runtime is configured. A malformed value, or a
 * previous image without a current one, throws: the process should not
 * start on a setting it cannot read.
 */
export function workerImageRuntimesFromEnv(
  environment: WorkerImagesEnvironment,
): WorkerImageRuntimes | null {
  const current = environment.WORKER_IMAGE_RUNTIME;
  const previous = environment.WORKER_IMAGE_PREVIOUS_RUNTIME;
  if (!current) {
    if (previous) {
      throw new Error(
        "WORKER_IMAGE_PREVIOUS_RUNTIME needs WORKER_IMAGE_RUNTIME beside it",
      );
    }
    return null;
  }
  return {
    current: readRuntime("WORKER_IMAGE_RUNTIME", current),
    previous: previous
      ? readRuntime("WORKER_IMAGE_PREVIOUS_RUNTIME", previous)
      : null,
  };
}

function readRuntime(name: string, value: string): ImageRuntime {
  try {
    return parseImageRuntime(value);
  } catch (error) {
    throw new Error(`${name}: ${(error as Error).message}`);
  }
}

/**
 * What a session's checkpoint pointer says it must resume under. `none`: no
 * checkpoint to restore. `unrecorded`: a pointer committed before the
 * combination was stored, which a restore still judges on its own.
 * `recorded`: the combination of the image that sealed it; its profile digest
 * is judged at restore, not here.
 */
export type PointerRuntime =
  | { readonly kind: "none" }
  | { readonly kind: "unrecorded" }
  | { readonly kind: "recorded"; readonly runtime: ImageRuntime };

/** A pointer row's combination; a null scheme is a row from before it, scheme 1. */
export function recordedPointer(
  runtime: Omit<RuntimeFingerprint, "profileSha256">,
  profileDigestScheme: number | null,
): PointerRuntime {
  return {
    kind: "recorded",
    runtime: {
      engine: runtime.engine,
      sdkVersion: runtime.sdkVersion,
      cliVersion: runtime.cliVersion,
      profileDigestScheme: profileDigestScheme ?? FIRST_PROFILE_DIGEST_SCHEME,
    },
  };
}

export type WorkerImageCandidate<I> = {
  readonly image: I;
  readonly runtime: ImageRuntime;
};

export type WorkerImageSelection<I> =
  | {
      readonly kind: "selected";
      readonly image: I;
      readonly runtime: ImageRuntime;
    }
  | {
      readonly kind: "none";
      readonly reason: "incompatible_checkpoint";
      readonly detail: string;
    };

/**
 * The image a session's next launch runs on. `images` is newest first, so of
 * two that share a combination (a rebuild with only OS fixes) the newer one
 * wins. A session with nothing recorded runs on the newest. The one judgment
 * the scheduler and the upgrade pre-check share.
 */
export function selectWorkerImage<I>(
  pointer: PointerRuntime,
  images: readonly [WorkerImageCandidate<I>, ...WorkerImageCandidate<I>[]],
): WorkerImageSelection<I> {
  if (pointer.kind !== "recorded") {
    const [newest] = images;
    return { kind: "selected", image: newest.image, runtime: newest.runtime };
  }
  const match = images.find((candidate) =>
    canRestoreCheckpoint(candidate.runtime, pointer.runtime),
  );
  if (match !== undefined) {
    return { kind: "selected", image: match.image, runtime: match.runtime };
  }
  return {
    kind: "none",
    reason: "incompatible_checkpoint",
    detail: `the checkpoint was sealed on ${describe(pointer.runtime)}; the configured worker images run ${images.map((candidate) => describe(candidate.runtime)).join(" and ")}`,
  };
}

/**
 * Whether an image can resume a checkpoint sealed on `pointer`: the same
 * engine build, and a digest scheme the image lists as one it still computes.
 * Directional (an image resumes the scheme before its own, never the reverse),
 * so it serves image choice, the upgrade pre-check and verify-restore only.
 * What a launch is reserved under and a worker's claim is held to stays the
 * strict `sameCombination`.
 */
export function canRestoreCheckpoint(
  image: ImageRuntime,
  pointer: ImageRuntime,
): boolean {
  return (
    image.engine === pointer.engine &&
    image.sdkVersion === pointer.sdkVersion &&
    image.cliVersion === pointer.cliVersion &&
    restorableSchemesOf(image).includes(pointer.profileDigestScheme)
  );
}

export function sameCombination(a: ImageRuntime, b: ImageRuntime): boolean {
  return (
    a.engine === b.engine &&
    a.sdkVersion === b.sdkVersion &&
    a.cliVersion === b.cliVersion &&
    a.profileDigestScheme === b.profileDigestScheme
  );
}

function describe(runtime: ImageRuntime): string {
  return `${runtime.engine} sdk ${runtime.sdkVersion} cli ${runtime.cliVersion} digest scheme ${runtime.profileDigestScheme}`;
}

export function runtimeVersionsOf(
  images: WorkerImageRuntimes,
): RuntimeVersions {
  const current = imageRuntimeVersions(images.current);
  return {
    current,
    accepted: [
      ...current,
      ...(images.previous === null
        ? []
        : imageRuntimeVersions(images.previous)),
    ],
  };
}
