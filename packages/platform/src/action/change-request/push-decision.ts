import {
  type AttributionMismatchDetail,
  type Principal,
  type PushRefusal,
  type PushRequest,
  type PushRequestView,
  type PushResolution,
  presentPushRequest,
  type ReceiptActor,
} from "@werft-ai/contracts";
import type { PushSourceResult } from "../../checkpoints/index.ts";
import {
  pinnedCarries,
  pushApprovability,
} from "../../decision/push-approvability.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  receiptActorOf,
  requirePermitted,
  SessionServiceError,
} from "../../musterrolle/index.ts";
import { deciderKeyOf } from "../../musterrolle/policy.ts";
import {
  idempotencyConflict,
  payloadHash,
  selfApproval,
} from "../../sessions/index.ts";
import {
  PUSH_REFUSAL_ERRORS,
  type PushRequestStore,
  type PushWriteResult,
} from "../ports/push-requests.ts";

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

export function refused(
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

export function settled(result: PushWriteResult): PushRequest {
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
 * The decision side of push requests (GA-8): the verdict the decision check
 * would give now, and the approve or reject that check guards.
 */
export function createPushDecision(deps: {
  authorization: AuthorizationPolicy;
  store: PushRequestStore;
  source: PushSource;
}) {
  const { authorization, store, source } = deps;

  return {
    // The verdict the decision check would give now, worded by contracts, so a
    // surface that lists requests shows the reason Slack shows.
    async withApprovability(
      ownerId: string,
      rawSessionId: string,
      requests: PushRequest[],
    ): Promise<PushRequestView[]> {
      // The stored id, as decide judges it: a manifest names its session in lower case.
      const sessionId = rawSessionId.toLowerCase();
      const session = await store.findSession(ownerId, sessionId);
      const pointer = session?.checkpointRevision ?? null;
      return Promise.all(
        requests.map(async (request) => ({
          ...request,
          approvability: presentPushRequest(
            await pushApprovability(
              { id: sessionId, checkpointRevision: pointer },
              {
                state: request.state,
                checkpointRevision: request.checkpoint_revision,
                gitCommit: request.git_commit,
                origin: request.origin,
              },
              source,
            ),
          ),
        })),
      );
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
        await requirePermitted(authorization, actor.caller, "session.approve", {
          kind: "session",
          id: sessionId,
        });
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
