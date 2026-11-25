import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { WERFT_MCP_INSTRUCTIONS } from "./instructions.ts";
import { type WerftMcpPart, werftTool } from "./part.ts";
import { docsPart } from "./parts/docs.ts";
import { guidePart } from "./parts/guide.ts";
import { statusPart } from "./parts/status.ts";
import { MASKED } from "./secrets.ts";
import {
  createWerftMcpServer,
  WERFT_MCP_METHODS,
  werftMcpToolNames,
} from "./server.ts";

const GRANT = { sessionId: "session-1", attemptId: "att_1" };
// Built here, so no file holds a value shaped like a credential.
const TOKEN = `gh${"p"}_${"A1b2C3d4".repeat(5)}`;

type Answer = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

function serverOf(
  parts: readonly WerftMcpPart[],
  onInternalError?: Parameters<
    typeof createWerftMcpServer
  >[0]["onInternalError"],
) {
  const handle = createWerftMcpServer({
    parts,
    version: "v9.9.9",
    ...(onInternalError === undefined ? {} : { onInternalError }),
  });
  return async (method: string, params?: unknown): Promise<Answer> =>
    (await handle(
      GRANT,
      {
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(params === undefined ? {} : { params }),
      },
      "req-1",
    )) as Answer;
}

// One part of each kind an area can add.
const seen: unknown[] = [];
const tools: WerftMcpPart = {
  tools: [
    werftTool({
      name: "find",
      description: "Finds a page",
      input: z.object({ query: z.string().min(1) }).strict(),
      call: async (args, call) => {
        seen.push({ args, call });
        return {
          content: [{ type: "text", text: `found ${args.query}` }],
          structuredContent: { query: args.query, leaked: TOKEN },
        };
      },
    }),
    {
      name: "broken",
      description: "Throws",
      inputSchema: { type: "object" },
      call: async () => {
        throw new Error(`boom ${TOKEN}`);
      },
    },
  ],
};
const resources: WerftMcpPart = {
  resources: {
    list: async () => [{ uri: "werft://docs/a", name: "a" }],
    templates: [{ uriTemplate: "werft://docs/{page}", name: "page" }],
    read: async (uri) =>
      uri === "werft://docs/a"
        ? [{ uri, mimeType: "text/markdown", text: `page a ${TOKEN}` }]
        : null,
  },
};
const prompts: WerftMcpPart = {
  prompts: [
    {
      name: "check",
      description: "A check",
      arguments: [{ name: "what", required: true }],
      get: async (args) => ({
        messages: [
          {
            role: "user",
            content: { type: "text", text: `check ${args.what} ${TOKEN}` },
          },
        ],
      }),
    },
  ],
};

describe("the built-in werft MCP server's handshake", () => {
  test("says what it is, as the version it was built as, with its instructions", async () => {
    const ask = serverOf([]);
    const { result } = await ask("initialize", {
      protocolVersion: "2025-06-18",
    });
    expect(result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "werft", title: "Werft", version: "v9.9.9" },
      instructions: WERFT_MCP_INSTRUCTIONS,
    });
    // A revision it does not know gets its newest.
    expect(
      (await ask("initialize", { protocolVersion: "2099-01-01" })).result
        ?.protocolVersion,
    ).toBe("2025-06-18");
    expect((await ask("ping")).result).toEqual({});
  });

  test("the instructions say when to use it first and to check status when unsure, and name no tool", () => {
    // The criteria the owner approved, in the instructions' own words.
    for (const said of [
      "what this agent is connected to in Werft",
      "what this agent may or may not do here",
      "how to set something up or change a setting in Werft",
      "Use this server first",
      "check this agent's status on this server first",
      "never returns a secret value",
    ]) {
      expect(WERFT_MCP_INSTRUCTIONS).toContain(said);
    }
    // No `snake_case` or `mcp__` name: a tool is found by its description.
    expect(WERFT_MCP_INSTRUCTIONS).not.toMatch(/mcp__|\b[a-z]+_[a-z_]+\b/);
  });

  test("its capabilities follow what its parts serve", async () => {
    const capabilitiesOf = async (parts: readonly WerftMcpPart[]) =>
      (await serverOf(parts)("initialize")).result?.capabilities;
    expect(await capabilitiesOf([tools])).toEqual({ tools: {} });
    expect(await capabilitiesOf([resources])).toEqual({
      tools: {},
      resources: {},
    });
    expect(await capabilitiesOf([tools, resources, prompts])).toEqual({
      tools: {},
      resources: {},
      prompts: {},
    });
  });
});

describe("what the parts add", () => {
  const ask = serverOf([tools, resources, prompts]);

  test("tools are listed read-only, in part order, and called with parsed arguments and the grant's session", async () => {
    expect((await ask("tools/list")).result).toEqual({
      tools: [
        {
          name: "find",
          description: "Finds a page",
          inputSchema: expect.objectContaining({
            type: "object",
            required: ["query"],
          }),
          annotations: { readOnlyHint: true },
        },
        {
          name: "broken",
          description: "Throws",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    expect(werftMcpToolNames([tools, resources, prompts])).toEqual([
      "find",
      "broken",
    ]);
    seen.length = 0;
    const called = await ask("tools/call", {
      name: "find",
      arguments: { query: "github" },
    });
    expect(called.result?.content).toEqual([
      { type: "text", text: "found github" },
    ]);
    expect(seen).toEqual([
      {
        args: { query: "github" },
        call: { ...GRANT, requestId: "req-1" },
      },
    ]);
  });

  test("arguments the tool's schema refuses are a tool error, and the tool is not run", async () => {
    seen.length = 0;
    const called = await ask("tools/call", { name: "find", arguments: {} });
    expect(called.result?.isError).toBe(true);
    expect(JSON.stringify(called.result?.content)).toContain(
      "Invalid arguments",
    );
    expect(seen).toEqual([]);
    expect((await ask("tools/call", { name: "nope" })).error).toEqual({
      code: -32602,
      message: "Unknown tool",
    });
  });

  test("resources are listed, templated and read by the part that owns the URI", async () => {
    expect((await ask("resources/list")).result).toEqual({
      resources: [{ uri: "werft://docs/a", name: "a" }],
    });
    expect((await ask("resources/templates/list")).result).toEqual({
      resourceTemplates: [{ uriTemplate: "werft://docs/{page}", name: "page" }],
    });
    expect(
      (await ask("resources/read", { uri: "werft://docs/a" })).result,
    ).toEqual({
      contents: [
        {
          uri: "werft://docs/a",
          mimeType: "text/markdown",
          text: `page a ${MASKED}`,
        },
      ],
    });
    expect(
      (await ask("resources/read", { uri: "werft://docs/b" })).error,
    ).toEqual({ code: -32002, message: "Resource not found" });
  });

  test("prompts are listed and filled, and a missing required argument is refused", async () => {
    expect((await ask("prompts/list")).result).toEqual({
      prompts: [
        {
          name: "check",
          description: "A check",
          arguments: [{ name: "what", required: true }],
        },
      ],
    });
    expect(
      (
        await ask("prompts/get", {
          name: "check",
          arguments: { what: "slack" },
        })
      ).result,
    ).toEqual({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `check slack ${MASKED}` },
        },
      ],
    });
    expect((await ask("prompts/get", { name: "check" })).error).toEqual({
      code: -32602,
      message: "Missing argument what",
    });
    expect((await ask("prompts/get", { name: "nope" })).error?.code).toBe(
      -32602,
    );
  });
});

describe("no secret value leaves the server", () => {
  test("a value a part returned that is shaped like a credential is masked, in text and in structured content", async () => {
    const ask = serverOf([tools]);
    const called = await ask("tools/call", {
      name: "find",
      arguments: { query: TOKEN },
    });
    expect(JSON.stringify(called)).not.toContain(TOKEN);
    expect(called.result).toEqual({
      content: [{ type: "text", text: `found ${MASKED}` }],
      structuredContent: { query: MASKED, leaked: MASKED },
    });
  });

  test("a part that throws answers a fixed sentence, and its exception goes to the log only", async () => {
    const logged: unknown[] = [];
    const ask = serverOf([tools], (error, context) => {
      logged.push([(error as Error).message, context]);
    });
    const called = await ask("tools/call", { name: "broken" });
    expect(called.result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "The Werft server could not answer this call. Try it again.",
        },
      ],
    });
    expect(JSON.stringify(called)).not.toContain("boom");
    expect(logged).toEqual([
      [
        `boom ${TOKEN}`,
        {
          method: "tools/call",
          name: "broken",
          call: { ...GRANT, requestId: "req-1" },
        },
      ],
    ]);
    // A logger that throws does not take the answer with it.
    const quiet = serverOf([tools], () => {
      throw new Error("logger down");
    });
    expect(
      (await quiet("tools/call", { name: "broken" })).result?.isError,
    ).toBe(true);
  });
});

describe("what the server does not serve", () => {
  test("a method outside its list, and resources or prompts no part has, are not served", async () => {
    const ask = serverOf([tools]);
    for (const method of [
      "completion/complete",
      "resources/list",
      "resources/read",
      "prompts/list",
      "prompts/get",
    ]) {
      expect([method, (await ask(method)).error?.code]).toEqual([
        method,
        -32601,
      ]);
    }
    expect(WERFT_MCP_METHODS).toContain("resources/read");
  });

  test("a notification gets no answer, and a malformed message a JSON-RPC error", async () => {
    const handle = createWerftMcpServer({ parts: [], version: "v1" });
    expect(
      await handle(
        GRANT,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        "r",
      ),
    ).toBeNull();
    expect(
      await handle(GRANT, { jsonrpc: "2.0", id: 1, result: {} }, "r"),
    ).toBe(null);
    expect(await handle(GRANT, "nope", "r")).toMatchObject({
      error: { code: -32600 },
    });
    expect(
      await handle(GRANT, { jsonrpc: "2.0", id: {}, method: "ping" }, "r"),
    ).toMatchObject({ error: { code: -32600 } });
  });

  test("two parts naming the same tool or prompt stop the server from being made", () => {
    expect(() =>
      createWerftMcpServer({ parts: [tools, tools], version: "v1" }),
    ).toThrow("name the tool find");
    expect(() =>
      createWerftMcpServer({ parts: [prompts, prompts], version: "v1" }),
    ).toThrow("name the prompt check");
  });
});

describe("the parts as shipped", () => {
  test("each area has its own part, and together they make a server", async () => {
    const context = { version: "v9.9.9" };
    const parts = [docsPart(context), statusPart(context), guidePart(context)];
    const ask = serverOf(parts);
    const { result } = await ask("initialize");
    expect(result?.instructions).toBe(WERFT_MCP_INSTRUCTIONS);
    const listed = (await ask("tools/list")).result?.tools as {
      name: string;
    }[];
    expect(listed.map((tool) => tool.name)).toEqual(werftMcpToolNames(parts));
  });
});
