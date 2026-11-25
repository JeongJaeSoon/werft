import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const FAKE_PLATFORM_INSTRUCTIONS =
  "FAKE_PLATFORM_INSTRUCTIONS Ask this server first about the platform.";
export const FAKE_PLATFORM_RESOURCE = "fake://guide";

export type FakePlatformMcp = {
  readonly url: string;
  /** tools/call requests that reached the tool. */
  calls(): number;
  stop(): Promise<void>;
};

/**
 * An MCP server shaped like the platform's own, stateless streamable HTTP on
 * a loopback port: it says what it is for (`instructions`) and has one tool
 * (`probe`), one resource and one prompt. A missing or wrong bearer is 401.
 */
export function startFakePlatformMcp(options: {
  bearer: string;
  instructions?: string;
}): FakePlatformMcp {
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${options.bearer}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const mcp = new McpServer(
        { name: "fake-platform", version: "1" },
        { instructions: options.instructions ?? FAKE_PLATFORM_INSTRUCTIONS },
      );
      mcp.registerTool(
        "probe",
        { description: "Says the platform server answered" },
        async () => {
          calls += 1;
          return { content: [{ type: "text", text: "probe:ok" }] };
        },
      );
      mcp.registerResource(
        "guide",
        FAKE_PLATFORM_RESOURCE,
        { mimeType: "text/plain" },
        async (uri) => ({
          contents: [{ uri: uri.href, text: "resource:ok" }],
        }),
      );
      mcp.registerPrompt("check", { description: "A check to run" }, () => ({
        messages: [
          { role: "user", content: { type: "text", text: "prompt:ok" } },
        ],
      }));
      // No session id generator: stateless, a server per request.
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await mcp.connect(transport as Transport);
      return transport.handleRequest(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    calls: () => calls,
    stop: async () => {
      await server.stop(true);
    },
  };
}
