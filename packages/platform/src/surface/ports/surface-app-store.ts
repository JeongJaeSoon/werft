import type {
  GetSlackAppResponse,
  SlackAppKind,
  SlackAppSecretPurpose,
  SlackAppSettings,
  SlackAppState,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { Principal } from "../../musterrolle/index.ts";
import type { SecretSummary } from "../../secrets/ports/secret-store.ts";

/** What Slack answers to `apps.manifest.create`; the secrets are stored, never shown. */
export type CreatedSurfaceApp = {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
};

export type SurfaceAppRecord = {
  id: string;
  workspaceId: string;
  kind: SlackAppKind;
  agentId: string | null;
  state: SlackAppState;
  appId: string | null;
  clientId: string | null;
  redirectUrl: string;
  createdByTokenUser: string | null;
  createdAt: Date;
  updatedAt: Date;
  events?: GetSlackAppResponse["events"];
  secrets: Record<SlackAppSecretPurpose, SecretSummary | null>;
};

/** The bots an agent answers, and its own install to read them against. */
export type AgentBotAllowList = {
  allowedBotUserIds: string[];
  install: { teamId: string; botUserId: string } | null;
  /**
   * The bot users of every Slack app this Werft install has in the
   * install's team, the agent's own among them. Empty without an install.
   */
  werftBotUserIds: string[];
};

/** What the manifest says about the agent, read with its active release. */
export type SurfaceAppAgent = {
  id: string;
  name: string;
  slug: string;
  /** The active release card's role, else the agent's description; may be empty. */
  role: string;
};

export type MadeSurfaceApp = {
  app: SurfaceAppRecord;
  agent: { id: string; name: string; slug: string; installed: boolean } | null;
};

/**
 * A person acting through the console, whose right is read again under
 * lock; null for the operator's CLI, which holds the database itself.
 */
export type SurfaceAppActor = {
  principal: Principal;
  managerRoles: readonly WorkspaceRole[];
} | null;

export type BeginAgentAppResult =
  | { outcome: "begun"; app: SurfaceAppRecord; agent: SurfaceAppAgent }
  | { outcome: "exists"; app: SurfaceAppRecord }
  /** `uncertain`: begun before `staleBefore`, so its answer was lost. */
  | { outcome: "creating"; app: SurfaceAppRecord; uncertain: boolean }
  | {
      outcome:
        | "agent_not_found"
        | "agent_not_active"
        | "actor_inactive"
        | "outranked";
    };

/** As for an agent's app; the name is what the link app is called after. */
export type BeginLinkAppResult =
  | { outcome: "begun"; app: SurfaceAppRecord; workspaceName: string }
  | { outcome: "exists"; app: SurfaceAppRecord }
  | { outcome: "creating"; app: SurfaceAppRecord; uncertain: boolean }
  | { outcome: "workspace_not_found" | "actor_inactive" | "outranked" };

/**
 * `begun`: the app is now `deleting` and Slack must be asked. `settled`:
 * no Slack app to delete (it failed, was abandoned or is gone already).
 */
export type BeginDeleteResult =
  | { outcome: "begun" | "settled" | "creating"; app: SurfaceAppRecord }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

/**
 * The workspace's Slack apps. A creation is two writes around the Slack
 * call: `beginAgentApp` records `creating`, `finishCreate` records what
 * Slack answered and seals the app's secrets in the same transaction.
 */
export type SurfaceEventsCheck = Omit<
  GetSlackAppResponse["events"],
  "url" | "last_received_at"
>;

export interface SurfaceAppStore {
  setEvents(
    workspaceId: string,
    slackAppId: string,
    events: SurfaceEventsCheck,
  ): Promise<void>;
  /**
   * Records `url` as sent to Slack: `pending` unless the app is already
   * `verified`, for this URL or an earlier one.
   */
  registerEventsUrl(
    workspaceId: string,
    slackAppId: string,
    url: string,
    checkedAt: string,
  ): Promise<void>;
  /**
   * `setEvents`, skipped once the app is `verified`: only a request signed
   * by this app sets that, and nothing later in the same registration may
   * take it back.
   */
  setEventsUnlessVerified(
    workspaceId: string,
    slackAppId: string,
    events: SurfaceEventsCheck,
  ): Promise<void>;
  /**
   * Records that a request signed by this app arrived at `at`. A mark at
   * most a minute old is kept, so a burst of events writes once.
   */
  markEventsReceived(
    workspaceId: string,
    slackAppId: string,
    at: Date,
  ): Promise<void>;
  getSettings(
    workspaceId: string,
    agentId: string,
  ): Promise<SlackAppSettings | null>;
  putSettings(input: {
    workspaceId: string;
    agentId: string;
    actor: SurfaceAppActor;
    settings: SlackAppSettings;
  }): Promise<"saved" | "not_found" | "actor_inactive" | "outranked">;
  /**
   * The Slack bots the agent answers, and its live install's team and bot
   * user (null while it has none); null for no such agent.
   */
  getAllowedBots(
    workspaceId: string,
    agentId: string,
  ): Promise<AgentBotAllowList | null>;
  putAllowedBots(input: {
    workspaceId: string;
    agentId: string;
    actor: SurfaceAppActor;
    allowedBotUserIds: readonly string[];
  }): Promise<"saved" | "not_found" | "actor_inactive" | "outranked">;
  /**
   * The operator CLI's save of the bots the agent answers. The list is
   * replaced and, when it changed, a `set_slack_allowed_bots` receipt with
   * `by: operator_cli` is written in the same transaction. Answers the list
   * as it was and as it is.
   */
  putAllowedBotsAsOperator(input: {
    workspaceId: string;
    agentId: string;
    allowedBotUserIds: readonly string[];
  }): Promise<"not_found" | { before: string[]; after: string[] }>;
  beginAgentApp(input: {
    workspaceId: string;
    agentId: string;
    actor: SurfaceAppActor;
    redirectUrl: string;
    newId: string;
    /** A `creating` row older than this counts as lost. */
    staleBefore: Date;
    /** Mark a lost `creating` row `abandoned` and begin a new one. */
    replaceUncertain: boolean;
  }): Promise<BeginAgentAppResult>;
  /** The workspace's one live link app, begun as `beginAgentApp` begins. */
  beginLinkApp(input: {
    workspaceId: string;
    actor: SurfaceAppActor;
    redirectUrl: string;
    newId: string;
    staleBefore: Date;
    replaceUncertain: boolean;
  }): Promise<BeginLinkAppResult>;
  finishCreate(input: {
    workspaceId: string;
    slackAppId: string;
    created: CreatedSurfaceApp;
    tokenUserId: string;
  }): Promise<SurfaceAppRecord>;
  /**
   * Seals the bot token an install returned under the app, replacing an
   * earlier one, and sets `bot_token_ref`. Null when the app is no longer
   * `created`.
   */
  storeBotToken(input: {
    workspaceId: string;
    slackAppId: string;
    botToken: string;
  }): Promise<SurfaceAppRecord | null>;
  /** Slack refused the creation: no app exists. */
  failCreate(workspaceId: string, slackAppId: string): Promise<void>;
  find(
    workspaceId: string,
    slackAppId: string,
  ): Promise<SurfaceAppRecord | null>;
  /**
   * The agent's `created` agent app, whatever workspace holds it: the
   * events route knows only the agent id in its path.
   */
  findAgentApp(agentId: string): Promise<SurfaceAppRecord | null>;
  /** The agent as its manifest describes it now; null when it is gone. */
  manifestAgent(
    workspaceId: string,
    agentId: string,
  ): Promise<SurfaceAppAgent | null>;
  /** The agent's live app (creating, created or deleting), if any. */
  findForAgent(
    workspaceId: string,
    agentId: string,
  ): Promise<SurfaceAppRecord | null>;
  /**
   * The workspace's `created` link app with its client secret opened, for
   * the server's own code exchange; null when there is none.
   */
  linkAppClient(
    workspaceId: string,
  ): Promise<{ app: SurfaceAppRecord; clientSecret: string } | null>;
  /**
   * The workspace's live agent and link apps, the link app first, then by
   * agent name; `installed` is whether the agent's bot identity is active.
   */
  listMade(workspaceId: string): Promise<MadeSurfaceApp[]>;
  /** The Slack user whose token made the workspace's newest app. */
  lastTokenUser(workspaceId: string): Promise<string | null>;
  beginDelete(input: {
    workspaceId: string;
    slackAppId: string;
    actor: SurfaceAppActor;
  }): Promise<BeginDeleteResult>;
  /** Marks the app deleted and drops its secrets. */
  finishDelete(
    workspaceId: string,
    slackAppId: string,
  ): Promise<SurfaceAppRecord>;
}
