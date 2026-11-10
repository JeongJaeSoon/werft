import { Link as RouterLink } from "@tanstack/react-router";
import type { AgentListItem } from "@werft-ai/contracts";
import { cn, linkVariants } from "@werft-ai/ui";
import { ArrowRight } from "lucide-react";
import { useI18n } from "../i18n/i18n.tsx";

/**
 * The agent's Slack tab, on a card or row only while that tab asks
 * something of a person. Above the row's stretched name link.
 */
export function SlackActionLink({ agent }: { readonly agent: AgentListItem }) {
  const { t } = useI18n();
  const action = agent.summary?.slack_action;
  if (!action) return null;
  return (
    <RouterLink
      to="/agents/$id"
      params={{ id: agent.id }}
      search={{ tab: "settings", section: "slack" }}
      className={cn(
        linkVariants(),
        "relative z-1 inline-flex w-fit items-center gap-1 text-caption",
      )}
    >
      {t("agents.slackAction", {
        reason: t(`agents.slackAction.${action}`),
      })}
      <ArrowRight aria-hidden="true" className="size-3.5 shrink-0" />
    </RouterLink>
  );
}
