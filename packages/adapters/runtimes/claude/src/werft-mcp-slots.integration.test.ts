/**
 * Which of the places an MCP server can say something the pinned engine
 * reads, measured against the real build behind the platform relay. Pinned
 * so that a change of the engine (or of the relay) shows: the built-in
 * `werft` server puts its core text where this says it is read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";
import { remoteMcpRelay } from "./remote-mcp.ts";
import { ClaudeSdkRuntime } from "./runtime.ts";

const BEARER = "slot-bearer";
const TOOL = "mcp__werft__probe";

/**
 * An MCP server shaped like the platform's own with a marker in each place a
 * server can say something (instructions, a tool's description, a resource,
 * a skill file, a prompt), recording every method it is asked.
 */
function startSlotServer(bearer: string) {
  const methods: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${bearer}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = (await request
        .clone()
        .json()
        .catch(() => undefined)) as { method?: unknown } | undefined;
      if (typeof body?.method === "string") methods.push(body.method);
      const mcp = new McpServer(
        { name: "werft", version: "1" },
        { instructions: SLOT.instructions },
      );
      mcp.registerTool(
        "probe",
        { description: SLOT.toolDescription },
        async () => ({ content: [{ type: "text", text: "probe:ok" }] }),
      );
      mcp.registerResource(
        "guide",
        "fake://guide",
        { description: SLOT.resourceDescription, mimeType: "text/plain" },
        async (uri) => ({
          contents: [{ uri: uri.href, text: SLOT.resourceBody }],
        }),
      );
      mcp.registerResource(
        "slots",
        "skill://slots/SKILL.md",
        { description: SLOT.skillDescription, mimeType: "text/markdown" },
        async (uri) => ({
          contents: [{ uri: uri.href, text: SLOT.skillBody }],
        }),
      );
      mcp.registerPrompt(
        "check",
        { description: SLOT.promptDescription },
        () => ({
          messages: [
            { role: "user", content: { type: "text", text: SLOT.promptBody } },
          ],
        }),
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await mcp.connect(transport as Transport);
      return transport.handleRequest(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    methods: () => [...methods],
    stop: () => server.stop(true),
  };
}

const SLOT = {
  instructions: "SLOT_INSTRUCTIONS ask this server first.",
  toolDescription: "SLOT_TOOL_DESCRIPTION says the server answered.",
  resourceDescription: "SLOT_RESOURCE_DESCRIPTION",
  resourceBody: "SLOT_RESOURCE_BODY",
  skillDescription: "SLOT_SKILL_DESCRIPTION",
  skillBody:
    "---\nname: slots\ndescription: SLOT_SKILL_DESCRIPTION\n---\nSLOT_SKILL_BODY\n",
  promptDescription: "SLOT_PROMPT_DESCRIPTION",
  promptBody: "SLOT_PROMPT_BODY",
};

/** Which places reached the model's first request, by their markers. */
function slotsIn(request: string) {
  return {
    instructions: request.includes("SLOT_INSTRUCTIONS"),
    toolDescription: request.includes("SLOT_TOOL_DESCRIPTION"),
    resource: /SLOT_RESOURCE_(DESCRIPTION|BODY)/.test(request),
    skill: /SLOT_SKILL_(DESCRIPTION|BODY)/.test(request),
    prompt: /SLOT_PROMPT_(DESCRIPTION|BODY)/.test(request),
  };
}

let isolated: IsolatedWorkspace | undefined;
let model: FakeAnthropicServer | undefined;
let platform: ReturnType<typeof startSlotServer> | undefined;

afterEach(async () => {
  model?.stop();
  await platform?.stop();
  await isolated?.dispose();
  isolated = undefined;
  model = undefined;
  platform = undefined;
});

/**
 * One turn in which the model lists the server's resources and reads its
 * skill file: what the model was sent, what came back from each, and which
 * methods reached the server. `tools` is the release's allowlist.
 */
async function turn(tools: string[]) {
  isolated = await createIsolatedWorkspace({ prefix: "werft-slots-" });
  const { home, workspace } = isolated;
  const server = startSlotServer(BEARER);
  platform = server;
  const fake = startFakeAnthropicServer((_request, index) =>
    index === 0
      ? toolReply("ListMcpResourcesTool", { server: "werft" })
      : index === 1
        ? toolReply("ReadMcpResourceTool", {
            server: "werft",
            uri: "skill://slots/SKILL.md",
          })
        : textReply("done"),
  );
  model = fake;
  const runtime = new ClaudeSdkRuntime({
    endpoints: [fake.url],
    models: ["claude-sonnet-4-5"],
  });
  const asked: string[] = [];
  const run = runtime.start(
    {
      claudeConfigDir: home,
      correlationId: "werft-slots",
      mode: "new" as const,
      cwd: workspace,
      home,
      maxTurns: 4,
      model: "claude-sonnet-4-5",
      profile: {
        kind: "anthropic" as const,
        endpoint: fake.url,
        auth: { kind: "api_key" as const, value: "placeholder-local" },
        principal: { ownerScope: "owner-a" },
      },
      settingSources: [],
      tools,
      servedTools: [TOOL],
      identities: { mcpServers: { werft: "binding-1" } },
      mcpServers: {
        werft: remoteMcpRelay({
          name: "werft",
          url: server.url,
          token: BEARER,
          tools: [TOOL],
          platform: true,
        }),
      },
    },
    {
      onPermission: async ({ tool }) => {
        asked.push(tool);
        return { behavior: "deny", message: "Nothing is asked here" };
      },
    },
  );
  const consume = (async () => {
    for await (const _frame of run) {
      // Drained so the run can end.
    }
  })();
  run.send({
    message: "what are you connected to?",
    uuid: crypto.randomUUID(),
  });
  run.finishInput();
  await Promise.race([
    consume,
    Bun.sleep(60_000).then(() => {
      throw new Error("The turn did not finish");
    }),
  ]);
  const requests = fake.requests.map((request) => JSON.stringify(request.body));
  const results = fake.requests
    .slice(1)
    .map((request) =>
      JSON.stringify(
        (request.body as { messages: { content: unknown }[] }).messages.at(-1)
          ?.content,
      ),
    );
  return {
    first: requests[0] ?? "",
    results,
    asked,
    methods: server.methods(),
  };
}

describe("the places an MCP server says something, against the pinned Claude engine", () => {
  test("the model reads the instructions and the tool descriptions, and no prompt, resource or skill", async () => {
    const { first, results, asked, methods } = await turn([]);
    expect(slotsIn(first)).toEqual({
      instructions: true,
      toolDescription: true,
      resource: false,
      skill: false,
      prompt: false,
    });
    // The engine offers the model its tools for reading a server's
    // resources, but a run's allowlist hook refuses them: no release names
    // them, so a resource (the skill file too) is out of the model's reach.
    expect(first).toContain('"name":"ListMcpResourcesTool"');
    expect(first).toContain('"name":"ReadMcpResourceTool"');
    expect(results[0]).toContain("Tool is outside the server allowlist");
    expect(results[1]).toContain("Tool is outside the server allowlist");
    expect(asked).toEqual([]);
    // Prompts are never listed, and no `skills/*` method is asked: this
    // build does not speak the skills extension.
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  }, 90_000);

  test("a release that allowed the resource tools would reach the skill file through the relay", async () => {
    const { results, asked, methods } = await turn([
      "ListMcpResourcesTool",
      "ReadMcpResourceTool",
    ]);
    expect(results[0]).toContain("SLOT_SKILL_DESCRIPTION");
    expect(results[1]).toContain("SLOT_SKILL_BODY");
    expect(asked).toEqual([]);
    // Read as a resource, not loaded as a skill.
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "resources/list",
      "resources/read",
    ]);
  }, 90_000);
});
