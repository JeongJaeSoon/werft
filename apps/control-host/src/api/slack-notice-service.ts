import type {
  GetSlackNoticeResponse,
  SetConversationRolloutRequest,
} from "@werft-ai/contracts";
import {
  type Database,
  managesWorkspace,
  rolloutOf,
  setConversationRollout,
} from "@werft-ai/db";
import {
  type AuthorizationPolicy,
  type Caller,
  requirePermitted,
  SessionServiceError,
} from "@werft-ai/platform";

type Place = { workspaceId: string; agentId: string };

const refused = (
  code: "BAD_REQUEST" | "ENDPOINT_RETIRED" | "FORBIDDEN" | "NOT_FOUND",
  message: string,
  reasonCode?: string,
) =>
  new SessionServiceError(
    code,
    message,
    undefined,
    reasonCode === undefined ? undefined : { reason_code: reasonCode },
  );

/**
 * An agent's conversation switch on its Slack tab. Whoever reads the agent's
 * settings sees it; only workspace owners and admins change it. The Slack
 * notice approval that once came before it is retired: its fields answer as
 * if no notice were published, and its routes answer 410.
 */
export function createSlackNoticeService(deps: {
  authorization: AuthorizationPolicy;
  db: Database;
}) {
  async function reader(caller: Caller, agentId: string) {
    await requirePermitted(deps.authorization, caller, "agent.settings_read", {
      kind: "agent",
      id: agentId,
    });
    const principal = caller.subject.principal;
    if (caller.subject.surface.kind !== "web" || principal?.kind !== "user") {
      throw refused(
        "FORBIDDEN",
        "The conversation switch is read and changed from a signed-in console session, not with an API key",
        "web_session_required",
      );
    }
    return {
      place: { workspaceId: caller.ownerId, agentId } satisfies Place,
      userId: principal.id,
    };
  }

  async function view(
    place: Place,
    userId: string,
  ): Promise<GetSlackNoticeResponse> {
    const [manages, rollout] = await Promise.all([
      managesWorkspace(deps.db, place.workspaceId, userId),
      rolloutOf(deps.db, place),
    ]);
    if (rollout === null) throw NOT_FOUND();
    return {
      notice: null,
      state: "no_notice",
      rollout,
      can_approve: manages,
      approvals: [],
    };
  }

  const NOT_FOUND = () => refused("NOT_FOUND", "Resource not found");
  const NOT_ADMIN_ROLLOUT = () =>
    refused(
      "FORBIDDEN",
      "Only a workspace owner or admin changes the agent's conversation switch",
      "workspace_admin_required",
    );

  return {
    async read(caller: Caller, agentId: string) {
      const { place, userId } = await reader(caller, agentId);
      return view(place, userId);
    },

    async setRollout(
      caller: Caller,
      agentId: string,
      body: SetConversationRolloutRequest,
    ) {
      const { place, userId } = await reader(caller, agentId);
      if (!(await managesWorkspace(deps.db, place.workspaceId, userId))) {
        throw NOT_ADMIN_ROLLOUT();
      }
      const result = await setConversationRollout(deps.db, {
        ...place,
        rollout: body.rollout,
        by: { userId },
        requestId: caller.requestId,
      });
      if (result.outcome === "not_found") throw NOT_FOUND();
      if (result.outcome === "not_admin") throw NOT_ADMIN_ROLLOUT();
      if (result.outcome === "on_unavailable") {
        throw refused(
          "BAD_REQUEST",
          "The conversation switch takes off or shadow; on is not open yet",
          "rollout_on_unavailable",
        );
      }
      return view(place, userId);
    },

    /**
     * The approve and revoke routes: gone whatever is sent. They stay
     * console-only, so an API key is refused as before.
     */
    retired(caller: Caller): never {
      if (
        caller.subject.surface.kind !== "web" ||
        caller.subject.principal?.kind !== "user"
      ) {
        throw refused(
          "FORBIDDEN",
          "The Slack notice routes take a signed-in console session, not an API key",
          "web_session_required",
        );
      }
      throw refused(
        "ENDPOINT_RETIRED",
        "The Slack notice approval is retired; the conversation switch needs none",
        "slack_notice_retired",
      );
    },
  };
}

export type SlackNoticeService = ReturnType<typeof createSlackNoticeService>;
