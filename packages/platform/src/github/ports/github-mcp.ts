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
   * The credential that created the session, with the release's agent: who
   * an MCP call acts as. Null when the session recorded none.
   */
  actor: ReceiptActor | null;
};

export interface GitHubMcpStore {
  /** Null when the session pins no agent release. */
  sessionState(sessionId: string): Promise<GitHubMcpSessionState | null>;
  /** The attempt's running turn, read when a push request starts. */
  runningTurn(input: {
    sessionId: string;
    attemptId: string;
  }): Promise<number | null>;
}
