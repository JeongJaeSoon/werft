import type { AgentDetail } from "@werft-ai/contracts";
import type { ReactNode } from "react";
import {
  AgentGlance,
  AgentReadiness,
  AgentRecentSessions,
} from "./overview.tsx";

export function OverviewTab({
  detail,
  toRelease,
}: {
  readonly detail: AgentDetail;
  readonly toRelease: ReactNode;
}) {
  return (
    <>
      <AgentGlance detail={detail} />
      <AgentReadiness detail={detail} toRelease={toRelease} />
      <AgentRecentSessions agentId={detail.agent.id} />
    </>
  );
}
