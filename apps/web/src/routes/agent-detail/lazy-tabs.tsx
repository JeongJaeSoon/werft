import { lazyRouteComponent } from "@tanstack/react-router";
import type { Agent, AgentDetail } from "@werft-ai/contracts";
import { Skeleton } from "@werft-ai/ui";
import { Suspense } from "react";

const SlackTab = lazyRouteComponent(() => import("./slack.tsx"));
const GitHubTab = lazyRouteComponent(() => import("./github.tsx"));

const LOADING = <Skeleton shape="block" height="24rem" decorative />;

/** Loaded on first open, then kept mounted so leaving the tab keeps a draft. */
export function SlackPanel({
  agent,
  mounted,
}: {
  readonly agent: Agent;
  readonly mounted: boolean;
}) {
  if (!mounted) return null;
  return (
    <Suspense fallback={LOADING}>
      <SlackTab
        agentId={agent.id}
        slug={agent.slug}
        name={agent.name}
        active={agent.active_release_id !== null}
      />
    </Suspense>
  );
}

export function GitHubPanel({
  detail,
  mounted,
}: {
  readonly detail: AgentDetail;
  readonly mounted: boolean;
}) {
  if (!mounted) return null;
  return (
    <Suspense fallback={LOADING}>
      <GitHubTab detail={detail} />
    </Suspense>
  );
}
