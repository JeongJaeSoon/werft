import { useState } from "react";

export const AGENT_VIEWS = ["cards", "table"] as const;
export type AgentView = (typeof AGENT_VIEWS)[number];

/** Per user, so two people sharing a browser keep their own choice. */
function agentViewKey(userId: string | undefined) {
  return `ap.agents.view.${userId ?? "anonymous"}`;
}

function isAgentView(value: unknown): value is AgentView {
  return AGENT_VIEWS.includes(value as AgentView);
}

function storedAgentView(userId: string | undefined): AgentView {
  try {
    const stored = globalThis.localStorage?.getItem(agentViewKey(userId));
    if (isAgentView(stored)) return stored;
  } catch {
    // Storage can be blocked; the design's cards are the default.
  }
  return "cards";
}

export function useAgentView(userId: string | undefined) {
  const [view, setView] = useState(() => storedAgentView(userId));
  const choose = (next: AgentView) => {
    setView(next);
    try {
      globalThis.localStorage?.setItem(agentViewKey(userId), next);
    } catch {
      // Storage can be blocked; the choice then lasts for this page only.
    }
  };
  return [view, choose] as const;
}
