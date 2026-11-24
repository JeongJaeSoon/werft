import type { Agent, AgentListItem } from "@werft-ai/contracts";
import {
  Badge,
  type BadgeProps,
  type StatusDotStatus,
  StatusText,
} from "@werft-ai/ui";
import { useI18n } from "../i18n/i18n.tsx";

type AgentState = "draft" | Agent["status"];
type AgentSummary = Pick<Agent, "status" | "active_release_id">;
type ListedAgent = Pick<AgentListItem, "status" | "activation">;

/** An agent never released is a draft, whatever its status; archived wins. */
export function agentState(agent: AgentSummary): AgentState {
  if (agent.status === "archived") return "archived";
  return agent.active_release_id === null ? "draft" : agent.status;
}

/**
 * As the list says it: `status` stays `active` on a draft, `activation`
 * does not. Only `activation: "active"` is switched on; a value this build
 * does not know shows as paused when `status` would say active.
 */
export function listedAgentState(agent: ListedAgent): AgentState {
  if (agent.activation === "active") return "active";
  if (agent.activation === "draft") return "draft";
  return agent.status === "active" ? "paused" : agent.status;
}

const STATE_VARIANT = {
  draft: "blue",
  active: "green",
  paused: "amber",
  archived: "gray",
} as const satisfies Record<AgentState, BadgeProps["variant"]>;

const STATE_LABEL = {
  draft: "agents.state.draft",
  active: "agents.state.released",
  paused: "agents.status.paused",
  archived: "agents.status.archived",
} as const;

export function AgentStateBadge({ agent }: { readonly agent: AgentSummary }) {
  const { t } = useI18n();
  const state = agentState(agent);
  return (
    <Badge
      variant={STATE_VARIANT[state]}
      data-state={state}
      className={state === "archived" ? "text-muted-foreground" : undefined}
    >
      {t(STATE_LABEL[state])}
    </Badge>
  );
}

const STATE_DOT = {
  draft: "idle",
  active: "done",
  paused: "idle",
  archived: "idle",
} as const satisfies Record<AgentState, StatusDotStatus>;

const STATE_TEXT = {
  draft: "agents.state.draft",
  active: "agents.status.active",
  paused: "agents.status.paused",
  archived: "agents.status.archived",
} as const;

/** The agent list's state: a dot and a word, "● 활성". */
export function AgentStateText({ agent }: { readonly agent: ListedAgent }) {
  const { t } = useI18n();
  const state = listedAgentState(agent);
  return (
    <StatusText status={STATE_DOT[state]} data-state={state}>
      {t(STATE_TEXT[state])}
    </StatusText>
  );
}
