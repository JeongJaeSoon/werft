import { queryOptions } from "@tanstack/react-query";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type { AgentMcpResponse } from "@werft-ai/contracts";
import {
  credentialRefSchema,
  isMcpToolName,
  mcpToolOfServer,
} from "@werft-ai/core/forms";
import { queryKeysOf } from "../../api/queries.ts";
import type { MessageKey } from "../../i18n/i18n.tsx";

export const mcpSettingsKey = (client: ApiClient, agentId: string) =>
  [...queryKeysOf(client).agent(agentId), "mcp-settings"] as const;

export function mcpSettingsQuery(client: ApiClient, agentId: string) {
  return queryOptions({
    queryKey: mcpSettingsKey(client, agentId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/mcp/settings", {
          params: { path: { id: agentId } },
        }),
      ),
    retry: false,
  });
}

export interface McpEdit {
  readonly server: string | null;
  readonly tools: readonly string[];
  readonly refs: readonly string[];
}

export const CREDENTIAL_REFS_MAX = 32;

export const editOf = (data: AgentMcpResponse): McpEdit => ({
  server: data.settings.server,
  tools: data.settings.allowed_tools,
  refs: data.settings.credential_refs,
});

const sorted = (names: readonly string[]) => [...names].sort();

export function sameEdit(a: McpEdit, b: McpEdit): boolean {
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length &&
    sorted(x).every((name, at) => name === sorted(y)[at]);
  return (
    a.server === b.server && same(a.tools, b.tools) && same(a.refs, b.refs)
  );
}

export function withServer(edit: McpEdit, server: string | null): McpEdit {
  return server === edit.server ? edit : { ...edit, server, tools: [] };
}

export type Added =
  | { readonly edit: McpEdit }
  | { readonly error: MessageKey; readonly vars?: Record<string, string> };

export function addTool(edit: McpEdit, raw: string): Added {
  const name = raw.trim();
  if (!isMcpToolName(name)) return { error: "agentAccess.toolInvalid" };
  if (edit.server === null || !mcpToolOfServer(name, edit.server)) {
    return {
      error: "agentAccess.toolOutside",
      vars: { server: edit.server ?? "" },
    };
  }
  if (edit.tools.includes(name)) return { error: "agentAccess.toolDuplicate" };
  return { edit: { ...edit, tools: [...edit.tools, name] } };
}

export function addRef(edit: McpEdit, raw: string): Added {
  const name = raw.trim();
  if (!credentialRefSchema.safeParse(name).success) {
    return { error: "agentAccess.credInvalid" };
  }
  if (edit.refs.includes(name)) return { error: "agentAccess.credDuplicate" };
  if (edit.refs.length >= CREDENTIAL_REFS_MAX) {
    return { error: "agentAccess.credFull" };
  }
  return { edit: { ...edit, refs: [...edit.refs, name] } };
}

const REFUSALS = [
  "server_unknown",
  "server_builtin",
  "server_required",
  "tool_outside_server",
  "server_credential_missing",
  "mcp_tool_denied",
  "duplicate",
] as const;

export function refusalKey(error: ApiError): MessageKey {
  const reason = (error.details as { reason_code?: unknown } | null)
    ?.reason_code;
  const known = REFUSALS.find((code) => code === reason);
  return known
    ? (`agentAccess.refused.${known}` as const)
    : "agentAccess.refused.other";
}

export function saveBody(edit: McpEdit, revision: number | null) {
  return {
    expected_revision: revision,
    settings: {
      server: edit.server,
      allowed_tools: sorted(edit.tools),
      credential_refs: sorted(edit.refs),
    },
  };
}
