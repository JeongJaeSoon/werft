import { randomBytes, timingSafeEqual } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  exposedMcpTools,
  messageOf,
  type PlatformMcpServer,
  withinHandshakeWait,
} from "@werft-ai/runtime-core";

const CALL_TIMEOUT_MS = 30 * 60_000;
const MAX_LIST_PAGES = 50;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** The newest revision the relay speaks; a client asking for another gets this one. */
const PROTOCOL_VERSION = "2025-06-18";

export type RelayCall = {
  /** The platform's name for the tool: `mcp__<server>__<tool>`. */
  tool: string;
  server: string;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
};

/** What the run decides before a call goes upstream: a refusal is the model's tool result. */
export type RelayPolicy = (
  call: RelayCall,
) => Promise<
  { allowed: true; done: () => void } | { allowed: false; text: string }
>;

export type McpRelay = {
  /** The URL the engine is configured with for each server. */
  urls: ReadonlyMap<string, string>;
  /** The only credential the engine holds for the relay; never the attempt's. */
  secret: string;
  close(): void;
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
};

function refused(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * A loopback MCP endpoint in this process for the platform's servers. The
 * engine can reach a platform tool only through it, and every call is judged
 * here before it goes to the egress proxy with the attempt's token, which
 * never leaves this process. The engine holds a random secret that opens
 * nothing but this relay, so a tool call has no way around the run's policy.
 */
export function startMcpRelay(
  servers: readonly PlatformMcpServer[],
  policy: RelayPolicy,
  options: { handshakeWaitMs?: number } = {},
): McpRelay {
  const secret = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${secret}`);
  const byPath = new Map<string, PlatformMcpServer>(
    servers.map((server) => [`/mcp/${server.name}`, server]),
  );
  const upstreams = new Map<string, Promise<Client>>();
  const connected = (server: PlatformMcpServer) => {
    let client = upstreams.get(server.name);
    if (client === undefined) {
      client = (async () => {
        const next = new Client({ name: "werft-worker", version: "1" });
        const transport = new StreamableHTTPClientTransport(
          new URL(server.url),
          {
            requestInit: {
              headers: { authorization: `Bearer ${server.token}` },
            },
          },
        ) as Transport;
        await next.connect(transport);
        return next;
      })();
      upstreams.set(server.name, client);
      client.catch(() => upstreams.delete(server.name));
    }
    return client;
  };

  const pinned = (server: PlatformMcpServer) => {
    const prefix = `mcp__${server.name}__`;
    return new Set(
      exposedMcpTools(server).map((name) => name.slice(prefix.length)),
    );
  };

  // What a platform server says of itself, for the engine's handshake. A
  // server that has not answered by the end of the wait is shown with its
  // tools alone.
  async function handshake(server: PlatformMcpServer) {
    const client =
      server.platform === true
        ? await withinHandshakeWait(
            () => connected(server),
            options.handshakeWaitMs,
          )
        : undefined;
    const served = client?.getServerCapabilities();
    const instructions = client?.getInstructions();
    return {
      protocolVersion: PROTOCOL_VERSION,
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
  }

  // A platform server's resources and prompts: read-only and the platform's
  // own, so they pass as the server answers. Undefined for any other method.
  function passed(
    server: PlatformMcpServer,
    method: unknown,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> | undefined {
    if (server.platform !== true) return undefined;
    const upstream = async <T>(ask: (client: Client) => Promise<T>) =>
      ask(await connected(server));
    switch (method) {
      case "resources/list":
        return upstream((c) => c.listResources(params, { signal }));
      case "resources/templates/list":
        return upstream((c) => c.listResourceTemplates(params, { signal }));
      case "resources/read":
        return upstream((c) => c.readResource(params as never, { signal }));
      case "prompts/list":
        return upstream((c) => c.listPrompts(params, { signal }));
      case "prompts/get":
        return upstream((c) => c.getPrompt(params as never, { signal }));
      default:
        return undefined;
    }
  }

  async function listTools(server: PlatformMcpServer, signal: AbortSignal) {
    const allowed = pinned(server);
    const client = await connected(server);
    // A server that declares no tools has none: asking it would fail, and
    // the engine gives up on a server whose tool list fails.
    if (client.getServerCapabilities()?.tools === undefined) return [];
    const tools: Array<{ name: string }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listed = await client.listTools(
        cursor === undefined ? {} : { cursor },
        { signal },
      );
      tools.push(...listed.tools.filter((tool) => allowed.has(tool.name)));
      cursor = listed.nextCursor;
      if (cursor === undefined) break;
    }
    return tools;
  }

  async function callTool(
    server: PlatformMcpServer,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const name = params.name;
    if (typeof name !== "string" || !pinned(server).has(name)) {
      return refused(`Tool ${String(name)} is not allowed`);
    }
    const args =
      typeof params.arguments === "object" &&
      params.arguments !== null &&
      !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    const decision = await policy({
      tool: `mcp__${server.name}__${name}`,
      server: server.name,
      arguments: args,
      signal,
    });
    if (!decision.allowed) return refused(decision.text);
    try {
      const client = await connected(server);
      return (await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: CALL_TIMEOUT_MS,
      })) as ToolResult;
    } catch (error) {
      return refused(messageOf(error));
    } finally {
      decision.done();
    }
  }

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(request) {
      const given = Buffer.from(request.headers.get("authorization") ?? "");
      if (
        given.length !== expected.length ||
        !timingSafeEqual(given, expected)
      ) {
        return new Response("unauthorized", { status: 401 });
      }
      const server = byPath.get(new URL(request.url).pathname);
      if (server === undefined)
        return new Response("not found", { status: 404 });
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = await request.json();
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          return rpcError(null, -32600, "Invalid Request");
        }
        message = parsed as Record<string, unknown>;
      } catch {
        return rpcError(null, -32700, "Parse error");
      }
      const { id, method } = message;
      // A notification or a response from the client needs no answer.
      if (id === undefined) return new Response(null, { status: 202 });
      const params =
        typeof message.params === "object" && message.params !== null
          ? (message.params as Record<string, unknown>)
          : {};
      switch (method) {
        case "initialize":
          return rpcResult(id, await handshake(server));
        case "ping":
          return rpcResult(id, {});
        case "tools/list":
          try {
            return rpcResult(id, {
              tools: await listTools(server, request.signal),
            });
          } catch (error) {
            return rpcError(id, -32603, messageOf(error));
          }
        case "tools/call":
          return rpcResult(id, await callTool(server, params, request.signal));
        default: {
          const answer = passed(server, method, params, request.signal);
          if (answer === undefined) {
            return rpcError(id, -32601, "Method not found");
          }
          try {
            return rpcResult(id, await answer);
          } catch (error) {
            return rpcError(id, -32603, messageOf(error));
          }
        }
      }
    },
  });
  const urls = new Map(
    servers.map(
      (server) =>
        [
          server.name,
          `http://127.0.0.1:${listener.port}/mcp/${server.name}`,
        ] as const,
    ),
  );
  return {
    urls,
    secret,
    close() {
      void listener.stop(true);
      for (const client of upstreams.values()) {
        void client.then((c) => c.close()).catch(() => {});
      }
    },
  };
}
