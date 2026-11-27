import { randomUUID } from "node:crypto";
import {
  type AuthorizationSubject,
  attemptStateSchema,
  type CheckpointBlockReason,
  type CountSessionsQuery,
  type CountSessionsResponse,
  type CreateSessionResponse,
  CUT_OFF_TURN_REASONS,
  checkpointBlockReasonSchema,
  createSessionResponseSchema,
  executionObservationSchema,
  type InputWait,
  type ListSessionsQuery,
  type ListTurnsQuery,
  PAUSE_REASON_VALUES,
  type PostSessionMessageResponse,
  postSessionMessageResponseSchema,
  type Receipt,
  type ReceiptSessionTarget,
  type RequesterAuth,
  type RuntimeKind,
  readStoredEvent,
  receiptSchema,
  SESSION_STATUS_VALUES,
  type SessionEventPayload,
  type SessionExtension,
  type SessionStatus,
  type SlackMessageRef,
  type SpecSource,
  SSE_SCHEMA_VERSION,
  type SseEvent,
  type SurfaceKind,
  specSourceSchema,
  sseEventSchema,
  type TurnDetail,
  type TurnSummary,
  taskClosingSchema,
  taskInterpretationSchema,
  turnStatusSchema,
  UNFINISHED_TURN_STATUSES,
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
  RecordedActor,
  SessionDetailRecord,
  SessionReader,
  SessionRecord,
  SessionUnitOfWork,
  SessionViewer,
  StoredSourceSet,
  TurnInputTopic,
  UsageDecision,
} from "@werft-ai/platform";
import {
  type CallerLimit,
  callerLimitDigest,
  callerLimitRefusal,
  IN_FLIGHT_STATUSES,
  InvalidCursorError,
  projectDurability,
  publicStatus,
  receiptActorOf,
  sessionRepositoryOf,
  storedPendingReasonHoldsWork,
  transcriptLimitAttention,
} from "@werft-ai/platform";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  not,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import {
  pushFollowUpQueued,
  pushFollowUpRequester,
} from "./action/push-follow-ups.ts";
import { captureWorkspaceMcpStart } from "./agents/agent-workspace-mcp.ts";
import { earlierInSecond, releaseLabel } from "./agents/release-labels.ts";
import { ownerlessPastGrace } from "./agents.ts";
import { workerRuntimeView } from "./checkpoints/checkpoint-runtime.ts";
import {
  containsPattern,
  findIdempotent,
  type IdempotencyScope,
  isUuid,
  lockIdempotencyScope,
  parseTurnSequence,
} from "./control-shared.ts";
import {
  directSourceDeletedAt,
  firstTurnDeletedAt,
  lockedDeletedSource,
  newTurnSources,
  takeSlackTurnInput,
  titleDeletedAt,
} from "./conversations/index.ts";
import {
  decodeCreatedAtCursor,
  decodeEventCursor,
  decodeTurnCursor,
  encodeCreatedAtCursor,
  encodeEventCursor,
  encodeTurnCursor,
  rethrowCursorCastError,
} from "./cursors.ts";
import { budgetAccountRefused } from "./exchange-budget.ts";
import { captureGitHubPolicyStart } from "./github/github-settings.ts";
import { acceptanceTransaction, admitInput } from "./input-limits.ts";
import { readArchivedWorkspaceLimit } from "./limits/workspace-limit.ts";
import {
  agentNamedInSession,
  agentReachable,
} from "./musterrolle/administers.ts";
import {
  inputRefusal,
  lockCallerLimit,
  pinnedLimitOf,
  recordCallerLimited,
  sessionReach,
  startReach,
} from "./musterrolle/agent-caller-limits.ts";
import {
  lockUnboundRefs,
  recordUnboundRefusal,
} from "./musterrolle/credential-bindings.ts";
import {
  captureEnvStart,
  recordEnvRefusal,
  recordEnvResolution,
} from "./musterrolle/env-variables.ts";
import {
  sessionRelationIs,
  sessionVisibleTo,
} from "./musterrolle/session-shares.ts";
import type { Database } from "./queries.ts";
import { startFreshAvailable } from "./recovery-control.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  attempts,
  checkpoints,
  events,
  executions,
  idempotencyKeys,
  pendingRequests,
  receipts,
  sessionEventArchives,
  sessionShares,
  sessions,
  turns,
  users,
  workerLaunches,
} from "./schema.ts";
import { newSessionPin, pinRefusesLive } from "./session-spec-pin.ts";
import { contextGapAttention } from "./sessions/context-gap.ts";
import { drainAttention } from "./sessions/drain.ts";
import { enqueueWithin } from "./sessions/enqueue.ts";
import { eventWithNeutralFields } from "./sessions/event-payload.ts";
import { readInputWaits } from "./sessions/pending-requests.ts";
import {
  actionableOfSession,
  actionableOfTurn,
  READ_AT,
  sessionNeedsInput,
} from "./sessions/pending-status.ts";
import {
  keyReaches,
  lockAgentUsage,
  lockAgentUse,
  lockPreviewManager,
  lockRequester,
  lockSessionReach,
  type Requester,
} from "./sessions/requester-locks.ts";
import { startupFailedAttention } from "./sessions/restore-failures.ts";
import {
  type ArchivedEventCache,
  type ArchivedEventSource,
  archiveChunkHolding,
  archiveChunksAfter,
  archivedRows,
  createArchivedEventCache,
  sameChunks,
} from "./sessions/session-event-archives.ts";
import { recordStatus } from "./sessions/session-events.ts";
import { openTaskLimit, writeTaskRequest } from "./sessions/task-open.ts";
import { withheldEventPayload } from "./sessions/withheld-events.ts";
import { rowsOf } from "./statement-rows.ts";
import {
  channelEmergencyStopped,
  emergencyStopHolds,
} from "./surface/emergency-stop-hold.ts";
import { m1GateOpenForWrite } from "./surface/m1-judgments.ts";

export const CREATE_SESSION = "create_session";
export const APPEND_MESSAGE = "append_message";
/** The receipt scope of the inputs conversation turns hand to a session. */
export const conversationTurnInputScope = (sessionId: string) =>
  `${sessionId.toLowerCase()}:conversation_turn`;

/**
 * Holds the lock a conversation turn's hand-off takes to write its input,
 * so what is read after it sees that input, or its absence, for good.
 */
export function lockConversationTurnInput(
  tx: Database,
  input: { workspaceId: string; sessionId: string; turnId: string },
) {
  return lockIdempotencyScope(tx, {
    principal: input.workspaceId,
    actor: null,
    requestId: null,
    operation: APPEND_MESSAGE,
    resource: conversationTurnInputScope(input.sessionId),
    key: input.turnId,
  });
}
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

// What a turn, and the session's first one, keep of who asked and why they
// could. A key with no person is the requester itself, and so is a Slack
// bot the agent answers (its Slack user id).
function usageRecord(usage: UsageDecision | null, requester: Requester) {
  const kind =
    requester.userId !== null
      ? ("user" as const)
      : requester.apiKeyId !== null
        ? ("api_key" as const)
        : requester.slackBotUserId !== null
          ? ("slack_bot" as const)
          : null;
  return {
    usageBasis: usage?.allowed ? usage.basis : null,
    usageTeamId: usage?.allowed ? usage.teamId : null,
    requesterKind: kind,
    requesterId:
      kind === "user"
        ? requester.userId
        : kind === "api_key"
          ? requester.apiKeyId
          : kind === "slack_bot"
            ? requester.slackBotUserId
            : null,
  };
}

/**
 * The credential a turn's requester came in on. A person with no credential
 * this can name (a caller assembled without a login) gets none; the input
 * is not refused for it.
 */
const NO_REQUESTER: Requester = {
  userId: null,
  apiKeyId: null,
  role: null,
  keyAgentId: null,
  slackBotUserId: null,
};

function requesterAuthOf(
  actor: RecordedActor | undefined,
  requester: Requester,
): RequesterAuth | null {
  const installationId =
    actor?.principal.kind === "installation" ? actor.principal.id : null;
  if (requester.slackBotUserId !== null) {
    return installationId === null || requester.keyAgentId === null
      ? null
      : {
          method: "slack_bot",
          installation_id: installationId,
          agent_id: requester.keyAgentId,
        };
  }
  if (requester.userId !== null) {
    if (installationId !== null && actor?.linkedAccount !== undefined) {
      return {
        method: "slack_link",
        installation_id: installationId,
        linked_account_id: actor.linkedAccount.id,
        linked_account_revision: actor.linkedAccount.revision,
      };
    }
    if (requester.apiKeyId !== null) {
      return { method: "personal_key", api_key_id: requester.apiKeyId };
    }
    return actor?.webSessionId === undefined
      ? null
      : { method: "web_session", web_session_id: actor.webSessionId };
  }
  if (requester.apiKeyId !== null) {
    const agentId = requester.keyAgentId ?? actor?.agentId ?? null;
    return agentId === null
      ? { method: "service_key" }
      : { method: "agent_key", agent_id: agentId };
  }
  return { method: "unauthenticated" };
}

function callerRecord(
  limit: CallerLimit | null,
  subject: AuthorizationSubject | undefined,
) {
  return {
    callerChannel:
      limit === null ? null : (subject?.surface.channel_id ?? null),
    callerLimitDigest: limit === null ? null : callerLimitDigest(limit),
  };
}

async function agentOfRelease(
  tx: Database,
  releaseId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ agentId: agentReleases.agentId })
    .from(agentReleases)
    .where(eq(agentReleases.id, releaseId))
    .limit(1);
  return row?.agentId ?? null;
}

async function insertQueuedTurn(
  tx: Database,
  input: {
    callerChannel?: string | null;
    callerLimitDigest?: string | null;
    sessionId: string;
    sequence: number;
    message: string;
    actorId: string | null;
    channel: SurfaceKind | null;
    slackMessage: SlackMessageRef | null;
    traceContext?: string | null;
    usageBasis?: string | null;
    usageTeamId?: string | null;
    requesterKind?: string | null;
    requesterId?: string | null;
    requesterAuth?: RequesterAuth | null;
    /** The sources the caller already judged; read here when left out. */
    sources?: StoredSourceSet | null;
    /** The lost turn this one continues, whose input it already is. */
    continues?: number;
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
      traceContext: input.traceContext ?? null,
      usageBasis: input.usageBasis ?? null,
      usageTeamId: input.usageTeamId ?? null,
      requesterKind: input.requesterKind ?? null,
      requesterId: input.requesterId ?? null,
      requesterAuth: input.requesterAuth ?? null,
      callerChannel: input.callerChannel ?? null,
      callerLimitDigest: input.callerLimitDigest ?? null,
      // Decided now: the lost turn's input is this turn's own.
      ...(input.continues === undefined
        ? {}
        : {
            prependedTurn: input.continues,
            prependSkipReason: "continuation" as const,
          }),
      sources:
        input.sources !== undefined
          ? input.sources
          : await newTurnSources(tx, {
              sessionId: input.sessionId,
              slackMessage: input.slackMessage,
            }),
    })
    .returning({ id: turns.id });
  if (!turn) throw new Error("Failed to insert turn");
  await enqueueWithin(tx, {
    sessionId: input.sessionId,
    turnId: turn.id,
    payload: { message: input.message },
  });
}

/** Takes a Slack turn's message as its topic's input, beside the turn. */
async function takeSlackInput(
  tx: Database,
  input: {
    workspaceId: string | null | undefined;
    releaseId: string | null;
    sessionId: string;
    sequence: number;
    slackMessage: SlackMessageRef | undefined;
    slackInput: TurnInputTopic | undefined;
  },
): Promise<void> {
  if (input.slackInput === undefined || input.slackMessage === undefined) {
    return;
  }
  const agentId =
    input.releaseId === null ? null : await agentOfRelease(tx, input.releaseId);
  if (!input.workspaceId || agentId === null) {
    throw new Error("a Slack input needs its session's workspace and agent");
  }
  // M1's judgment is asked for only past the whole gate, in the turn's own
  // transaction under the agent's lock (a1/J5).
  const judgment =
    input.slackInput.judgment !== undefined &&
    (await m1GateOpenForWrite(tx, {
      workspaceId: input.workspaceId,
      agentId,
      teamId: input.slackMessage.team_id,
      channelId: input.slackMessage.channel_id,
    }))
      ? input.slackInput.judgment
      : undefined;
  await takeSlackTurnInput(
    tx,
    {
      workspaceId: input.workspaceId,
      agentId,
      teamId: input.slackMessage.team_id,
    },
    {
      topicId: input.slackInput.topicId,
      channelId: input.slackMessage.channel_id,
      ts: input.slackMessage.ts,
      turn: { sessionId: input.sessionId, sequence: input.sequence },
      engagement: input.slackInput.engagement,
      ...(judgment === undefined ? {} : { judgment }),
    },
  );
}

/**
 * Whether the release's agent is paused or archived, or has had no one to
 * administer it for the whole grace period, read under a share lock on the
 * agent row so a pause that commits later waits for this acceptance, and one
 * that committed earlier is seen. Approval is not read again: it is recorded
 * once and never withdrawn, so what the service saw cannot go stale.
 *
 * Ownership is judged here and nowhere earlier, so a succession that commits
 * before this read lets the start through without waiting for the reconciler.
 * It is judged in a statement of its own after the lock: a statement that
 * waited for the lock still reads every other row from the snapshot it took
 * before waiting, so an admin removed on the agent itself (which holds the
 * agent row) would still count. Losing the last owner through a disable or a
 * team change locks none of the rows read here; starts that read before it
 * commits go through, which the grace period makes harmless.
 */
export async function lockedNotRunnable(
  tx: Database,
  releaseId: string,
): Promise<"agent_inactive" | "agent_ownerless" | null> {
  const [row] = await tx
    .select({ id: agents.id, status: agents.status })
    .from(agentReleases)
    .innerJoin(agents, eq(agents.id, agentReleases.agentId))
    .where(eq(agentReleases.id, releaseId))
    .limit(1)
    .for("share", { of: agents });
  if (row === undefined) return null;
  if (row.status !== "active") return "agent_inactive";
  const [judged] = await tx
    .select({
      ownerless: ownerlessPastGrace(tx, agents),
    })
    .from(agents)
    .where(eq(agents.id, row.id));
  return judged?.ownerless ? "agent_ownerless" : null;
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
      return acceptanceTransaction(db, async (tx) => {
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
        // Who asks is judged first, so every refusal below (a paused agent,
        // an unbound credential, a repository the catalog lost) is said only to
        // someone who may still use the agent: it names the agent's admins
        // or its state.
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
        let usage: UsageDecision | null = null;
        let callerLimit: CallerLimit | null = null;
        let limitedAgentId: string | null = null;
        if (input.agentReleaseId !== undefined && workspaceId) {
          // Before any lock on a team (lockAgentUse below): see lockAgentUsage.
          usage = await lockAgentUsage(
            tx,
            requester,
            workspaceId,
            input.agentReleaseId,
          );
          if (input.agentPrivate || !usage.allowed) {
            return { outcome: "agent_private" };
          }
          // Before every refusal that names a limit or the agent's state: the
          // caller may have left the agent since the policy decided.
          const releaseId = input.agentReleaseId;
          const useRefused = async () =>
            !(await lockAgentUse(tx, requester, workspaceId, releaseId));
          if (input.callerLimited !== undefined) {
            if (await useRefused()) return { outcome: "agent_use_refused" };
            return {
              outcome: "caller_limited",
              dimension: input.callerLimited,
            };
          }
          // Right after the usage rows, so the rule's teams and the caller's
          // member rows are taken in id order before lockAgentUse's.
          limitedAgentId = await agentOfRelease(tx, input.agentReleaseId);
          if (limitedAgentId !== null) {
            callerLimit = await lockCallerLimit(tx, {
              workspaceId,
              agentId: limitedAgentId,
              userId: requester.userId,
              channelId: input.callerSubject?.surface.channel_id ?? null,
            });
          }
          if (await useRefused()) return { outcome: "agent_use_refused" };
          if (
            input.preview &&
            (limitedAgentId === null ||
              !(await lockPreviewManager(
                tx,
                input.principal,
                requester,
                workspaceId,
                limitedAgentId,
              )))
          ) {
            return { outcome: "preview_refused" };
          }
        } else if (input.preview) {
          return { outcome: "preview_refused" };
        }
        if (input.notRunnableReason !== undefined) {
          return {
            outcome: "not_runnable" as const,
            reason: input.notRunnableReason,
          };
        }
        if (input.credentialsUnbound && input.agentReleaseId !== undefined) {
          const reason = await lockedNotRunnable(tx, input.agentReleaseId);
          if (reason !== null) return { outcome: "not_runnable", reason };
          return unbound(input.agentReleaseId);
        }
        if (input.repository === null || input.extensionsRefused) {
          return { outcome: "unsupported" };
        }
        // After the requester's rows, so the agent row is never taken before
        // a key row (a key revoke locks the key, then the agent).
        if (input.agentReleaseId !== undefined) {
          const reason = await lockedNotRunnable(tx, input.agentReleaseId);
          if (reason !== null) return { outcome: "not_runnable", reason };
        }
        const workspaceMcpStart =
          input.agentReleaseId === undefined
            ? null
            : await captureWorkspaceMcpStart(tx, input.agentReleaseId);
        // The same merge and the same coverage check as the service made,
        // over the rows locked above: when a rule moved since, this answer
        // wins. Before the unbound check, which would hide a limit that
        // keeps the caller from the card's credentials at all.
        if (
          callerLimit !== null &&
          input.agentReleaseId !== undefined &&
          limitedAgentId !== null
        ) {
          const reach = await startReach(tx, {
            releaseId: input.agentReleaseId,
            workspaceMcpStart,
            githubPolicySource: input.githubPolicySource ?? "release",
            repositoryIds: [
              ...(typeof input.repository === "object"
                ? [input.repository.id]
                : []),
              ...(input.attachedRepositoryIds ?? []),
            ],
          });
          const dimension =
            reach === null ? null : callerLimitRefusal(callerLimit, reach);
          if (dimension !== null) {
            if (input.callerSubject !== undefined) {
              await recordCallerLimited(tx, {
                subject: input.callerSubject,
                ownerId: scope.principal,
                requestId: input.principal.requestId ?? "",
                agentId: limitedAgentId,
                releaseId: input.agentReleaseId,
                sessionId: null,
              });
            }
            return { outcome: "caller_limited", dimension };
          }
        }
        if (
          input.agentReleaseId !== undefined &&
          (
            await lockUnboundRefs(tx, {
              workspaceId: scope.principal,
              releaseId: input.agentReleaseId,
            })
          ).length > 0
        ) {
          return unbound(input.agentReleaseId);
        }
        // After the credentials, in the same transaction: the rows are locked
        // FOR SHARE, so the session stores the values that were checked.
        const envCapture =
          input.agentReleaseId === undefined
            ? ({ outcome: "none" } as const)
            : await captureEnvStart(tx, {
                workspaceId: scope.principal,
                releaseId: input.agentReleaseId,
                names: input.envNames ?? [],
              });
        if (envCapture.outcome === "refused") {
          // `agentReleaseId` is set: an empty name list never refuses.
          const { receiptId } = await recordEnvRefusal(tx, {
            ownerId: scope.principal,
            actor: scope.actor,
            requestId: scope.requestId,
            reason: envCapture.reason,
            target: {
              releaseId: input.agentReleaseId as string,
              idempotencyKey: input.idempotencyKey,
            },
          });
          return {
            outcome: "variables_refused" as const,
            reason: envCapture.reason,
            receiptId,
          };
        }
        // A Slack message deleted before its session was made makes none,
        // nor, for a task, any message its conversation turn read.
        if (
          input.slackMessage !== undefined &&
          workspaceId &&
          (await lockedDeletedSource(tx, {
            workspaceId,
            sessionId: null,
            throughTurn: null,
            sources: input.task?.sources ?? {
              direct: [
                {
                  team_id: input.slackMessage.team_id,
                  channel_id: input.slackMessage.channel_id,
                  ts: input.slackMessage.ts,
                },
              ],
              inherited: [],
            },
          })) !== null
        ) {
          return { outcome: "source_deleted" };
        }
        // Last of its locks, so none is taken after the binding's.
        if (
          input.slackMessage !== undefined &&
          input.agentReleaseId !== undefined &&
          (await channelEmergencyStopped(tx, {
            releaseId: input.agentReleaseId,
            teamId: input.slackMessage.team_id,
            channelId: input.slackMessage.channel_id,
          }))
        ) {
          return { outcome: "emergency_stopped" };
        }
        const refused = await admitInput(tx, {
          sessionId: null,
          message: input.message,
          limits: input.limits,
        });
        if (refused) return refused;
        // One task acceptance per agent at a time counts the tasks open.
        if (input.task !== undefined) {
          const limited = await openTaskLimit(tx, {
            releaseId: input.agentReleaseId,
            conversationId: input.parentConversationId ?? null,
            limits: input.task.openLimits,
          });
          if (limited !== null) {
            return { outcome: "task_limit", scope: limited };
          }
        }
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
          input.captureGitHubPolicyStart === true
            ? await captureGitHubPolicyStart(tx, input.agentReleaseId)
            : null;
        await tx.insert(sessions).values({
          id: sessionId,
          ownerId: scope.principal,
          ...repository,
          attachedRepositoryIds: input.attachedRepositoryIds ?? null,
          extensions: input.extensions ?? null,
          githubPolicySource: input.githubPolicySource ?? "release",
          githubPolicyStart,
          workspaceMcpStart,
          envStart:
            envCapture.outcome === "resolved" ? envCapture.envStart : null,
          title: input.title ?? null,
          titleSource: input.titleSource ?? "derived",
          channel: input.channel ?? null,
          parentConversationId: input.parentConversationId ?? null,
          model: input.model ?? null,
          unmetered: input.unmetered ?? false,
          agentReleaseId: input.agentReleaseId,
          preview: input.preview === true,
          ...((await newSessionPin(
            tx,
            input.agentReleaseId,
            input.model ?? null,
          )) ?? {}),
          platformPrompt: input.platformPrompt ?? null,
          permissionWaitOverride: input.permissionWait ?? null,
          workspaceId: actor?.workspaceId ?? null,
          createdByUserId: actor?.userId ?? null,
          createdByApiKeyId: actor?.apiKeyId ?? null,
          ...usageRecord(usage, requester),
          callerLimit,
          callerLimitDigest:
            callerLimit === null ? null : callerLimitDigest(callerLimit),
          ...(input.task === undefined
            ? {}
            : {
                taskInterpretation: taskInterpretationSchema.parse(
                  input.task.interpretation,
                ),
                taskClosing: taskClosingSchema.parse(input.task.closing),
              }),
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
          traceContext: input.traceContext ?? null,
          ...usageRecord(usage, requester),
          requesterAuth: requesterAuthOf(actor, requester),
          ...callerRecord(callerLimit, input.callerSubject),
          // A task's first input carries what its conversation turn read.
          ...(input.task === undefined ? {} : { sources: input.task.sources }),
        });
        await takeSlackInput(tx, {
          workspaceId: actor?.workspaceId,
          releaseId: input.agentReleaseId,
          sessionId,
          sequence: 1,
          slackMessage: input.slackMessage,
          slackInput: input.slackInput,
        });
        if (input.task !== undefined) {
          await writeTaskRequest(tx, {
            sessionId,
            agentReleaseId: input.agentReleaseId,
            slackMessage: input.slackMessage,
            text: input.task.requestText,
          });
        }

        if (envCapture.outcome === "resolved") {
          await recordEnvResolution(tx, {
            ownerId: scope.principal,
            actor: scope.actor,
            requestId: scope.requestId,
            sessionId,
            envStart: envCapture.envStart,
          });
        }

        const receiptId = randomUUID();
        const response: CreateSessionResponse = {
          session_id: sessionId,
          turn_id: "1",
          receipt_id: receiptId,
          receipt_status: "accepted",
          status: "queued",
          ...(input.extensions && input.extensions.length > 0
            ? { extensions: input.extensions }
            : {}),
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
        // A continuation is one request per lost turn, whoever asks and
        // with whatever key: the turn is the key, in a scope of its own
        // that no key a caller sends for a message can name.
        resource:
          input.continueTurn !== undefined
            ? `${sessionId}:continue`
            : input.conversationTurnId !== undefined
              ? conversationTurnInputScope(sessionId)
              : sessionId,
        key:
          input.continueTurn !== undefined
            ? String(input.continueTurn)
            : (input.conversationTurnId ?? input.idempotencyKey),
      };
      return acceptanceTransaction(db, async (tx) => {
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        // A continuation cancelled before it ran (an emergency stop's)
        // continued nothing: the lost turn may be continued again.
        const spent =
          existing !== undefined &&
          input.continueTurn !== undefined &&
          (await continuationCancelled(tx, sessionId, existing.result));
        if (existing && !spent) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          return {
            outcome: "replayed",
            response: postSessionMessageResponseSchema.parse(existing.result),
          };
        }
        if (spent) {
          await tx
            .delete(idempotencyKeys)
            .where(
              and(
                eq(idempotencyKeys.principal, scope.principal),
                eq(idempotencyKeys.operation, scope.operation),
                eq(idempotencyKeys.resource, scope.resource),
                eq(idempotencyKeys.key, scope.key),
              ),
            );
        }
        // A turn that ended other than handed hands nothing on (v1-b/E4).
        if (
          input.conversationTurnId !== undefined &&
          rowsOf<{ ended: boolean }>(
            await tx.execute(sql`
              SELECT task_effect IS NOT NULL AND task_effect <> 'routed' AS ended
              FROM conversation_turns
              WHERE id = ${input.conversationTurnId}::uuid`),
          )[0]?.ended === true
        ) {
          return { outcome: "conflict" };
        }
        const platform = input.platform;
        const requester =
          platform === undefined
            ? await lockRequester(tx, input.principal, "sessions:write")
            : NO_REQUESTER;
        if (!requester) return { outcome: "actor_inactive" };
        // The M1 gate reads the channel's bindings with the session held; an
        // emergency stop takes those bindings before the session, so they
        // are taken here first, in the stop's order, and the two never wait
        // on each other in a cycle.
        if (
          input.slackInput?.judgment !== undefined &&
          input.slackMessage !== undefined
        ) {
          await tx.execute(sql`
            SELECT 1 FROM surface_bindings b
            WHERE b.agent_id = (
                SELECT r.agent_id FROM sessions s
                JOIN agent_releases r ON r.id = s.agent_release_id
                WHERE s.id = ${sessionId}::uuid)
              AND b.surface = 'slack'
              AND b.external_surface_id = ${input.slackMessage.channel_id}
            ORDER BY b.id
            FOR SHARE OF b`);
        }
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
            sourceDeletedAt: sessions.sourceDeletedAt,
            agentReleaseId: sessions.agentReleaseId,
            runtimeSpec: sessions.runtimeSpec,
            model: sessions.model,
            repositoryId: sessions.repositoryId,
            attachedRepositoryIds: sessions.attachedRepositoryIds,
            mcpStart: sessions.mcpStart,
            workspaceMcpStart: sessions.workspaceMcpStart,
            githubPolicySource: sessions.githubPolicySource,
            githubPolicyStart: sessions.githubPolicyStart,
            callerLimit: sessions.callerLimit,
            preview: sessions.preview,
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
        // Before any check of the input itself: a follow-up already queued is
        // the answer, whatever the session would say to a new one now.
        if (
          platform !== undefined &&
          (await pushFollowUpQueued(tx, sessionId, platform.pushRequestId))
        ) {
          return { outcome: "already_queued" };
        }
        if (!(await keyReaches(tx, requester, session.agentReleaseId))) {
          return { outcome: "actor_inactive" };
        }
        // Locked before the reach below takes any team (see lockAgentUsage),
        // but said after it: a session the requester cannot see does not exist
        // for them, whoever its agent is.
        const usage =
          platform === undefined &&
          session.agentReleaseId !== null &&
          session.workspaceId !== null
            ? await lockAgentUsage(
                tx,
                requester,
                session.workspaceId,
                session.agentReleaseId,
              )
            : null;
        const limitedAgentId =
          usage !== null && session.agentReleaseId !== null
            ? await agentOfRelease(tx, session.agentReleaseId)
            : null;
        const senderLimit =
          limitedAgentId !== null && session.workspaceId !== null
            ? await lockCallerLimit(tx, {
                workspaceId: session.workspaceId,
                agentId: limitedAgentId,
                userId: requester.userId,
                channelId: input.callerSubject?.surface.channel_id ?? null,
              })
            : null;
        // Taken before the reach so the admin rows come before its team
        // member rows; said after it, and before the usage refusal, so a
        // creator who lost the agent hears why their preview stopped.
        const previewHeld =
          platform !== undefined ||
          !session.preview ||
          (limitedAgentId !== null &&
            session.workspaceId !== null &&
            (await lockPreviewManager(
              tx,
              input.principal,
              requester,
              session.workspaceId,
              limitedAgentId,
            )));
        if (
          platform === undefined &&
          (await lockSessionReach(tx, requester, session)) !== "ok"
        ) {
          return { outcome: "not_found" };
        }
        if (!previewHeld) {
          return { outcome: "preview_refused" };
        }
        if (input.agentPrivate || (usage !== null && !usage.allowed)) {
          return { outcome: "agent_private" };
        }
        if (
          senderLimit !== null &&
          limitedAgentId !== null &&
          session.agentReleaseId !== null
        ) {
          const reach = await sessionReach(tx, session);
          const dimension =
            reach === null
              ? null
              : inputRefusal(
                  senderLimit,
                  reach,
                  pinnedLimitOf(session.callerLimit),
                );
          if (dimension !== null) {
            if (input.callerSubject !== undefined) {
              await recordCallerLimited(tx, {
                subject: input.callerSubject,
                ownerId: scope.principal,
                requestId: input.principal.requestId ?? "",
                agentId: limitedAgentId,
                releaseId: session.agentReleaseId,
                sessionId,
              });
            }
            return { outcome: "caller_limited", dimension };
          }
        }
        if (session.takeoverRequiredAt !== null) {
          return { outcome: "awaiting_takeover" };
        }
        // Before the admission: a session stopped for a deleted source says
        // why, whether it is pausing, paused or stopped by now.
        if (session.sourceDeletedAt !== null) {
          return { outcome: "source_deleted", sessionStopped: true };
        }
        // An admin stopped the agent in the session's channel: nothing goes
        // in, a continuation included, until the channel is on again.
        if (await emergencyStopHolds(tx, sessionId)) {
          return { outcome: "emergency_stopped" };
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
        // This input revives a failed session, which an authoritative spec
        // pin refuses unless the session has one on its own model.
        if (session.status === "failed" && pinRefusesLive(session)) {
          return { outcome: "pin_required" };
        }
        // A continuation carries the input of the turn it goes on from, read
        // where that turn keeps it. Only a cut-off turn (its worker's lost
        // lease, or an emergency stop of its channel) has one to give: any
        // other turn's end already said what it came to.
        const [lost] =
          input.continueTurn === undefined
            ? []
            : await tx
                .select({ message: turns.message })
                .from(turns)
                .where(
                  and(
                    eq(turns.sessionId, sessionId),
                    eq(turns.sequence, input.continueTurn),
                    eq(turns.status, "failed"),
                    inArray(turns.terminalReason, [...CUT_OFF_TURN_REASONS]),
                  ),
                )
                .limit(1);
        if (input.continueTurn !== undefined && !lost) {
          return { outcome: "not_found" };
        }
        // A turn after the lost one already goes on from it: a message sent
        // since, or one that waited behind it. The button goes with it. One
        // cancelled before it ran (an emergency stop's) goes on from nothing.
        if (input.continueTurn !== undefined) {
          const [later] = await tx
            .select({ sequence: turns.sequence })
            .from(turns)
            .where(
              and(
                eq(turns.sessionId, sessionId),
                gt(turns.sequence, input.continueTurn),
                ne(turns.status, "cancelled"),
              ),
            )
            .limit(1);
          if (later) return { outcome: "superseded" };
        }
        const message = lost?.message ?? input.message;
        // The turn would carry a source Slack deleted: its own message, one
        // an earlier turn of the session came from, or one the conversation
        // turn that handed it on read.
        const sources = await newTurnSources(tx, {
          sessionId,
          slackMessage:
            platform === undefined ? (input.slackMessage ?? null) : null,
          carried:
            platform === undefined ? (input.carriedSources ?? null) : null,
        });
        if (
          session.workspaceId !== null &&
          (await lockedDeletedSource(tx, {
            workspaceId: session.workspaceId,
            sessionId,
            sources,
            throughTurn: null,
          })) !== null
        ) {
          return { outcome: "source_deleted" };
        }
        const refused = await admitInput(tx, {
          sessionId,
          message,
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
          message,
          traceContext: input.traceContext ?? null,
          sources,
          ...(input.continueTurn === undefined
            ? {}
            : { continues: input.continueTurn }),
          ...(platform === undefined
            ? {
                actorId: input.principal.actor?.userId ?? null,
                channel: input.channel ?? null,
                slackMessage: input.slackMessage ?? null,
                ...usageRecord(usage, requester),
                requesterAuth: requesterAuthOf(
                  input.principal.actor,
                  requester,
                ),
                ...callerRecord(senderLimit, input.callerSubject),
              }
            : {
                // The agent's turn: no person, no surface, no usage basis.
                actorId: null,
                channel: null,
                slackMessage: null,
                ...(await pushFollowUpRequester(tx, {
                  agentReleaseId: session.agentReleaseId,
                  pushRequestId: platform.pushRequestId,
                  decision: platform.decision,
                })),
              }),
        });
        if (platform === undefined) {
          await takeSlackInput(tx, {
            workspaceId: session.workspaceId,
            releaseId: session.agentReleaseId,
            sessionId,
            sequence,
            slackMessage: input.slackMessage,
            slackInput: input.slackInput,
          });
        }
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

// The session's last turn was cut off: by its worker's lost lease, or by an
// emergency stop of its channel. One cancelled before it ran (an emergency
// stop's) is not the last.
const LAST_TURN_CUT_OFF = sql<boolean>`coalesce((
  SELECT t.status = 'failed' AND t.terminal_reason IN (${sql.join(
    CUT_OFF_TURN_REASONS.map((reason) => sql`${reason}`),
    sql`, `,
  )})
  FROM ${turns} t
  WHERE t.session_id = ${sessions}.id AND t.status <> 'cancelled'
  ORDER BY t.sequence DESC LIMIT 1
), false)`;

/** The turn a continuation queued was cancelled before it ran. */
async function continuationCancelled(
  tx: Database,
  sessionId: string,
  result: unknown,
): Promise<boolean> {
  const parsed = postSessionMessageResponseSchema.safeParse(result);
  if (!parsed.success) return false;
  const [turn] = await tx
    .select({ status: turns.status })
    .from(turns)
    .where(
      and(
        eq(turns.sessionId, sessionId),
        eq(turns.sequence, Number(parsed.data.turn_id)),
      ),
    );
  return turn?.status === "cancelled";
}

type SessionRow = typeof sessions.$inferSelect;
type TurnRow = typeof turns.$inferSelect;
type TurnRead = {
  turn: TurnRow;
  awaitingInput: boolean;
  creatorName: string | null;
  sourceDeletedAt: Date | null;
};

const turnWorkspace = sql`(SELECT ws.workspace_id FROM sessions ws WHERE ws.id = ${turns.sessionId})`;

/** When Slack deleted the turn's instruction (directSourceDeletedAt). */
const turnSourceDeletedAt =
  sql<Date | null>`${directSourceDeletedAt(sql`${turns.sources}`, turnWorkspace)}`.mapWith(
    (value: string | Date | null) => (value === null ? null : new Date(value)),
  );

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

// As stored: a kind or method this build does not know is shown, not dropped.
function requesterView(row: {
  requesterKind: string | null;
  requesterId: string | null;
  requesterAuth: unknown;
}): TurnSummary["requester"] {
  if (!row.requesterKind || !row.requesterId) return null;
  const auth =
    row.requesterAuth !== null &&
    typeof row.requesterAuth === "object" &&
    !Array.isArray(row.requesterAuth)
      ? (row.requesterAuth as Record<string, unknown>)
      : null;
  const method = auth?.method;
  const carried = auth?.carried_from;
  return {
    kind: row.requesterKind,
    id: row.requesterId,
    auth_method: typeof method === "string" && method !== "" ? method : null,
    carried:
      carried !== null &&
      typeof carried === "object" &&
      !Array.isArray(carried),
  };
}

function summarizeTurn(
  { turn: row, awaitingInput, creatorName, sourceDeletedAt }: TurnRead,
  checkpointRevision: number | null,
): TurnSummary {
  return {
    turn_id: String(row.sequence),
    session_id: row.sessionId,
    status: turnStatusSchema.parse(publicStatus(row.status, awaitingInput)),
    // Its instruction was deleted in Slack: withheld, not erased.
    message: sourceDeletedAt === null ? row.message : "",
    source_deleted_at: sourceDeletedAt?.toISOString() ?? null,
    channel: row.channel,
    slack_permalink: row.slackMessage?.permalink ?? null,
    created_by:
      row.actorId === null || creatorName === null
        ? null
        : { user_id: row.actorId, display_name: creatorName },
    requester: requesterView(row),
    // A reason an engine wrote may quote what the turn read.
    terminal_reason: sourceDeletedAt === null ? row.terminalReason : null,
    prepended_turn_id:
      row.prependedTurn !== null && row.prependSkipReason === null
        ? String(row.prependedTurn)
        : null,
    checkpoint_revision: checkpointRevision,
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    ended_at: row.endedAt?.toISOString() ?? null,
  };
}

/** A title cut or made from a deleted first message reads as none. */
function withheldTitle(
  row: Pick<SessionRow, "title" | "titleSource">,
  firstDeletedAt: Date | null,
): { title: string | null; title_deleted_at: string | null } {
  return firstDeletedAt !== null &&
    (row.titleSource === "derived" || row.titleSource === "generated")
    ? { title: null, title_deleted_at: firstDeletedAt.toISOString() }
    : { title: row.title, title_deleted_at: null };
}

/** A status event without the title a withheld one would show. */
function withoutTitle(payload: SessionEventPayload): SessionEventPayload {
  if (payload.event !== "status" || payload.data.title === undefined) {
    return payload;
  }
  const { title: _title, ...data } = payload.data;
  return { event: "status", data };
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

/** A stored spec source as the read model shows it; null when it does not parse. */
function specOf(stored: unknown): SpecSource | null {
  const parsed = specSourceSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

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
        runtimeKind: sql<RuntimeKind | null>`${sessions.runtimeSpec} -> 'runtime' ->> 'kind'`,
        retiredCheckpointRevision: sessions.contextResetCheckpointRevision,
        workspaceId: sessions.workspaceId,
        // Any title an event set may be one made from the first turn,
        // even once a person renamed the session since.
        titleDeleted: sql<boolean>`${firstTurnDeletedAt("sessions")} IS NOT NULL`,
      })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
      .limit(1);
    return row ?? null;
  }

  // Only a revision a restore can still reach counts: one garbage
  // collection took, or one a start_fresh decision retired, does
  // not. The session bound lets the primary key find the rows; turn_id
  // has no index of its own.
  async function checkpointRevisions(
    sessionId: string,
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
          eq(checkpoints.sessionId, sessionId),
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
        sourceDeletedAt: turnSourceDeletedAt,
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
      return and(
        sessionNeedsInput(db),
        // Implied by `sessionNeedsInput`, but uncorrelated: the plan can
        // start from the few open requests instead of every session of the
        // owner.
        inArray(
          sessions.id,
          db
            .select({ id: pendingRequests.sessionId })
            .from(pendingRequests)
            .where(
              and(
                isNull(pendingRequests.resolvedAt),
                gt(pendingRequests.expiresAt, sql`statement_timestamp()`),
              ),
            ),
        ),
      );
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
    // Whose eyes: a session whose agent this viewer may not use shows no
    // agent. Absent for a read that never reaches a person (internal).
    viewer?: SessionViewer,
  ): Promise<SessionRecord[]> {
    if (rows.length === 0) return [];
    const ids = rows.map(({ session }) => session.id);
    const releaseIds = [
      ...new Set(rows.flatMap(({ session }) => session.agentReleaseId ?? [])),
    ];
    // Turn 1's actor started the session; a takeover rewrites
    // created_by_user_id but leaves it. A session whose turn 1 names no actor
    // falls back to created_by_user_id.
    const firstTurns = await executor
      .select({
        sessionId: turns.sessionId,
        actorId: turns.actorId,
        slackMessage: turns.slackMessage,
        sourceDeletedAt: turnSourceDeletedAt,
      })
      .from(turns)
      .where(and(inArray(turns.sessionId, ids), eq(turns.sequence, 1)));
    // What the finished turns ran, summed per session: idle, paused and
    // waiting time between turns falls outside every turn.
    const turnTimes = new Map(
      (
        await executor
          .select({
            sessionId: turns.sessionId,
            ms: sql<string>`coalesce(sum(extract(epoch from ${turns.endedAt} - ${turns.startedAt}) * 1000), 0)`,
          })
          .from(turns)
          .where(
            and(
              inArray(turns.sessionId, ids),
              isNotNull(turns.startedAt),
              isNotNull(turns.endedAt),
            ),
          )
          .groupBy(turns.sessionId)
      ).map((row) => [row.sessionId, Math.max(0, Math.round(Number(row.ms)))]),
    );
    const cutOff = new Set(
      (
        await executor
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(inArray(sessions.id, ids), LAST_TURN_CUT_OFF))
      ).map((row) => row.id),
    );
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
              status: agents.status,
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
          inArray(turns.status, UNFINISHED_TURN_STATUSES),
        ),
      );

    // An open launch still meant to run whose resource waits for room.
    const capacityWaits = new Map(
      (
        await executor
          .select({
            sessionId: workerLaunches.sessionId,
            since: workerLaunches.capacityWaitSince,
          })
          .from(workerLaunches)
          .innerJoin(executions, eq(executions.id, workerLaunches.executionId))
          .where(
            and(
              inArray(workerLaunches.sessionId, ids),
              isNull(workerLaunches.slotReleasedAt),
              isNotNull(workerLaunches.capacityWaitSince),
              isNull(workerLaunches.claimedAttemptId),
              eq(executions.desiredState, "running"),
            ),
          )
      ).map((wait) => [wait.sessionId, wait.since]),
    );

    const agentIds = [...new Set(releases.map((release) => release.id))];
    const usable =
      viewer === undefined || agentIds.length === 0
        ? null
        : new Set(
            (
              await executor
                .select({ id: agents.id })
                .from(agents)
                .where(
                  and(
                    inArray(agents.id, agentIds),
                    agentNamedInSession(
                      executor,
                      agents.workspaceId,
                      {
                        userId: viewer.userId,
                        keyAgentId: viewer.keyAgentId ?? null,
                      },
                      agents.id,
                    ),
                  ),
                )
            ).map((agent) => agent.id),
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
        ...withheldTitle(row, firstTurnOf(row)?.sourceDeletedAt ?? null),
        preview: row.preview,
        agent_hidden:
          release !== undefined && usable?.has(release.id) === false,
        agent:
          release && usable?.has(release.id) !== false
            ? {
                id: release.id,
                name: release.name,
                release_version_no: release.release_version_no,
                release_label: releaseLabel(release.createdAt, release.earlier),
                release_is_active:
                  release.activeReleaseId === release.releaseId,
                archived: release.status === "archived",
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
        wait_reason: capacityWaits.has(row.id)
          ? ("waiting_for_capacity" as const)
          : null,
        waiting_since: capacityWaits.get(row.id)?.toISOString() ?? null,
        spec: specOf(row.specSource),
        model: row.model,
        repository_id: row.repositoryId,
        repository: sessionRepositoryOf(row),
        attached_repository_ids: row.attachedRepositoryIds,
        extensions: row.extensions as SessionExtension[] | null,
        current_turn_id: current ? String(current.sequence) : null,
        queued_turn_count: mine.filter((turn) => turn.status === "queued")
          .length,
        turn_time_ms: turnTimes.get(row.id) ?? 0,
        last_turn_cut_off: cutOff.has(row.id),
        last_event_at: lastEventAt?.toISOString() ?? null,
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
            // A title withheld for its deleted message finds nothing.
            sql`(${sessions.title} ILIKE ${containsPattern(q)} AND ${titleDeletedAt("sessions")} IS NULL)`,
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
          // Only an idle session is counted as cut off; the rest skip the read.
          cutOff:
            sql<boolean>`CASE WHEN ${sessions.status} = 'idle' THEN ${LAST_TURN_CUT_OFF} ELSE false END`.as(
              "cut_off",
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
            cutOff: listed.cutOff,
            count: sql<number>`count(*)::int`,
          })
          .from(listed)
          .groupBy(listed.status, listed.awaitingInput, listed.cutOff);
      });
      const counts = Object.fromEntries(
        [...SESSION_STATUS_VALUES, "cut_off"].map((status) => [status, 0]),
      ) as CountSessionsResponse["counts"];
      let total = 0;
      for (const row of rows) {
        const status = publicStatus(row.status, row.awaitingInput);
        counts[status] += row.count;
        if (status === "idle" && row.cutOff) counts.cut_off += row.count;
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
                query.last_turn_cut_off === undefined
                  ? undefined
                  : query.last_turn_cut_off === "true"
                    ? LAST_TURN_CUT_OFF
                    : not(LAST_TURN_CUT_OFF),
                query.agent_id
                  ? inArray(
                      sessions.agentReleaseId,
                      db
                        .select({ id: agentReleases.id })
                        .from(agentReleases)
                        .innerJoin(agents, eq(agents.id, agentReleases.agentId))
                        .where(
                          and(
                            eq(agentReleases.agentId, query.agent_id),
                            // An agent the viewer may not use, or is outside,
                            // filters like one that is not there, save one
                            // the holding team holds, named on its sessions.
                            agentNamedInSession(
                              db,
                              agents.workspaceId,
                              {
                                userId: viewer.userId,
                                keyAgentId: viewer.keyAgentId ?? null,
                              },
                              agents.id,
                            ),
                          ),
                        ),
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
            items: last ? await summarize(tx, page, last.readAt, viewer) : [],
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
      viewer?: SessionViewer,
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
            viewer,
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
                    runtimeEngine: checkpoints.runtimeEngine,
                    runtimeSdkVersion: checkpoints.runtimeSdkVersion,
                    runtimeCliVersion: checkpoints.runtimeCliVersion,
                    runtimeProfileSha256: checkpoints.runtimeProfileSha256,
                    runtimeProfileScheme: checkpoints.runtimeProfileScheme,
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
          const [optedOut] = await tx
            .select({ id: agents.id })
            .from(sessions)
            .innerJoin(
              agentReleases,
              eq(agentReleases.id, sessions.agentReleaseId),
            )
            .innerJoin(agents, eq(agents.id, agentReleases.agentId))
            .where(
              and(
                eq(sessions.id, sessionId),
                eq(agents.autoModelMigration, false),
              ),
            )
            .limit(1);
          return {
            ...summary,
            auto_model_migration: optedOut === undefined,
            holds_execution: row.executionId !== null,
            budget_account_refused: await budgetAccountRefused(tx, sessionId),
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
              PAUSE_REASON_VALUES.find((value) => value === row.pauseReason) ??
              null,
            pending_request_count: read.pendingCount,
            attention:
              (row.sourceDeletedAt === null
                ? null
                : { code: "SOURCE_DELETED" as const }) ??
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
            start_fresh_available: await startFreshAvailable(tx, sessionId),
            cost_usd: row.costUsd,
            provider_tokens: row.providerTokens,
            repo_url: row.repoUrl,
            branch: row.branch,
            repository_mode: row.repositoryMode,
            github_policy_source: row.githubPolicySource,
            spec: specOf(row.specSource),
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
            worker_runtime: workerRuntimeView(row, checkpoint ?? null),
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
        sessionId,
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
        sessionId,
        [row.id],
        session.retiredCheckpointRevision,
      );
      const parts =
        read.sourceDeletedAt === null
          ? resultParts(row.resultJson)
          : { result: null, usage: resultParts(row.resultJson).usage };
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

    async hiddenAgentRefs(ownerId, viewer, refs) {
      const agentIds = new Set<string>();
      const releaseIds = new Set<string>();
      if (!isUuid(ownerId)) return { agentIds, releaseIds };
      const who = {
        userId: viewer.userId,
        keyAgentId: viewer.keyAgentId ?? null,
      };
      const unusable = not(agentReachable(db, ownerId, who, agents.id));
      const named = refs.agentIds.filter(isUuid).map((id) => id.toLowerCase());
      if (named.length > 0) {
        for (const row of await db
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.workspaceId, ownerId),
              inArray(agents.id, named),
              unusable,
            ),
          )) {
          agentIds.add(row.id);
        }
      }
      const releaseWhere = [
        refs.releaseIds.length > 0
          ? inArray(agentReleases.id, [...refs.releaseIds])
          : undefined,
        refs.sessionId !== null && isUuid(refs.sessionId)
          ? inArray(
              agentReleases.id,
              db
                .select({ id: sessions.agentReleaseId })
                .from(sessions)
                .where(
                  and(
                    eq(sessions.id, refs.sessionId),
                    eq(sessions.ownerId, ownerId),
                  ),
                ),
            )
          : undefined,
      ].filter((clause) => clause !== undefined);
      if (releaseWhere.length > 0) {
        for (const row of await db
          .select({ id: agentReleases.id, agentId: agentReleases.agentId })
          .from(agentReleases)
          .innerJoin(agents, eq(agents.id, agentReleases.agentId))
          .where(
            and(eq(agents.workspaceId, ownerId), or(...releaseWhere), unusable),
          )) {
          releaseIds.add(row.id);
          agentIds.add(row.agentId);
        }
      }
      return { agentIds, releaseIds };
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
      // The page's turns whose instruction Slack deleted; their events are
      // served withheld, an archived one as one still stored.
      const sequences = [
        ...new Set(
          rows.flatMap((row) =>
            row.turn_sequence === null ? [] : [Number(row.turn_sequence)],
          ),
        ),
      ];
      const withheld = new Map(
        sequences.length === 0
          ? []
          : (
              await db
                .select({
                  sequence: turns.sequence,
                  deletedAt: turnSourceDeletedAt,
                })
                .from(turns)
                .where(
                  and(
                    eq(turns.sessionId, sessionId),
                    inArray(turns.sequence, sequences),
                    isNotNull(turns.sources),
                  ),
                )
            ).flatMap(({ sequence, deletedAt }) =>
              deletedAt === null ? [] : [[sequence, deletedAt] as const],
            ),
      );
      // Fields filled here on read count against the byte bound too: a page
      // stops before the row they would push past it.
      let filledBytes = 0;
      let cut = false;
      const items: SseEvent[] = [];
      for (const [index, row] of rows.entries()) {
        const stored = readStoredEvent(row.type, row.payload);
        const neutral =
          stored.readable && row.bare && options.neutralize
            ? options.neutralize(owned.runtimeKind, stored.payload)
            : stored.payload;
        const deletedAt =
          row.turn_sequence === null
            ? undefined
            : withheld.get(Number(row.turn_sequence));
        const payload =
          deletedAt !== undefined
            ? withheldEventPayload(neutral)
            : owned.titleDeleted && neutral.event === "status"
              ? withoutTitle(neutral)
              : neutral;
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
              ...(deletedAt === undefined
                ? {}
                : { source_deleted_at: deletedAt.toISOString() }),
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
