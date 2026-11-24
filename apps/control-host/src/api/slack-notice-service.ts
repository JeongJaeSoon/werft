import {
  type ApproveSlackNoticeRequest,
  type GetSlackNoticeResponse,
  SLACK_NOTICE_VERSIONS,
  type SlackNoticeState,
  type SlackNoticeText,
  type SlackNoticeVersionEntry,
  slackNoticeWindow,
} from "@werft-ai/contracts";
import {
  approveSlackNotice,
  type Database,
  judgeSlackNotice,
  liveSlackNoticeApprovals,
  managesWorkspace,
  revokeSlackNotice,
} from "@werft-ai/db";
import {
  type AuthorizationPolicy,
  type Caller,
  requirePermitted,
  SessionServiceError,
} from "@werft-ai/platform";

type Place = { workspaceId: string; agentId: string };

const refused = (
  code: "FORBIDDEN" | "NOT_FOUND" | "REVISION_CONFLICT" | "SLACK_NOT_INSTALLED",
  message: string,
  reasonCode?: string,
) =>
  new SessionServiceError(
    code,
    message,
    undefined,
    reasonCode === undefined ? undefined : { reason_code: reasonCode },
  );

const textOf = (text: SlackNoticeText) => ({
  body: [...text.body],
  policy_link: { ...text.policyLink },
});

/**
 * The notice an agent's Slack tab shows, and the approval a workspace owner or
 * admin gives there. Whoever reads the agent's settings sees it; only owners
 * and admins approve, revoke, and see the approvers' email addresses.
 */
export function createSlackNoticeService(deps: {
  authorization: AuthorizationPolicy;
  db: Database;
  versions?: readonly SlackNoticeVersionEntry[];
}) {
  const versions = deps.versions ?? SLACK_NOTICE_VERSIONS;

  async function reader(caller: Caller, agentId: string) {
    await requirePermitted(deps.authorization, caller, "agent.settings_read", {
      kind: "agent",
      id: agentId,
    });
    const principal = caller.subject.principal;
    if (caller.subject.surface.kind !== "web" || principal?.kind !== "user") {
      throw refused(
        "FORBIDDEN",
        "The Slack notice is approved from a signed-in console session, not with an API key",
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
    const window = slackNoticeWindow(versions);
    const current = versions.at(-1);
    const [judgment, live, manages] = await Promise.all([
      judgeSlackNotice(deps.db, place, versions),
      liveSlackNoticeApprovals(deps.db, place),
      managesWorkspace(deps.db, place.workspaceId, userId),
    ]);
    const counts = (version: number) =>
      window !== null &&
      version >= window.oldestCounted &&
      version <= window.current;
    const state: SlackNoticeState = judgment.approved
      ? "approved"
      : judgment.reason === "not_approved" &&
          live.some((approval) => !counts(approval.version))
        ? "reapproval_required"
        : judgment.reason;
    return {
      notice:
        current === undefined
          ? null
          : {
              version: current.version,
              requires_reapproval: current.requiresReapproval,
              text: {
                ko: textOf(current.text.ko),
                ja: textOf(current.text.ja),
              },
            },
      state,
      can_approve: manages,
      approvals: live.map((approval) => ({
        id: approval.id,
        slack_team_id: approval.slackTeamId,
        notice_version: approval.version,
        counts: counts(approval.version),
        approved_by: {
          user_id: approval.approvedBy,
          display_name: approval.approvedByName,
          email: manages ? approval.approvedByEmail : null,
        },
        approved_at: approval.approvedAt.toISOString(),
      })),
    };
  }

  const NOT_FOUND = () => refused("NOT_FOUND", "Resource not found");
  const NOT_ADMIN = () =>
    refused(
      "FORBIDDEN",
      "Only a workspace owner or admin approves the Slack notice",
      "workspace_admin_required",
    );
  const NOT_INSTALLED = () =>
    refused(
      "SLACK_NOT_INSTALLED",
      "The agent's Slack app is not installed, so there is no organization to approve for",
    );

  return {
    async read(caller: Caller, agentId: string) {
      const { place, userId } = await reader(caller, agentId);
      return view(place, userId);
    },

    async approve(
      caller: Caller,
      agentId: string,
      body: ApproveSlackNoticeRequest,
    ) {
      const { place, userId } = await reader(caller, agentId);
      // Who may approve is answered before what is approved; the write checks again under its lock.
      if (!(await managesWorkspace(deps.db, place.workspaceId, userId))) {
        throw NOT_ADMIN();
      }
      const window = slackNoticeWindow(versions);
      if (window === null) {
        throw refused(
          "REVISION_CONFLICT",
          "No Slack notice is published yet",
          "no_notice",
        );
      }
      if (body.notice_version !== window.current) {
        throw refused(
          "REVISION_CONFLICT",
          "The notice shown is no longer the current version; read it again",
          "notice_version_stale",
        );
      }
      const result = await approveSlackNotice(
        deps.db,
        {
          ...place,
          by: userId,
          locale: body.locale,
          requestId: caller.requestId,
        },
        versions,
      );
      if (result.outcome === "not_found") throw NOT_FOUND();
      if (result.outcome === "not_admin") throw NOT_ADMIN();
      if (result.outcome === "not_installed") throw NOT_INSTALLED();
      if (result.outcome === "no_notice") {
        throw refused(
          "REVISION_CONFLICT",
          "No Slack notice is published yet",
          "no_notice",
        );
      }
      return view(place, userId);
    },

    async revoke(caller: Caller, agentId: string) {
      const { place, userId } = await reader(caller, agentId);
      const result = await revokeSlackNotice(deps.db, {
        ...place,
        by: userId,
        requestId: caller.requestId,
      });
      if (result.outcome === "not_found") throw NOT_FOUND();
      if (result.outcome === "not_admin") throw NOT_ADMIN();
      return view(place, userId);
    },
  };
}

export type SlackNoticeService = ReturnType<typeof createSlackNoticeService>;
