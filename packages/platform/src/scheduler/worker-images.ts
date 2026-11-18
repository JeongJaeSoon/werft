import {
  FIRST_PROFILE_DIGEST_SCHEME,
  type ImageRuntime,
  imageRuntimeVersions,
  parseImageRuntime,
  type RuntimeFingerprint,
  restorableSchemesOf,
} from "@werft-ai/runtime-core";
import type { RuntimeVersions } from "../catalog/index.ts";

export type WorkerImagesEnvironment = {
  WORKER_IMAGE?: string | undefined;
  WORKER_IMAGES?: string | undefined;
  WORKER_IMAGE_PREVIOUS?: string | undefined;
  WORKER_IMAGE_PREVIOUS_RUNTIME?: string | undefined;
  WORKER_IMAGE_RUNTIME?: string | undefined;
};

/**
 * One entry of `WORKER_IMAGES`. A retracted image stays listed so that what
 * it sealed is told apart from what nothing can restore, but no session
 * launches on it.
 */
export type ListedWorkerImage = {
  readonly image: string;
  readonly runtime: ImageRuntime;
  readonly retracted: boolean;
};

/**
 * Images of one engine an installation may list unretracted: the newest and
 * the release before it. An operating limit, not a proof: that the older one
 * really is the release before is what the compatibility CI checks.
 */
export const WORKER_IMAGES_PER_ENGINE = 2;

const SINGLE_IMAGE_SETTINGS = [
  "WORKER_IMAGE",
  "WORKER_IMAGE_RUNTIME",
  "WORKER_IMAGE_PREVIOUS",
  "WORKER_IMAGE_PREVIOUS_RUNTIME",
] as const;
// The distribution reference grammar, `[host[:port]/]name@sha256:<hex>`.
const LABEL = "[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?";
const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const DIGEST_REFERENCE = new RegExp(
  `^(?:${LABEL}(?:\\.${LABEL})*(?::\\d+)?/)?${COMPONENT}(?:/${COMPONENT})*@(sha256:[0-9a-f]{64})$`,
);

/**
 * What tells two image references apart: the digest of a `name@sha256:`
 * reference, so one image under two repository paths (a registry mirror) is
 * one image; any other reference (a Docker image id) as it is.
 */
export function imageIdentity(reference: string): string {
  const at = reference.lastIndexOf("@sha256:");
  return at === -1 ? reference : reference.slice(at + 1);
}

const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Milliseconds since the epoch, or NaN unless every field is in range. */
function isoTime(text: string): number {
  const match = ISO_TIME.exec(text);
  if (match === null) return NaN;
  const [
    year = 0,
    month = 0,
    day = 0,
    hour = 0,
    minute = 0,
    second = 0,
    offsetHour = 0,
    offsetMinute = 0,
  ] = match.slice(1).map((part) => Number(part ?? 0));
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC rolls 2026-02-30 over to March; a field out of range does not survive.
  const inRange =
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day &&
    at.getUTCHours() === hour &&
    at.getUTCMinutes() === minute &&
    at.getUTCSeconds() === second &&
    offsetHour < 24 &&
    offsetMinute < 60;
  return inRange ? Date.parse(text) : NaN;
}

/**
 * `WORKER_IMAGES`: a JSON array of `{image, runtime, released_at, retracted?}`,
 * newest first, each image pinned by digest and each runtime its build's
 * `imageFingerprint()` output. `released_at` must fall strictly in the
 * array's order, so a list pasted out of order stops the process instead of
 * starting new sessions on an older image. A list with every image
 * retracted still starts: the processes stay up to stop and tell the
 * sessions, where a failed rollout would leave the old settings launching
 * the retracted image. Null when unset: the single-image settings apply, and
 * setting both throws.
 */
export function workerImageListFromEnv(
  environment: WorkerImagesEnvironment,
): readonly [ListedWorkerImage, ...ListedWorkerImage[]] | null {
  const text = environment.WORKER_IMAGES;
  if (!text) return null;
  const alongside = SINGLE_IMAGE_SETTINGS.filter((name) => environment[name]);
  if (alongside.length > 0) {
    throw new Error(
      `WORKER_IMAGES replaces ${alongside.join(", ")}; set one or the other`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("WORKER_IMAGES is not JSON");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("WORKER_IMAGES must be a non-empty JSON array");
  }
  const listed: ListedWorkerImage[] = [];
  // Newest first within each engine; two engines' releases may share a time.
  const newer = new Map<string, { at: number; text: string }>();
  for (const [index, entry] of value.entries()) {
    const where = `WORKER_IMAGES[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${where} must be a JSON object`);
    }
    const { image, runtime, released_at, retracted, ...rest } = entry as Record<
      string,
      unknown
    >;
    const unknown = Object.keys(rest);
    if (unknown.length > 0) {
      throw new Error(`${where} has unknown field(s): ${unknown.join(", ")}`);
    }
    const digest =
      typeof image === "string" ? DIGEST_REFERENCE.exec(image)?.[1] : undefined;
    if (typeof image !== "string" || digest === undefined) {
      throw new Error(
        `${where}.image must be pinned by digest (repository@sha256:<digest>)`,
      );
    }
    // Two names for one digest run the same image, which has one runtime.
    if (listed.some((earlier) => earlier.image.endsWith(`@${digest}`))) {
      throw new Error(`${where}.image ${digest} is listed twice`);
    }
    if (
      typeof runtime !== "object" ||
      runtime === null ||
      Array.isArray(runtime)
    ) {
      throw new Error(`${where}.runtime must be a JSON object`);
    }
    const at = typeof released_at === "string" ? isoTime(released_at) : NaN;
    if (typeof released_at !== "string" || Number.isNaN(at)) {
      throw new Error(`${where}.released_at must be an ISO 8601 time`);
    }
    const parsed = readRuntime(`${where}.runtime`, JSON.stringify(runtime));
    const above = newer.get(parsed.engine);
    if (above !== undefined && at >= above.at) {
      throw new Error(
        `${where}.released_at ${released_at} is not before ${above.text} of the ${parsed.engine} image above it: list each engine's newest image first`,
      );
    }
    newer.set(parsed.engine, { at, text: released_at });
    if (retracted !== undefined && typeof retracted !== "boolean") {
      throw new Error(`${where}.retracted must be true or false`);
    }
    listed.push({ image, runtime: parsed, retracted: retracted === true });
  }
  for (const engine of newer.keys()) {
    const unretracted = listed.filter(
      ({ runtime, retracted }) => runtime.engine === engine && !retracted,
    ).length;
    if (unretracted > WORKER_IMAGES_PER_ENGINE) {
      throw new Error(
        `WORKER_IMAGES lists ${unretracted} unretracted ${engine} images: at most ${WORKER_IMAGES_PER_ENGINE}, the newest and the release before it`,
      );
    }
  }
  return listed as [ListedWorkerImage, ...ListedWorkerImage[]];
}

/**
 * The listed images a new launch may take: the unretracted ones, newest
 * first. Null without `WORKER_IMAGES`: the single-image settings retract
 * nothing. Empty when every listed image is retracted.
 */
export function launchableImagesFor(
  environment: Readonly<Record<string, string | undefined>> &
    WorkerImagesEnvironment,
): readonly ListedWorkerImage[] | null {
  return (
    workerImageListFromEnv(environment)?.filter(
      ({ retracted }) => !retracted,
    ) ?? null
  );
}

/**
 * The runtimes of the configured worker images, from `WORKER_IMAGES` or the
 * single-image settings; null when none is set. Newest first, the
 * unretracted ones ahead; a retracted image's workers keep running until
 * they are drained, so its runtimes stay accepted.
 */
export function configuredImageRuntimesFromEnv(
  environment: WorkerImagesEnvironment,
): readonly [ImageRuntime, ...ImageRuntime[]] | null {
  const listed = workerImageListFromEnv(environment);
  if (listed !== null) {
    return [
      ...listed.filter(({ retracted }) => !retracted),
      ...listed.filter(({ retracted }) => retracted),
    ].map(({ runtime }) => runtime) as [ImageRuntime, ...ImageRuntime[]];
  }
  const runtimes = workerImageRuntimesFromEnv(environment);
  if (runtimes === null) return null;
  return runtimes.previous === null
    ? [runtimes.current]
    : [runtimes.current, runtimes.previous];
}

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

/** `parseImageRuntime`, its error prefixed with the setting it came from. */
export function readRuntime(name: string, value: string): ImageRuntime {
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
  /** Listed, but no session launches on it. */
  readonly retracted?: boolean;
};

/**
 * `runtime_retired`: only a retracted image runs what the session needs —
 * restores its checkpoint, or, with every image retracted, anything at all.
 * `incompatible_checkpoint`: no listed image restores it.
 * `engine_unavailable`: a session with no checkpoint, and no image of its
 * engine listed; it waits for one rather than stopping.
 */
export type WorkerImageSelection<I> =
  | {
      readonly kind: "selected";
      readonly image: I;
      readonly runtime: ImageRuntime;
    }
  | {
      readonly kind: "none";
      readonly reason:
        | "incompatible_checkpoint"
        | "runtime_retired"
        | "engine_unavailable";
      readonly detail: string;
    };

/**
 * The images a session of `engine` may run on: every one when `engine` is
 * left out, none when it is null (a runtime kind this host does not know).
 * The scheduler's choice and the API's `NO_WORKER_IMAGE` filter alike.
 */
export function imagesOfEngine<T extends { runtime: { engine: string } }>(
  images: readonly T[],
  engine: string | null | undefined,
): readonly T[] {
  return engine === undefined
    ? images
    : images.filter((image) => image.runtime.engine === engine);
}

/**
 * The image a session's next launch runs on: the newest unretracted one that
 * restores its checkpoint (`canRestoreCheckpoint`: the same engine, SDK and
 * CLI). `images` is newest first, so of two that share a combination (a
 * rebuild with only OS fixes, or the fix of a retracted build) the newer
 * wins. A session with nothing recorded runs on the newest unretracted. The
 * one judgment the scheduler and the upgrade pre-check share.
 *
 * `engine`, when given, is the session's (null: a runtime kind this host
 * does not know): only images of it are candidates. Left out, every listed
 * image is.
 */
export function selectWorkerImage<I>(
  pointer: PointerRuntime,
  listed: readonly [WorkerImageCandidate<I>, ...WorkerImageCandidate<I>[]],
  engine?: string | null,
): WorkerImageSelection<I> {
  const images = imagesOfEngine(listed, engine);
  if (images.length === 0) {
    const missing =
      engine === null
        ? "the session's runtime kind is not one this host runs"
        : `no configured worker image runs the ${engine} engine`;
    return pointer.kind === "recorded"
      ? {
          kind: "none",
          reason: "incompatible_checkpoint",
          detail: `the checkpoint was sealed on ${describe(pointer.runtime)}; ${missing}`,
        }
      : { kind: "none", reason: "engine_unavailable", detail: missing };
  }
  const launchable = images.filter((candidate) => !candidate.retracted);
  if (pointer.kind !== "recorded") {
    const [newest] = launchable;
    return newest === undefined
      ? {
          kind: "none",
          reason: "runtime_retired",
          detail: "every configured worker image is retracted",
        }
      : { kind: "selected", image: newest.image, runtime: newest.runtime };
  }
  const restores = (candidate: WorkerImageCandidate<I>) =>
    canRestoreCheckpoint(candidate.runtime, pointer.runtime);
  const match = launchable.find(restores);
  if (match !== undefined) {
    return { kind: "selected", image: match.image, runtime: match.runtime };
  }
  const sealed = `the checkpoint was sealed on ${describe(pointer.runtime)}`;
  if (images.some(restores)) {
    return {
      kind: "none",
      reason: "runtime_retired",
      detail: `${sealed}; only a retracted worker image restores it${launchable.length === 0 ? "" : `, and the others run ${launchable.map((candidate) => describe(candidate.runtime)).join(" and ")}`}`,
    };
  }
  return {
    kind: "none",
    reason: "incompatible_checkpoint",
    detail: `${sealed}; the configured worker images run ${images.map((candidate) => describe(candidate.runtime)).join(" and ")}`,
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

/** An image runs the runtime kinds whose checkpoints carry its engine. */
export function runtimeVersionsOf(
  runtimes: readonly [ImageRuntime, ...ImageRuntime[]],
  kinds: ReadonlyArray<{ kind: string; checkpointEngine: string }>,
): RuntimeVersions {
  return {
    accepted: runtimes.flatMap((runtime) =>
      kinds
        .filter(({ checkpointEngine }) => checkpointEngine === runtime.engine)
        .flatMap(({ kind }) =>
          imageRuntimeVersions(runtime).map((version) => ({
            kind,
            version,
            engine: runtime.engine,
          })),
        ),
    ),
  };
}
