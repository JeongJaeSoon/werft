import type { AgentDetail } from "@werft-ai/contracts";
import { AgentGlance, AgentRecentSessions } from "./overview.tsx";
import { ProfileFollow } from "./profile-follow.tsx";

export function OverviewTab({
  detail,
  manages,
}: {
  readonly detail: AgentDetail;
  readonly manages: boolean;
}) {
  return (
    <>
      <AgentGlance detail={detail} />
      <ProfileFollow detail={detail} manages={manages} />
      <AgentRecentSessions agentId={detail.agent.id} />
    </>
  );
}
