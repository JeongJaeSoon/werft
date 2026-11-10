import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Agent } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  buttonVariants,
  Page,
  Section,
} from "@werft-ai/ui";
import { ArrowLeft } from "lucide-react";
import { agentSummariesQuery } from "../../api/queries.ts";
import { AgentAvatar } from "../../components/agent-cards.tsx";
import { AgentStateBadge } from "../../components/agent-state.tsx";
import { LoadFailure } from "../../components/load-failure.tsx";
import { ManagingTeamName } from "../../components/managing-team.tsx";
import { SECTION_BODY } from "../../components/section-body.ts";
import { StatusScreen } from "../../components/status-screen.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import {
  NewSessionButton,
  NewSessionReason,
  useOutsiderNewSessionReason,
} from "./new-session.tsx";

export function AgentNotFound() {
  const { t } = useI18n();
  return (
    <Page
      title={t("agent.notFound.title")}
      description={t("agent.notFound.body")}
    >
      <Link
        className={buttonVariants({
          variant: "outline",
          className: "self-start",
        })}
        to="/agents"
      >
        {t("agent.notFound.back")}
      </Link>
    </Page>
  );
}

/** What a 403 leaves a person who is not on the agent. */
export function OutsideAgent({ id }: { readonly id: string }) {
  const { client } = useWerft();
  const rows = useQuery(agentSummariesQuery(client, [id]));
  if (rows.isPending) return <StatusScreen kind="loading" />;
  if (rows.error)
    return (
      <LoadFailure error={rows.error} onRetry={() => void rows.refetch()} />
    );
  const agent = rows.data.items.find((item) => item.id === id);
  return agent ? <OutsideAgentView agent={agent} /> : <AgentNotFound />;
}

function OutsideAgentView({ agent }: { readonly agent: Agent }) {
  const { t } = useI18n();
  const newSessionReason = useOutsiderNewSessionReason(agent);
  return (
    <Page
      title={
        <span className="flex min-w-0 items-center gap-3">
          <AgentAvatar name={agent.name} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{agent.name}</span>
        </span>
      }
      titleAside={<AgentStateBadge agent={agent} />}
      description={
        agent.description ? (
          <span className="[overflow-wrap:anywhere]">{agent.description}</span>
        ) : undefined
      }
      actions={
        <div className="flex flex-1 flex-wrap items-start gap-2">
          <NewSessionButton
            releaseId={agent.active_release_id}
            reason={newSessionReason}
          />
          <Link
            to="/agents"
            className={buttonVariants({
              variant: "outline",
              className: "ms-auto",
            })}
          >
            <ArrowLeft strokeWidth={1.5} aria-hidden="true" />
            {t("agent.back")}
          </Link>
        </div>
      }
    >
      <NewSessionReason reason={newSessionReason} />
      <Section title={t("managingTeam.title")}>
        <div className={SECTION_BODY}>
          <div>
            <ManagingTeamName agent={agent} />
          </div>
          <Alert>
            <AlertDescription>{t("agent.outsider.body")}</AlertDescription>
          </Alert>
        </div>
      </Section>
    </Page>
  );
}
