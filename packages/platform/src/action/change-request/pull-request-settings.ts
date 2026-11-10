import type {
  AgentPullRequestSettings,
  PullRequestSettings,
} from "@werft-ai/contracts";

export type ResolvedPullRequestSettings = {
  sessionLink: "url" | "id";
  readRepository: boolean;
  templateName: string | null;
  /**
   * The template the settings supply: used where the repository has none
   * (`repository_first`), or in its place (`override`). Null: the platform's
   * default. `layer` names whose it is, for the receipt.
   */
  text: { layer: "agent" | "workspace"; template: string } | null;
};

export function resolvePullRequestSettings(
  workspace: PullRequestSettings,
  agent: AgentPullRequestSettings | null,
): ResolvedPullRequestSettings {
  const formatting =
    agent === null || agent.formatting === "inherit"
      ? workspace.formatting
      : agent.formatting;
  const sessionLink = workspace.session_link;
  if (formatting === "off") {
    return {
      sessionLink,
      readRepository: false,
      templateName: null,
      text: null,
    };
  }
  const text =
    agent?.template != null
      ? { layer: "agent" as const, template: agent.template }
      : workspace.default_template !== null
        ? { layer: "workspace" as const, template: workspace.default_template }
        : null;
  return {
    sessionLink,
    readRepository: workspace.template_mode === "repository_first",
    templateName: agent?.template_name ?? null,
    text,
  };
}
