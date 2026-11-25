import type { SessionWorkerRuntime } from "@werft-ai/contracts";
import {
  type FinalizeInput,
  type PointerRuntime,
  recordedPointer,
  type UpgradeImage,
} from "@werft-ai/platform";
import { FIRST_PROFILE_DIGEST_SCHEME } from "@werft-ai/runtime-core";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Database } from "../queries.ts";
import { attempts, checkpoints, sessions, workerLaunches } from "../schema.ts";
import { hasRestorePoint } from "../sessions/index.ts";

export type RuntimeFingerprint = NonNullable<
  FinalizeInput["checkpointRuntime"]
>;

type RuntimeColumns = {
  runtimeEngine: string | null;
  runtimeSdkVersion: string | null;
  runtimeCliVersion: string | null;
  runtimeProfileSha256: string | null;
};

export function runtimeColumns(
  runtime: RuntimeFingerprint | undefined,
): RuntimeColumns {
  return {
    runtimeEngine: runtime?.engine ?? null,
    runtimeSdkVersion: runtime?.sdkVersion ?? null,
    runtimeCliVersion: runtime?.cliVersion ?? null,
    runtimeProfileSha256: runtime?.profileSha256 ?? null,
  };
}

/**
 * The session's runtime columns for a pointer update: the fingerprint goes
 * in only while the session has none, all four together, so the first
 * committed checkpoint that carries one decides it.
 */
export function sessionRuntimeOnce(
  runtime: RuntimeFingerprint | undefined,
): Partial<Record<keyof RuntimeColumns, SQL>> {
  if (runtime === undefined) return {};
  const once = (column: AnyPgColumn, value: string) =>
    sql`CASE WHEN ${sessions.runtimeEngine} IS NULL THEN ${value} ELSE ${column} END`;
  return {
    runtimeEngine: once(sessions.runtimeEngine, runtime.engine),
    runtimeSdkVersion: once(sessions.runtimeSdkVersion, runtime.sdkVersion),
    runtimeCliVersion: once(sessions.runtimeCliVersion, runtime.cliVersion),
    runtimeProfileSha256: once(
      sessions.runtimeProfileSha256,
      runtime.profileSha256,
    ),
  };
}

// Null when any column is: a row from before them, or one committed without
// a verified fingerprint. A launch reads that as the current image.
export function runtimeOfColumns(
  row: RuntimeColumns,
): RuntimeFingerprint | null {
  if (
    row.runtimeEngine === null ||
    row.runtimeSdkVersion === null ||
    row.runtimeCliVersion === null ||
    row.runtimeProfileSha256 === null
  ) {
    return null;
  }
  return {
    engine: row.runtimeEngine,
    sdkVersion: row.runtimeSdkVersion,
    cliVersion: row.runtimeCliVersion,
    profileSha256: row.runtimeProfileSha256,
  };
}

/**
 * The session detail's `worker_runtime`: the session's own record, and the
 * pointer's combination when a launch would restore that checkpoint.
 */
export function workerRuntimeView(
  session: RuntimeColumns & {
    firstWorkerImage: string | null;
    checkpointRevision: number | null;
    checkpointPendingReason: string | null;
    contextResetCheckpointRevision: number | null;
  },
  pointer: (RuntimeColumns & { runtimeProfileScheme: number | null }) | null,
): SessionWorkerRuntime {
  const restored =
    pointer !== null && hasRestorePoint(session)
      ? runtimeOfColumns(pointer)
      : null;
  const first = runtimeOfColumns(session);
  return {
    first_image: session.firstWorkerImage,
    first: first === null ? null : combinationOf(first),
    checkpoint:
      restored === null || pointer === null
        ? null
        : {
            ...combinationOf(restored),
            profile_digest_scheme:
              pointer.runtimeProfileScheme ?? FIRST_PROFILE_DIGEST_SCHEME,
          },
  };
}

function combinationOf(
  runtime: RuntimeFingerprint,
): NonNullable<SessionWorkerRuntime["first"]> {
  return {
    engine: runtime.engine,
    sdk_version: runtime.sdkVersion,
    cli_version: runtime.cliVersion,
    profile_sha256: runtime.profileSha256,
  };
}

// The checkpoint a session's pointer names, as a join from sessions.
const POINTER_CHECKPOINT = and(
  eq(checkpoints.sessionId, sessions.id),
  eq(checkpoints.revision, sessions.checkpointRevision),
);

// What readPointerImageRuntime's rules read of a session and that checkpoint.
const POINTER_COLUMNS = {
  runtimeKind: sql<
    string | null
  >`CASE WHEN jsonb_typeof(${sessions.runtimeSpec} -> 'runtime' -> 'kind') = 'string' THEN ${sessions.runtimeSpec} -> 'runtime' ->> 'kind' END`,
  checkpointRevision: sessions.checkpointRevision,
  checkpointPendingReason: sessions.checkpointPendingReason,
  contextResetCheckpointRevision: sessions.contextResetCheckpointRevision,
  runtimeEngine: checkpoints.runtimeEngine,
  runtimeSdkVersion: checkpoints.runtimeSdkVersion,
  runtimeCliVersion: checkpoints.runtimeCliVersion,
  runtimeProfileSha256: checkpoints.runtimeProfileSha256,
  runtimeProfileScheme: checkpoints.runtimeProfileScheme,
};

/**
 * The image combination the session's pointer was sealed under, for
 * choosing the image its next launch runs on, the revision it was read at
 * (0 with no pointer), and the runtime kind the session's spec pins (null:
 * none, or not a string).
 */
export async function readPointerImageRuntime(
  db: Database,
  sessionId: string,
): Promise<{
  pointer: PointerRuntime;
  checkpointRevision: number;
  runtimeKind: string | null;
}> {
  const [row] = await db
    .select(POINTER_COLUMNS)
    .from(sessions)
    .leftJoin(checkpoints, POINTER_CHECKPOINT)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  // What the claim's restore skips (a start_fresh retired it, or a pending
  // reason blocks it) restores nothing, so no image is held to it.
  const runtimeKind = row?.runtimeKind ?? null;
  if (row === undefined || !hasRestorePoint(row)) {
    return { pointer: { kind: "none" }, checkpointRevision: 0, runtimeKind };
  }
  const runtime = runtimeOfColumns(row);
  return {
    pointer:
      runtime === null
        ? { kind: "unrecorded" }
        : recordedPointer(runtime, row.runtimeProfileScheme),
    checkpointRevision: row.checkpointRevision,
    runtimeKind,
  };
}

/**
 * The fingerprint of the checkpoint the session's pointer names, which a
 * restore will be held to. Null for a session with no pointer and for a
 * pointer committed before the fingerprint was recorded: both run on the
 * current image.
 */
export async function readPointerRuntime(
  db: Database,
  sessionId: string,
): Promise<RuntimeFingerprint | null> {
  const [row] = await db
    .select({
      runtimeEngine: checkpoints.runtimeEngine,
      runtimeSdkVersion: checkpoints.runtimeSdkVersion,
      runtimeCliVersion: checkpoints.runtimeCliVersion,
      runtimeProfileSha256: checkpoints.runtimeProfileSha256,
    })
    .from(sessions)
    .innerJoin(checkpoints, POINTER_CHECKPOINT)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row === undefined ? null : runtimeOfColumns(row);
}

/**
 * The sessions an upgrade can strand, with each pointer read by
 * readPointerImageRuntime's rules: every one that holds a checkpoint no
 * collection has ended (the compose gate checks the same set), and every one
 * not closed, which an upgrade that drops its engine's images strands with
 * or without one. `runtimeKind` as readPointerImageRuntime reads it.
 */
export async function listUpgradeSessions(db: Database): Promise<
  {
    sessionId: string;
    pointer: PointerRuntime;
    open: boolean;
    runtimeKind: string | null;
  }[]
> {
  const rows = await db
    .select({
      sessionId: sessions.id,
      open: sql<boolean>`${sessions.admissionState} <> 'closed'`,
      ...POINTER_COLUMNS,
    })
    .from(sessions)
    .leftJoin(checkpoints, POINTER_CHECKPOINT)
    .where(
      or(
        ne(sessions.admissionState, "closed"),
        inArray(
          sessions.id,
          db
            .selectDistinct({ sessionId: checkpoints.sessionId })
            .from(checkpoints)
            .where(isNull(checkpoints.collectedAt)),
        ),
      ),
    )
    .orderBy(asc(sessions.id));
  return rows.map(({ sessionId, open, runtimeKind, ...row }) => {
    if (!hasRestorePoint(row)) {
      return { sessionId, pointer: { kind: "none" }, open, runtimeKind };
    }
    const runtime = runtimeOfColumns(row);
    return {
      sessionId,
      pointer:
        runtime === null
          ? { kind: "unrecorded" }
          : recordedPointer(runtime, row.runtimeProfileScheme),
      open,
      runtimeKind,
    };
  });
}

/**
 * The session of every launch a worker claimed that still holds its slot:
 * the workers running now, idle or mid-turn. An unclaimed launch has no
 * worker bound, and is built again by whichever scheduler finds it.
 */
export async function listSlotHoldingWorkerSessions(
  db: Database,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ sessionId: attempts.sessionId })
    .from(workerLaunches)
    .innerJoin(attempts, eq(attempts.id, workerLaunches.claimedAttemptId))
    .where(isNull(workerLaunches.slotReleasedAt))
    .orderBy(asc(attempts.sessionId));
  return rows.map(({ sessionId }) => sessionId);
}

/**
 * What every launch still holding a slot runs, claimed or not: a worker that
 * may yet seal a checkpoint. A launch reserved before its image was stored
 * runs its scheduler's newest image, which the upgrade check judges anyway.
 */
export async function listUnreleasedLaunchImages(
  db: Database,
): Promise<UpgradeImage[]> {
  const rows = await db
    .selectDistinct({
      image: workerLaunches.image,
      engine: workerLaunches.runtimeEngine,
      sdkVersion: workerLaunches.runtimeSdkVersion,
      cliVersion: workerLaunches.runtimeCliVersion,
      profileDigestScheme: workerLaunches.runtimeProfileScheme,
    })
    .from(workerLaunches)
    .where(
      and(
        isNull(workerLaunches.slotReleasedAt),
        isNotNull(workerLaunches.image),
      ),
    );
  return rows.map(({ image, ...runtime }) => ({
    image: image as string,
    runtime:
      runtime.engine === null ||
      runtime.sdkVersion === null ||
      runtime.cliVersion === null ||
      runtime.profileDigestScheme === null
        ? null
        : {
            engine: runtime.engine,
            sdkVersion: runtime.sdkVersion,
            cliVersion: runtime.cliVersion,
            profileDigestScheme: runtime.profileDigestScheme,
          },
  }));
}
