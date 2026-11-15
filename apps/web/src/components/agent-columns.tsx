import { Link as RouterLink } from "@tanstack/react-router";
import type { AgentListItem, RuntimeKind } from "@werft-ai/contracts";
import { RUNTIME_KIND_VALUES } from "@werft-ai/core/forms";
import {
  Badge,
  type BadgeProps,
  Code,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";
import { CircleAlert } from "lucide-react";
import { useI18n } from "../i18n/i18n.tsx";
import { GitHubMark, SlackMark } from "./brand-marks.tsx";

/*
 * The agent list's cells. A list without summaries (the agents a person
 * administers) does not know the engine, the channels or the running
 * sessions, and shows a dash for each.
 */

/** A dash to the eye, "없음" to a screen reader. */
export function Dash() {
  const { t } = useI18n();
  return (
    <span className="text-subtle-foreground">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{t("agent.panel.none")}</span>
    </span>
  );
}

/** One line, cut with an ellipsis; the whole slug is in the title. */
export function AgentSlug({ slug }: { readonly slug: string }) {
  const { t } = useI18n();
  return (
    <Code title={slug} className="min-w-0 truncate text-muted-foreground">
      <span className="sr-only">{t("agents.slug")} </span>
      {slug}
    </Code>
  );
}

// The runtime kind is data (G2): its values come from the contract, and the
// engine's brand name reads the same in every locale.
const [claudeRuntime, codexRuntime, piRuntime] = RUNTIME_KIND_VALUES;
const ENGINE = {
  [claudeRuntime]: { label: "Claude", variant: "amber" },
  [codexRuntime]: { label: "Codex", variant: "teal" },
  [piRuntime]: { label: "Pi", variant: "gray" },
} as const satisfies Record<
  RuntimeKind,
  { label: string; variant: BadgeProps["variant"] }
>;

export function AgentEngine({ agent }: { readonly agent: AgentListItem }) {
  const engine = agent.summary?.engine;
  if (!engine) return <Dash />;
  return (
    <Badge variant={ENGINE[engine].variant} data-engine={engine}>
      {ENGINE[engine].label}
    </Badge>
  );
}

export function AgentChannels({ agent }: { readonly agent: AgentListItem }) {
  const { t } = useI18n();
  const channels = agent.summary?.channels ?? [];
  if (channels.length === 0) return <Dash />;
  return channels.map((channel) => {
    const Mark = channel === "slack" ? SlackMark : GitHubMark;
    const label = t(`agents.channel.${channel}`);
    return (
      <span
        key={channel}
        role="img"
        aria-label={label}
        title={label}
        data-channel={channel}
        className="inline-flex"
      >
        <Mark className="size-4" />
      </span>
    );
  });
}

export function AgentRunning({ agent }: { readonly agent: AgentListItem }) {
  const running = agent.summary?.running_count ?? 0;
  return running > 0 ? running : <Dash />;
}

/**
 * A warning mark while the agent's Slack tab asks something of a person.
 * The mark is the link to that tab, so the one Tab stop both opens the
 * reason (on focus) and leads to the fix; a link inside the note itself
 * would be out of a keyboard's reach. Above the row's stretched name link.
 */
export function SlackActionMark({ agent }: { readonly agent: AgentListItem }) {
  const { t } = useI18n();
  const action = agent.summary?.slack_action;
  if (!action) return null;
  const label = t("agents.slackAction", {
    reason: t(`agents.slackAction.${action}`),
  });
  return (
    <Tooltip>
      <TooltipTrigger asChild={true}>
        <RouterLink
          to="/agents/$id"
          params={{ id: agent.id }}
          search={{ tab: "slack" }}
          aria-label={t("agents.slackActionShort")}
          data-slot="slack-action"
          data-action={action}
          className="relative z-1 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-(color:--werft-tone-caution-fg) hover:bg-hover"
        >
          <CircleAlert aria-hidden="true" className="size-4" />
        </RouterLink>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
