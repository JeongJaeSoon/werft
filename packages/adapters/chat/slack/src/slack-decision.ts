import {
  type AuthorizationDecision,
  type AuthorizationSubject,
  INSTALLATION_SESSION_SCOPE_VALUES,
  type SlackEventDropReason,
  type SlackNotice,
  type SlackSurfaceAction,
  type SlackUser,
  type SurfaceCeiling,
  slackNoticeFor,
  slackUserKindOf,
} from "@werft-ai/contracts";
import {
  type AgentIdentityStore,
  type AuthorizationPolicy,
  agentForSlackEvent,
  type Caller,
  type LinkedAccountStore,
  type SlackEventKey,
  type SurfaceBindingStore,
} from "@werft-ai/platform";

export type SlackInput = {
  /** The event's app and team, and the agent its request URL names. */
  event: SlackEventKey & { agentId?: string };
  /** Who typed, or who pressed the button — never the thread's requester. */
  user: SlackUser;
  action: SlackSurfaceAction;
  /**
   * Where it was typed or pressed. Every DM with the bot shares the
   * install's one DM binding, so a DM's own channel id is not read.
   */
  channel: { id: string; dm: boolean };
  /**
   * A new conversation is asked of the channel's binding; a follow-up or a
   * button, of its session.
   */
  resource:
    | { kind: "surface_binding"; releaseId?: string }
    | { kind: "session" | "session_link"; id: string };
  requestId: string;
  /** The web page where a person links their Slack account. */
  connectUrl: string;
};

const NO_CEILING: SurfaceCeiling = { actions: [], disclosure: "summary" };

export type SlackDecision =
  // Not this agent's app, or the app is gone: nothing runs and nobody is told.
  // `channel_left`: the bot is out of the channel, so nobody is told either.
  | { status: "dropped"; reason: SlackEventDropReason | "channel_left" }
  | {
      status: "decided";
      workspaceId: string;
      agentId: string;
      decision: AuthorizationDecision;
      installationId: string;
      /** What the decision judged: what a session call goes on as. */
      subject: AuthorizationSubject;
      /** Who the input is recorded as; set only when it may proceed. */
      actorUserId: string | null;
      /** What to show the person alone, once per thread; null for none. */
      notice: SlackNotice | null;
      pending: { id: string; revision: number } | null;
    };

/**
 * The caller a decided Slack input calls the session service as: the
 * installation, recorded as the person its linked account names, under the
 * same subject the decision judged.
 */
export function slackCallerOf(
  decision: Extract<SlackDecision, { status: "decided" }>,
  requestId: string,
): Caller {
  const link = decision.subject.linked_account;
  return {
    ownerId: decision.workspaceId,
    actor: {
      principal: { kind: "installation", id: decision.installationId },
      userId: decision.actorUserId,
      workspaceId: decision.workspaceId,
      apiKeyId: null,
      ...(link === undefined
        ? {}
        : { linkedAccount: { id: link.id, revision: link.revision } }),
    },
    subject: decision.subject,
    requestId,
  };
}

/**
 * The whole Musterrolle half of a Slack mention or button (design 3.2):
 * the agent the app belongs to, the person the Slack account links to now,
 * then the decision and the notice for a refusal. The Slack channel calls
 * this once per input it processes and for every button press, with the
 * person who pressed it.
 */
export async function authorizeSlackInput(
  deps: {
    authorization: AuthorizationPolicy;
    agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
    links: Pick<LinkedAccountStore, "resolveLinkedSubject">;
    bindings: Pick<
      SurfaceBindingStore,
      "resolveSlackChannel" | "findPendingApproval" | "findLiveSlackChannel"
    >;
  },
  input: SlackInput,
): Promise<SlackDecision> {
  const agent = await agentForSlackEvent(deps.agents, input.event);
  if (agent.status === "dropped") {
    return { status: "dropped", reason: agent.reason };
  }
  const { workspaceId, agentId } = agent;
  const stored = await deps.bindings.resolveSlackChannel(
    agent.installationId,
    input.channel.dm ? null : input.channel.id,
  );
  // A channel the bot left is not told anything: the bot is not in it, and
  // a refusal posted there would be a reply from a channel it was removed from.
  if (stored === null && !input.channel.dm) {
    const live = await deps.bindings.findLiveSlackChannel(
      agent.installationId,
      input.channel.id,
    );
    if (live?.status === "left") {
      return { status: "dropped", reason: "channel_left" };
    }
  }
  // An unbound, switched-off or other agent's channel takes nothing. It is
  // still decided, so the refusal is recorded and the person told.
  const binding =
    stored !== null && stored.mode !== "off" && stored.agentId === agentId
      ? stored
      : null;
  const pending =
    stored === null && !input.channel.dm
      ? await deps.bindings.findPendingApproval(
          agent.installationId,
          input.channel.id,
        )
      : null;

  const linked = await deps.links.resolveLinkedSubject({
    provider: "slack",
    externalTenant: input.event.teamId,
    externalUserId: input.user.id,
  });
  const subject: AuthorizationSubject = {
    principal: {
      kind: "installation",
      id: agent.installationId,
      // An installation's partition is its workspace's.
      owner_id: workspaceId,
      workspace_id: workspaceId,
      scopes: [...INSTALLATION_SESSION_SCOPE_VALUES],
    },
    // Passed even when stale or offboarded, so the decision names why.
    ...(linked.status === "unlinked"
      ? {}
      : {
          actor_user_id: linked.userId,
          linked_account: linked.linkedAccount,
        }),
    surface: {
      kind: "slack",
      ...(binding === null
        ? {}
        : {
            binding_id: binding.id,
            ...(binding.channelKind === null
              ? {}
              : { channel_kind: binding.channelKind }),
          }),
      slack_user_kind: slackUserKindOf(input.user, input.event.teamId),
      ceiling: binding?.ceiling ?? NO_CEILING,
      agent_id: agentId,
    },
  };
  const { resource } = input;
  const decision = await deps.authorization.authorize({
    subject,
    action: input.action,
    resource:
      resource.kind !== "surface_binding"
        ? { kind: resource.kind, id: resource.id, owner_scope: workspaceId }
        : {
            kind: "surface_binding",
            owner_scope: workspaceId,
            ...(binding === null
              ? { id: null, agent_id: agentId }
              : { id: binding.id }),
            ...(resource.releaseId === undefined
              ? {}
              : { release_id: resource.releaseId }),
          },
    request_id: input.requestId,
  });
  return {
    status: "decided",
    workspaceId,
    agentId,
    decision,
    installationId: agent.installationId,
    subject,
    actorUserId:
      decision.outcome !== "deny" && linked.status === "linked"
        ? linked.userId
        : null,
    notice:
      pending !== null && decision.outcome === "deny"
        ? { message: "pendingApproval" }
        : slackNoticeFor(decision, input.action, {
            connectUrl: input.connectUrl,
          }),
    pending: decision.outcome === "deny" ? pending : null,
  };
}
