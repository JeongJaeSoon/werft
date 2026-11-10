import type { PermissionMode, RuntimeKind } from "@werft-ai/contracts";
import {
  type CatalogConnectionView,
  connectionOf,
  runtimeKindOfProvider,
} from "../sessions/catalog.ts";
import type { ToolCatalogs } from "../sessions/tool-names.ts";
import type { ReleaseRun } from "./release-ids.ts";

/**
 * The runtime a new release of each kind runs: the version the image's
 * codec pins. A kind absent here is not installed.
 */
export type InstalledRuntimes = Readonly<Partial<Record<RuntimeKind, string>>>;

export type ReleaseRunRefusal = {
  reason_code: "connection_unknown" | "runtime_unsupported" | "tools_unknown";
  message: string;
};

/**
 * What a release on `connectionId` runs apart from its card. The runtime is
 * the one the connection's kind runs on, at the version the image ships; its
 * tools are that runtime's whole built-in catalog, which the workspace's and
 * the agent's rules then narrow. The engine runs `auto` where its classifier
 * works over the connection (an operator said so, or an Anthropic connection
 * nobody judged), and `default` (a person answers) everywhere else.
 */
export function releaseRunOf(
  catalog: {
    connections: Readonly<Record<string, CatalogConnectionView>>;
    tool_catalogs?: ToolCatalogs | undefined;
  },
  runtimes: InstalledRuntimes,
  connectionId: string,
): { ok: true; run: ReleaseRun } | ({ ok: false } & ReleaseRunRefusal) {
  const connection = connectionOf(catalog, connectionId);
  if (connection === undefined) {
    return {
      ok: false,
      reason_code: "connection_unknown",
      message: `Connection ${connectionId} is not enabled in this installation`,
    };
  }
  const kind = runtimeKindOfProvider(connection.provider.kind);
  const version = runtimes[kind];
  if (version === undefined) {
    return {
      ok: false,
      reason_code: "runtime_unsupported",
      message: `Connection ${connectionId} is a ${connection.provider.kind} connection, whose runtime ${kind} this image does not ship`,
    };
  }
  const tools = catalog.tool_catalogs?.for(kind, version);
  if (tools === undefined) {
    return {
      ok: false,
      reason_code: "tools_unknown",
      message: `No built-in tool catalog is installed for ${kind} ${version}`,
    };
  }
  const permission_mode: PermissionMode =
    kind === "claude_agent_sdk" &&
    (connection.auto_mode === "supported" ||
      (connection.auto_mode === "unknown" &&
        connection.provider.kind === "anthropic"))
      ? "auto"
      : "default";
  return {
    ok: true,
    run: {
      connection_id: connectionId,
      connection,
      runtime: { kind, version },
      tools: tools.tools.map((tool) => tool.name),
      permission_mode,
      project_settings: { claude_md: true },
    },
  };
}
