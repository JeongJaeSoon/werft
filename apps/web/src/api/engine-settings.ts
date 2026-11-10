import { queryOptions } from "@tanstack/react-query";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type { EngineRules } from "../components/engine-settings-lists.ts";
import { queryKeysOf } from "./queries.ts";

export const workspaceEngineSettingsKey = (
  client: ApiClient,
  workspaceId: string,
) => [queryKeysOf(client).members[0], "engine-settings", workspaceId] as const;

export const agentEngineSettingsKey = (client: ApiClient, agentId: string) =>
  [...queryKeysOf(client).agent(agentId), "engine-settings"] as const;

export function workspaceEngineSettingsQuery(
  client: ApiClient,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: workspaceEngineSettingsKey(client, workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/engine-settings", {
          params: { path: { id: workspaceId } },
        }),
      ),
    retry: false,
  });
}

export function agentEngineSettingsQuery(client: ApiClient, agentId: string) {
  return queryOptions({
    queryKey: agentEngineSettingsKey(client, agentId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/engine-settings", {
          params: { path: { id: agentId } },
        }),
      ),
    retry: false,
  });
}

export const putWorkspaceEngineSettings = (
  client: ApiClient,
  workspaceId: string,
  body: PutBody,
) =>
  unwrap(
    client.PUT("/v1/workspaces/{id}/engine-settings", {
      params: { path: { id: workspaceId } },
      body,
    }),
  );

export const putAgentEngineSettings = (
  client: ApiClient,
  agentId: string,
  body: PutBody,
) =>
  unwrap(
    client.PUT("/v1/agents/{id}/engine-settings", {
      params: { path: { id: agentId } },
      body,
    }),
  );

interface PutBody {
  readonly expected_revision: number | null;
  readonly settings: EngineRules;
}

/** What a refused save tells the form: a reason code and the rule it is about. */
export function refusalOf(error: ApiError): {
  readonly code: string | null;
  readonly rule: string | null;
} {
  const details = (error.details ?? {}) as {
    reason_code?: unknown;
    rule?: unknown;
  };
  return {
    code: typeof details.reason_code === "string" ? details.reason_code : null,
    rule:
      typeof details.rule === "string" && details.rule !== ""
        ? details.rule
        : null,
  };
}
