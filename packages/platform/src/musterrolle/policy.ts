import {
  type Principal as AuthenticatedPrincipal,
  type AuthorizationAction,
  type AuthorizationDecision,
  type AuthorizationReason,
  type AuthorizationRequest,
  type AuthorizationResource,
  type AuthorizationSubject,
  type AuthorizationSurface,
  accessAxisOf,
  actionAppliesTo,
  authorizationRequestSchema,
  conversationIdSchema,
  type DeciderKey,
  ownerScopeOf,
  type PrincipalRef,
  type ReceiptActor,
  type SessionScope,
  SLACK_SURFACE_ACTION_VALUES,
  scopesForRole,
  type WebSessionId,
  WORKSPACE_MANAGER_ROLES,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  PrivateChannelPlace,
  SessionOrigin,
  SessionShareStore,
  SessionViewer,
} from "../sessions/ports/session-share-store.ts";
import type { ChannelMemberCheckable } from "../surface/ports/channel-member-checkable.ts";
import type { UsageDecision } from "./agent-usage-decision.ts";
import type { ConversationAccess } from "./ports/conversation-access.ts";
import type { DecisionLog } from "./ports/decision-log.ts";

export type RecordedActor = {
  principal: PrincipalRef;
  userId: string | null;
  workspaceId: string | null;
  apiKeyId: string | null;
  /** The agent an agent key calls as; null for every other credential. */
  agentId?: string | null;
  /** Who issued the key in `apiKeyId`; null when its row names nobody. */
  apiKeyIssuerId?: string | null;
  apiKeyKind?: DeciderKey["kind"] | null;
  /** The Slack link a person spoke through; a write re-reads it. */
  linkedAccount?: { id: string; revision: number };
  /** The console login this request came in on; a write does not re-read it. */
  webSessionId?: WebSessionId;
  /**
   * The allowed Slack bot whose mention this is, for `agentId`; no person.
   * A write re-reads the agent's allow list.
   */
  slackBotUserId?: string;
};

/** The partition a store reads and writes under. */
export type Principal = {
  ownerId: string;
  actor?: RecordedActor;
  requestId?: string;
};

/**
 * A receipt names the credential, the person the policy resolved behind it,
 * and the agent whose key it is. `agent_id` says who called, not whose
 * session it acted on.
 */
export function receiptActorOf(principal: Principal): ReceiptActor | null {
  const actor = principal.actor;
  if (!actor) return null;
  return {
    principal: actor.principal,
    actor_user_id: actor.userId,
    agent_id: actor.agentId ?? null,
  };
}

/** The key behind an approval, for its receipt; null for anyone else. */
export function deciderKeyOf(principal: Principal): DeciderKey | null {
  const actor = principal.actor;
  if (!actor?.apiKeyId) return null;
  const agent = (actor.agentId ?? null) !== null;
  return {
    id: actor.apiKeyId,
    kind: actor.apiKeyKind ?? (agent ? "agent" : "personal"),
    issued_by_user_id: actor.apiKeyIssuerId ?? (agent ? null : actor.userId),
  };
}

/**
 * Who calls a service. `ownerId` is what the stores partition on; the policy
 * checks it against the subject, so a caller assembled with another owner's
 * partition is told the resource does not exist.
 */
export type Caller = Principal & {
  subject: AuthorizationSubject;
  requestId: string;
};

/**
 * `storedKey` is set only when authentication found the key's row: the
 * AUTH_MODE=none principal is an api_key named after its owner, with no row.
 */
export function callerFor(
  principal: AuthenticatedPrincipal,
  surface: AuthorizationSurface,
  requestId: string,
  storedKey?: {
    creatorId: string | null;
    agentId?: string | null;
    issuerId?: string | null;
    kind?: DeciderKey["kind"];
  },
  webSessionId?: WebSessionId,
): Caller {
  const userId =
    principal.kind === "user"
      ? principal.id
      : principal.kind === "api_key"
        ? (storedKey?.creatorId ?? null)
        : null;
  return {
    ownerId: ownerScopeOf(principal),
    actor: {
      principal: { kind: principal.kind, id: principal.id },
      userId,
      workspaceId: principal.workspace_id,
      apiKeyId: principal.kind === "api_key" && storedKey ? principal.id : null,
      agentId:
        principal.kind === "api_key" ? (storedKey?.agentId ?? null) : null,
      apiKeyIssuerId:
        principal.kind === "api_key" ? (storedKey?.issuerId ?? null) : null,
      apiKeyKind:
        principal.kind === "api_key" ? (storedKey?.kind ?? null) : null,
      ...(webSessionId === undefined ? {} : { webSessionId }),
    },
    subject: {
      principal,
      ...(userId === null ? {} : { actor_user_id: userId }),
      surface,
    },
    requestId,
  };
}

export type IdentityReading =
  | {
      status: "ok";
      principal: AuthenticatedPrincipal;
      keyCreator?: { userId: string; role: WorkspaceRole };
      /**
       * Set for an agent key, and for a Slack bot the agent allows: the one
       * agent it reaches, with no person behind it.
       */
      keyAgentId?: string;
    }
  | {
      status: Extract<
        AuthorizationReason,
        "unlinked" | "disabled" | "stale_link"
      >;
    };

// Step 1 of the decision: the identity as it stands now, read for every
// decision and never cached across requests.
export interface IdentityReader {
  reread(
    subject: AuthorizationSubject & { principal: AuthenticatedPrincipal },
  ): Promise<IdentityReading>;
}

// An installation names no person until linked accounts exist, so it is
// unlinked.
export const authenticatedIdentity: IdentityReader = {
  async reread(subject) {
    return subject.principal.kind === "installation"
      ? { status: "unlinked" }
      : { status: "ok", principal: subject.principal };
  },
};

/**
 * Which agent a resource belongs to and who administers it, read for every
 * decision that needs it.
 */
export interface AgentAuthority {
  /** The agent an identified resource belongs to; null for none. */
  agentOf(
    workspaceId: string,
    resource: { kind: AuthorizationResource["kind"]; id: string },
  ): Promise<string | null>;
  /** An admin row of their own, or a live team they are a live member of. */
  isAdmin(
    workspaceId: string,
    agentId: string,
    userId: string,
  ): Promise<boolean>;
  /**
   * A live member who is a workspace manager, administers the agent, or is
   * a live member of its live managing team (agent-rbac (b), "inside").
   * Without it nobody is inside but managers and the agent's admins.
   */
  isInside?(
    workspaceId: string,
    agentId: string,
    userId: string,
  ): Promise<boolean>;
  /**
   * The agent a release was made for; null for none. Without it a start on
   * a binding or a link that names a release is refused.
   */
  agentOfRelease?(
    workspaceId: string,
    releaseId: string,
  ): Promise<string | null>;
  /**
   * Whether the person behind a caller may use the agent, read
   * without a lock. Without it every agent is open: a deployment with no
   * agent store has no private ones.
   */
  usageOf?(
    workspaceId: string,
    agentId: string,
    who: UsageRequester,
  ): Promise<UsageDecision>;
}

/** The caller as the usage decision sees them. */
export type UsageRequester = {
  /** The person: the user, or a personal key's creator. */
  userId: string | null;
  role: WorkspaceRole | null;
  /** The agent a key is bound to. */
  keyAgentId: string | null;
};

// Without a store an agent is only ever named directly, and nobody
// administers one.
export const noAgentAuthority: AgentAuthority = {
  async agentOf(_workspaceId, resource) {
    return resource.kind === "agent" ? resource.id : null;
  },
  async isAdmin() {
    return false;
  },
};

/** The credential names a release needs that its agent has no binding for. */
export interface CredentialCheck {
  unboundRefs(workspaceId: string, releaseId: string): Promise<string[]>;
}

// Without a store nothing can show a release's credentials are bound, so a
// session that names one is refused (fail-closed).
export const noCredentialCheck: CredentialCheck = {
  async unboundRefs() {
    throw new Error("no credential binding store");
  },
};

/** The workspace's Slack guest setting, read for every guest's decision. */
export interface SlackGuestSetting {
  enabled(workspaceId: string): Promise<boolean>;
}

// Without a settings store the setting is its default: off (D25).
export const slackGuestsDisabled: SlackGuestSetting = {
  async enabled() {
    return false;
  },
};

/** Who made a session and whom it is shared with, read for every decision. */
export type SessionAccess = Pick<SessionShareStore, "visibleTo" | "originOf"> &
  Partial<
    Pick<
      SessionShareStore,
      "privateChannels" | "pushRequesterOf" | "pendingRequesterOf"
    >
  >;

// Member checks run at once per decision; more would spend the Slack
// install's rate limit on one list.
const PRIVATE_CHANNEL_CHECKS_AT_ONCE = 8;

// Without a store no session was ever re-shared, so each reads workspace;
// whose session it is cannot be read, so nobody may change that.
export const workspaceWideSessions: SessionAccess = {
  async visibleTo() {
    return true;
  },
  async originOf() {
    throw new Error("no session share store");
  },
};

/**
 * The request a card waits on: a push, or a tool permission or a question.
 */
export type CardRequestRef =
  | { pushRequestId: string }
  | { pendingRequestId: string };

/**
 * Answer 15, second part (94S-2000), and Q5 for permission and question
 * cards (94S-2175): whether a request's requester has left the private
 * channel its session belongs to, so the channel's members decide it. Only
 * a confirmed absence counts; a check that cannot tell, or a session that is
 * no private channel's, keeps the usual rule.
 */
export async function requesterLeft(
  deps: {
    sessions: SessionAccess;
    channelMembers?: ChannelMemberCheckable | undefined;
    logger?:
      | {
          warn(
            message: string,
            fields?: Readonly<Record<string, unknown>>,
          ): void;
        }
      | undefined;
  },
  input: {
    workspaceId: string;
    sessionId: string;
    /** The session's private channels, when the caller read them already. */
    places?: readonly PrivateChannelPlace[];
  } & CardRequestRef,
): Promise<boolean> {
  const { sessions, channelMembers } = deps;
  const membership = channelMembers?.membership.bind(channelMembers);
  const { workspaceId, sessionId } = input;
  const push = "pushRequestId" in input;
  const requestId = push ? input.pushRequestId : input.pendingRequestId;
  const requesterOf = push
    ? sessions.pushRequesterOf
    : sessions.pendingRequesterOf;
  const unconfirmed = push
    ? {
        message: "Push requester's channel membership unconfirmed",
        fields: {
          event: "push.requester_left.unconfirmed",
          session_id: sessionId,
          push_request_id: requestId,
        },
      }
    : {
        message: "Pending request's requester channel membership unconfirmed",
        fields: {
          event: "pending.requester_left.unconfirmed",
          session_id: sessionId,
          pending_request_id: requestId,
        },
      };
  if (membership === undefined || requesterOf === undefined) return false;
  try {
    const places =
      input.places ??
      (await sessions.privateChannels?.(input.workspaceId, input.sessionId)) ??
      [];
    if (places.length === 0) return false;
    const requester = await requesterOf.call(
      sessions,
      workspaceId,
      sessionId,
      requestId,
    );
    if (requester === null) return false;
    const answers = await Promise.all(
      places.map((place) =>
        membership({
          workspaceId: input.workspaceId,
          agentId: place.agentId.toLowerCase(),
          channelId: place.channelId,
          userId: requester,
        }),
      ),
    );
    if (answers.includes("unconfirmed")) {
      deps.logger?.warn(unconfirmed.message, unconfirmed.fields);
      return false;
    }
    return answers.every((answer) => answer === "not_member");
  } catch (error) {
    deps.logger?.warn(unconfirmed.message, {
      ...unconfirmed.fields,
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}

export const POLICY_VERSION = "m17";

export interface AuthorizationPolicy {
  /**
   * The agent a release belongs to, whether this subject may use it and
   * whether they are inside it, for a start that must answer as a missing
   * release when they may not. Null when the release or the subject cannot
   * be resolved: the caller goes on as for any other release. Records
   * nothing.
   */
  usageOfRelease?(
    subject: AuthorizationSubject,
    ownerScope: string,
    releaseId: string,
  ): Promise<{ agentId: string; usage: UsageDecision; inside: boolean } | null>;
  /**
   * `record: false` decides without keeping the decision: for what a screen
   * offers, never for an act. `record: "deny"` keeps every outcome but an
   * allow, which it hands back unrecorded for an act whose store keeps it
   * with the change (`UnrecordedAllow`).
   */
  authorize(
    request: AuthorizationRequest,
    options?: { record?: false | "deny" },
  ): Promise<AuthorizationDecision>;
  /**
   * The conversations of the private channels whose sessions this subject
   * may pass the door of now (SessionViewer.privateChannels), for a
   * read across sessions. Records nothing.
   */
  privateChannelsOf?(
    subject: AuthorizationSubject,
    ownerScope: string,
  ): Promise<string[]>;
}

// The scope each session action needs. Actions with no scope have no rule
// yet and are refused.
export const ACTION_SCOPES: Partial<Record<AuthorizationAction, SessionScope>> =
  {
    "session.read": "sessions:read",
    "session.submit": "sessions:write",
    "session.approve": "sessions:approve",
    "session.control": "sessions:control",
    "session.recover": "sessions:recover",
  };

// The scope an action needs. Renaming needs what sending does, so it stays
// out of ACTION_SCOPES, where each scope names one action (the edge records
// a refusal under it).
export function scopeOf(action: AuthorizationAction): SessionScope | undefined {
  return action === "session.rename" ? "sessions:write" : ACTION_SCOPES[action];
}

// Design 4.1, the workspace and agent rows. An API key never holds one of
// these, whatever its scopes.
export const MANAGEMENT_ROLES: Partial<
  Record<AuthorizationAction, readonly WorkspaceRole[]>
> = {
  "workspace.manage": ["owner", "admin"],
  "audit_retention.manage": ["owner"],
  "audit_log.read": ["owner"],
  "member.manage": ["owner", "admin"],
  "team.manage": ["owner", "admin"],
  "api_key.manage": ["owner", "admin"],
  "api_key.manage_own": ["owner", "admin", "member"],
  "account.link": ["owner", "admin", "member"],
  "agent.create": ["owner", "admin", "member"],
  "agent.manage": ["owner", "admin"],
  "agent.restore": ["owner"],
  "agent.admin.manage": ["owner", "admin"],
  "agent.usage.manage": ["owner", "admin"],
  "credential.bind": ["owner", "admin"],
  "variable.workspace.manage": ["owner", "admin"],
  "variable.agent.manage": ["owner", "admin"],
  "binding.manage": ["owner", "admin"],
  "binding.approve": ["owner", "admin"],
  "session.audit_read": ["owner", "admin"],
  "session.admin_list": ["owner", "admin"],
  "usage.installation_read": ["owner"],
  "usage.agent_read": ["owner", "admin"],
  "judgment.read": ["owner", "admin"],
  "installation.settings.manage": ["owner"],
  "achievement_rule.manage": ["owner", "admin"],
  "achievement.review": ["owner", "admin"],
};

const WORKSPACE_MANAGERS: readonly WorkspaceRole[] = WORKSPACE_MANAGER_ROLES;

// What a manager may do on a session outside its share, given a reason
// (A.3 step 2): read it under audit, take it over, end it, recover it.
export const OUT_OF_SHARE_ACTIONS: ReadonlySet<AuthorizationAction> = new Set([
  "session.audit_read",
  "member.manage",
  "session.control",
  "session.recover",
]);

// What an agent's admin may also do on that agent, whatever their role.
export const AGENT_ADMIN_ACTIONS: ReadonlySet<AuthorizationAction> = new Set([
  "api_key.manage",
  "agent.manage",
  "agent.admin.manage",
  "agent.usage.manage",
  "credential.bind",
  "variable.agent.manage",
  "binding.manage",
  "usage.agent_read",
  "judgment.read",
  "achievement.review",
]);

// Reads of an agent, judged by who is inside it rather than by role, and
// not recorded when allowed: they change nothing.
export const AGENT_READ_ACTIONS: ReadonlySet<AuthorizationAction> = new Set([
  "agent.read",
  "agent.settings_read",
]);

function within(
  scopes: readonly SessionScope[],
  role: WorkspaceRole,
): SessionScope[] {
  const ceiling = new Set(scopesForRole(role));
  return scopes.filter((scope) => ceiling.has(scope));
}

function authorityScopes(reading: {
  principal: AuthenticatedPrincipal;
  keyCreator?: { role: WorkspaceRole };
}): SessionScope[] {
  const { principal, keyCreator } = reading;
  if (principal.kind === "user")
    return within(principal.scopes, principal.role);
  if (keyCreator) return within(principal.scopes, keyCreator.role);
  return [...principal.scopes];
}

// A personal key looks as its creator; an agent key or the CLI's operator key
// is no member and looks as itself (design 4.6).
function viewerOf(reading: {
  principal: AuthenticatedPrincipal;
  keyCreator?: { userId: string };
  keyAgentId?: string;
}): SessionViewer {
  const { principal } = reading;
  if (principal.kind === "user")
    return { userId: principal.id, apiKeyId: null, keyAgentId: null };
  if (principal.kind === "api_key") {
    return {
      userId: reading.keyCreator?.userId ?? null,
      apiKeyId: principal.id,
      keyAgentId: reading.keyAgentId ?? null,
    };
  }
  // An allowed bot looks as its agent, as that agent's key does.
  return {
    userId: null,
    apiKeyId: null,
    keyAgentId: reading.keyAgentId ?? null,
  };
}

function claimedActorMatches(
  subject: AuthorizationSubject,
  reading: Extract<IdentityReading, { status: "ok" }>,
): boolean {
  const expected =
    reading.principal.kind === "user"
      ? reading.principal.id
      : reading.keyCreator?.userId;
  return subject.actor_user_id === expected;
}

// Design 9-3: each judged on its own, so seeing a conversation never lets
// anyone write to it. No role or scope grants them, so they stay out of
// MANAGEMENT_ROLES and the console's permission list.
export const CONVERSATION_ACTIONS: ReadonlySet<AuthorizationAction> = new Set([
  "conversation.view",
  "conversation.post",
  "task.spawn",
]);

export const RECORDED_ALLOW_ACTIONS: ReadonlySet<AuthorizationAction> = new Set(
  [
    ...(Object.keys(MANAGEMENT_ROLES) as AuthorizationAction[]),
    ...CONVERSATION_ACTIONS,
    "routine.manage",
    "session.approve",
    "session.share",
  ],
);

// A reason is given to be kept: every decision that carries one is.
export function mustRecord(
  request: AuthorizationRequest,
  decision: AuthorizationDecision,
): boolean {
  return (
    decision.outcome !== "allow" ||
    RECORDED_ALLOW_ACTIONS.has(request.action) ||
    accessAxisOf(request.action) !== null ||
    request.subject.justification !== undefined ||
    (request.subject.surface.kind === "slack" &&
      request.action === "session.submit")
  );
}

const SLACK_ACTIONS: ReadonlySet<AuthorizationAction> = new Set(
  SLACK_SURFACE_ACTION_VALUES,
);

// requesterLeft: an allow that only a requester's leaving let through.
type Judgement = [
  AuthorizationReason,
  SessionScope[],
  redact?: true | undefined,
  requesterLeft?: true | undefined,
];

// Web and api add no ceiling of their own. On Slack the person acts through
// the installation and the channel: the smallest of the three.
function slackCeilingScopes(
  subject: AuthorizationSubject,
  surface: AuthorizationSurface,
  scopes: readonly SessionScope[],
): SessionScope[] {
  const installation = new Set<SessionScope>(
    subject.principal?.kind === "installation" ? subject.principal.scopes : [],
  );
  const channel = new Set(
    (surface.ceiling?.actions ?? []).map((allowed) => ACTION_SCOPES[allowed]),
  );
  return scopes.filter((held) => installation.has(held) && channel.has(held));
}

export function createAuthorizationPolicy(
  deps: {
    identity?: IdentityReader;
    agents?: AgentAuthority;
    credentials?: CredentialCheck;
    slackGuests?: SlackGuestSetting;
    sessions?: SessionAccess;
    /** Without it no one passes a private channel's door. */
    channelMembers?: ChannelMemberCheckable;
    /** Without it every conversation decision is refused. */
    conversations?: ConversationAccess;
    newDecisionId?: () => string;
    decisions?: DecisionLog;
    /** Hears the failures that end in a refusal instead of an error. */
    logger?: {
      warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
    };
  } = {},
): AuthorizationPolicy {
  const identity = deps.identity ?? authenticatedIdentity;
  const errorName = (error: unknown) =>
    error instanceof Error ? error.name : typeof error;
  const agents = deps.agents ?? noAgentAuthority;
  const credentials = deps.credentials ?? noCredentialCheck;
  const slackGuests = deps.slackGuests ?? slackGuestsDisabled;
  const sessions = deps.sessions ?? workspaceWideSessions;

  async function agentOfResource(
    resource: AuthorizationResource,
  ): Promise<string | null> {
    if (resource.id === null) return resource.agent_id?.toLowerCase() ?? null;
    const agentId = await agents.agentOf(resource.owner_scope, {
      kind: resource.kind,
      id: resource.id,
    });
    return agentId?.toLowerCase() ?? null;
  }
  // D21: a person's session is theirs alone to share; a key's session is
  // the workspace's managers' and its agent's admins'.
  async function mayShare(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    sessionId: string,
  ): Promise<boolean> {
    if (principal.kind !== "user") return false;
    const origin = await sessions.originOf(workspaceId, sessionId);
    if (origin === null) return false;
    if (origin.creatorUserId !== null) {
      return origin.creatorUserId.toLowerCase() === principal.id.toLowerCase();
    }
    if (WORKSPACE_MANAGERS.includes(principal.role)) return true;
    const agentId = await agents.agentOf(workspaceId, {
      kind: "session",
      id: sessionId,
    });
    return (
      agentId !== null &&
      (await agents.isAdmin(workspaceId, agentId.toLowerCase(), principal.id))
    );
  }
  // Seeing a session through its share is not answering for it,
  // nor renaming it. Its creator answers (a key's session: that
  // key renames it but never approves it), as do its agent's admins, the
  // workspace's managers and its agent's keys, which the agent ceiling holds
  // to that agent.
  async function mayAnswer(
    reading: Extract<IdentityReading, { status: "ok" }>,
    workspaceId: string,
    sessionId: string,
    approve: boolean,
  ): Promise<"ok" | "role" | "self_approval"> {
    // A caller from before workspaces (an operator's key CLI key, a legacy
    // key, AUTH_MODE=none) has no members beside it to answer for, nor
    // another key to approve instead: the quickstart runs on one such key.
    if (reading.principal.workspace_id === null) return "ok";
    const viewer = viewerOf(reading);
    const same = (a: string | null, b: string | null) =>
      a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
    let origin: SessionOrigin | null | undefined;
    if (approve && viewer.apiKeyId !== null) {
      origin = await sessions.originOf(workspaceId, sessionId);
      if (same(origin?.creatorApiKeyId ?? null, viewer.apiKeyId)) {
        return "self_approval";
      }
    }
    if (approve && reading.keyAgentId !== undefined) return "ok";
    const role =
      reading.principal.kind === "user"
        ? reading.principal.role
        : reading.keyCreator?.role;
    if (role !== undefined && WORKSPACE_MANAGERS.includes(role)) return "ok";
    if (origin === undefined) {
      origin = await sessions.originOf(workspaceId, sessionId);
    }
    if (origin === null) return "role";
    if (
      origin.creatorUserId !== null
        ? same(origin.creatorUserId, viewer.userId)
        : same(origin.creatorApiKeyId, viewer.apiKeyId)
    ) {
      return "ok";
    }
    if (viewer.userId === null) return "role";
    const agentId = await agents.agentOf(workspaceId, {
      kind: "session",
      id: sessionId,
    });
    return agentId !== null &&
      (await agents.isAdmin(workspaceId, agentId.toLowerCase(), viewer.userId))
      ? "ok"
      : "role";
  }
  // A person starts as themselves, a personal key as its creator; an agent
  // key is inside its own agent, the only one its ceiling lets it reach.
  async function startsInside(
    reading: Extract<IdentityReading, { status: "ok" }>,
    workspaceId: string,
    agentId: string,
  ): Promise<boolean> {
    if (reading.keyAgentId !== undefined) return true;
    const { principal } = reading;
    const starter =
      principal.kind === "user"
        ? { userId: principal.id, role: principal.role }
        : reading.keyCreator;
    if (starter === undefined) return false;
    if (WORKSPACE_MANAGERS.includes(starter.role)) return true;
    return agents.isInside
      ? agents.isInside(workspaceId, agentId, starter.userId)
      : agents.isAdmin(workspaceId, agentId, starter.userId);
  }

  // A personal key uses an agent as its creator; an agent's key as that
  // agent; any other key has no person.
  async function usageFor(
    reading: Extract<IdentityReading, { status: "ok" }>,
    workspaceId: string,
    agentId: string,
  ): Promise<UsageDecision> {
    if (!agents.usageOf)
      return { allowed: true, basis: "public", teamId: null };
    const { principal } = reading;
    const person =
      principal.kind === "user"
        ? { userId: principal.id, role: principal.role }
        : {
            userId: reading.keyCreator?.userId ?? null,
            role: reading.keyCreator?.role ?? null,
          };
    return agents.usageOf(workspaceId, agentId, {
      ...person,
      keyAgentId: reading.keyAgentId ?? null,
    });
  }
  // Design 9-3. View: a DM is its person's; a public channel is whoever
  // may use the agent; a private channel adds a live Slack link and current
  // membership, and hides whatever cannot be confirmed. Post: view, and on a
  // channel a live link (the post goes out under the person), not archived,
  // listening not off; a web DM needs none of those. Spawn: post, and the
  // start a session on that agent would need. On Slack a spawn is the
  // linked person's, from the very place the event came from.
  async function conversationReason(
    action: AuthorizationAction,
    reading: Extract<IdentityReading, { status: "ok" }>,
    workspaceId: string,
    resourceId: string | null,
    justified: boolean,
    surface: AuthorizationSurface,
  ): Promise<AuthorizationReason> {
    const { principal } = reading;
    // Decision 44: no key reaches a conversation, audit reads included.
    if (principal.kind !== "user") return "role";
    const id = conversationIdSchema.safeParse(resourceId);
    if (!id.success || deps.conversations === undefined) return "error";
    const conversations = deps.conversations;
    if (action === "session.audit_read") {
      if (!WORKSPACE_MANAGERS.includes(principal.role)) return "role";
      if (!justified) return "justification_required";
      return (await conversations.placeOf(workspaceId, id.data)) === null
        ? "not_found"
        : "ok";
    }
    const place = await conversations.placeOf(workspaceId, id.data);
    if (place === null) return "not_found";
    const agentId = place.agentId.toLowerCase();
    if (surface.kind === "slack") {
      // One agent's app never reaches another agent's conversations.
      if (agentId !== surface.agent_id?.toLowerCase()) return "agent_ceiling";
      // An installation speaks for the channel its event came from alone.
      const channelId = place.kind === "channel" ? place.channelId : undefined;
      if (surface.channel_id !== channelId) return "error";
    }
    const self = (userId: string) =>
      userId.toLowerCase() === principal.id.toLowerCase();
    if (place.kind === "dm") {
      if (!self(place.personUserId)) return "not_found";
      if (action === "conversation.view") return "ok";
    }
    const usable = (await usageFor(reading, workspaceId, agentId)).allowed;
    const linked = () =>
      conversations.slackLinked(workspaceId, agentId, principal.id);
    if (place.kind === "channel" && place.private) {
      // Every refusal reads the same, so a non-member learns nothing of it.
      if (
        !usable ||
        !(await linked()) ||
        !(await conversations.isMember({
          workspaceId,
          agentId,
          channelId: place.channelId,
          userId: principal.id,
        }))
      ) {
        return "not_found";
      }
    } else if (!usable) {
      return "agent_private";
    }
    if (place.kind === "channel") {
      if (action === "conversation.view") return "ok";
      if (!place.private && !(await linked())) return "unlinked";
      if (await conversations.archived(workspaceId, id.data)) {
        return "conversation_archived";
      }
      if ((await conversations.listening(workspaceId, id.data)) === "off") {
        return "listening_off";
      }
    }
    if (action === "conversation.post") return "ok";
    return (await startsInside(reading, workspaceId, agentId)) ? "ok" : "role";
  }

  // Design 9-3 for a private channel's sessions: a person who may use the
  // agent and is a member of the channel now; never a key. An event or a
  // click from that very channel (its channel read from the signed Slack
  // payload) is a member's, so Slack is not asked. Whatever cannot be
  // confirmed hides the channel.
  async function privateChannelsFor(
    reading: Extract<IdentityReading, { status: "ok" }>,
    surface: AuthorizationSurface,
    workspaceId: string,
    places: readonly PrivateChannelPlace[],
  ): Promise<string[]> {
    const { principal } = reading;
    const unknown = places.filter((place) => place.kindUnknown === true);
    if (unknown.length > 0) {
      deps.logger?.warn("Channel kind unknown; held private", {
        event: "session.private_channel.kind_unknown",
        conversation_count: unknown.length,
      });
    }
    if (places.length === 0 || principal.kind === "api_key") return [];
    const same = (a: string | undefined, b: string) =>
      a !== undefined && a.toLowerCase() === b.toLowerCase();
    if (principal.kind !== "user") return [];
    const members = deps.channelMembers;
    // The signed payload stands in for the member check only; the agent
    // access is checked all the same.
    const fromChannel = (place: PrivateChannelPlace) =>
      surface.kind === "slack" &&
      surface.channel_id === place.channelId &&
      same(surface.agent_id, place.agentId);
    const ask = places.filter(
      (place) => fromChannel(place) || members !== undefined,
    );
    const seen: string[] = [];
    const sees = async (place: PrivateChannelPlace) => {
      try {
        const agentId = place.agentId.toLowerCase();
        if (!(await usageFor(reading, workspaceId, agentId)).allowed) {
          deps.logger?.warn("Private channel hidden; agent usage denied", {
            event: "session.private_channel.usage_denied",
            reason: "usage_denied",
            workspace_id: workspaceId,
            agent_id: agentId,
            channel_id: place.channelId,
          });
          return false;
        }
        return (
          fromChannel(place) ||
          (members !== undefined &&
            (await members.isMember({
              workspaceId,
              agentId,
              channelId: place.channelId,
              userId: principal.id,
            })))
        );
      } catch (error) {
        deps.logger?.warn("Private channel access unconfirmed; hidden", {
          error_name: errorName(error),
        });
        return false;
      }
    };
    for (let at = 0; at < ask.length; at += PRIVATE_CHANNEL_CHECKS_AT_ONCE) {
      const batch = ask.slice(at, at + PRIVATE_CHANNEL_CHECKS_AT_ONCE);
      const answers = await Promise.all(batch.map(sees));
      batch.forEach((place, i) => {
        if (answers[i]) seen.push(place.conversationId);
      });
    }
    return seen;
  }

  const decisions = deps.decisions;
  const newDecisionId = deps.newDecisionId ?? (() => crypto.randomUUID());

  async function decide(request: AuthorizationRequest): Promise<Judgement> {
    const parsed = authorizationRequestSchema.safeParse(request);
    if (!parsed.success) return ["error", []];
    const { subject, action, resource } = parsed.data;
    const scope = scopeOf(action);
    const roles = MANAGEMENT_ROLES[action];
    if (
      (scope === undefined &&
        roles === undefined &&
        action !== "session.share" &&
        action !== "workspace.read" &&
        !AGENT_READ_ACTIONS.has(action) &&
        !CONVERSATION_ACTIONS.has(action)) ||
      !actionAppliesTo(action, resource.kind)
    ) {
      return ["error", []];
    }
    if (subject.principal === null) return ["no_requester", []];
    const { surface } = subject;
    if (surface.kind === "slack") {
      // Only an installation speaks for Slack, and it always says who the
      // person is to Slack. Strangers go first: they are no one to link,
      // and the guest setting is not theirs to pass (design A.3 step 4).
      if (
        subject.principal.kind !== "installation" ||
        surface.slack_user_kind === undefined ||
        surface.agent_id === undefined
      ) {
        return ["error", []];
      }
      if (surface.slack_user_kind === "external") {
        return ["external_user", []];
      }
      if (
        surface.slack_user_kind === "guest" &&
        !(await slackGuests.enabled(subject.principal.workspace_id))
      ) {
        return ["guest_disabled", []];
      }
      // A bot names no person: it is either the bot or a linked account.
      if (
        surface.slack_bot_user_id !== undefined &&
        (subject.linked_account !== undefined ||
          subject.actor_user_id !== undefined)
      ) {
        return ["error", []];
      }
    }

    const reading = await identity.reread({
      ...subject,
      principal: subject.principal,
    });
    if (reading.status !== "ok") return [reading.status, []];
    // An allowed bot is let in as its agent and nothing else.
    if (
      surface.slack_bot_user_id !== undefined &&
      reading.keyAgentId?.toLowerCase() !== surface.agent_id?.toLowerCase()
    ) {
      return ["unlinked", []];
    }
    if (!claimedActorMatches(subject, reading)) return ["error", []];
    if (resource.owner_scope !== ownerScopeOf(reading.principal)) {
      return ["not_found", []];
    }

    const { principal } = reading;
    const manager =
      principal.kind === "user" && WORKSPACE_MANAGERS.includes(principal.role);
    const justified = (subject.justification?.trim() ?? "") !== "";
    if (resource.kind === "conversation") {
      let scopes = authorityScopes(reading);
      if (surface.kind === "slack") {
        // Slack opens a start alone: seeing and posting stay the web's and
        // the API's. A start passes the ceiling a session start does.
        const start = scopeOf("session.submit");
        scopes = slackCeilingScopes(subject, surface, scopes);
        if (
          action !== "task.spawn" ||
          start === undefined ||
          !scopes.includes(start) ||
          !surface.ceiling?.actions.includes("session.submit")
        ) {
          return ["surface_ceiling", scopes];
        }
      }
      if (subject.agent !== undefined) return ["agent_ceiling", []];
      const reason = await conversationReason(
        action,
        reading,
        resource.owner_scope,
        resource.id,
        justified,
        surface,
      );
      return [reason, reason === "error" ? [] : scopes];
    }
    // Step 2 goes on to the share: a session outside it does not exist for
    // this subject, save for what a manager does with a reason.
    let places: PrivateChannelPlace[] = [];
    if (resource.kind === "session" && resource.id !== null) {
      places =
        (await sessions.privateChannels?.(resource.owner_scope, resource.id)) ??
        [];
      const visible = await sessions.visibleTo(
        resource.owner_scope,
        resource.id,
        {
          ...viewerOf(reading),
          privateChannels: await privateChannelsFor(
            reading,
            surface,
            resource.owner_scope,
            places,
          ),
        },
      );
      // The reason a key is refused is kept apart from not_found, though
      // it answers the same.
      const hidden: AuthorizationReason =
        principal.kind === "api_key" && places.length > 0
          ? "private_channel_key"
          : "not_found";
      if (action === "session.share") {
        // Behind a private channel's door its share is changed only by
        // someone who passes it: its creator gone from the channel is not.
        if (places.length > 0 && !visible) return [hidden, []];
        if (!(await mayShare(principal, resource.owner_scope, resource.id))) {
          return [visible ? "role" : hidden, []];
        }
      } else if (
        manager &&
        OUT_OF_SHARE_ACTIONS.has(action) &&
        // A private channel's policy leaves a manager its audit read alone.
        (places.length === 0 || action === "session.audit_read")
      ) {
        // Audit reads and takeovers are management screens only, so asking
        // for the reason there reveals nothing; a control without one is as
        // blind as anyone's (owner and admin see not_found on the ordinary
        // screens too).
        if (!justified && (action === "session.audit_read" || !visible)) {
          if (action === "session.audit_read" || action === "member.manage") {
            return ["justification_required", []];
          }
          return [hidden, []];
        }
      } else if (!visible) {
        return [hidden, []];
      }
    }

    let scopes = authorityScopes(reading);
    if (action === "session.share") {
      // Judged above; a key never changes a share (design 4.1).
    } else if (action === "workspace.read") {
      // Every member and a member's personal key; an agent's key, the CLI's
      // operator key and an installation read nothing here.
      if (
        principal.kind !== "user" &&
        (reading.keyCreator === undefined || reading.keyAgentId !== undefined)
      ) {
        return ["role", scopes];
      }
    } else if (AGENT_READ_ACTIONS.has(action)) {
      // A person, or a personal key as its creator (agent-rbac (b)); an
      // agent key reads its own agent's row through session.submit instead.
      const reader =
        principal.kind === "user"
          ? { userId: principal.id, role: principal.role }
          : reading.keyAgentId === undefined
            ? reading.keyCreator
            : undefined;
      if (reader === undefined) return ["role", scopes];
      if (resource.kind === "agent") {
        const agentId = await agentOfResource(resource);
        if (agentId === null) return ["not_found", scopes];
        if (
          !WORKSPACE_MANAGERS.includes(reader.role) &&
          !(await (agents.isInside
            ? agents.isInside(resource.owner_scope, agentId, reader.userId)
            : agents.isAdmin(resource.owner_scope, agentId, reader.userId)))
        ) {
          // An agent is its managing team's: outside it, it does not exist.
          return ["not_found", scopes];
        }
      }
    } else if (roles !== undefined) {
      if (principal.kind !== "user") return ["role", scopes];
      if (!roles.includes(principal.role)) {
        const agentId = AGENT_ADMIN_ACTIONS.has(action)
          ? await agentOfResource(resource)
          : null;
        if (
          agentId === null ||
          !(await agents.isAdmin(principal.workspace_id, agentId, principal.id))
        ) {
          return ["role", scopes];
        }
      }
    } else if (scope === undefined || !scopes.includes(scope)) {
      return ["role", scopes];
    } else if (
      reading.keyAgentId !== undefined &&
      (await agentOfResource(resource)) !== reading.keyAgentId.toLowerCase()
    ) {
      // A key bound to an agent reaches that agent's sessions and nothing
      // else, a list across agents included.
      return ["agent_ceiling", scopes];
    }
    let redact = false;
    if (surface.kind === "slack") {
      scopes = slackCeilingScopes(subject, surface, scopes);
      if (
        !SLACK_ACTIONS.has(action) ||
        scope === undefined ||
        !scopes.includes(scope)
      ) {
        return ["surface_ceiling", scopes];
      }
      // One agent's app never reaches another agent's sessions, even in the
      // same workspace.
      if (
        (await agentOfResource(resource)) !== surface.agent_id?.toLowerCase()
      ) {
        return ["agent_ceiling", scopes];
      }
      redact =
        action === "session.read" && surface.ceiling?.disclosure === "summary";
    }
    let requesterGone: true | undefined;
    if (action === "session.approve" || action === "session.rename") {
      const answer =
        resource.id === null
          ? "role"
          : await mayAnswer(
              reading,
              resource.owner_scope,
              resource.id,
              action === "session.approve",
            );
      // A private channel's member, who sees the session, decides a push, a
      // tool permission or a question whose requester left the channel; the
      // requester no longer sees it. Only the role refusal is lifted: every
      // check below still runs. A tool permission or question answered by
      // anyone after its requester left is marked too; a session allow given
      // there is bound to its giver and judged again before each later call.
      const request: CardRequestRef | null =
        resource.push_request_id !== undefined
          ? { pushRequestId: resource.push_request_id }
          : resource.pending_request_id !== undefined
            ? { pendingRequestId: resource.pending_request_id }
            : null;
      const left =
        (answer === "role" ||
          (answer === "ok" &&
            request !== null &&
            "pendingRequestId" in request)) &&
        action === "session.approve" &&
        resource.id !== null &&
        request !== null &&
        (await requesterLeft(
          {
            sessions,
            channelMembers: deps.channelMembers,
            logger: deps.logger,
          },
          {
            workspaceId: resource.owner_scope,
            sessionId: resource.id,
            places,
            ...request,
          },
        ));
      if (answer !== "ok" && !left) return [answer, scopes];
      if (left) requesterGone = true;
    }
    // No agent identity has a ceiling to multiply by yet.
    if (subject.agent !== undefined) return ["agent_ceiling", scopes];
    // Who may use a private agent, after every refusal that is
    // the same for a public one, and before the credential check, whose
    // answer names the agent's admins. A workspace's session that is
    // visible to the requester is answered here too: the share does not
    // make the agent theirs.
    if (
      action === "session.submit" &&
      principal.workspace_id !== null &&
      (resource.release_id !== undefined || resource.id !== null)
    ) {
      const agentId = await agentOfResource(resource);
      if (agentId !== null) {
        const usage = await usageFor(reading, resource.owner_scope, agentId);
        if (!usage.allowed) return ["agent_private", scopes];
      }
    }
    if (resource.release_id !== undefined && action !== "session.submit") {
      return ["error", []];
    }
    // A start on web, api and Slack alike: only those inside the agent run
    // it (agent-rbac (b)). An agent key is inside its own agent, the only
    // one the ceiling above lets it reach. A Slack start on an agent with no
    // release is judged too, so only those inside learn it has none.
    if (
      (resource.release_id !== undefined ||
        (action === "session.submit" && resource.kind === "surface_binding")) &&
      reading.keyAgentId === undefined
    ) {
      const agentId = await agentOfResource(resource);
      if (agentId === null) return ["error", []];
      if (!(await startsInside(reading, resource.owner_scope, agentId))) {
        return ["role", scopes];
      }
    }
    // Re-read at every start: a binding revoked since activation stops the
    // next session.
    if (resource.release_id !== undefined) {
      if (resource.kind !== "session") {
        if (agents.agentOfRelease === undefined) return ["error", []];
        const releaseAgent = await agents.agentOfRelease(
          resource.owner_scope,
          resource.release_id,
        );
        if (
          releaseAgent === null ||
          releaseAgent.toLowerCase() !== (await agentOfResource(resource))
        ) {
          return ["agent_ceiling", scopes];
        }
      }
      const unbound = await credentials.unboundRefs(
        resource.owner_scope,
        resource.release_id,
      );
      if (unbound.length > 0) return ["credential_unbound", scopes];
    }
    // A summary is still a ceiling: the reason names it.
    return redact
      ? ["surface_ceiling", scopes, true]
      : ["ok", scopes, undefined, requesterGone];
  }

  return {
    async privateChannelsOf(subject, ownerScope) {
      if (subject.principal === null || !sessions.privateChannels) return [];
      const reading = await identity.reread({
        ...subject,
        principal: subject.principal,
      });
      if (
        reading.status !== "ok" ||
        ownerScope !== ownerScopeOf(reading.principal)
      ) {
        return [];
      }
      return privateChannelsFor(
        reading,
        subject.surface,
        ownerScope,
        await sessions.privateChannels(ownerScope, null),
      );
    },

    async usageOfRelease(subject, ownerScope, releaseId) {
      if (
        subject.principal === null ||
        agents.agentOfRelease === undefined ||
        !agents.usageOf
      ) {
        return null;
      }
      const reading = await identity.reread({
        ...subject,
        principal: subject.principal,
      });
      if (
        reading.status !== "ok" ||
        reading.principal.workspace_id === null ||
        ownerScope !== ownerScopeOf(reading.principal)
      ) {
        return null;
      }
      const agentId = await agents.agentOfRelease(ownerScope, releaseId);
      if (agentId === null) return null;
      return {
        agentId,
        usage: await usageFor(reading, ownerScope, agentId.toLowerCase()),
        inside: await startsInside(reading, ownerScope, agentId.toLowerCase()),
      };
    },
    async authorize(request, options) {
      const decision_id = newDecisionId();
      let reason: AuthorizationReason;
      let effective_scopes: SessionScope[];
      let redact: true | undefined;
      let left: true | undefined;
      try {
        [reason, effective_scopes, redact, left] = await decide(request);
      } catch (error) {
        deps.logger?.warn("Authorization could not decide; refusing", {
          action: request.action,
          error_name: errorName(error),
        });
        [reason, effective_scopes, redact] = ["error", [], undefined];
      }
      const decision: AuthorizationDecision = redact
        ? {
            outcome: "redact",
            reason_code: reason,
            effective_scopes,
            redact: { view: "summary" },
            policy_version: POLICY_VERSION,
            decision_id,
          }
        : {
            outcome: reason === "ok" ? "allow" : "deny",
            reason_code: reason,
            effective_scopes,
            policy_version: POLICY_VERSION,
            decision_id,
            ...(left && reason === "ok" ? { requester_left: true } : {}),
          };
      const parsed = authorizationRequestSchema.safeParse(request);
      if (
        !decisions &&
        options?.record !== false &&
        accessAxisOf(request.action) !== null
      ) {
        // An access act takes effect only once recorded, so a policy
        // assembled without its log refuses every one.
        return refusedUnrecorded(decision);
      }
      if (
        !decisions ||
        options?.record === false ||
        (options?.record === "deny" && decision.outcome === "allow") ||
        !parsed.success ||
        !mustRecord(parsed.data, decision)
      ) {
        return decision;
      }
      try {
        await decisions.record({ request: parsed.data, decision });
        return decision;
      } catch (error) {
        deps.logger?.warn("Authorization decision could not be recorded", {
          action: parsed.data.action,
          outcome: decision.outcome,
          error_name: errorName(error),
        });
        return refusedUnrecorded(decision);
      }
    },
  };
}

// A redact grants a summary, so an unrecorded one is refused too.
function refusedUnrecorded(
  decision: AuthorizationDecision,
): AuthorizationDecision {
  if (decision.outcome === "deny") return decision;
  const { redact: _summary, access, ...unrecorded } = decision;
  return {
    ...unrecorded,
    outcome: "deny",
    reason_code: "error",
    effective_scopes: [],
    ...(access && { access: { ...access, granted: null } }),
  };
}
