import {
  FIRST_PROFILE_DIGEST_SCHEME,
  type ImageRuntime,
  imageRuntimeVersions,
  parseImageRuntime,
  type RuntimeFingerprint,
  restorableSchemesOf,
} from "@werft-ai/runtime-core";
import type { RuntimeVersions } from "../sessions/index.ts";

export type WorkerImagesEnvironment = {
  WORKER_IMAGE?: string | undefined;
  WORKER_IMAGES?: string | undefined;
  WORKER_IMAGE_PREVIOUS?: string | undefined;
  WORKER_IMAGE_PREVIOUS_RUNTIME?: string | undefined;
  WORKER_IMAGE_RUNTIME?: string | undefined;
};

/** One entry of `WORKER_IMAGES`. */
export type ListedWorkerImage = {
  readonly image: string;
  readonly runtime: ImageRuntime;
};

/**
 * Images of one engine an installation may list: the newest and the release
 * before it. An operating limit, not a proof: that the older one really is
 * the release before is what the compatibility CI checks.
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
 * `WORKER_IMAGES`: a JSON array of `{image, runtime, released_at}`, newest
 * first, each image pinned by digest and each runtime its build's
 * `imageFingerprint()` output. `released_at` must fall strictly in the
 * array's order, so a list pasted out of order stops the process instead of
 * starting new sessions on an older image. Null when unset: the single-image
 * settings apply, and setting both throws.
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
  let newer: { at: number; text: string } | null = null;
  for (const [index, entry] of value.entries()) {
    const where = `WORKER_IMAGES[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${where} must be a JSON object`);
    }
    const { image, runtime, released_at, ...rest } = entry as Record<
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
    if (newer !== null && at >= newer.at) {
      throw new Error(
        `${where}.released_at ${released_at} is not before ${newer.text} above it: list the newest image first`,
      );
    }
    newer = { at, text: released_at };
    listed.push({
      image,
      runtime: readRuntime(`${where}.runtime`, JSON.stringify(runtime)),
    });
  }
  const engines = [...new Set(listed.map(({ runtime }) => runtime.engine))];
  if (engines.length > 1) {
    throw new Error(
      `WORKER_IMAGES lists images of ${engines.join(" and ")}: images of one engine only`,
    );
  }
  if (listed.length > WORKER_IMAGES_PER_ENGINE) {
    throw new Error(
      `WORKER_IMAGES lists ${listed.length} ${engines[0]} images: at most ${WORKER_IMAGES_PER_ENGINE}, the newest and the release before it`,
    );
  }
  return listed as [ListedWorkerImage, ...ListedWorkerImage[]];
}

/**
 * The runtimes of the configured worker images, newest first, from
 * `WORKER_IMAGES` or the single-image settings; null when none is set.
 */
export function configuredImageRuntimesFromEnv(
  environment: WorkerImagesEnvironment,
): readonly [ImageRuntime, ...ImageRuntime[]] | null {
  const listed = workerImageListFromEnv(environment);
  if (listed !== null) {
    return listed.map(({ runtime }) => runtime) as [
      ImageRuntime,
      ...ImageRuntime[],
    ];
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

/** New releases name the newest image's versions; any listed image's still run. */
export function runtimeVersionsOf(
  runtimes: readonly [ImageRuntime, ...ImageRuntime[]],
): RuntimeVersions {
  return {
    current: imageRuntimeVersions(runtimes[0]),
    accepted: runtimes.flatMap(imageRuntimeVersions),
  };
}
