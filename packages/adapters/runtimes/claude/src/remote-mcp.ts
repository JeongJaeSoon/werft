import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  GetPromptRequestSchema,
  InitializeRequestSchema,
  type InitializeResult,
  LATEST_PROTOCOL_VERSION,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { messageOf, withinHandshakeWait } from "@werft-ai/runtime-core";

const CALL_TIMEOUT_MS = 30 * 60_000;
const MAX_LIST_PAGES = 50;

const listedDescriptions = new WeakMap<McpServer, Map<string, string>>();

/**
 * The descriptions the relays among `servers` were last given for their
 * pinned tools, by engine name. The engine passes them on nowhere: its init
 * and `mcpServerStatus()` carry tool names only.
 */
export function relayedToolDescriptions(
  servers: Record<string, unknown> | undefined,
): ReadonlyMap<string, string> {
  const descriptions = new Map<string, string>();
  for (const server of Object.values(servers ?? {})) {
    const instance = (server as { instance?: unknown } | null)?.instance;
    if (!(instance instanceof McpServer)) continue;
    for (const entry of listedDescriptions.get(instance) ?? []) {
      descriptions.set(...entry);
    }
  }
  return descriptions;
}

export type RemoteMcpServer = {
  /** The registry name: the engine names its tools `mcp__<name>__<tool>`. */
  name: string;
  /** The egress proxy's route for this server. */
  url: string;
  /** The attempt's egress token for that route. */
  token: string;
  /** The `mcp__<name>__<tool>` names the run exposes. */
  tools: readonly string[];
  /**
   * The platform's own server: the engine also gets what the server says of
   * itself (its instructions) and its resources and prompts. A remote server
   * an administrator named gives the engine its pinned tools and nothing else.
   */
  platform?: boolean;
  /** How long the engine's handshake waits for a platform server's own. */
  handshakeWaitMs?: number;
};

/**
 * A remote MCP server as an in-process one: the engine talks to this relay,
 * and the relay talks to the egress proxy with the attempt's token. The
 * token stays in this process, never in the engine's argv or environment,
 * where `--mcp-config` would have put it. The engine sees only the tools the
 * run exposes; the proxy refuses any other call on its own.
 */
export function remoteMcpRelay(server: RemoteMcpServer): {
  type: "sdk";
  name: string;
  instance: McpServer;
} {
  const prefix = `mcp__${server.name}__`;
  const pinned = new Set(
    server.tools
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length)),
  );
  let upstream: Promise<Client> | undefined;
  const connected = () => {
    upstream ??= (async () => {
      const client = new Client({ name: "werft-worker", version: "1" });
      // The SDK's own transport, typed without exactOptionalPropertyTypes.
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { authorization: `Bearer ${server.token}` } },
      }) as Transport;
      await client.connect(transport);
      return client;
    })();
    upstream.catch(() => {
      upstream = undefined;
    });
    return upstream;
  };
  const platform = server.platform === true;
  const relay = new McpServer(
    { name: server.name, version: "1" },
    {
      // What a handler may be registered for; the handshake below tells the
      // engine only what the server itself has.
      capabilities: platform
        ? { tools: {}, resources: {}, prompts: {} }
        : { tools: {} },
    },
  );
  relay.server.setRequestHandler(ListToolsRequestSchema, async (_, extra) => {
    const client = await connected();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listed = await client.listTools(
        cursor === undefined ? {} : { cursor },
        { signal: extra.signal },
      );
      tools.push(...listed.tools.filter((tool) => pinned.has(tool.name)));
      cursor = listed.nextCursor;
      if (cursor === undefined) break;
    }
    listedDescriptions.set(
      relay,
      new Map(
        tools.flatMap((tool) =>
          typeof tool.description === "string"
            ? [[`${prefix}${tool.name}`, tool.description] as const]
            : [],
        ),
      ),
    );
    return { tools };
  });
  relay.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const { name } = request.params;
      if (!pinned.has(name)) return failed(`Tool ${name} is not allowed`);
      try {
        const client = await connected();
        return (await client.callTool(request.params, undefined, {
          signal: extra.signal,
          timeout: CALL_TIMEOUT_MS,
        })) as CallToolResult;
      } catch (error) {
        return failed(messageOf(error));
      }
    },
  );
  if (platform) {
    // The engine's handshake waits for the server's, so what the server says
    // of itself reaches the engine as its own. A server that has not answered
    // by the end of the wait is shown with its tools alone.
    relay.server.setRequestHandler(
      InitializeRequestSchema,
      async (request): Promise<InitializeResult> => {
        const asked = request.params.protocolVersion;
        const client = await withinHandshakeWait(
          connected,
          server.handshakeWaitMs,
        );
        const served = client?.getServerCapabilities();
        const instructions = client?.getInstructions();
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : LATEST_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
            ...(served?.resources === undefined ? {} : { resources: {} }),
            ...(served?.prompts === undefined ? {} : { prompts: {} }),
          },
          serverInfo: { name: server.name, version: "1" },
          ...(instructions === undefined || instructions === ""
            ? {}
            : { instructions }),
        };
      },
    );
    // Read-only and the platform's own: passed through as the server answers.
    relay.server.setRequestHandler(
      ListResourcesRequestSchema,
      async (request, extra) =>
        (await connected()).listResources(request.params, {
          signal: extra.signal,
        }),
    );
    relay.server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async (request, extra) =>
        (await connected()).listResourceTemplates(request.params, {
          signal: extra.signal,
        }),
    );
    relay.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request, extra) =>
        (await connected()).readResource(request.params, {
          signal: extra.signal,
        }),
    );
    relay.server.setRequestHandler(
      ListPromptsRequestSchema,
      async (request, extra) =>
        (await connected()).listPrompts(request.params, {
          signal: extra.signal,
        }),
    );
    relay.server.setRequestHandler(
      GetPromptRequestSchema,
      async (request, extra) =>
        (await connected()).getPrompt(request.params, { signal: extra.signal }),
    );
  }
  return { type: "sdk", name: server.name, instance: relay };
}

function failed(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
