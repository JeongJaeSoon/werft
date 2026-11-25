import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { LocalToolServer } from "@werft-ai/runtime-core";

// What a tool of no argument takes: nothing, and nothing else.
const NO_ARGUMENTS = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

/**
 * A server the worker answers in its own process, as the engine's in-process
 * MCP server: it lists its tools and passes each call to its own handler. A
 * call with an argument, or of a tool it does not have, is refused here.
 */
export function localToolRelay(server: LocalToolServer): {
  type: "sdk";
  name: string;
  instance: McpServer;
} {
  const tools = new Map(server.tools.map((tool) => [tool.name, tool]));
  const relay = new McpServer(
    { name: server.name, version: "1" },
    { capabilities: { tools: {} } },
  );
  relay.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: server.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: NO_ARGUMENTS,
    })),
  }));
  relay.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const tool = tools.get(request.params.name);
      if (tool === undefined) {
        return failed(`Tool ${request.params.name} is not allowed`);
      }
      if (Object.keys(request.params.arguments ?? {}).length > 0) {
        return failed(`Tool ${tool.name} takes no arguments`);
      }
      try {
        const answer = await tool.call(extra.signal);
        return {
          ...(answer.isError ? { isError: true } : {}),
          content: [{ type: "text", text: answer.text }],
        };
      } catch {
        return failed(`Tool ${tool.name} could not be answered`);
      }
    },
  );
  return { type: "sdk", name: server.name, instance: relay };
}

/** The engine's names of a local server's tools. */
export function localToolNames(server: LocalToolServer): string[] {
  return server.tools.map((tool) => `mcp__${server.name}__${tool.name}`);
}

function failed(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
