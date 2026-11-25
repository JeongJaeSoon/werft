import { WERFT_MCP_SERVER } from "@werft-ai/contracts";
import { WERFT_MCP_INSTRUCTIONS } from "./instructions.ts";
import type {
  WerftMcpCall,
  WerftMcpPart,
  WerftMcpPrompt,
  WerftMcpTool,
} from "./part.ts";
import { maskSecretsIn } from "./secrets.ts";

/**
 * The built-in `werft` MCP server: what Werft tells the agents that run on it
 * about itself. Every session has it, reached like the built-in `github`
 * server: the egress proxy calls it with a grant the authorizer signed for
 * one session and attempt, and nothing in a request body picks the session.
 *
 * The server itself is the frame. What it serves comes from its parts (the
 * tools, resources and prompts of one area each), and so do its capabilities.
 */

// The protocol revisions this server answers; an unknown request gets the
// newest, as the specification lets a server do.
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// JSON-RPC and MCP error codes.
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const RESOURCE_NOT_FOUND = -32002;
const INTERNAL_ERROR = -32603;

/** The JSON-RPC methods the server answers, which the egress route lets through. */
export const WERFT_MCP_METHODS: readonly string[] = [
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
];

type JsonRpcId = string | number;
export type WerftMcpResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique<T extends { name: string }>(kind: string, items: T[]): T[] {
  const seen = new Set<string>();
  for (const { name } of items) {
    if (seen.has(name)) {
      throw new Error(`Two parts of the werft server name the ${kind} ${name}`);
    }
    seen.add(name);
  }
  return items;
}

/** The tools `parts` serve, by the server's own names. */
export function werftMcpToolNames(parts: readonly WerftMcpPart[]): string[] {
  return parts.flatMap((part) => (part.tools ?? []).map((tool) => tool.name));
}

export function createWerftMcpServer(deps: {
  parts: readonly WerftMcpPart[];
  /** What the server answers as (`werftVersionOf`). */
  version: string;
  /** Where the exception behind a failed call goes to be logged. */
  onInternalError?: (
    error: unknown,
    context: { method: string; name: string; call: WerftMcpCall },
  ) => void;
}) {
  const tools: WerftMcpTool[] = unique(
    "tool",
    deps.parts.flatMap((part) => [...(part.tools ?? [])]),
  );
  const prompts: WerftMcpPrompt[] = unique(
    "prompt",
    deps.parts.flatMap((part) => [...(part.prompts ?? [])]),
  );
  const resources = deps.parts.flatMap((part) =>
    part.resources === undefined ? [] : [part.resources],
  );
  const capabilities = {
    tools: {},
    ...(resources.length === 0 ? {} : { resources: {} }),
    ...(prompts.length === 0 ? {} : { prompts: {} }),
  };

  return async function handle(
    grant: { sessionId: string; attemptId: string },
    message: unknown,
    requestId: string,
  ): Promise<WerftMcpResponse | null> {
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: INVALID_REQUEST, message: "Invalid request" },
      };
    }
    const id = message.id;
    // A notification, or a response to a request this server never sends.
    if (
      typeof message.method === "string"
        ? id === undefined
        : "result" in message || "error" in message
    ) {
      return null;
    }
    if (typeof message.method !== "string") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: INVALID_REQUEST, message: "Invalid request" },
      };
    }
    if (typeof id !== "string" && typeof id !== "number") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: INVALID_REQUEST, message: "Invalid request id" },
      };
    }
    const { method } = message;
    // Everything a part answers goes out masked: no secret-shaped value
    // leaves, whatever a part read.
    const answer = (result: unknown): WerftMcpResponse => ({
      jsonrpc: "2.0",
      id,
      result: maskSecretsIn(result),
    });
    const fail = (code: number, text: string): WerftMcpResponse => ({
      jsonrpc: "2.0",
      id,
      error: { code, message: text },
    });
    const params = isRecord(message.params) ? message.params : {};
    const call: WerftMcpCall = { ...grant, requestId };
    // A fault of a part: the agent gets a fixed sentence, never the
    // exception, and a logger that fails does not take the answer with it.
    const fault = (name: string, error: unknown) => {
      try {
        deps.onInternalError?.(error, { method, name, call });
      } catch {}
    };
    const faulted = (name: string, error: unknown) => {
      fault(name, error);
      return fail(INTERNAL_ERROR, "The Werft server could not answer this");
    };
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return answer({
          protocolVersion:
            typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
              ? asked
              : PROTOCOL_VERSIONS[0],
          capabilities,
          serverInfo: {
            name: WERFT_MCP_SERVER,
            title: "Werft",
            version: deps.version,
          },
          instructions: WERFT_MCP_INSTRUCTIONS,
        });
      }
      case "ping":
        return answer({});
      case "tools/list":
        return answer({
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            // Every tool of this server reads only.
            annotations: { readOnlyHint: true },
          })),
        });
      case "tools/call": {
        const tool = tools.find((candidate) => candidate.name === params.name);
        if (tool === undefined) return fail(INVALID_PARAMS, "Unknown tool");
        try {
          return answer(await tool.call(params.arguments, call));
        } catch (error) {
          fault(tool.name, error);
          return answer({
            isError: true,
            content: [
              {
                type: "text",
                text: "The Werft server could not answer this call. Try it again.",
              },
            ],
          });
        }
      }
      case "resources/list":
        if (resources.length === 0) break;
        try {
          return answer({
            resources: (
              await Promise.all(resources.map((part) => part.list(call)))
            ).flat(),
          });
        } catch (error) {
          return faulted("resources", error);
        }
      case "resources/templates/list":
        if (resources.length === 0) break;
        return answer({
          resourceTemplates: resources.flatMap((part) => [
            ...(part.templates ?? []),
          ]),
        });
      case "resources/read": {
        if (resources.length === 0) break;
        const { uri } = params;
        if (typeof uri !== "string") return fail(INVALID_PARAMS, "No URI");
        try {
          for (const part of resources) {
            const contents = await part.read(uri, call);
            if (contents !== null) return answer({ contents });
          }
        } catch (error) {
          return faulted("resources", error);
        }
        return fail(RESOURCE_NOT_FOUND, "Resource not found");
      }
      case "prompts/list":
        if (prompts.length === 0) break;
        return answer({
          prompts: prompts.map((prompt) => ({
            name: prompt.name,
            ...(prompt.title === undefined ? {} : { title: prompt.title }),
            description: prompt.description,
            ...(prompt.arguments === undefined
              ? {}
              : { arguments: prompt.arguments }),
          })),
        });
      case "prompts/get": {
        if (prompts.length === 0) break;
        const prompt = prompts.find(
          (candidate) => candidate.name === params.name,
        );
        if (prompt === undefined) return fail(INVALID_PARAMS, "Unknown prompt");
        const given = isRecord(params.arguments) ? params.arguments : {};
        const args = Object.fromEntries(
          Object.entries(given).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
        const missing = (prompt.arguments ?? []).find(
          (argument) => argument.required === true && !(argument.name in args),
        );
        if (missing !== undefined) {
          return fail(INVALID_PARAMS, `Missing argument ${missing.name}`);
        }
        try {
          return answer(await prompt.get(args, call));
        } catch (error) {
          return faulted(prompt.name, error);
        }
      }
    }
    return fail(METHOD_NOT_FOUND, `Method ${method} is not served`);
  };
}
