import type { Agent } from "@werft-ai/contracts";
import { Badge, type BadgeProps } from "@werft-ai/ui";
import { useI18n } from "../i18n/i18n.tsx";

type AgentState = "draft" | Agent["status"];
type AgentSummary = Pick<Agent, "status" | "active_release_id">;

/** An agent never released is a draft, whatever its status; archived wins. */
export function agentState(agent: AgentSummary): AgentState {
  if (agent.status === "archived") return "archived";
  return agent.active_release_id === null ? "draft" : agent.status;
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

/**
 * The state as a word: a released agent gets a green dot (the word stays for
 * screen readers), every other state is written out.
 */
export function AgentStateText({ agent }: { readonly agent: AgentSummary }) {
  const { t } = useI18n();
  const state = agentState(agent);
  return (
    <span
      data-state={state}
      className="inline-flex items-center gap-1.5 text-control"
    >
      {state === "active" ? (
        <>
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-[var(--werft-tone-success-fg)]"
          />
          <span className="sr-only">{t(STATE_LABEL[state])}</span>
        </>
      ) : (
        <span className="text-muted-foreground">{t(STATE_LABEL[state])}</span>
      )}
    </span>
  );
}

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
