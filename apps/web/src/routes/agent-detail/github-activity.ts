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

const namesOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string")
    : [];

export function mcpChange(
  receipt: Receipt,
  t: Translate,
): { readonly before: string | null; readonly after: string } {
  const result = (receipt.result ?? {}) as {
    before?: unknown;
    after?: unknown;
  };
  const none = t("agentAccess.activity.none");
  const summary = (side: unknown): string => {
    const values = (side ?? {}) as {
      server?: unknown;
      allowed_tools?: unknown;
      credential_refs?: unknown;
    };
    const join = (names: string[]) =>
      names.length > 0 ? names.join(", ") : none;
    return t("agentAccess.activity.summary", {
      server: typeof values.server === "string" ? values.server : none,
      tools: join(namesOf(values.allowed_tools)),
      refs: join(namesOf(values.credential_refs)),
    });
  };
  return {
    before:
      result.before === null || result.before === undefined
        ? null
        : summary(result.before),
    after: summary(result.after),
  };
}

export function receiptTitle(receipt: Receipt, t: Translate): string {
  if (receipt.operation === "set_agent_mcp") {
    return t("agentAccess.activity.mcp");
  }
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
