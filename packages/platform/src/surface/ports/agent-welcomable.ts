import type { SurfaceMembership } from "@werft-ai/contracts";

/**
 * What a welcome did. `enqueued` and `duplicate` name the channel that heard
 * (or already had heard) it. The membership states say why nothing was
 * enqueued: a row for a channel the bot is not in would fail for good.
 * `unknown_membership`: the channel was not asked, or did not answer, whether
 * the bot is in the home.
 */
export type WelcomeOutcome =
  | { status: "enqueued" | "duplicate"; channelId: string }
  | {
      status: Exclude<SurfaceMembership["state"], "joined">;
      channelId: string;
      error: string | null;
    }
  | { status: "unknown_membership"; channelId: string }
  | { status: "no_home" | "no_release" | "not_installed" | "rollback" };

/** Tells an agent's home channel that the agent is there. */
export interface AgentWelcomable {
  /** Never throws: a welcome that cannot go is logged and left on the binding. */
  activated(
    workspaceId: string,
    agentId: string,
    releaseId: string,
  ): Promise<WelcomeOutcome | null>;
  /**
   * `ask`: ask the channel (and join) before deciding; otherwise only the
   * stored membership counts, so nothing but the database is read.
   */
  welcome(
    workspaceId: string,
    agentId: string,
    options: { ask: boolean },
  ): Promise<WelcomeOutcome>;
}
