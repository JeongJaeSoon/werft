import type { Agent } from "@werft-ai/contracts";
import type { ReactNode } from "react";
import { AgentAdmins } from "../../components/agent-admins.tsx";
import { ManagingTeam } from "../../components/managing-team.tsx";
import type { Outcome } from "../../components/outcome.tsx";
import { useToast } from "../../components/toast.tsx";
import { useI18n } from "../../i18n/i18n.tsx";

/**
 * The admins tab says a done change in one toast shared by both sections,
 * and keeps the page for a refusal. Its own component, so the toast timer
 * does not redraw the whole detail.
 */
export function AdminsTab({
  agent,
  manages,
  onOutcome,
  result,
}: {
  readonly agent: Agent;
  readonly manages: boolean;
  readonly onOutcome: (outcome: Outcome | null) => void;
  readonly result: ReactNode;
}) {
  const { t } = useI18n();
  const { notify, toast } = useToast(t("common.dismiss"));
  return (
    <>
      <ManagingTeam
        agent={agent}
        manages={manages}
        notify={notify}
        onOutcome={onOutcome}
      />
      <AgentAdmins
        agentId={agent.id}
        managingTeamId={agent.managing_team_id}
        notify={notify}
        onOutcome={onOutcome}
      />
      {result}
      {toast}
    </>
  );
}
