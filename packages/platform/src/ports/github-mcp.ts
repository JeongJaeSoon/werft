import type {
  AgentGitHub,
  GitHubPolicySource,
  ReceiptActor,
} from "@werft-ai/contracts";

/** What the built-in `github` MCP server is judged on, read for every exchange. */
export type GitHubMcpSessionState = {
  ownerId: string;
  agentId: string;
  releaseId: string;
  source: GitHubPolicySource;
  /**
   * `effectiveGitHubPolicy`'s settings. Null when there are none to read,
   * or none this image can: the server then serves nothing.
   */
  github: AgentGitHub | null;
  /** `agents.github_enabled` now. */
  enabled: boolean;
  /**
   * Built-in tools a saved `mcp__github__<tool>` deny blocks, by their short
   * names, from the rows as they are now. All of them when the rules cannot
   * be read. Absent from a store that predates it, which blocks none.
   */
  blockedTools?: readonly string[];
  /**
   * The credential that created the session, with the release's agent: who
   * an MCP call acts as. Null when the session recorded none.
   */
  actor: ReceiptActor | null;
};

/**
 * The saved rules of a session could not be read. Thrown by a store before
 * anything ran, so the caller answers retryably and never as a tool result.
 */
export class SavedRulesUnavailable extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The rules saved for this session could not be read", options);
    this.name = "SavedRulesUnavailable";
  }
}

export interface GitHubMcpStore {
  /** Null when the session pins no agent release. */
  sessionState(sessionId: string): Promise<GitHubMcpSessionState | null>;
  /** The attempt's running turn, read when a push request starts. */
  runningTurn(input: {
    sessionId: string;
    attemptId: string;
  }): Promise<number | null>;
}
