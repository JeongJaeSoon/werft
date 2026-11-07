import { useQuery } from "@tanstack/react-query";
import { type ApiClient, type components, unwrap } from "@werft-ai/client";
import { queryKeysOf } from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import type { Translate } from "../../i18n/i18n.tsx";

type Receipt = components["schemas"]["Receipt"];

export const githubKey = (client: ApiClient, agentId: string) =>
  [...queryKeysOf(client).agent(agentId), "github"] as const;

export function useAgentGitHubActivity(agentId: string, enabled = true) {
  const { client } = useWerft();
  return useQuery({
    queryKey: [...githubKey(client, agentId), "activity"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/github/activity", {
          params: { path: { id: agentId } },
        }),
      ),
    retry: false,
    enabled,
  });
}

export function receiptTitle(receipt: Receipt, t: Translate): string {
  const result = (receipt.result ?? {}) as {
    enabled?: boolean;
    change?: string;
  };
  if (receipt.operation === "set_agent_github") {
    if (result.change === "settings") {
      return t("agentGitHub.activity.set_agent_github.settings");
    }
    return t(
      result.enabled
        ? "agentGitHub.activity.set_agent_github.on"
        : "agentGitHub.activity.set_agent_github.off",
    );
  }
  const key = `agentGitHub.activity.${receipt.operation}${
    receipt.status === "failed" ? ".failed" : ""
  }` as const;
  return t(key as Parameters<Translate>[0]);
}
