import type { AgentDetail } from "@werft-ai/contracts";
import type { ReactNode } from "react";
import { AgentGlance, AgentReadiness } from "./overview.tsx";
import { ProfileFollow } from "./profile-follow.tsx";

export function OverviewTab({
  detail,
  manages,
  toRelease,
}: {
  readonly detail: AgentDetail;
  readonly manages: boolean;
  readonly toRelease: ReactNode;
}) {
  return (
    <>
      <AgentGlance detail={detail} />
      <ProfileFollow detail={detail} manages={manages} />
      <AgentReadiness detail={detail} toRelease={toRelease} />
    </>
  );
}
