import {
  type AgentMcpResponse,
  type AgentMcpSettings,
  GITHUB_MCP_SERVER,
  mcpToolOfServer,
  type PutAgentMcpSettingsRequest,
  type PutAgentMcpSettingsResponse,
} from "@werft-ai/contracts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "../musterrolle/policy.ts";
import {
  ACTOR_INACTIVE,
  NOT_FOUND,
  OUTRANKED,
} from "../musterrolle/service-errors.ts";
import type { AgentMcpStore } from "../ports/agent-mcp-store.ts";
import type { SessionCatalog } from "../sessions/catalog.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import { mcpValuesOfCard } from "./mcp-release-values.ts";

const refused = (field: string, reason: string) =>
  new SessionServiceError("BAD_REQUEST", `${field}: ${reason}`, undefined, {
    field,
    reason_code: reason,
  });

/** The names once each, in the order the row stores them. */
const sortedUnique = (names: readonly string[]) => [...new Set(names)].sort();

/**
 * The agent's MCP tab: the server it calls, the tools it may call and the
 * credential names it needs. Saved apart from the card, so it makes no
 * release; a change that narrows reaches running sessions, a change that
 * widens only the next session. Whoever manages the agent reads it; it is
 * saved from a signed-in console session, so `updated_by` is always a person.
 */
export function createAgentMcpService(deps: {
  authorization: AuthorizationPolicy;
  store: AgentMcpStore;
  catalog: Pick<SessionCatalog, "mcp_servers">;
}) {
  const { authorization, store, catalog } = deps;
  const server = (id: string) =>
    Object.hasOwn(catalog.mcp_servers ?? {}, id)
      ? catalog.mcp_servers?.[id]
      : undefined;
  const target = (agentId: string) => ({ kind: "agent", id: agentId }) as const;

  return {
    async get(caller: Caller, agentId: string): Promise<AgentMcpResponse> {
      await requirePermitted(
        authorization,
        caller,
        "agent.settings_read",
        target(agentId),
      );
      const workspaceId = caller.ownerId;
      const [agent, row] = await Promise.all([
        store.agent(workspaceId, agentId),
        store.row(agentId),
      ]);
      if (agent === null) throw NOT_FOUND();
      const release = agent.activeRelease;
      // No row: what a session of the active release does now.
      const fromRelease =
        release === null
          ? null
          : mcpValuesOfCard(release.card, release.policyPins);
      const settings: AgentMcpSettings =
        row !== null
          ? {
              server: row.server,
              allowed_tools: row.allowedTools,
              credential_refs: row.credentialRefs,
            }
          : {
              server: fromRelease?.server ?? null,
              allowed_tools: fromRelease?.allowedTools ?? [],
              credential_refs: fromRelease?.credentialRefs ?? [],
            };
      return {
        source: row !== null ? "agent" : "release",
        settings,
        settings_revision: row?.revision ?? null,
        active_release_id: release?.id ?? null,
        bound_credential_refs: await store.boundRefs(
          workspaceId,
          agentId,
          settings.credential_refs,
        ),
        // The catalog is installation-wide, so a server another workspace
        // alone may use is left out, as `put` refuses it.
        available_servers: Object.entries(catalog.mcp_servers ?? {})
          .filter(
            ([id, entry]) =>
              id !== GITHUB_MCP_SERVER &&
              entry.workspaces.includes(agent.workspaceSlug),
          )
          .map(([id]) => id)
          .sort(),
      };
    },

    /**
     * Replaces the agent's whole settings row. Only a server the save adds is
     * judged against the catalog, so a server the operator has since removed
     * can still be narrowed and cleared; the rules between fields hold for
     * the whole request.
     */
    async put(
      caller: Caller,
      agentId: string,
      request: PutAgentMcpSettingsRequest,
    ): Promise<PutAgentMcpSettingsResponse> {
      await requirePermitted(
        authorization,
        caller,
        "agent.manage",
        target(agentId),
      );
      const userId = caller.actor?.userId;
      if (
        caller.subject.surface.kind !== "web" ||
        caller.subject.principal?.kind !== "user" ||
        !userId
      ) {
        throw new SessionServiceError(
          "FORBIDDEN",
          "An agent's MCP settings are saved from a signed-in console session, not with an API key",
          undefined,
          { reason_code: "web_session_required" },
        );
      }
      const given = request.settings;
      const duplicate = (field: string, names: readonly string[]) => {
        const index = names.findIndex((name, at) => names.indexOf(name) !== at);
        if (index >= 0) throw refused(`${field}.${index}`, "duplicate");
      };
      duplicate("settings.allowed_tools", given.allowed_tools);
      duplicate("settings.credential_refs", given.credential_refs);
      if (given.server === null && given.allowed_tools.length > 0) {
        throw refused("settings.allowed_tools", "server_required");
      }
      if (given.server === GITHUB_MCP_SERVER) {
        throw refused("settings.server", "server_builtin");
      }
      const settings: AgentMcpSettings = {
        server: given.server,
        allowed_tools: sortedUnique(given.allowed_tools),
        credential_refs: sortedUnique(given.credential_refs),
      };
      const workspaceId = caller.ownerId;
      const agent = await store.agent(workspaceId, agentId);
      if (agent === null) throw NOT_FOUND();
      const result = await store.put({
        workspaceId,
        agentId,
        expectedRevision: request.expected_revision,
        settings,
        userId,
        principal: caller,
        managerRoles: MANAGEMENT_ROLES["agent.manage"] ?? [],
        check: (current, releaseServer, releaseMcpDeny) => {
          if (settings.server === null) return;
          // Only what this save adds is judged: a tool the row already holds
          // can still be narrowed away, whatever the profile blocks since.
          // This runs before the server checks, which return early.
          const already =
            current !== null && current.server === settings.server
              ? new Set(current.allowedTools)
              : new Set<string>();
          const blocked = new Set(releaseMcpDeny);
          given.allowed_tools.forEach((tool, at) => {
            if (already.has(tool)) return;
            if (!mcpToolOfServer(tool, settings.server ?? "")) {
              throw refused(
                `settings.allowed_tools.${at}`,
                "tool_outside_server",
              );
            }
            if (blocked.has(tool)) {
              throw refused(`settings.allowed_tools.${at}`, "mcp_tool_denied");
            }
          });
          const entry = server(settings.server);
          // What the agent has now: its row, or its release while it has none.
          // Both come from under the agent's lock, not from the read above.
          const held = current === null ? releaseServer : current.server;
          if (entry === undefined) {
            if (settings.server === held) return;
            throw refused("settings.server", "server_unknown");
          }
          // The catalog is installation-wide; a server another workspace
          // alone may use is as good as absent for this one.
          if (
            settings.server !== held &&
            !entry.workspaces.includes(agent.workspaceSlug)
          ) {
            throw refused("settings.server", "server_unknown");
          }
          if (!settings.credential_refs.includes(entry.credential_ref)) {
            throw refused(
              "settings.credential_refs",
              "server_credential_missing",
            );
          }
        },
      });
      switch (result.outcome) {
        case "saved":
          return {
            settings_revision: result.revision,
            receipt_id: result.receiptId,
          };
        case "conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            `The MCP settings are at revision ${result.revision ?? "none"}, not ${request.expected_revision ?? "none"}`,
          );
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },
  };
}

export type AgentMcpService = ReturnType<typeof createAgentMcpService>;
