import { createHmac, timingSafeEqual } from "node:crypto";
import {
  GITHUB_MCP_FIXED_TOOLS,
  GITHUB_MCP_SERVER,
  type GitHubMcpTool,
  githubMcpTools,
} from "@werft-ai/contracts";
import { z } from "zod";
import {
  type GitHubMcpStore,
  SavedRulesUnavailable,
} from "../../github/ports/github-mcp.ts";
import { isRecord, refusalOf } from "../refusal.ts";
import {
  createToolDispatcher,
  definedTool,
  describeTools,
  servedTool,
  toolAnswer,
} from "../tools/dispatch.ts";
import { GITHUB_TOOL_HANDLERS } from "../tools/github-handlers.ts";
import { refused } from "../tools/handler.ts";
import {
  type SessionServices,
  sessionBoundAuthorization,
} from "../tools/session-bound.ts";

/**
 * The built-in `github` MCP server (design github-agent.md §3 "내장 MCP 서버
 * github"): the session's agent calls the same service functions as the
 * session API, for its own session only. The egress proxy reaches it with
 * a grant the authorizer signed for one session and attempt; nothing in a
 * request body picks the session.
 */

const GRANT_VERSION = "v1";
export const GITHUB_MCP_GRANT_TTL_MS = 60_000;

export type GitHubMcpGrant = { sessionId: string; attemptId: string };

const grantPayloadSchema = z
  .object({
    session_id: z.string().min(1),
    attempt_id: z.string().min(1),
    exp: z.number().int(),
  })
  .strict();

function mac(key: Uint8Array, signed: string): Buffer {
  return createHmac("sha256", key).update(signed, "utf8").digest();
}

/** The bearer the authorizer hands the proxy for one exchange. */
export function signGitHubMcpGrant(
  key: Uint8Array,
  grant: GitHubMcpGrant,
  nowMs: number,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      session_id: grant.sessionId,
      attempt_id: grant.attemptId,
      exp: nowMs + GITHUB_MCP_GRANT_TTL_MS,
    }),
    "utf8",
  ).toString("base64url");
  const signed = `${GRANT_VERSION}.${payload}`;
  return `${signed}.${mac(key, signed).toString("base64url")}`;
}

/** The session and attempt a bearer names, or null for any other bearer. */
export function verifyGitHubMcpGrant(
  key: Uint8Array,
  bearer: string,
  nowMs: number,
): GitHubMcpGrant | null {
  const parts = bearer.split(".");
  if (parts.length !== 3 || parts[0] !== GRANT_VERSION) return null;
  const [, payload = "", given = ""] = parts;
  const expected = mac(key, `${GRANT_VERSION}.${payload}`);
  const presented = Buffer.from(given, "base64url");
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return null;
  }
  let parsed: z.infer<typeof grantPayloadSchema>;
  try {
    parsed = grantPayloadSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
  if (parsed.exp <= nowMs) return null;
  return { sessionId: parsed.session_id, attemptId: parsed.attempt_id };
}

// The protocol revisions this server answers; an unknown request gets the
// newest, as the specification lets a server do.
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcId = string | number;
export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export function createGitHubMcpServer(deps: {
  store: GitHubMcpStore;
  services: SessionServices;
  /** Where the exception behind an `internal_error` answer goes to be logged. */
  onInternalError?: (
    error: unknown,
    context: { tool: GitHubMcpTool; sessionId: string; requestId: string },
  ) => void;
}) {
  const dispatchTool = createToolDispatcher({
    handlers: GITHUB_TOOL_HANDLERS,
    store: deps.store,
    services: (sessionId) =>
      deps.services(sessionBoundAuthorization(sessionId)),
  });

  return async function handle(
    grant: GitHubMcpGrant,
    message: unknown,
    requestId: string,
  ): Promise<JsonRpcResponse | null> {
    // The clock of a waiting call starts here, not when its service starts.
    const startedAt = performance.now();
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
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
        error: { code: -32600, message: "Invalid request" },
      };
    }
    if (typeof id !== "string" && typeof id !== "number") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request id" },
      };
    }
    const answer = (result: unknown): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id,
      result,
    });
    const fail = (code: number, text: string): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id,
      error: { code, message: text },
    });
    const params = isRecord(message.params) ? message.params : {};
    switch (message.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return answer({
          protocolVersion:
            typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
              ? asked
              : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: GITHUB_MCP_SERVER, version: "1" },
        });
      }
      case "ping":
        return answer({});
      case "tools/list":
      case "tools/call":
        break;
      default:
        return fail(-32601, `Method ${message.method} is not served`);
    }
    // Read for every call: the proxy judged the exchange a moment ago, and
    // the same reads here keep a switch flipped since then from acting.
    const askedTool =
      message.method === "tools/call" ? definedTool(params.name) : null;
    // A fault of the server: the model gets the code, never the exception,
    // and a logger that fails does not take the answer with it.
    const internalFault = (tool: GitHubMcpTool, error: unknown) => {
      try {
        deps.onInternalError?.(error, {
          tool,
          sessionId: grant.sessionId,
          requestId,
        });
      } catch {}
      return answer(toolAnswer(refused(refusalOf(tool, "internal_error"))));
    };
    let state: Awaited<ReturnType<typeof deps.store.sessionState>>;
    try {
      state = await deps.store.sessionState(grant.sessionId);
    } catch (error) {
      // Other methods have no tool to answer for: the transport reports it.
      // The same for the saved rules: nothing has run yet, and a failure to
      // read them is the transport's retryable 503, not a tool result that
      // says "internal error" and that nobody retries.
      if (askedTool === null || error instanceof SavedRulesUnavailable) {
        throw error;
      }
      return internalFault(askedTool, error);
    }
    if (
      state === null ||
      state.github === null ||
      (!state.enabled && state.source === "release") ||
      state.actor === null
    ) {
      return fail(-32001, "GitHub tools are not available to this session");
    }
    const blocked = state.blockedTools ?? [];
    if (message.method === "tools/list") {
      return answer({
        // A saved deny does not change what is listed: the model sees what
        // the release exposes and the call is refused, as for the general
        // MCP route.
        tools: describeTools(
          state.source === "release"
            ? githubMcpTools(state.github)
            : GITHUB_MCP_FIXED_TOOLS,
        ),
      });
    }
    const tool = servedTool(params.name);
    if (tool === null) {
      return fail(-32602, "Unknown tool");
    }
    if (blocked.includes(tool)) {
      return fail(-32001, "A saved rule denies this tool");
    }
    try {
      return answer(
        await dispatchTool({
          grant,
          tool,
          args: params.arguments,
          requestId,
          startedAt,
          github: state.github,
          state: {
            ownerId: state.ownerId,
            actor: state.actor,
            source: state.source,
            enabled: state.enabled,
          },
        }),
      );
    } catch (error) {
      return internalFault(tool, error);
    }
  };
}
