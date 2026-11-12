import {
  ADMIN_SESSION_LIST_LIMIT,
  type ListAdminSessionsResponse,
  type SessionShareView,
  type SetSessionShareRequest,
  type SetSessionShareResponse,
} from "@werft-ai/contracts";
import type {
  SessionShare,
  SessionShareStore,
} from "../sessions/ports/session-share-store.ts";
import type { AuthorizationPolicy, Caller } from "./policy.ts";
import { requirePermitted } from "./require-permitted.ts";
import { NOT_FOUND, SessionServiceError } from "./service-errors.ts";

// Session share scopes (design 4.6). Reading a share is reading the session;
// changing it is `session.share`, which the policy gives a person's session
// to its creator alone and a key's session to its managers (D21).

function shareView(share: SessionShare): SessionShareView {
  return {
    session_id: share.sessionId,
    scope: share.scope,
    user_ids: share.userIds,
    team_ids: share.teamIds,
    revision: share.revision,
    updated_by: share.updatedBy,
    updated_at: share.updatedAt?.toISOString() ?? null,
    audience_limited: share.audienceLimited,
  };
}

export function createSessionShareService(deps: {
  authorization: AuthorizationPolicy;
  store: SessionShareStore;
  newId?: () => string;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  return {
    async getShare(caller: Caller, sessionId: string) {
      await requirePermitted(authorization, caller, "session.read", {
        kind: "session",
        id: sessionId,
      });
      const share = await store.get(caller.ownerId, sessionId);
      if (!share) throw NOT_FOUND();
      return shareView(share);
    },

    async setShare(
      caller: Caller,
      sessionId: string,
      body: SetSessionShareRequest,
    ): Promise<SetSessionShareResponse> {
      await requirePermitted(authorization, caller, "session.share", {
        kind: "session",
        id: sessionId,
      });
      // The policy allows only a person; the share records which one.
      const userId = caller.actor?.userId;
      const workspaceId = caller.actor?.workspaceId;
      if (!userId || !workspaceId) {
        throw new SessionServiceError(
          "FORBIDDEN",
          "Only a person changes who sees a session",
        );
      }
      const receiptId = newId();
      const result = await store.set({
        principal: caller,
        ownerId: caller.ownerId,
        workspaceId,
        sessionId,
        scope: body.scope,
        userIds: body.user_ids ?? [],
        teamIds: body.team_ids ?? [],
        ...(body.expected_revision === undefined
          ? {}
          : { expectedRevision: body.expected_revision }),
        updatedBy: userId,
        receiptId,
      });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "invalid_target":
          throw new SessionServiceError(
            "BAD_REQUEST",
            "Every person named must be a live member and every team a team of this workspace",
          );
        case "actor_inactive":
          throw new SessionServiceError(
            "FORBIDDEN",
            "This principal is no longer a member of the workspace",
          );
        case "revision_conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            `expected_revision does not match the current revision ${result.currentRevision}`,
          );
        case "unchanged":
          return { share: shareView(result.share), receipt_id: null };
        default:
          return { share: shareView(result.share), receipt_id: receiptId };
      }
    },

    async listForAdmin(caller: Caller): Promise<ListAdminSessionsResponse> {
      await requirePermitted(authorization, caller, "session.admin_list", {
        kind: "workspace",
        id: caller.ownerId,
      });
      const rows = await store.listForAdmin(
        caller.ownerId,
        ADMIN_SESSION_LIST_LIMIT,
      );
      return {
        items: rows.map((row) => ({
          session_id: row.sessionId,
          created_by_user_id: row.createdByUserId,
          created_by_api_key_id: row.createdByApiKeyId,
          agent_release_id: row.agentReleaseId,
          status: row.status,
          admission_state: row.admissionState,
          share_scope: row.shareScope,
          created_at: row.createdAt.toISOString(),
          takeover_required_at: row.takeoverRequiredAt?.toISOString() ?? null,
        })),
      };
    },
  };
}

export type SessionShareService = ReturnType<typeof createSessionShareService>;
