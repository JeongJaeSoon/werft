import {
  type AttributionMismatchDetail,
  type CreatePushRequestRequest,
  type ListPushRequestsResponse,
  type Principal,
  type PushIntentRefusal,
  type PushRefusal,
  type PushRequest,
  type PushRequestSnapshot,
  type PushResolution,
  pushBranchFor,
  pushClassOf,
  type ReceiptActor,
} from "@werft-ai/contracts";
import { namesWorkingTreeSnapshot } from "@werft-ai/runtime-core";
import type { PushSourceResult } from "../checkpoints/checkpoint-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  deciderKeyOf,
  receiptActorOf,
} from "../musterrolle/policy.ts";
import type { PushIntentJob, PushIntentStore } from "../ports/push-intents.ts";
import {
  PUSH_REFUSAL_ERRORS,
  type PushRequestStore,
  type PushWriteResult,
} from "../ports/push-requests.ts";
import { additionalRepositoryAllowed } from "./additional-repositories.ts";
import { repositoryBinding, type SessionCatalog } from "./catalog.ts";
import { pinnedCarries } from "./push-approvability.ts";
import {
  idempotencyConflict,
  payloadHash,
  requirePermitted,
  SessionServiceError,
  selfApproval,
} from "./session-service.ts";

export type PushActor = {
  /** Who asks the authorization policy, as every other session entry does. */
  caller: Caller;
  principal: Principal;
  ownerId: string;
  /**
   * False when nothing checked who is calling (AUTH_MODE=none trusts any
   * X-Owner-Id, so code inside a worker could claim to be the owner).
   */
  verified: boolean;
};

export interface PushSource {
  readPushSource(sessionId: string): Promise<PushSourceResult>;
  /** One pinned revision, judged whatever the pointer says now. */
  readPushSourceAt(
    sessionId: string,
    revision: number,
  ): Promise<PushSourceResult>;
}

const DECIDER_KINDS: ReadonlySet<Principal["kind"]> = new Set([
  "user",
  "api_key",
]);

/** A caller assembled outside the API middleware may carry no recorded actor. */
export function pushReceiptActor(actor: PushActor): ReceiptActor {
  return (
    receiptActorOf(actor.caller) ?? {
      principal: { kind: actor.principal.kind, id: actor.principal.id },
      actor_user_id: null,
      agent_id: null,
    }
  );
}

/** Refuses a caller nothing authenticated; no receipt, as nothing is known of it. */
export function requireVerified(actor: PushActor) {
  if (!actor.verified) refused("unverified_principal", null);
}

/**
 * Who may decide a push, and so open a pull request from it: a credential
 * holding sessions:approve that is an API key or a signed-in user.
 */
export function mayDecidePush(
  principal: Principal,
  /** The person the caller was resolved to, if any. */
  actorUserId: string | null = null,
): "missing_scope" | "unverified_principal" | null {
  if (!(principal.scopes as readonly string[]).includes("sessions:approve")) {
    return "missing_scope";
  }
  if (DECIDER_KINDS.has(principal.kind)) return null;
  // A Slack installation decides only as the person its linked account
  // names, whom the policy judges as it would on the web.
  return principal.kind === "installation" && actorUserId !== null
    ? null
    : "unverified_principal";
}

function refused(
  refusal: PushRefusal,
  receiptId: string | null,
  mismatches?: readonly AttributionMismatchDetail[],
  reason?: string,
  checkpointRevision?: number,
): never {
  const { code, message } = PUSH_REFUSAL_ERRORS[refusal];
  throw new SessionServiceError(code, message, undefined, {
    refusal,
    ...(receiptId === null ? {} : { receipt_id: receiptId }),
    ...(mismatches === undefined ? {} : { mismatches }),
    ...(reason === undefined ? {} : { reason }),
    ...(checkpointRevision === undefined
      ? {}
      : { checkpoint_revision: checkpointRevision }),
  });
}

function settled(result: PushWriteResult): PushRequest {
  switch (result.outcome) {
    case "conflict":
      return idempotencyConflict();
    case "refused":
      return refused(
        result.refusal,
        result.receiptId,
        undefined,
        result.reason,
      );
    default:
      return result.request;
  }
}

/**
 * Push requests (94S-628): a human asks for the session's latest checkpoint
 * to be pushed to `agent/<session-id>`, and a holder of sessions:approve other
 * than the key that started the session approves or rejects exactly that
 * commit (GA-8). The push itself is the platform's
 * (94S-629, push-executor.ts).
 */
export function createPushRequestService(deps: {
  authorization: AuthorizationPolicy;
  store: PushRequestStore;
  intents: PushIntentStore;
  source: PushSource;
  /** Pins the repository entry the push must still match (94S-629). */
  catalog: SessionCatalog;
}) {
  const { authorization, store, intents, source, catalog } = deps;

  // The session's share decides who may see or act on it, as for every other
  // session command; a session the caller cannot see is NOT_FOUND.
  const requireSession = (
    actor: PushActor,
    action: "session.read" | "session.submit" | "session.approve",
    sessionId: string,
  ) =>
    requirePermitted(authorization, actor.caller, action, {
      kind: "session",
      id: sessionId,
    });

  // The checks that need no checkpoint: the repository is the session's or
  // one its release allows, and the attached-repository policy does not
  // deny. Shared by a direct request, an intent made inside a turn, and the
  // intent runner, which judges them again when it runs.
  async function judgeTarget(
    ownerId: string,
    sessionId: string,
    body: CreatePushRequestRequest,
  ) {
    const session = await store.findSession(ownerId, sessionId);
    if (session === null) return { status: "no_session" as const };
    const repositoryId = body.repository_id ?? session.repositoryId;
    const refusedWith = (
      refusal: PushRefusal,
      fields: { repository_id?: string } = {},
    ) => ({ status: "refused" as const, refusal, fields });
    if (repositoryId === null) return refusedWith("no_repository");
    const repository = { repository_id: repositoryId };
    const entry = Object.hasOwn(catalog.repositories, repositoryId)
      ? catalog.repositories[repositoryId]
      : undefined;
    if (entry === undefined) return refusedWith("no_repository", repository);
    if (
      repositoryId !== session.repositoryId &&
      additionalRepositoryAllowed(catalog, session, repositoryId) === null
    ) {
      return refusedWith("repository_not_allowed", repository);
    }
    const attachedPush =
      pushClassOf(session.repositoryId, repositoryId) === "push.attached";
    // `push.attached = deny` ends the request here; `ask` and `allow` are
    // told apart later by whether a policy approves it.
    if (attachedPush && session.pushAttached === "deny") {
      return refusedWith("repository_not_allowed", repository);
    }
    return {
      status: "ok" as const,
      session,
      repositoryId,
      entry,
      attachedPush,
      repository,
    };
  }

  return {
    /**
     * `request_push` inside a running turn: records that the turn's final
     * checkpoint is to be pushed, after the checks that need no checkpoint.
     * Nothing is pinned or created here; finalize pins, the runner creates.
     */
    async requestIntent(
      actor: PushActor,
      rawSessionId: string,
      input: {
        attemptId: string;
        turnId: number;
        body: CreatePushRequestRequest;
        /** The local branch to push; absent is the turn-end snapshot. */
        sourceRef?: string;
        pullRequest?: unknown;
      },
    ) {
      requireVerified(actor);
      const sessionId = rawSessionId.toLowerCase();
      await requireSession(actor, "session.submit", sessionId);
      const judged = await judgeTarget(actor.ownerId, sessionId, input.body);
      if (judged.status === "no_session") {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      if (judged.status === "refused") {
        return refused(
          judged.refusal,
          await store.recordRefusal({
            ownerId: actor.ownerId,
            sessionId,
            actor: pushReceiptActor(actor),
            operation: "request_push",
            refusal: judged.refusal,
            result: {
              push_request_id: null,
              action: null,
              verdict: "refuse",
              refusal: judged.refusal,
              repository_id: judged.fields.repository_id ?? null,
              checkpoint_revision: null,
              git_commit: null,
              target_branch: null,
            },
          }),
        );
      }
      if (!judged.session.githubEnabled) {
        return { status: "github_disabled" as const };
      }
      const written = await intents.createDeferred({
        ownerId: actor.ownerId,
        sessionId,
        turnId: input.turnId,
        attemptId: input.attemptId,
        repositoryId: judged.repositoryId,
        targetBranch: pushBranchFor(sessionId, input.body.branch),
        actor: pushReceiptActor(actor),
        pushClass: judged.attachedPush ? "push.attached" : "push.primary",
        policySource: judged.session.policySource,
        ...(input.sourceRef === undefined
          ? {}
          : { sourceRef: input.sourceRef }),
        ...(input.pullRequest === undefined
          ? {}
          : { pullRequest: input.pullRequest }),
      });
      if (written.outcome === "turn_not_running") {
        return { status: "turn_not_running" as const };
      }
      if (written.outcome === "source_ref_required") {
        return {
          status: "source_ref_required" as const,
          target_branch: written.targetBranch,
        };
      }
      return {
        status: "deferred" as const,
        intent: written.intent,
      };
    },

    /**
     * The runner's side: judges the gates again with the session as it is
     * now, verifies the pinned revision, and makes the push request in the
     * intent's own transition. The runner holds the stored actor's authority
     * only: an approval happens only when the session's policy still gives
     * it (judged here, from the session), never because the runner decided.
     */
    async createFromIntent(job: PushIntentJob) {
      const end = async (
        status: "failed" | "cancelled",
        code: PushIntentRefusal,
      ) => ((await intents.end(job, status, code)) ? "ended" : "lost");
      if (job.sessionClosed) return end("cancelled", "session_closed");
      const body = {
        repository_id: job.repositoryId,
        ...(job.targetBranch === pushBranchFor(job.sessionId)
          ? {}
          : {
              branch: job.targetBranch.slice(
                pushBranchFor(job.sessionId).length + 1,
              ),
            }),
      };
      const judged = await judgeTarget(job.ownerId, job.sessionId, body);
      if (judged.status === "no_session") {
        return end("cancelled", "session_closed");
      }
      if (judged.status === "refused") {
        return end("failed", "repository_not_allowed");
      }
      if (!judged.session.githubEnabled)
        return end("failed", "github_disabled");
      const pinned = await source.readPushSourceAt(
        job.sessionId,
        job.pinnedRevision,
      );
      if (pinned.status === "none") return end("failed", "source_missing");
      if (pinned.status === "unavailable") {
        return end("failed", "checkpoint_unavailable");
      }
      let gitCommit = pinned.gitCommit;
      if (job.sourceRef === null) {
        if (
          pinned.mismatches !== undefined &&
          namesWorkingTreeSnapshot(pinned.mismatches, pinned.gitCommit)
        ) {
          return end("failed", "uncommitted_changes");
        }
        if (pinned.mismatches !== undefined && pinned.mismatches.length > 0) {
          return end("failed", "attribution_mismatch");
        }
      } else {
        const named = (pinned.sources ?? []).find(
          (candidate) => candidate.name === job.sourceRef,
        );
        if (named === undefined) return end("failed", "source_missing");
        gitCommit = named.commit;
      }
      const { session, attachedPush, entry } = judged;
      const result = await intents.transition(job, {
        ownerId: job.ownerId,
        sessionId: job.sessionId,
        actor: job.actor,
        payloadHash: payloadHash({ intent: job.id }),
        repositoryId: judged.repositoryId,
        repositoryBinding: repositoryBinding(judged.repositoryId, entry),
        targetBranch: job.targetBranch,
        checkpointRevision: pinned.revision,
        gitCommit,
        flow: "actions",
        ...(job.pullRequest === null || job.pullRequest === undefined
          ? {}
          : { pullRequestIntent: job.pullRequest }),
        policyApproval: attachedPush
          ? session.attachedApproval
          : session.policyApproval,
        policyFields: session.policyFields,
      });
      return result.outcome;
    },

    async create(
      actor: PushActor,
      rawSessionId: string,
      input: { idempotencyKey: string; body?: CreatePushRequestRequest },
    ): Promise<PushRequest> {
      requireVerified(actor);
      const sessionId = rawSessionId.toLowerCase();
      const body = input.body ?? {};
      await requireSession(actor, "session.submit", sessionId);
      const refuse = async (
        refusal: PushRefusal,
        fields: {
          repository_id?: string;
          mismatches?: AttributionMismatchDetail[];
          checkpoint_revision?: number;
        } = {},
      ) =>
        refused(
          refusal,
          await store.recordRefusal({
            ownerId: actor.ownerId,
            sessionId,
            actor: pushReceiptActor(actor),
            operation: "request_push",
            refusal,
            result: {
              push_request_id: null,
              action: null,
              verdict: "refuse",
              refusal,
              repository_id: fields.repository_id ?? null,
              checkpoint_revision: fields.checkpoint_revision ?? null,
              git_commit: null,
              target_branch: null,
              ...(fields.mismatches === undefined
                ? {}
                : { mismatches: fields.mismatches }),
            },
          }),
          fields.mismatches,
          undefined,
          fields.checkpoint_revision,
        );
      const replay = await store.replayCreate({
        ownerId: actor.ownerId,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(body),
      });
      if (replay !== null) return settled(replay);
      const judged = await judgeTarget(actor.ownerId, sessionId, body);
      if (judged.status === "no_session") {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      if (judged.status === "refused") {
        return refuse(judged.refusal, judged.fields);
      }
      const { session, repositoryId, entry, attachedPush, repository } = judged;
      if (body.checkpoint_revision === undefined) {
        // Nothing here says the session's work after its latest saved
        // revision was saved too, so the caller names the revision it means.
        const latest = await source.readPushSource(sessionId);
        if (latest.status === "none")
          return refuse("no_checkpoint", repository);
        if (latest.status === "unavailable") {
          return refuse("checkpoint_unavailable", repository);
        }
        return refuse("checkpoint_revision_required", {
          ...repository,
          checkpoint_revision: latest.revision,
        });
      }
      const pinned = await source.readPushSourceAt(
        sessionId,
        body.checkpoint_revision,
      );
      if (pinned.status === "none") return refuse("no_checkpoint", repository);
      if (pinned.status === "unavailable") {
        return refuse("checkpoint_unavailable", repository);
      }
      // The worker's own look at the commits it holds; a checkpoint from a
      // worker that makes none passes here and meets the push's check.
      if (
        pinned.mismatches !== undefined &&
        namesWorkingTreeSnapshot(pinned.mismatches, pinned.gitCommit)
      ) {
        // Before the real check: committing is the next step, and the turn's
        // repair then handles whatever the commits need.
        return refuse("uncommitted_changes", repository);
      }
      if (pinned.mismatches !== undefined && pinned.mismatches.length > 0) {
        return refuse("attribution_mismatch", {
          ...repository,
          mismatches: pinned.mismatches,
        });
      }
      return settled(
        await store.create({
          ownerId: actor.ownerId,
          sessionId,
          actor: pushReceiptActor(actor),
          idempotencyKey: input.idempotencyKey,
          payloadHash: payloadHash(body),
          repositoryId,
          repositoryBinding: repositoryBinding(repositoryId, entry),
          targetBranch: pushBranchFor(sessionId, body.branch),
          checkpointRevision: pinned.revision,
          gitCommit: pinned.gitCommit,
          policyApproval: attachedPush
            ? session.attachedApproval
            : session.policyApproval,
          policyFields: session.policyFields,
        }),
      );
    },

    async list(
      actor: PushActor,
      sessionId: string,
    ): Promise<ListPushRequestsResponse> {
      requireVerified(actor);
      await requireSession(actor, "session.read", sessionId);
      const items = await store.list(actor.ownerId, sessionId);
      if (items === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return { items, intents: await intents.list(actor.ownerId, sessionId) };
    },

    async get(
      actor: PushActor,
      sessionId: string,
      pushRequestId: string,
    ): Promise<PushRequest> {
      requireVerified(actor);
      await requireSession(actor, "session.read", sessionId);
      const request = await store.get(actor.ownerId, sessionId, pushRequestId);
      if (request === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return request;
    },

    /** `get_push_request`: needs `session.read` only, like `get`. */
    async snapshot(
      actor: PushActor,
      sessionId: string,
      ref: { pushRequestId: string } | { pushIntentId: string },
    ): Promise<PushRequestSnapshot> {
      requireVerified(actor);
      await requireSession(actor, "session.read", sessionId);
      const snapshot = await store.snapshot(actor.ownerId, sessionId, ref);
      if (snapshot === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return snapshot;
    },

    async decide(
      actor: PushActor,
      rawSessionId: string,
      rawPushRequestId: string,
      input: {
        idempotencyKey: string;
        readBody: () => Promise<PushResolution>;
      },
    ): Promise<PushRequest> {
      requireVerified(actor);
      const sessionId = rawSessionId.toLowerCase();
      const pushRequestId = rawPushRequestId.toLowerCase();
      const receiptActor = pushReceiptActor(actor);
      const deciderKey = deciderKeyOf(actor.caller);
      const refuseDecision = async (refusal: PushRefusal): Promise<never> =>
        refused(
          refusal,
          await store.recordRefusal({
            ownerId: actor.ownerId,
            sessionId,
            actor: receiptActor,
            operation: "resolve_push",
            refusal,
            result: {
              push_request_id: pushRequestId,
              action: null,
              verdict: "refuse",
              refusal,
              repository_id: null,
              checkpoint_revision: null,
              git_commit: null,
              target_branch: null,
              decider_key: deciderKey,
            },
          }),
        );
      const refusal = mayDecidePush(
        actor.principal,
        actor.caller.actor?.userId ?? null,
      );
      if (refusal !== null) await refuseDecision(refusal);
      try {
        await requireSession(actor, "session.approve", sessionId);
      } catch (error) {
        if (selfApproval(error)) await refuseDecision("self_approval");
        throw error;
      }
      const body = await input.readBody();
      // An intent request is pinned to a revision the pointer has left on
      // purpose. Approving it needs that revision to still verify for this
      // session and still carry the commit the request names; the pointer
      // moving is not a reason to refuse it.
      if (body.decision === "approve") {
        const request = await store.get(
          actor.ownerId,
          sessionId,
          pushRequestId,
        );
        if (request?.origin === "intent" && request.state === "requested") {
          const pinned = await source.readPushSourceAt(
            sessionId,
            request.checkpoint_revision,
          );
          if (
            pinned.status !== "ready" ||
            !pinnedCarries(pinned, request.git_commit)
          ) {
            await refuseDecision("pinned_source_invalid");
          }
        }
      }
      // Only consulted when the session checkpointed since the request; a
      // store that cannot answer leaves the exact-revision rule in force.
      const latest =
        body.decision === "approve"
          ? await source.readPushSource(sessionId).catch(() => null)
          : null;
      return settled(
        await store.decide({
          ownerId: actor.ownerId,
          sessionId,
          pushRequestId,
          actor: receiptActor,
          decision: body.decision,
          gitCommit: body.git_commit,
          reason: body.reason ?? null,
          idempotencyKey: input.idempotencyKey,
          payloadHash: payloadHash(body),
          latest:
            latest?.status === "ready"
              ? { revision: latest.revision, gitCommit: latest.gitCommit }
              : null,
          deciderKey,
        }),
      );
    },
  };
}

export type PushRequestService = ReturnType<typeof createPushRequestService>;
