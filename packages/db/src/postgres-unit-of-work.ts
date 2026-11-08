import { randomUUID } from "node:crypto";
import {
  attemptStateSchema,
  type CheckpointBlockReason,
  type CountSessionsQuery,
  type CountSessionsResponse,
  type CreateSessionResponse,
  checkpointBlockReasonSchema,
  createSessionResponseSchema,
  executionObservationSchema,
  type InputWait,
  type ListSessionsQuery,
  type ListTurnsQuery,
  type PostSessionMessageResponse,
  postSessionMessageResponseSchema,
  type Receipt,
  type ReceiptSessionTarget,
  readStoredEvent,
  receiptSchema,
  SESSION_STATUS_VALUES,
  type SessionStatus,
  type SlackMessageRef,
  SSE_SCHEMA_VERSION,
  type SseEvent,
  type SurfaceKind,
  sseEventSchema,
  type TurnDetail,
  type TurnSummary,
  turnStatusSchema,
  type WorkspaceLimitMode,
  workspaceLimitModeSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type {
  AcceptSessionInput,
  AcceptSessionResult,
  AppendMessageInput,
  AppendMessageResult,
  EventPage,
  NeutralizeEvent,
  ReadEventsQuery,
  SessionDetailRecord,
  SessionReader,
  SessionRecord,
  SessionUnitOfWork,
  SessionViewer,
} from "@werft-ai/platform";
import {
  InvalidCursorError,
  projectDurability,
  sessionRepositoryOf,
  storedPendingReasonHoldsWork,
  transcriptLimitAttention,
} from "@werft-ai/platform";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  max,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { contextGapAttention } from "./context-gap.ts";
import {
  containsPattern,
  findIdempotent,
  type IdempotencyScope,
  lockIdempotencyScope,
  parseTurnSequence,
  receiptActorOf,
} from "./control-shared.ts";
import {
  lockUnboundRefs,
  recordUnboundRefusal,
} from "./credential-bindings.ts";
import {
  decodeCreatedAtCursor,
  decodeEventCursor,
  decodeTurnCursor,
  encodeCreatedAtCursor,
  encodeEventCursor,
  encodeTurnCursor,
  rethrowCursorCastError,
} from "./cursors.ts";
import { drainAttention } from "./drain.ts";
import { enqueueWithin } from "./enqueue.ts";
import { eventWithNeutralFields } from "./event-payload.ts";
import { captureGitHubPolicyStart } from "./github-settings.ts";
import { admitInput } from "./input-limits.ts";
import { captureMcpStart } from "./mcp-settings.ts";
import {
  AWAITABLE_STATUSES,
  actionableOfSession,
  actionableOfTurn,
  IN_FLIGHT_STATUSES,
  publicStatus,
  READ_AT,
  readInputWaits,
} from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import { earlierInSecond, releaseLabel } from "./release-labels.ts";
import {
  keyReaches,
  lockAgentUse,
  lockRequester,
  lockSessionReach,
} from "./requester-locks.ts";
import { startupFailedAttention } from "./restore-failures.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  attempts,
  checkpoints,
  events,
  executions,
  idempotencyKeys,
  receipts,
  sessionEventArchives,
  sessionShares,
  sessions,
  turns,
  users,
} from "./schema.ts";
import { readSessionActivity } from "./session-activity.ts";
import {
  type ArchivedEventCache,
  type ArchivedEventSource,
  archiveChunkHolding,
  archiveChunksAfter,
  archivedRows,
  createArchivedEventCache,
  sameChunks,
} from "./session-event-archives.ts";
import { recordStatus } from "./session-events.ts";
import { sessionRelationIs, sessionVisibleTo } from "./session-shares.ts";
import { readArchivedWorkspaceLimit } from "./workspace-limit.ts";

export const CREATE_SESSION = "create_session";
const APPEND_MESSAGE = "append_message";
export const SESSIONS_RESOURCE = "sessions";

async function recordAcceptance(
  tx: Database,
  scope: IdempotencyScope,
  payloadHash: string,
  receipt: {
    id: string;
    targetRef: { session_id: string; turn_id: string; request_id: null };
    result: unknown;
  },
) {
  await tx.insert(receipts).values({
    id: receipt.id,
    ownerId: scope.principal,
    actor: scope.actor,
    requestId: scope.requestId,
    operation: scope.operation,
    targetRef: receipt.targetRef,
    result: receipt.result,
  });
  await tx.insert(idempotencyKeys).values({
    principal: scope.principal,
    operation: scope.operation,
    resource: scope.resource,
    key: scope.key,
    payloadHash,
    receiptId: receipt.id,
  });
}

async function insertQueuedTurn(
  tx: Database,
  input: {
    sessionId: string;
    sequence: number;
    message: string;
    actorId: string | null;
    channel: SurfaceKind | null;
    slackMessage: SlackMessageRef | null;
  },
) {
  // now() is the transaction start, which can precede a competing append
  // that won the session lock first; clock_timestamp() keeps created_at
  // ordered like sequence.
  const [turn] = await tx
    .insert(turns)
    .values({
      sessionId: input.sessionId,
      sequence: input.sequence,
      message: input.message,
      status: "queued",
      createdAt: sql`clock_timestamp()`,
      actorId: input.actorId,
      channel: input.channel,
      slackMessage: input.slackMessage,
    })
    .returning({ id: turns.id });
  if (!turn) throw new Error("Failed to insert turn");
  await enqueueWithin(tx, {
    sessionId: input.sessionId,
    turnId: turn.id,
    payload: { message: input.message },
  });
}

export function createPostgresSessionUnitOfWork(
  db: Database,
): SessionUnitOfWork {
  return {
    acceptInputAtomic(input: AcceptSessionInput): Promise<AcceptSessionResult> {
      const scope: IdempotencyScope = {
        principal: input.principal.ownerId,
        actor: receiptActorOf(input.principal),
        requestId: input.principal.requestId ?? null,
        operation: CREATE_SESSION,
        resource: SESSIONS_RESOURCE,
        key: input.idempotencyKey,
      };
      return db.transaction(async (tx) => {
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          return {
            outcome: "replayed",
            response: createSessionResponseSchema.parse(existing.result),
          };
        }
        const unbound = async (releaseId: string) => {
          const { receiptId } = await recordUnboundRefusal(tx, {
            ownerId: scope.principal,
            actor: scope.actor,
            requestId: scope.requestId,
            operation: CREATE_SESSION,
            releaseId,
            sessionId: null,
          });
          return { outcome: "credential_unbound" as const, receiptId };
        };
        if (input.credentialsUnbound && input.agentReleaseId !== undefined) {
          return unbound(input.agentReleaseId);
        }

        if (input.repository === null) return { outcome: "unsupported" };
        const requester = await lockRequester(
          tx,
          input.principal,
          "sessions:write",
        );
        if (
          !requester ||
          !(await keyReaches(tx, requester, input.agentReleaseId ?? null))
        ) {
          return { outcome: "actor_inactive" };
        }
        // AUTH_MODE=none and keys from before workspaces have no settings.
        const workspaceId = input.principal.actor?.workspaceId;
        if (
          input.agentReleaseId !== undefined &&
          workspaceId &&
          !(await lockAgentUse(
            tx,
            requester,
            workspaceId,
            input.agentReleaseId,
          ))
        ) {
          return { outcome: "agent_use_refused" };
        }
        // The settings are locked and read before the names are judged, so
        // the session stores the very list that was checked.
        const mcpStart =
          input.agentReleaseId === undefined
            ? null
            : await captureMcpStart(tx, input.agentReleaseId);
        if (
          input.agentReleaseId !== undefined &&
          (
            await lockUnboundRefs(tx, {
              workspaceId: scope.principal,
              releaseId: input.agentReleaseId,
              ...(mcpStart === null
                ? { fromRelease: true as const }
                : { names: mcpStart.credential_refs }),
            })
          ).length > 0
        ) {
          return unbound(input.agentReleaseId);
        }
        const refused = await admitInput(tx, {
          sessionId: null,
          message: input.message,
          limits: input.limits,
        });
        if (refused) return refused;
        const sessionId = randomUUID();
        const actor = input.principal.actor;
        const repository =
          input.repository === "none"
            ? {
                repositoryMode: "none" as const,
                repositoryId: null,
                repoUrl: null,
                branch: null,
              }
            : {
                repositoryMode: "repository" as const,
                repositoryId: input.repository.id,
                repoUrl: input.repository.url,
                branch: input.repository.branch,
              };
        const githubPolicyStart =
          input.captureGitHubPolicyStart === true &&
          input.agentReleaseId !== undefined
            ? await captureGitHubPolicyStart(tx, input.agentReleaseId)
            : null;
        await tx.insert(sessions).values({
          id: sessionId,
          ownerId: scope.principal,
          ...repository,
          attachedRepositoryIds: input.attachedRepositoryIds ?? null,
          githubPolicySource: input.githubPolicySource ?? "release",
          githubPolicyStart,
          mcpStart,
          title: input.title ?? null,
          titleSource: input.titleSource ?? "derived",
          channel: input.channel ?? null,
          profileId: input.profileId,
          profileFingerprint: input.profileFingerprint ?? null,
          model: input.model ?? null,
          unmetered: input.unmetered ?? false,
          agentReleaseId: input.agentReleaseId ?? null,
          platformPrompt: input.platformPrompt ?? null,
          permissionWaitOverride: input.permissionWait ?? null,
          workspaceId: actor?.workspaceId ?? null,
          createdByUserId: actor?.userId ?? null,
          createdByApiKeyId: actor?.apiKeyId ?? null,
        });
        if (input.shareScope !== undefined) {
          if (!actor?.workspaceId) {
            throw new Error("a share scope needs the session's workspace");
          }
          await tx.insert(sessionShares).values({
            sessionId,
            ownerId: scope.principal,
            workspaceId: actor.workspaceId,
            scope: input.shareScope,
          });
        }
        await insertQueuedTurn(tx, {
          sessionId,
          sequence: 1,
          message: input.message,
          actorId: actor?.userId ?? null,
          channel: input.channel ?? null,
          slackMessage: input.slackMessage ?? null,
        });

        const receiptId = randomUUID();
        const response: CreateSessionResponse = {
          session_id: sessionId,
          turn_id: "1",
          receipt_id: receiptId,
          receipt_status: "accepted",
          status: "queued",
        };
        await recordAcceptance(tx, scope, input.payloadHash, {
          id: receiptId,
          targetRef: { session_id: sessionId, turn_id: "1", request_id: null },
          result: response,
        });
        return { outcome: "accepted", response };
      });
    },

    appendInputAtomic(input: AppendMessageInput): Promise<AppendMessageResult> {
      // uuid columns compare case-insensitively but the idempotency resource
      // is text: normalise so "ABC…" and "abc…" share one scope (codex P2).
      const sessionId = input.sessionId.toLowerCase();
      const scope: IdempotencyScope = {
        principal: input.principal.ownerId,
        actor: receiptActorOf(input.principal),
        requestId: input.principal.requestId ?? null,
        operation: APPEND_MESSAGE,
        resource: sessionId,
        key: input.idempotencyKey,
      };
      return db.transaction(async (tx) => {
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          return {
            outcome: "replayed",
            response: postSessionMessageResponseSchema.parse(existing.result),
          };
        }
        if (input.profileBlocked) return { outcome: "profile_blocked" };

        const requester = await lockRequester(
          tx,
          input.principal,
          "sessions:write",
        );
        if (!requester) return { outcome: "actor_inactive" };
        // The session row lock serializes every append to one session, so
        // max(sequence)+1 below cannot be handed out twice or leave a gap.
        const [session] = await tx
          .select({
            id: sessions.id,
            workspaceId: sessions.workspaceId,
            createdByUserId: sessions.createdByUserId,
            createdByApiKeyId: sessions.createdByApiKeyId,
            admissionState: sessions.admissionState,
            checkpointPendingReason: sessions.checkpointPendingReason,
            status: sessions.status,
            takeoverRequiredAt: sessions.takeoverRequiredAt,
            agentReleaseId: sessions.agentReleaseId,
          })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, scope.principal),
            ),
          )
          .limit(1)
          .for("update");
        if (!session) {
          return { outcome: "not_found" };
        }
        if (!(await keyReaches(tx, requester, session.agentReleaseId))) {
          return { outcome: "actor_inactive" };
        }
        if ((await lockSessionReach(tx, requester, session)) !== "ok") {
          return { outcome: "not_found" };
        }
        if (session.takeoverRequiredAt !== null) {
          return { outcome: "awaiting_takeover" };
        }
        if (session.admissionState !== "active") {
          return {
            outcome: "rejected",
            admissionState: session.admissionState,
          };
        }
        // A turn accepted now would run on a transcript the platform cannot
        // read back; it could never be reported as durably finished. An
        // advisory reason (the run was not quiescent) holds nothing back.
        const pendingReason = session.checkpointPendingReason;
        if (
          pendingReason !== null &&
          storedPendingReasonHoldsWork(pendingReason)
        ) {
          return { outcome: "checkpoint_unavailable", reason: pendingReason };
        }
        if (
          session.agentReleaseId !== null &&
          (
            await lockUnboundRefs(tx, {
              workspaceId: scope.principal,
              releaseId: session.agentReleaseId,
              sessionId,
            })
          ).length > 0
        ) {
          const refusal = await recordUnboundRefusal(tx, {
            ownerId: scope.principal,
            actor: scope.actor,
            requestId: scope.requestId,
            operation: APPEND_MESSAGE,
            releaseId: session.agentReleaseId,
            sessionId,
          });
          return { outcome: "credential_unbound", ...refusal };
        }
        const refused = await admitInput(tx, {
          sessionId,
          message: input.message,
          limits: input.limits,
        });
        if (refused) return refused;
        const [last] = await tx
          .select({ sequence: max(turns.sequence) })
          .from(turns)
          .where(eq(turns.sessionId, sessionId));
        const sequence = (last?.sequence ?? 0) + 1;
        await insertQueuedTurn(tx, {
          sessionId: sessionId,
          sequence,
          message: input.message,
          actorId: input.principal.actor?.userId ?? null,
          channel: input.channel ?? null,
          slackMessage: input.slackMessage ?? null,
        });
        await tx
          .update(sessions)
          .set({
            // A session the scheduler gave up launching is left
            // `failed` with nothing queued; this input is what launches it
            // again, so it reads as queued from here.
            status: sql`CASE WHEN ${sessions.status} = 'failed' THEN 'queued'::session_status ELSE ${sessions.status} END`,
            updatedAt: new Date(),
          })
          .where(eq(sessions.id, sessionId));
        // The stream said failed; without this it would until the turn
        // starts, while reads already say queued.
        if (session.status === "failed") {
          await recordStatus(tx, {
            sessionId,
            phase: "queued",
            turnRowId: null,
            now: new Date(),
          });
        }

        const receiptId = randomUUID();
        const turnId = String(sequence);
        const response: PostSessionMessageResponse = {
          turn_id: turnId,
          receipt_id: receiptId,
          receipt_status: "accepted",
        };
        await recordAcceptance(tx, scope, input.payloadHash, {
          id: receiptId,
          targetRef: {
            session_id: sessionId,
            turn_id: turnId,
            request_id: null,
          },
          result: response,
        });
        return { outcome: "accepted", response };
      });
    },
  };
}

export function receiptFromRow(row: typeof receipts.$inferSelect): Receipt {
  // A resource or user target (the interface-track routes, account
  // recovery) parses as stored, strict, rather than being forced into
  // the session shape.
  const stored = (row.targetRef ?? {}) as Partial<ReceiptSessionTarget>;
  const target =
    "resource" in stored || "user_id" in stored
      ? stored
      : {
          session_id: stored.session_id,
          turn_id: stored.turn_id ?? null,
          request_id: stored.request_id ?? null,
        };
  // operation/error are stored untyped; a row this reader cannot
  // represent is a bug in the writer, so let the parse throw.
  return receiptSchema.parse({
    id: row.id,
    operation: row.operation,
    target_ref: target,
    ...(row.actor === null ? {} : { actor: row.actor }),
    status: row.status,
    result: row.result ?? null,
    error: row.error ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

const CREATED_AT_TEXT = sql<string>`${sessions.createdAt}::text`;
const ID_PREFIX = /^[0-9a-f-]+$/;
// The newest event in stream order (ids are commit order within a session),
// one index probe where max(created_at) visited every event of every listed
// session; with none left in events, the last archived one. Qualified by
// hand: drizzle renders a single-table select's columns bare, and a bare
// "id" here would be the event's.
const LAST_EVENT_AT = sql<Date | null>`coalesce((
  SELECT e.created_at FROM ${events} e
  WHERE e.session_id = ${sessions}.id
  ORDER BY e.id DESC LIMIT 1
), (
  SELECT a.last_created_at FROM ${sessionEventArchives} a
  WHERE a.session_id = ${sessions}.id
  ORDER BY a.from_id DESC LIMIT 1
))`.mapWith(events.createdAt);

type SessionRow = typeof sessions.$inferSelect;
type TurnRow = typeof turns.$inferSelect;
type TurnRead = {
  turn: TurnRow;
  awaitingInput: boolean;
  creatorName: string | null;
};

// result_json holds the SDK result message: its `result` and `usage` when
// present, otherwise the whole document is the result.
function resultParts(resultJson: unknown): {
  result: unknown;
  usage: unknown;
} {
  if (resultJson && typeof resultJson === "object") {
    const record = resultJson as Record<string, unknown>;
    return {
      result: "result" in record ? record.result : resultJson,
      usage: record.usage ?? null,
    };
  }
  return { result: resultJson ?? null, usage: null };
}

function summarizeTurn(
  { turn: row, awaitingInput, creatorName }: TurnRead,
  checkpointRevision: number | null,
): TurnSummary {
  return {
    turn_id: String(row.sequence),
    session_id: row.sessionId,
    status: turnStatusSchema.parse(publicStatus(row.status, awaitingInput)),
    message: row.message,
    channel: row.channel,
    slack_permalink: row.slackMessage?.permalink ?? null,
    created_by:
      row.actorId === null || creatorName === null
        ? null
        : { user_id: row.actorId, display_name: creatorName },
    terminal_reason: row.terminalReason,
    checkpoint_revision: checkpointRevision,
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    ended_at: row.endedAt?.toISOString() ?? null,
  };
}

const byteLength = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value) ?? "");

// Exported so a test can EXPLAIN it: the work per page must stay bounded
// by `limit` however long the session history is. The byte total is the
// serialized length, not pg_column_size: TOAST compresses a repetitive
// 60 KiB document to under 1 KiB on disk, and it is the serialized form
// that this process holds.
//
// `archived` are lines of the session's archived chunks past `after`: read
// back as events rows ahead of the ones still stored, so a page reads the
// same whichever side of an archive its rows are on.
export function eventPageQuery(
  sessionId: string,
  after: number,
  limit: number,
  maxBytes: number,
  archived: readonly string[] = [],
) {
  const source =
    archived.length === 0
      ? events
      : sql`(
          SELECT r.id, r.type, r.payload, r.neutral, r.turn_id, r.attempt_id,
                 r.occurred_at, r.created_at, ${sessionId}::uuid AS session_id
          FROM ${archivedRows(archived)}
          UNION ALL
          (SELECT s.id, s.type, s.payload, s.neutral, s.turn_id, s.attempt_id,
                  s.occurred_at, s.created_at, s.session_id
           FROM ${events} s
           WHERE s.session_id = ${sessionId} AND s.id > ${after}
           ORDER BY s.id
           LIMIT ${limit})
        )`;
  return sql`
    SELECT id, type, payload, bare, attempt_id, occurred_ms, turn_sequence,
           running_bytes, fetched
    FROM (
      SELECT c.id, c.type, c.payload, c.bare, c.attempt_id, c.turn_sequence,
             c.occurred_ms,
             sum(octet_length(c.payload::text)) OVER (ORDER BY c.id)
               AS running_bytes,
             row_number() OVER (ORDER BY c.id) AS position,
             count(*) OVER () AS fetched
      FROM (
        SELECT e.id, e.type,
               ${eventWithNeutralFields(sql`e`)} AS payload,
               e.neutral IS NULL AS bare, e.attempt_id,
               t.sequence AS turn_sequence,
               (extract(epoch FROM coalesce(e.occurred_at, e.created_at))
                 * 1000)::bigint AS occurred_ms
        FROM ${source} e
        LEFT JOIN ${turns} t ON t.id = e.turn_id
        WHERE e.session_id = ${sessionId} AND e.id > ${after}
        ORDER BY e.id
        LIMIT ${limit}
      ) c
    ) page
    WHERE position = 1 OR running_bytes <= ${maxBytes}
    ORDER BY id
  `;
}

type EventPageRow = {
  id: string;
  type: string;
  payload: unknown;
  bare: boolean;
  attempt_id: string | null;
  running_bytes: string;
  occurred_ms: string;
  turn_sequence: number | null;
  fetched: string;
};

export function createPostgresSessionReader(
  db: Database,
  options: {
    logger?: StructuredLogger;
    // Fills the neutral fields of a row stored before they were written.
    neutralize?: NeutralizeEvent;
    // Where archived events are read; a session with archived chunks cannot
    // be read without it.
    archivedEvents?: ArchivedEventSource;
  } = {},
): SessionReader {
  const archiveCache: ArchivedEventCache | undefined =
    options.archivedEvents === undefined
      ? undefined
      : createArchivedEventCache(options.archivedEvents);
  function archive(): ArchivedEventCache {
    if (archiveCache === undefined) {
      throw new Error(
        "This session has archived events and this process has no checkpoint object store to read them from",
      );
    }
    return archiveCache;
  }
  // Ordered by row id, which is commit order within one session: every
  // writer (the worker's appendEvents, PostgresQueue.publish) inserts
  // under the session row lock, so a lower id can never become visible
  // after a higher one and a reader that resumes from the last id it saw
  // misses nothing. A new writer must take the same lock.
  //
  // The byte bound is applied in SQL over a running sum of payload sizes
  // so that Postgres, not this process, holds whatever falls past it.
  // The candidate set is cut to `limit` rows first, because window
  // functions run before LIMIT and would otherwise size the whole
  // remaining history on every page. The first row always comes
  // through, or an oversized event could never be read at all.
  // The Database type is generic over the driver, so execute() cannot
  // name its row shape; pg hands back bigints and counts as strings and
  // raw timestamps in a driver-dependent form, hence the epoch column.
  // Rows written outside the worker protocol carry no occurred_at; the
  // insert time is the closest thing to when it happened.
  async function pageRows(
    sessionId: string,
    after: number,
    query: ReadEventsQuery,
    archived: readonly string[],
  ): Promise<EventPageRow[]> {
    const result = (await db.execute(
      eventPageQuery(sessionId, after, query.limit, query.maxBytes, archived),
    )) as { rows: EventPageRow[] };
    return result.rows;
  }
  async function ownedSession(ownerId: string, sessionId: string) {
    const [row] = await db
      .select({
        id: sessions.id,
        profileId: sessions.profileId,
        retiredCheckpointRevision: sessions.contextResetCheckpointRevision,
      })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
      .limit(1);
    return row ?? null;
  }

  // Only a revision a restore can still reach counts: one garbage
  // collection took, or one a start_fresh decision retired, does
  // not.
  async function checkpointRevisions(
    turnIds: number[],
    retiredCheckpointRevision: number | null,
  ) {
    if (turnIds.length === 0) return new Map<number, number>();
    const rows = await db
      .select({
        turnId: checkpoints.turnId,
        revision: max(checkpoints.revision),
      })
      .from(checkpoints)
      .where(
        and(
          inArray(checkpoints.turnId, turnIds),
          isNull(checkpoints.collectedAt),
          retiredCheckpointRevision === null
            ? undefined
            : gt(checkpoints.revision, retiredCheckpointRevision),
        ),
      )
      .groupBy(checkpoints.turnId);
    return new Map(
      rows.flatMap((row) =>
        row.turnId === null || row.revision === null
          ? []
          : [[row.turnId, row.revision] as const],
      ),
    );
  }

  // Reads a turn with whether it is waiting on a person, in one statement.
  const turnWithInput = () =>
    db
      .select({
        turn: turns,
        awaitingInput: sql<boolean>`exists (${actionableOfTurn(db)})`,
        creatorName: users.displayName,
      })
      .from(turns)
      .leftJoin(users, eq(users.id, turns.actorId));

  // A reason a newer build recorded reads as unknown after a rollback
  // rather than failing the whole detail.
  function publicPendingReason(
    sessionId: string,
    stored: string | null,
  ): CheckpointBlockReason | "unknown" | null {
    if (stored === null) return null;
    const parsed = checkpointBlockReasonSchema.safeParse(stored);
    if (parsed.success) return parsed.data;
    options.logger?.warn("Stored checkpoint pending reason is unknown", {
      session_id: sessionId,
      checkpoint_pending_reason: stored,
    });
    return "unknown";
  }

  // `?status=` filters on what the list shows, not on the stored column.
  function publicStatusIs(status: SessionStatus) {
    const waiting = actionableOfSession(db);
    if (status === "needs_input") {
      return and(inArray(sessions.status, AWAITABLE_STATUSES), exists(waiting));
    }
    if (status === "running") {
      return and(
        inArray(sessions.status, IN_FLIGHT_STATUSES),
        notExists(waiting),
      );
    }
    if (status === "idle") {
      return and(eq(sessions.status, status), notExists(waiting));
    }
    return eq(sessions.status, status);
  }

  // A list row says only which stage; the detail says what it waits on.
  function summaryWait(wait: InputWait | null) {
    return wait === null ? null : { state: wait.state };
  }

  async function summarize(
    executor: Database,
    rows: {
      session: SessionRow;
      awaitingInput: boolean;
      lastEventAt: Date | null;
    }[],
    // READ_AT of the statement that read awaitingInput.
    readAt: string,
  ): Promise<SessionRecord[]> {
    if (rows.length === 0) return [];
    const ids = rows.map(({ session }) => session.id);
    const releaseIds = [
      ...new Set(rows.flatMap(({ session }) => session.agentReleaseId ?? [])),
    ];
    // Turn 1's actor started the session; a takeover rewrites
    // created_by_user_id but leaves it. Rows from before #427 fall back.
    const firstTurns = await executor
      .select({
        sessionId: turns.sessionId,
        actorId: turns.actorId,
        slackMessage: turns.slackMessage,
      })
      .from(turns)
      .where(and(inArray(turns.sessionId, ids), eq(turns.sequence, 1)));
    const firstTurnOf = (session: SessionRow) =>
      firstTurns.find((turn) => turn.sessionId === session.id);
    const starterOf = (session: SessionRow) =>
      firstTurnOf(session)?.actorId ?? session.createdByUserId;
    const creatorIds = [
      ...new Set(rows.flatMap(({ session }) => starterOf(session) ?? [])),
    ];
    const releases =
      releaseIds.length === 0
        ? []
        : await executor
            .select({
              releaseId: agentReleases.id,
              id: agents.id,
              name: agents.name,
              activeReleaseId: agents.activeReleaseId,
              release_version_no: agentVersions.versionNo,
              createdAt: agentReleases.createdAt,
              earlier: earlierInSecond(agentReleases),
            })
            .from(agentReleases)
            .innerJoin(agents, eq(agents.id, agentReleases.agentId))
            .innerJoin(
              agentVersions,
              eq(agentVersions.id, agentReleases.versionId),
            )
            .where(inArray(agentReleases.id, releaseIds));
    const creators =
      creatorIds.length === 0
        ? []
        : await executor
            .select({ user_id: users.id, display_name: users.displayName })
            .from(users)
            .where(inArray(users.id, creatorIds));
    const activities = await readSessionActivity(executor, ids);
    const inputWaits = await readInputWaits(
      executor,
      rows.map(({ session }) => session),
      readAt,
    );
    const openTurns = await executor
      .select({
        sessionId: turns.sessionId,
        sequence: turns.sequence,
        status: turns.status,
      })
      .from(turns)
      .where(
        and(
          inArray(turns.sessionId, ids),
          inArray(turns.status, ["queued", "running", "needs_input"]),
        ),
      );

    return rows.map(({ session: row, awaitingInput, lastEventAt }) => {
      const mine = openTurns.filter((turn) => turn.sessionId === row.id);
      const current = mine
        .filter((turn) => turn.status !== "queued")
        .sort((a, b) => b.sequence - a.sequence)[0];
      const release = releases.find(
        (candidate) => candidate.releaseId === row.agentReleaseId,
      );
      return {
        id: row.id,
        title: row.title,
        agent: release
          ? {
              id: release.id,
              name: release.name,
              release_version_no: release.release_version_no,
              release_label: releaseLabel(release.createdAt, release.earlier),
              release_is_active: release.activeReleaseId === release.releaseId,
            }
          : null,
        created_by:
          creators.find((creator) => creator.user_id === starterOf(row)) ??
          null,
        channel: row.channel,
        slack_permalink: firstTurnOf(row)?.slackMessage?.permalink ?? null,
        revision: row.revision,
        admission_state: row.admissionState,
        status: publicStatus(row.status, awaitingInput),
        input_wait: summaryWait(inputWaits.get(row.id) ?? null),
        profile_id: row.profileId,
        profile_fingerprint: row.profileFingerprint,
        model: row.model,
        repository_id: row.repositoryId,
        repository: sessionRepositoryOf(row),
        attached_repository_ids: row.attachedRepositoryIds,
        current_turn_id: current ? String(current.sequence) : null,
        queued_turn_count: mine.filter((turn) => turn.status === "queued")
          .length,
        last_event_at: lastEventAt?.toISOString() ?? null,
        activity: activities.get(row.id),
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
      };
    });
  }

  // What listSessions and countSessions both read, so a count is always the
  // list read to its end with the same filters; agent_id is the list's alone.
  function sessionFilter(
    ownerId: string,
    query: CountSessionsQuery,
    viewer: SessionViewer,
  ) {
    const q = query.q?.toLowerCase();
    return and(
      eq(sessions.ownerId, ownerId),
      sessionVisibleTo(db, viewer),
      query.relation === undefined || query.relation === "all"
        ? undefined
        : sessionRelationIs(db, viewer, query.relation),
      q === undefined
        ? undefined
        : or(
            sql`${sessions.title} ILIKE ${containsPattern(q)}`,
            ID_PREFIX.test(q)
              ? sql`${sessions.id}::text LIKE ${`${q}%`}`
              : undefined,
          ),
    );
  }

  return {
    async countSessions(
      ownerId: string,
      query: CountSessionsQuery,
      viewer: SessionViewer,
    ): Promise<CountSessionsResponse> {
      const listed = db
        .select({
          status: sessions.status,
          awaitingInput: sql<boolean>`exists (${actionableOfSession(db)})`.as(
            "awaiting_input",
          ),
        })
        .from(sessions)
        .where(sessionFilter(ownerId, query, viewer))
        .as("listed");
      // The per-row visibility and input subqueries push the plan's cost past
      // jit_above_cost: over 50,000 sessions compiling took 296 of 331 ms and
      // the count itself 35 (P-LIST-SCALE), so JIT is off for this read.
      const rows = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL jit = off`);
        return tx
          .select({
            status: listed.status,
            awaitingInput: listed.awaitingInput,
            count: sql<number>`count(*)::int`,
          })
          .from(listed)
          .groupBy(listed.status, listed.awaitingInput);
      });
      const counts = Object.fromEntries(
        SESSION_STATUS_VALUES.map((status) => [status, 0]),
      ) as CountSessionsResponse["counts"];
      let total = 0;
      for (const row of rows) {
        const status = publicStatus(row.status, row.awaitingInput);
        counts[status] += row.count;
        total += row.count;
      }
      return { counts, total };
    },

    async listSessions(
      ownerId: string,
      query: ListSessionsQuery,
      viewer: SessionViewer,
    ) {
      const cursor = query.cursor ? decodeCreatedAtCursor(query.cursor) : null;
      // One snapshot, as the detail: an answer committed between the page
      // and its summary read showed needs_input beside input_wait null.
      return db.transaction(
        async (tx) => {
          // As countSessions: a search that matches little reads every
          // session of the owner, and JIT took 27 of its 47 ms.
          await tx.execute(sql`SET LOCAL jit = off`);
          const rows = await tx
            .select({
              session: sessions,
              cursorAt: CREATED_AT_TEXT,
              awaitingInput: sql<boolean>`exists (${actionableOfSession(db)})`,
              lastEventAt: LAST_EVENT_AT,
              readAt: READ_AT,
            })
            .from(sessions)
            .where(
              and(
                sessionFilter(ownerId, query, viewer),
                query.status ? publicStatusIs(query.status) : undefined,
                query.agent_id
                  ? inArray(
                      sessions.agentReleaseId,
                      db
                        .select({ id: agentReleases.id })
                        .from(agentReleases)
                        .where(eq(agentReleases.agentId, query.agent_id)),
                    )
                  : undefined,
                cursor
                  ? sql`(${sessions.createdAt}, ${sessions.id}) < (${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(desc(sessions.createdAt), desc(sessions.id))
            .limit(query.limit + 1)
            .catch(rethrowCursorCastError);
          const page = rows.slice(0, query.limit);
          const last = page[page.length - 1];
          return {
            items: last ? await summarize(tx, page, last.readAt) : [],
            next_cursor:
              rows.length > query.limit && last
                ? encodeCreatedAtCursor({
                    created_at: last.cursorAt,
                    id: last.session.id,
                  })
                : null,
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    getSession(
      ownerId: string,
      sessionId: string,
    ): Promise<SessionDetailRecord | null> {
      // One snapshot for every field: read one by one, a turn starting
      // between two reads showed running beside current_turn_id null.
      // A reader built on a caller's transaction gets a savepoint here and
      // the caller's isolation instead, so that must hold a snapshot too.
      return db.transaction(
        async (tx) => {
          // The count and the status it projects come from one statement,
          // so the detail never says needs_input beside a count of zero.
          const [read] = await tx
            .select({
              session: sessions,
              pendingCount: sql<number>`(SELECT count(*)::int FROM (${actionableOfSession(tx)}) AS actionable)`,
              lastEventAt: LAST_EVENT_AT,
              readAt: READ_AT,
              isolation: sql<string>`current_setting('transaction_isolation')`,
            })
            .from(sessions)
            .where(
              and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)),
            )
            .limit(1);
          if (!read) return null;
          if (read.isolation === "read committed") {
            throw new Error("Session detail needs a snapshot transaction");
          }
          const row = read.session;
          const [summary] = await summarize(
            tx,
            [
              {
                session: row,
                awaitingInput: read.pendingCount > 0,
                lastEventAt: read.lastEventAt,
              },
            ],
            read.readAt,
          );
          if (!summary) return null;
          // A pool launch carries whatever generation its backend picked, so
          // the highest generation need not be the execution that claimed
          // last. The session names its current one; once
          // released, its last attempt does.
          const [lastAttempt] = await tx
            .select({
              id: attempts.id,
              executionId: attempts.executionId,
              startedAt: attempts.startedAt,
            })
            .from(attempts)
            .where(eq(attempts.sessionId, sessionId))
            .orderBy(desc(attempts.leaseEpoch))
            .limit(1);
          let workspaceLimitMode: WorkspaceLimitMode | undefined;
          if (lastAttempt !== undefined) {
            const [classification] = await tx
              .select({ payload: events.payload })
              .from(events)
              .where(
                and(
                  eq(events.sessionId, sessionId),
                  eq(events.attemptId, lastAttempt.id),
                  eq(events.type, "system"),
                  sql`${events.payload}->>'subtype' = 'workspace_limit_mode'`,
                ),
              )
              .orderBy(desc(events.id))
              .limit(1);
            const parsed = workspaceLimitModeSchema.safeParse(
              classification?.payload,
            );
            if (parsed.success) workspaceLimitMode = parsed.data;
            else if (
              classification === undefined &&
              archiveCache !== undefined
            ) {
              const chunks = await tx
                .select()
                .from(sessionEventArchives)
                .where(
                  and(
                    eq(sessionEventArchives.sessionId, sessionId),
                    gte(
                      sessionEventArchives.lastCreatedAt,
                      lastAttempt.startedAt,
                    ),
                  ),
                )
                .orderBy(desc(sessionEventArchives.fromId));
              workspaceLimitMode = await readArchivedWorkspaceLimit(
                archiveCache,
                chunks,
                lastAttempt,
              );
            }
          }
          const currentExecutionId =
            row.executionId ?? lastAttempt?.executionId ?? null;
          const [execution] = await tx
            .select({
              backend: executions.backend,
              state: executions.observedState,
              observed_at: executions.observedAt,
            })
            .from(executions)
            .where(eq(executions.sessionId, sessionId))
            .orderBy(
              ...(currentExecutionId === null
                ? []
                : [desc(eq(executions.id, currentExecutionId))]),
              desc(executions.generation),
            )
            .limit(1);
          const [completed] = await tx
            .select({ sequence: max(turns.sequence) })
            .from(turns)
            .where(
              and(
                eq(turns.sessionId, sessionId),
                eq(turns.status, "completed"),
              ),
            );
          // The turn the *pointer's* checkpoint closed, not the newest
          // checkpoint row: the two agree only while nothing is committing.
          // A turn-less checkpoint closed none but still has its size.
          const [checkpoint] =
            row.checkpointRevision === null
              ? []
              : await tx
                  .select({
                    sequence: turns.sequence,
                    transcriptBytes: checkpoints.transcriptBytes,
                  })
                  .from(checkpoints)
                  .leftJoin(turns, eq(turns.id, checkpoints.turnId))
                  .where(
                    and(
                      eq(checkpoints.sessionId, sessionId),
                      eq(checkpoints.revision, row.checkpointRevision),
                    ),
                  )
                  .limit(1);
          return {
            ...summary,
            ...(workspaceLimitMode === undefined
              ? {}
              : { workspace_limit_mode: workspaceLimitMode }),
            execution: execution
              ? executionObservationSchema.parse({
                  ...execution,
                  observed_at: execution.observed_at?.toISOString() ?? null,
                })
              : null,
            checkpoint_revision: row.checkpointRevision,
            input_wait:
              (await readInputWaits(tx, [row], read.readAt)).get(row.id) ??
              null,
            pause_reason:
              row.pauseReason === "awaiting_input" ? row.pauseReason : null,
            pending_request_count: read.pendingCount,
            attention:
              (await drainAttention(tx, row)) ??
              (await contextGapAttention(tx, row)) ??
              startupFailedAttention(row) ??
              transcriptLimitAttention(
                row.checkpointPendingReason,
                // A pointer start_fresh retired says nothing about the
                // engine session running now.
                row.contextResetCheckpointRevision !== null &&
                  row.checkpointRevision !== null &&
                  row.checkpointRevision <= row.contextResetCheckpointRevision
                  ? null
                  : (checkpoint?.transcriptBytes ?? null),
              ),
            cost_usd: row.costUsd,
            provider_tokens: row.providerTokens,
            repo_url: row.repoUrl,
            branch: row.branch,
            repository_mode: row.repositoryMode,
            github_policy_source: row.githubPolicySource,
            profile_fingerprint: row.profileFingerprint,
            durability: projectDurability({
              checkpointCommittedAt: row.checkpointCommittedAt,
              checkpointFallbackRevision: row.checkpointFallbackRevision,
              checkpointRevision: row.checkpointRevision,
              contextResetTurnId:
                row.contextResetTurnSequence === null
                  ? null
                  : String(row.contextResetTurnSequence),
              lastCheckpointedTurnId:
                checkpoint?.sequence == null
                  ? null
                  : String(checkpoint.sequence),
              lastCompletedTurnId:
                completed?.sequence == null ? null : String(completed.sequence),
              lastTranscriptPersistedAt: row.lastTranscriptPersistedAt,
              pendingReason: publicPendingReason(
                sessionId,
                row.checkpointPendingReason,
              ),
            }),
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async listTurns(ownerId: string, sessionId: string, query: ListTurnsQuery) {
      const cursor = query.cursor ? decodeTurnCursor(query.cursor) : null;
      const session = await ownedSession(ownerId, sessionId);
      if (!session) return null;
      const rows = await turnWithInput()
        .where(
          and(
            eq(turns.sessionId, sessionId),
            cursor ? gt(turns.sequence, cursor.sequence) : undefined,
          ),
        )
        .orderBy(asc(turns.sequence))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const revisions = await checkpointRevisions(
        page.map(({ turn }) => turn.id),
        session.retiredCheckpointRevision,
      );
      return {
        items: page.map((read) =>
          summarizeTurn(read, revisions.get(read.turn.id) ?? null),
        ),
        next_cursor:
          rows.length > query.limit && last
            ? encodeTurnCursor({ sequence: last.turn.sequence })
            : null,
      };
    },

    async getTurn(
      ownerId: string,
      sessionId: string,
      turnId: string,
    ): Promise<TurnDetail | null> {
      const sequence = parseTurnSequence(turnId);
      if (sequence === null) return null;
      const session = await ownedSession(ownerId, sessionId);
      if (!session) return null;
      const [read] = await turnWithInput()
        .where(
          and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)),
        )
        .limit(1);
      if (!read) return null;
      const row = read.turn;
      const revisions = await checkpointRevisions(
        [row.id],
        session.retiredCheckpointRevision,
      );
      const parts = resultParts(row.resultJson);
      const attemptRows = row.attemptId
        ? await db
            .select()
            .from(attempts)
            .where(eq(attempts.id, row.attemptId))
            .limit(1)
        : [];
      return {
        ...summarizeTurn(read, revisions.get(row.id) ?? null),
        result: parts.result,
        usage: parts.usage,
        attempts: attemptRows.map((attempt) => ({
          attempt_id: attempt.id,
          state: attemptStateSchema.parse(attempt.state),
          lease_epoch: attempt.leaseEpoch,
          execution_generation: attempt.executionGeneration,
          started_at: attempt.startedAt.toISOString(),
          ended_at: attempt.endedAt?.toISOString() ?? null,
          profile_id: attempt.profileId,
        })),
      };
    },

    async getReceipt(
      ownerId: string,
      receiptId: string,
    ): Promise<Receipt | null> {
      const [row] = await db
        .select()
        .from(receipts)
        .where(and(eq(receipts.id, receiptId), eq(receipts.ownerId, ownerId)))
        .limit(1);
      return row ? receiptFromRow(row) : null;
    },

    async readEvents(
      ownerId: string,
      sessionId: string,
      query: ReadEventsQuery,
    ): Promise<EventPage | null> {
      const after = decodeEventCursor(query.after);
      const owned = await ownedSession(ownerId, sessionId);
      if (!owned) return null;
      // events.id is global, so a well-formed cursor from another session
      // would silently skip this one's history and a forged future cursor
      // would stream nothing forever. A nonzero cursor must name a row of
      // this session; alpha never trims, so a miss is a bad request rather
      // than 410 CURSOR_EXPIRED. A row that was archived is still the
      // session's.
      if (after > 0) {
        const [anchor] = await db
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.sessionId, sessionId), eq(events.id, after)))
          .limit(1);
        if (!anchor) {
          const chunk = await archiveChunkHolding(db, sessionId, after);
          const held =
            chunk !== undefined &&
            (await archive().lines(chunk)).some(({ id }) => id === after);
          if (!held) throw new InvalidCursorError();
        }
      }
      // A page's rows from archived chunks: enough of them to fill it, the
      // rows still stored follow. The chunk list and the page query are two
      // statements, so an archive or restore committing between them would
      // drop or repeat rows: the list is read again after the query and the
      // page is taken again while it moved.
      let rows: EventPageRow[] = [];
      for (let attempt = 0; ; attempt += 1) {
        const chunks = await archiveChunksAfter(db, sessionId, after);
        const archived: string[] = [];
        for (const chunk of chunks) {
          if (archived.length >= query.limit) break;
          for (const { id, line } of await archive().lines(chunk)) {
            if (id > after && archived.length < query.limit) {
              archived.push(line);
            }
          }
        }
        rows = await pageRows(sessionId, after, query, archived);
        const again = await archiveChunksAfter(db, sessionId, after);
        if (sameChunks(chunks, again)) break;
        if (attempt >= 4) {
          throw new Error(
            "Session events kept moving between the archive and the table while a page was read",
          );
        }
      }
      const fetched = Number(rows[0]?.fetched ?? 0);
      // Fields filled here on read count against the byte bound too: a page
      // stops before the row they would push past it.
      let filledBytes = 0;
      let cut = false;
      const items: SseEvent[] = [];
      for (const [index, row] of rows.entries()) {
        const stored = readStoredEvent(row.type, row.payload);
        const payload =
          stored.readable && row.bare && options.neutralize
            ? options.neutralize(owned.profileId, stored.payload)
            : stored.payload;
        if (payload !== stored.payload) {
          filledBytes +=
            byteLength(payload.data) - byteLength(stored.payload.data);
        }
        if (
          index > 0 &&
          Number(row.running_bytes) + filledBytes > query.maxBytes
        ) {
          cut = true;
          break;
        }
        if (!stored.readable) {
          options.logger?.warn("Stored event does not match the contract", {
            session_id: sessionId,
            event_row_id: Number(row.id),
            event_type: row.type,
          });
        }
        items.push(
          sseEventSchema.parse({
            id: encodeEventCursor(Number(row.id)),
            event: payload.event,
            data: {
              schema_version: SSE_SCHEMA_VERSION,
              session_id: sessionId,
              turn_id:
                row.turn_sequence === null ? null : String(row.turn_sequence),
              attempt_id: row.attempt_id,
              occurred_at: new Date(Number(row.occurred_ms)).toISOString(),
              data: payload.data,
            },
          }),
        );
      }
      return {
        items,
        // Cut by the row limit, or by the byte bound below the row limit.
        more: cut || fetched === query.limit || rows.length < fetched,
      };
    },
  };
}
