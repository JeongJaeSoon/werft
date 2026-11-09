import { randomUUID } from "node:crypto";
import {
  GITHUB_MCP_TOOL_ARGUMENTS,
  type GitHubMcpTool,
  type GitHubPolicySource,
  githubPolicyReceiptFields,
  githubPolicySourceOf,
  OPEN_PULL_REQUEST_STAGES,
  OPEN_PUSH_REQUEST_STATES,
  type PullRequestStage,
  type PushDecider,
  type PushReceiptResult,
  type PushRequest,
  type PushRequestFlow,
  type PushRequestOrigin,
  type PushRequestSnapshot,
  type PushRequestState,
  pushBranchFor,
  pushDecisionOf,
  type ReceiptActor,
  repositoryCeilingOf,
} from "@werft-ai/contracts";
import {
  PUSH_REFUSAL_ERRORS,
  type PushJob,
  type PushRefusalRecord,
  type PushRequestDisplayReader,
  type PushRequestStore,
  type PushWriteResult,
  type ToolSummaryContext,
} from "@werft-ai/platform";
import { and, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { enqueueActionNotice } from "./action-notices.ts";
import {
  findIdempotent,
  type IdempotencyScope,
  lockIdempotencyScope,
} from "./control-shared.ts";
import { githubPolicyColumns, githubPolicyOfRow } from "./github-settings.ts";
import type { Database } from "./queries.ts";
import {
  agentGitHubSettings,
  agentReleases,
  agents,
  catalogRepositories,
  githubWorkspaceSettings,
  idempotencyKeys,
  pullRequests,
  pushIntents,
  pushRequests,
  receipts,
  sessions,
} from "./schema.ts";

type Row = typeof pushRequests.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GITHUB_TOOL = "mcp__github__";

/** The catalog's owner/name for a repository id, null without a row. */
export const catalogName = (repositoryId: SQL) => sql<string | null>`(
  SELECT c.owner || '/' || c.name FROM ${catalogRepositories} c
  WHERE c.id = ${repositoryId}
)`;

async function repositoryName(
  db: Database,
  repositoryId: string,
): Promise<string> {
  const [row] = await db
    .select({
      owner: catalogRepositories.owner,
      name: catalogRepositories.name,
    })
    .from(catalogRepositories)
    .where(eq(catalogRepositories.id, repositoryId))
    .limit(1);
  return row ? `${row.owner}/${row.name}` : repositoryId;
}

/**
 * What a GitHub tool's input points at, read from the platform's rows: a
 * push request's repository and branch, or the repository an id names (the
 * id itself when the catalog has no row for it). Empty for any other tool,
 * an input that does not parse, or a push request of another session.
 */
export async function toolSummaryContext(
  db: Database,
  sessionId: string,
  tool: string,
  input: unknown,
): Promise<ToolSummaryContext> {
  const name = tool.startsWith(GITHUB_TOOL)
    ? tool.slice(GITHUB_TOOL.length)
    : "";
  if (!Object.hasOwn(GITHUB_MCP_TOOL_ARGUMENTS, name)) return {};
  const parsed =
    GITHUB_MCP_TOOL_ARGUMENTS[name as GitHubMcpTool].safeParse(input);
  if (!parsed.success) return {};
  const args = parsed.data as {
    push_request_id?: string;
    repository_id?: string;
    branch?: string;
  };
  if (args.push_request_id !== undefined) {
    if (!UUID.test(args.push_request_id) || !UUID.test(sessionId)) return {};
    const [row] = await db
      .select({
        repositoryId: pushRequests.repositoryId,
        repositoryName: catalogName(sql`${pushRequests.repositoryId}`),
        targetBranch: pushRequests.targetBranch,
      })
      .from(pushRequests)
      .where(
        and(
          eq(pushRequests.id, args.push_request_id.toLowerCase()),
          eq(pushRequests.sessionId, sessionId.toLowerCase()),
        ),
      )
      .limit(1);
    return row
      ? {
          repository: row.repositoryName ?? row.repositoryId,
          branch: row.targetBranch,
        }
      : {};
  }
  if (name === "attach_repository" && args.repository_id !== undefined) {
    return { repository: await repositoryName(db, args.repository_id) };
  }
  if (name !== "request_push" || !UUID.test(sessionId)) return {};
  let repositoryId = args.repository_id ?? null;
  if (repositoryId === null) {
    const [session] = await db
      .select({ repositoryId: sessions.repositoryId })
      .from(sessions)
      .where(eq(sessions.id, sessionId.toLowerCase()))
      .limit(1);
    repositoryId = session?.repositoryId ?? null;
  }
  return {
    ...(repositoryId === null
      ? {}
      : { repository: await repositoryName(db, repositoryId) }),
    branch: pushBranchFor(sessionId.toLowerCase(), args.branch),
  };
}

type RecordedPullRequest = { number: number | null; url: string };

/**
 * The pull request of each push request. A pull request row belongs to the
 * push request that created it; a later push to the same branch finds that
 * pull request open and only records its verified number. A number is unique
 * within a repository only, so that row is found by session, repository and
 * number.
 */
async function recordedPullRequests(
  db: Database,
  rows: readonly {
    id: string;
    sessionId: string;
    repositoryId: string;
    prVerifiedNumber: number | null;
  }[],
): Promise<Map<string, RecordedPullRequest>> {
  if (rows.length === 0) return new Map();
  const reusing = rows.filter((row) => row.prVerifiedNumber !== null);
  const found = await db
    .select({
      sessionId: pullRequests.sessionId,
      repositoryId: pullRequests.repositoryId,
      pushRequestId: pullRequests.pushRequestId,
      number: pullRequests.number,
      url: pullRequests.url,
    })
    .from(pullRequests)
    .where(
      or(
        inArray(
          pullRequests.pushRequestId,
          rows.map((row) => row.id),
        ),
        reusing.length === 0
          ? undefined
          : and(
              inArray(pullRequests.sessionId, [
                ...new Set(reusing.map((row) => row.sessionId)),
              ]),
              inArray(pullRequests.number, [
                ...new Set(reusing.map((row) => row.prVerifiedNumber ?? 0)),
              ]),
            ),
      ),
    );
  const byRequest = new Map<string, RecordedPullRequest>();
  for (const row of rows) {
    const own = found.find((entry) => entry.pushRequestId === row.id);
    const reused =
      row.prVerifiedNumber === null
        ? undefined
        : found.find(
            (entry) =>
              entry.sessionId === row.sessionId &&
              entry.repositoryId === row.repositoryId &&
              entry.number === row.prVerifiedNumber,
          );
    const entry = own ?? reused;
    if (entry) byRequest.set(row.id, { number: entry.number, url: entry.url });
  }
  return byRequest;
}

function publicPushRequest(
  row: Row,
  recorded: RecordedPullRequest | null = null,
): PushRequest {
  return {
    id: row.id,
    session_id: row.sessionId,
    repository_id: row.repositoryId,
    checkpoint_revision: row.checkpointRevision,
    git_commit: row.gitCommit,
    target_branch: row.targetBranch,
    state: row.state as PushRequestState,
    requested_by: row.requestedBy as ReceiptActor,
    requested_at: row.createdAt.toISOString(),
    resolved_by: (row.decidedBy as PushDecider | null) ?? null,
    resolved_at: row.decidedAt?.toISOString() ?? null,
    resolution_reason: row.decisionReason,
    request_receipt_id: row.requestReceiptId,
    resolution_receipt_id: row.decisionReceiptId,
    finished_at: row.finishedAt?.toISOString() ?? null,
    push_receipt_id: row.pushReceiptId,
    origin: row.origin as PushRequestOrigin,
    flow: row.flow as PushRequestFlow,
    pr_state: (row.prState as PullRequestStage | null) ?? null,
    pr_error: row.prError ?? null,
    pr_number: recorded?.number ?? null,
    pr_url: recorded?.url ?? null,
  };
}

function resultOf(
  row: Row | null,
  fields: Pick<
    PushReceiptResult,
    "action" | "verdict" | "refusal" | "decider_key"
  >,
): PushReceiptResult {
  return {
    push_request_id: row?.id ?? null,
    ...fields,
    repository_id: row?.repositoryId ?? null,
    checkpoint_revision: row?.checkpointRevision ?? null,
    git_commit: row?.gitCommit ?? null,
    target_branch: row?.targetBranch ?? null,
  };
}

const claimable = sql`${pushRequests.state} = 'approved' OR (${pushRequests.state} = 'pushing' AND (${pushRequests.leaseExpiresAt} IS NULL OR ${pushRequests.leaseExpiresAt} < now()))`;

/**
 * The policy source of a session whose policy approval its settings no
 * longer give, else null. A `release` session lapses too: a person's row
 * can now require approval of a pin that waived it.
 */
async function approvalLapsed(
  tx: Database,
  row: Row,
): Promise<GitHubPolicySource | null> {
  if (row.approvalBasis !== "policy") return null;
  const [session] = await tx
    .select(githubPolicyColumns)
    .from(sessions)
    .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
    .leftJoin(agents, eq(agents.id, agentReleases.agentId))
    .leftJoin(agentGitHubSettings, eq(agentGitHubSettings.agentId, agents.id))
    .where(eq(sessions.id, row.sessionId))
    .limit(1);
  if (session === undefined) return null;
  const policy = githubPolicyOfRow(session);
  const stillGiven = pushDecisionOf(policy) === "allow";
  return stillGiven ? null : policy.source;
}

/** Back to `requested`, for a person; nothing was pushed under this claim. */
async function returnToPerson(
  tx: Database,
  row: Row,
  source: GitHubPolicySource,
): Promise<void> {
  await insertRefusal(tx, {
    ownerId: row.ownerId,
    sessionId: row.sessionId,
    actor: null,
    operation: "resolve_push",
    refusal: "approval_required",
    result: {
      ...resultOf(row, {
        action: null,
        verdict: "refuse",
        refusal: "approval_required",
      }),
      approved_by: (row.decidedBy as PushDecider | null) ?? null,
      policy_source: source,
      agent_settings_revision: row.approvalSettingsRevision,
    },
  });
  await tx
    .update(pushRequests)
    .set({
      state: "requested",
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      decisionReceiptId: null,
      approvalBasis: null,
      approvalSettingsRevision: null,
      pushStartedAt: null,
      leaseExpiresAt: null,
    })
    .where(eq(pushRequests.id, row.id));
}

async function insertRefusal(
  tx: Database,
  input: PushRefusalRecord,
): Promise<string> {
  const id = randomUUID();
  await tx.insert(receipts).values({
    id,
    ownerId: input.ownerId,
    operation: input.operation,
    targetRef: {
      session_id: input.sessionId,
      turn_id: null,
      request_id: input.result.push_request_id,
    },
    status: "failed",
    result: input.result,
    error: PUSH_REFUSAL_ERRORS[input.refusal],
    actor: input.actor,
  });
  return id;
}

// The receipts here carry their own actor; the scope only finds the key.
function createScope(
  ownerId: string,
  sessionId: string,
  key: string,
): IdempotencyScope {
  return {
    principal: ownerId,
    operation: "request_push",
    resource: sessionId.toLowerCase(),
    key,
    actor: null,
    requestId: null,
  };
}

async function replayCreate(
  tx: Database,
  scope: ReturnType<typeof createScope>,
  payloadHash: string,
): Promise<PushWriteResult | null> {
  const existing = await findIdempotent(tx, scope);
  if (!existing) return null;
  if (existing.payloadHash !== payloadHash) return { outcome: "conflict" };
  const [row] = await tx
    .select()
    .from(pushRequests)
    .where(eq(pushRequests.requestReceiptId, existing.receiptId))
    .limit(1);
  return row ? { outcome: "replayed", request: publicPushRequest(row) } : null;
}

export function createPostgresPushRequests(
  db: Database,
): PushRequestStore & PushRequestDisplayReader {
  return {
    async findSession(ownerId, sessionId) {
      const [row] = await db
        .select({
          repositoryId: sessions.repositoryId,
          profileId: sessions.profileId,
          attached: sessions.attachedRepositoryIds,
          releaseId: agentReleases.id,
          githubEnabled: agents.githubEnabled,
          repositoryCeiling: githubWorkspaceSettings.repositoryCeiling,
          ceilingRevision: githubWorkspaceSettings.revision,
          ...githubPolicyColumns,
        })
        .from(sessions)
        .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .leftJoin(agents, eq(agents.id, agentReleases.agentId))
        .leftJoin(
          agentGitHubSettings,
          eq(agentGitHubSettings.agentId, agents.id),
        )
        .leftJoin(
          githubWorkspaceSettings,
          sql`${githubWorkspaceSettings.workspaceId} = coalesce(${agents.workspaceId}, ${sessions.workspaceId})`,
        )
        .where(
          and(
            eq(sessions.id, sessionId.toLowerCase()),
            eq(sessions.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (row === undefined) return null;
      const policy = githubPolicyOfRow(row);
      return {
        repositoryId: row.repositoryId,
        profileId: row.profileId,
        attached: row.attached,
        policySource: policy.source,
        github: policy.settings,
        repositoryCeiling: repositoryCeilingOf(row.repositoryCeiling),
        // Off now, or off as the session started: both close it.
        githubEnabled: (row.githubEnabled ?? false) && policy.enabledAtStart,
        push: pushDecisionOf(policy),
        policyApproval:
          row.releaseId === null
            ? null
            : {
                releaseId: row.releaseId,
                source: policy.source,
                settingsRevision: policy.agentSettingsRevision,
              },
        policyFields: githubPolicyReceiptFields(
          policy,
          row.ceilingRevision ?? 0,
        ),
      };
    },

    recordRefusal(input) {
      return insertRefusal(db, input);
    },

    replayCreate(input) {
      return replayCreate(
        db,
        createScope(input.ownerId, input.sessionId, input.idempotencyKey),
        input.payloadHash,
      );
    },

    create(input): Promise<PushWriteResult> {
      const sessionId = input.sessionId.toLowerCase();
      const targetBranch = input.targetBranch ?? pushBranchFor(sessionId);
      const scope = createScope(input.ownerId, sessionId, input.idempotencyKey);
      const refuse = async (
        tx: Database,
        refusal: "not_found" | "request_open" | "checkpoint_moved",
        row: Row | null,
      ): Promise<PushWriteResult> => ({
        outcome: "refused",
        refusal,
        receiptId: await insertRefusal(tx, {
          ownerId: input.ownerId,
          sessionId,
          actor: input.actor,
          operation: "request_push",
          refusal,
          result: resultOf(row, {
            action: null,
            verdict: "refuse",
            refusal,
          }),
        }),
      });
      return db.transaction(async (tx) => {
        await lockIdempotencyScope(tx, scope);
        const replay = await replayCreate(tx, scope, input.payloadHash);
        if (replay) return replay;
        const [session] = await tx
          .select({ checkpointRevision: sessions.checkpointRevision })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, input.ownerId),
            ),
          )
          .limit(1)
          .for("update");
        if (!session) return refuse(tx, "not_found", null);
        const [open] = await tx
          .select()
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.sessionId, sessionId),
              eq(pushRequests.repositoryId, input.repositoryId),
              eq(pushRequests.targetBranch, targetBranch),
              inArray(pushRequests.state, [...OPEN_PUSH_REQUEST_STATES]),
            ),
          )
          .limit(1);
        if (open) return refuse(tx, "request_open", open);
        // The same target also waits while an earlier request's pull
        // request is still due or opening: two pushes must not become the
        // heads of each other's pull requests. Every creator passes here
        // (REST, the legacy MCP path, the intent runner), all under the
        // session row lock taken above.
        const [pending] = await tx
          .select()
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.sessionId, sessionId),
              eq(pushRequests.repositoryId, input.repositoryId),
              eq(pushRequests.targetBranch, targetBranch),
              inArray(pushRequests.prState, [...OPEN_PULL_REQUEST_STAGES]),
            ),
          )
          .limit(1);
        if (pending) {
          return {
            ...(await refuse(tx, "request_open", pending)),
            reason: "pull_request_pending",
          };
        }
        // An intent request pins the revision its turn ended on, which a
        // later turn's checkpoint may have passed; its source is verified
        // by the caller against that revision instead.
        if (
          input.origin !== "intent" &&
          session.checkpointRevision !== input.checkpointRevision
        ) {
          return refuse(tx, "checkpoint_moved", null);
        }
        const id = randomUUID();
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.ownerId,
          operation: "request_push",
          targetRef: { session_id: sessionId, turn_id: null, request_id: id },
          status: "succeeded",
          result: {
            push_request_id: id,
            action: null,
            verdict: "allow",
            refusal: null,
            repository_id: input.repositoryId,
            checkpoint_revision: input.checkpointRevision,
            git_commit: input.gitCommit,
            target_branch: targetBranch,
            ...input.policyFields,
          } satisfies PushReceiptResult,
          actor: input.actor,
        });
        await tx.insert(idempotencyKeys).values({
          ...scope,
          payloadHash: input.payloadHash,
          receiptId,
        });
        // A policy that pushes without a person's approval decides here,
        // in the request's own transaction (design github-agent.md
        // decision 6); the executor sees an approved row as for any other.
        const approval = input.policyApproval;
        const policy =
          approval === null
            ? null
            : {
                decider: {
                  kind: "policy",
                  agent_release_id: approval.releaseId,
                  policy_source: approval.source,
                  agent_settings_revision: approval.settingsRevision,
                } satisfies PushDecider,
                receiptId: randomUUID(),
                settingsRevision: approval.settingsRevision,
              };
        if (policy !== null) {
          await tx.insert(receipts).values({
            id: policy.receiptId,
            ownerId: input.ownerId,
            operation: "resolve_push",
            targetRef: { session_id: sessionId, turn_id: null, request_id: id },
            status: "succeeded",
            result: {
              push_request_id: id,
              action: "approve",
              verdict: "allow",
              refusal: null,
              repository_id: input.repositoryId,
              checkpoint_revision: input.checkpointRevision,
              git_commit: input.gitCommit,
              target_branch: targetBranch,
              approved_by: policy.decider,
              ...input.policyFields,
            } satisfies PushReceiptResult,
            // No one decided: the policy did.
            actor: null,
          });
        }
        const [row] = await tx
          .insert(pushRequests)
          .values({
            id,
            ownerId: input.ownerId,
            sessionId,
            repositoryId: input.repositoryId,
            repositoryBinding: input.repositoryBinding,
            checkpointRevision: input.checkpointRevision,
            gitCommit: input.gitCommit,
            targetBranch,
            requestedBy: input.actor,
            requestReceiptId: receiptId,
            // Taken after the session lock, not at transaction start: the
            // pull request schedule orders requests by this value under the
            // same lock, and a transaction that waited for the lock must not
            // look older than the one it waited for.
            createdAt: sql`clock_timestamp()`,
            // An intent request is always `actions`, whatever the setting
            // is when the runner makes it.
            origin: input.origin ?? "direct",
            flow:
              input.origin === "intent" ? "actions" : (input.flow ?? "legacy"),
            pullRequestIntent: input.pullRequestIntent ?? null,
            ...(policy === null
              ? {}
              : {
                  state: "approved",
                  decidedBy: policy.decider,
                  decidedAt: sql`now()`,
                  decisionReceiptId: policy.receiptId,
                  approvalBasis: "policy",
                  approvalSettingsRevision: policy.settingsRevision,
                }),
          })
          .returning();
        if (!row) throw new Error("push request insert returned no row");
        return { outcome: "written", request: publicPushRequest(row) };
      });
    },

    async list(ownerId, sessionId) {
      const session = await this.findSession(ownerId, sessionId);
      if (!session) return null;
      const rows = await db
        .select()
        .from(pushRequests)
        .where(
          and(
            eq(pushRequests.sessionId, sessionId.toLowerCase()),
            eq(pushRequests.ownerId, ownerId),
          ),
        )
        .orderBy(desc(pushRequests.createdAt), desc(pushRequests.id));
      const recorded = await recordedPullRequests(db, rows);
      return rows.map((row) =>
        publicPushRequest(row, recorded.get(row.id) ?? null),
      );
    },

    async get(ownerId, sessionId, pushRequestId) {
      const [row] = await db
        .select()
        .from(pushRequests)
        .where(
          and(
            eq(pushRequests.id, pushRequestId.toLowerCase()),
            eq(pushRequests.sessionId, sessionId.toLowerCase()),
            eq(pushRequests.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!row) return null;
      const recorded = await recordedPullRequests(db, [row]);
      return publicPushRequest(row, recorded.get(row.id) ?? null);
    },

    snapshot(ownerId, rawSessionId, ref) {
      const sessionId = rawSessionId.toLowerCase();
      if (!UUID.test(sessionId)) return Promise.resolve(null);
      const byIntent = "pushIntentId" in ref;
      const wanted = (
        "pushIntentId" in ref ? ref.pushIntentId : ref.pushRequestId
      ).toLowerCase();
      if (!UUID.test(wanted)) return Promise.resolve(null);
      return db.transaction(
        async (tx) => {
          let intent: typeof pushIntents.$inferSelect | undefined;
          let requestId: string | null = null;
          if (byIntent) {
            [intent] = await tx
              .select()
              .from(pushIntents)
              .where(
                and(
                  eq(pushIntents.id, wanted),
                  eq(pushIntents.sessionId, sessionId),
                  eq(pushIntents.ownerId, ownerId),
                ),
              )
              .limit(1);
            if (!intent) return null;
            requestId = intent.pushRequestId;
          } else {
            requestId = wanted;
            [intent] = await tx
              .select()
              .from(pushIntents)
              .where(
                and(
                  eq(pushIntents.pushRequestId, wanted),
                  eq(pushIntents.sessionId, sessionId),
                  eq(pushIntents.ownerId, ownerId),
                ),
              )
              .limit(1);
          }
          const [request] =
            requestId === null
              ? []
              : await tx
                  .select()
                  .from(pushRequests)
                  .where(
                    and(
                      eq(pushRequests.id, requestId),
                      eq(pushRequests.sessionId, sessionId),
                      eq(pushRequests.ownerId, ownerId),
                    ),
                  )
                  .limit(1);
          if (!request && !intent) return null;
          const [pull] = request
            ? await tx
                .select({ number: pullRequests.number, url: pullRequests.url })
                .from(pullRequests)
                .where(eq(pullRequests.pushRequestId, request.id))
                .limit(1)
            : [];
          const scope = request ?? intent;
          if (!scope) return null;
          return {
            push_intent_id: intent?.id ?? null,
            intent_status: (intent?.status ??
              null) as PushRequestSnapshot["intent_status"],
            intent_refusal: (intent?.refusalCode ??
              null) as PushRequestSnapshot["intent_refusal"],
            push_request_id: request?.id ?? null,
            push_state: (request?.state ??
              null) as PushRequestSnapshot["push_state"],
            repository_id: scope.repositoryId,
            target_branch: scope.targetBranch,
            pull_request_scheduled: request
              ? request.pullRequestIntent !== null
              : intent?.pullRequest != null,
            pull_request_stage: (request?.prState ??
              null) as PushRequestSnapshot["pull_request_stage"],
            pull_request_error: request?.prError ?? null,
            pull_request:
              pull?.number == null
                ? null
                : { number: pull.number, url: pull.url },
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async displayOf(ownerId, sessionId, pushRequestId) {
      if (!UUID.test(sessionId) || !UUID.test(pushRequestId)) return null;
      const [row] = await db
        .select({
          repositoryId: pushRequests.repositoryId,
          repositoryName: catalogName(sql`${pushRequests.repositoryId}`),
          targetBranch: pushRequests.targetBranch,
          gitCommit: pushRequests.gitCommit,
          state: pushRequests.state,
          decidedBy: pushRequests.decidedBy,
          createdAt: pushRequests.createdAt,
        })
        .from(pushRequests)
        .where(
          and(
            eq(pushRequests.id, pushRequestId.toLowerCase()),
            eq(pushRequests.sessionId, sessionId.toLowerCase()),
            eq(pushRequests.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!row) return null;
      const decider = (row.decidedBy as { actor_user_id?: unknown } | null)
        ?.actor_user_id;
      return {
        repositoryId: row.repositoryId,
        repositoryName: row.repositoryName,
        targetBranch: row.targetBranch,
        gitCommit: row.gitCommit,
        state: row.state as PushRequestState,
        decidedByUserId: typeof decider === "string" ? decider : null,
        createdAt: row.createdAt.toISOString(),
      };
    },

    decide(input): Promise<PushWriteResult> {
      const sessionId = input.sessionId.toLowerCase();
      const pushRequestId = input.pushRequestId.toLowerCase();
      const scope: IdempotencyScope = {
        principal: input.ownerId,
        // The name before the receipt rename, so a retry across it replays.
        operation: "decide_push",
        resource: pushRequestId,
        key: input.idempotencyKey,
        actor: null,
        requestId: null,
      };
      return db.transaction(async (tx) => {
        const refuse = async (
          refusal:
            | "not_found"
            | "already_resolved"
            | "checkpoint_moved"
            | "commit_mismatch",
          row: Row | null,
        ): Promise<PushWriteResult> => ({
          outcome: "refused",
          refusal,
          receiptId: await insertRefusal(tx, {
            ownerId: input.ownerId,
            sessionId,
            actor: input.actor,
            operation: "resolve_push",
            refusal,
            result: resultOf(row, {
              action: input.decision,
              verdict: "refuse",
              refusal,
              decider_key: input.deciderKey ?? null,
            }),
          }),
        });
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          const [row] = await tx
            .select()
            .from(pushRequests)
            .where(
              and(
                eq(pushRequests.decisionReceiptId, existing.receiptId),
                eq(pushRequests.sessionId, sessionId),
                eq(pushRequests.ownerId, input.ownerId),
              ),
            )
            .limit(1);
          if (row)
            return { outcome: "replayed", request: publicPushRequest(row) };
        }
        // FOR SHARE holds the checkpoint pointer still until the decision
        // commits, so an approval can never land on a moved pointer.
        const [session] = await tx
          .select({
            checkpointRevision: sessions.checkpointRevision,
            githubPolicySource: sessions.githubPolicySource,
          })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, input.ownerId),
            ),
          )
          .limit(1)
          .for("share");
        if (!session) return refuse("not_found", null);
        const [row] = await tx
          .select()
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.id, pushRequestId),
              eq(pushRequests.sessionId, sessionId),
            ),
          )
          .limit(1)
          .for("update");
        if (!row) return refuse("not_found", null);
        if (row.state !== "requested") return refuse("already_resolved", row);
        if (input.decision === "approve") {
          if (input.gitCommit !== row.gitCommit) {
            return refuse("commit_mismatch", row);
          }
          // A later checkpoint of the same commit still pushes what the
          // person approved: the push runs from the pinned revision.
          const sameCommit =
            input.latest?.revision === session.checkpointRevision &&
            input.latest.gitCommit === row.gitCommit;
          // An intent request is pinned to a past revision on purpose; the
          // service checks that revision (`pinnedSourceValid`) before this
          // runs, and the pointer moving is not a reason to refuse.
          if (
            row.origin !== "intent" &&
            session.checkpointRevision !== row.checkpointRevision &&
            !sameCommit
          ) {
            return refuse("checkpoint_moved", row);
          }
        }
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.ownerId,
          operation: "resolve_push",
          targetRef: {
            session_id: sessionId,
            turn_id: null,
            request_id: row.id,
          },
          status: "succeeded",
          result: {
            ...resultOf(row, {
              action: input.decision,
              verdict: "allow",
              refusal: null,
              decider_key: input.deciderKey ?? null,
            }),
            policy_source: githubPolicySourceOf(session.githubPolicySource),
          },
          actor: input.actor,
        });
        await tx.insert(idempotencyKeys).values({
          ...scope,
          payloadHash: input.payloadHash,
          receiptId,
        });
        const [decided] = await tx
          .update(pushRequests)
          .set({
            state: input.decision === "approve" ? "approved" : "rejected",
            decidedBy: input.actor,
            decidedAt: sql`now()`,
            decisionReason: input.reason,
            decisionReceiptId: receiptId,
            approvalBasis: "human",
            approvalSettingsRevision: null,
          })
          .where(eq(pushRequests.id, row.id))
          .returning();
        if (!decided) throw new Error("push request update returned no row");
        return { outcome: "written", request: publicPushRequest(decided) };
      });
    },

    claimNextApproved(leaseMs): Promise<PushJob | null> {
      return db.transaction(async (tx) => {
        // Each lapsed approval leaves the candidates, so this ends.
        for (;;) {
          const [candidate] = await tx
            .select()
            .from(pushRequests)
            .where(claimable)
            .orderBy(pushRequests.createdAt)
            .limit(1)
            .for("update", { skipLocked: true });
          if (!candidate) return null;
          const lapsed = await approvalLapsed(tx, candidate);
          if (lapsed !== null) {
            await returnToPerson(tx, candidate, lapsed);
            continue;
          }
          const [row] = await tx
            .update(pushRequests)
            .set({
              state: "pushing",
              pushStartedAt: sql`now()`,
              pushAttempts: sql`${pushRequests.pushAttempts} + 1`,
              leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
            })
            .where(eq(pushRequests.id, candidate.id))
            .returning();
          if (!row) throw new Error("push request update returned no row");
          return {
            id: row.id,
            ownerId: row.ownerId,
            sessionId: row.sessionId,
            repositoryId: row.repositoryId,
            repositoryBinding: row.repositoryBinding,
            checkpointRevision: row.checkpointRevision,
            gitCommit: row.gitCommit,
            targetBranch: row.targetBranch,
            attempt: row.pushAttempts,
          };
        }
      });
    },

    finish(job, outcome) {
      return db.transaction(async (tx) => {
        // The session first, then the request, as every other writer does:
        // the notice written below references the session, and a schedule
        // that holds the session while it waits for this request would
        // otherwise wait on each other.
        const [owner] = await tx
          .select({ sessionId: pushRequests.sessionId })
          .from(pushRequests)
          .where(eq(pushRequests.id, job.id))
          .limit(1);
        if (!owner) return false;
        await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, owner.sessionId))
          .for("update");
        const [row] = await tx
          .select()
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.id, job.id),
              eq(pushRequests.state, "pushing"),
              eq(pushRequests.pushAttempts, job.attempt),
            ),
          )
          .limit(1)
          .for("update");
        if (!row) return false;
        const [session] = await tx
          .select({ githubPolicySource: sessions.githubPolicySource })
          .from(sessions)
          .where(eq(sessions.id, row.sessionId))
          .limit(1);
        const pushed = outcome.state === "pushed";
        const error = pushed ? null : PUSH_REFUSAL_ERRORS[outcome.refusal];
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: row.ownerId,
          operation: "push",
          targetRef: {
            session_id: row.sessionId,
            turn_id: null,
            request_id: row.id,
          },
          status: pushed ? "succeeded" : "failed",
          result: {
            ...resultOf(row, {
              action: null,
              verdict: pushed ? "allow" : "refuse",
              refusal: pushed ? null : outcome.refusal,
            }),
            remote_url: outcome.remoteUrl ?? null,
            remote_ref: outcome.remoteRef ?? null,
            previous_commit: pushed ? outcome.previousCommit : null,
            approved_by: (row.decidedBy as PushDecider | null) ?? null,
            reason_code:
              outcome.state === "failed" ? (outcome.reasonCode ?? null) : null,
            ...(outcome.state === "failed" && outcome.mismatches !== undefined
              ? { mismatches: outcome.mismatches }
              : {}),
            policy_source: githubPolicySourceOf(session?.githubPolicySource),
            agent_settings_revision: row.approvalSettingsRevision,
          } satisfies PushReceiptResult,
          error,
        });
        await tx
          .update(pushRequests)
          .set({
            state: outcome.state,
            finishedAt: sql`now()`,
            leaseExpiresAt: null,
            pushError: error,
            pushReceiptId: receiptId,
            // A pull request intent turns the finished push into a due
            // stage in this same write: the row is locked, so an intent
            // reserved meanwhile is either seen here or sees `pushed`.
            // Only the actions flow has a drain; a legacy request's pull
            // request is the follow-up turn's.
            ...(row.flow !== "actions" ||
            row.pullRequestIntent === null ||
            row.prState !== null
              ? {}
              : pushed
                ? { prState: "due", prNextAttemptAt: null }
                : { prState: "cancelled", prError: outcome.refusal }),
          })
          .where(eq(pushRequests.id, row.id));
        if (row.flow === "actions") {
          await enqueueActionNotice(tx, {
            sessionId: row.sessionId,
            pushRequestId: row.id,
            notice: {
              result: pushed ? "pushed" : "push_failed",
              repository: row.repositoryId,
              branch: row.targetBranch,
              commit: row.gitCommit,
              ...(pushed ? {} : { reason: outcome.refusal }),
            },
          });
        }
        return true;
      });
    },
  };
}
