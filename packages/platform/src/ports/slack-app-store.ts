import type {
  GetSlackAppResponse,
  SlackAppKind,
  SlackAppSecretPurpose,
  SlackAppSettings,
  SlackAppState,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/policy.ts";
import type { SecretSummary } from "./secret-store.ts";

/** What Slack answers to `apps.manifest.create`; the secrets are stored, never shown. */
export type CreatedSlackApp = {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
};

export type SlackAppRecord = {
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

/** What the manifest says about the agent, read with its active release. */
export type SlackAppAgent = {
  id: string;
  name: string;
  slug: string;
  /** The active release card's role, else the agent's description; may be empty. */
  role: string;
};

export type MadeSlackApp = {
  app: SlackAppRecord;
  agent: { id: string; name: string; slug: string; installed: boolean } | null;
};

/**
 * A person acting through the console, whose right is read again under
 * lock; null for the operator's CLI, which holds the database itself.
 */
export type SlackAppActor = {
  principal: Principal;
  managerRoles: readonly WorkspaceRole[];
} | null;

export type BeginAgentAppResult =
  | { outcome: "begun"; app: SlackAppRecord; agent: SlackAppAgent }
  | { outcome: "exists"; app: SlackAppRecord }
  /** `uncertain`: begun before `staleBefore`, so its answer was lost. */
  | { outcome: "creating"; app: SlackAppRecord; uncertain: boolean }
  | {
      outcome:
        | "agent_not_found"
        | "agent_not_active"
        | "actor_inactive"
        | "outranked";
    };

/** As for an agent's app; the name is what the link app is called after. */
export type BeginLinkAppResult =
  | { outcome: "begun"; app: SlackAppRecord; workspaceName: string }
  | { outcome: "exists"; app: SlackAppRecord }
  | { outcome: "creating"; app: SlackAppRecord; uncertain: boolean }
  | { outcome: "workspace_not_found" | "actor_inactive" | "outranked" };

/**
 * `begun`: the app is now `deleting` and Slack must be asked. `settled`:
 * no Slack app to delete (it failed, was abandoned or is gone already).
 */
export type BeginDeleteResult =
  | { outcome: "begun" | "settled" | "creating"; app: SlackAppRecord }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

/**
 * The workspace's Slack apps. A creation is two writes around the Slack
 * call: `beginAgentApp` records `creating`, `finishCreate` records what
 * Slack answered and seals the app's secrets in the same transaction.
 */
export type SlackEventsCheck = Omit<GetSlackAppResponse["events"], "url">;

export interface SlackAppStore {
  setEvents(
    workspaceId: string,
    slackAppId: string,
    events: SlackEventsCheck,
  ): Promise<void>;
  /**
   * Records `url` as sent to Slack: `pending` again unless the app is
   * already `verified` for that same URL.
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
    events: SlackEventsCheck,
  ): Promise<void>;
  getSettings(
    workspaceId: string,
    agentId: string,
  ): Promise<SlackAppSettings | null>;
  putSettings(input: {
    workspaceId: string;
    agentId: string;
    actor: SlackAppActor;
    settings: SlackAppSettings;
  }): Promise<"saved" | "not_found" | "actor_inactive" | "outranked">;
  beginAgentApp(input: {
    workspaceId: string;
    agentId: string;
    actor: SlackAppActor;
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
    actor: SlackAppActor;
    redirectUrl: string;
    newId: string;
    staleBefore: Date;
    replaceUncertain: boolean;
  }): Promise<BeginLinkAppResult>;
  finishCreate(input: {
    workspaceId: string;
    slackAppId: string;
    created: CreatedSlackApp;
    tokenUserId: string;
  }): Promise<SlackAppRecord>;
  /**
   * Seals the bot token an install returned under the app, replacing an
   * earlier one, and sets `bot_token_ref`. Null when the app is no longer
   * `created`.
   */
  storeBotToken(input: {
    workspaceId: string;
    slackAppId: string;
    botToken: string;
  }): Promise<SlackAppRecord | null>;
  /** Slack refused the creation: no app exists. */
  failCreate(workspaceId: string, slackAppId: string): Promise<void>;
  find(workspaceId: string, slackAppId: string): Promise<SlackAppRecord | null>;
  /**
   * The agent's `created` agent app, whatever workspace holds it: the
   * events route knows only the agent id in its path.
   */
  findAgentApp(agentId: string): Promise<SlackAppRecord | null>;
  /** The agent as its manifest describes it now; null when it is gone. */
  manifestAgent(
    workspaceId: string,
    agentId: string,
  ): Promise<SlackAppAgent | null>;
  /** The agent's live app (creating, created or deleting), if any. */
  findForAgent(
    workspaceId: string,
    agentId: string,
  ): Promise<SlackAppRecord | null>;
  /**
   * The workspace's `created` link app with its client secret opened, for
   * the server's own code exchange; null when there is none.
   */
  linkAppClient(
    workspaceId: string,
  ): Promise<{ app: SlackAppRecord; clientSecret: string } | null>;
  /**
   * The workspace's live agent and link apps, the link app first, then by
   * agent name; `installed` is whether the agent's bot identity is active.
   */
  listMade(workspaceId: string): Promise<MadeSlackApp[]>;
  /** The Slack user whose token made the workspace's newest app. */
  lastTokenUser(workspaceId: string): Promise<string | null>;
  beginDelete(input: {
    workspaceId: string;
    slackAppId: string;
    actor: SlackAppActor;
  }): Promise<BeginDeleteResult>;
  /** Marks the app deleted and drops its secrets. */
  finishDelete(
    workspaceId: string,
    slackAppId: string,
  ): Promise<SlackAppRecord>;
}
