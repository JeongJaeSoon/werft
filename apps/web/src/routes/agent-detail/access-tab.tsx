import type { AgentDetail } from "@werft-ai/contracts";
import type { RefObject } from "react";
import type { Outcome } from "../../components/outcome.tsx";
import { McpSettings } from "./access.tsx";
import { Credentials } from "./credentials.tsx";
import { type Place, type Placed, PlacedOutcome } from "./placement.tsx";

export function AccessTab({
  detail,
  placed,
  outcomeAt,
  unbound,
  credentialsTitle,
}: {
  readonly detail: AgentDetail;
  readonly placed: Placed | null;
  readonly outcomeAt: (at: Place) => (outcome: Outcome | null) => void;
  readonly unbound: readonly string[] | null;
  readonly credentialsTitle: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <>
      <McpSettings
        agentId={detail.agent.id}
        result={<PlacedOutcome placed={placed} at="mcp" />}
        onOutcome={outcomeAt("mcp")}
      />
      <Credentials
        detail={detail}
        missing={unbound ?? []}
        titleRef={credentialsTitle}
        result={<PlacedOutcome placed={placed} at="credentials" />}
        onOutcome={outcomeAt("credentials")}
      />
    </>
  );
}
