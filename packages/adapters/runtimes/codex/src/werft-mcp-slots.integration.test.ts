/**
 * Which of the places an MCP server can say something the pinned Codex
 * engine reads, measured against the real build behind the platform relay.
 * Pinned so that a change of the engine (or of the relay) shows: the
 * built-in `werft` server puts its core text where this says it is read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RuntimeEvent } from "@werft-ai/runtime-core";
import { codexExecutable } from "./binary.ts";
import { CodexAgentRuntime } from "./contract.ts";
import {
  assistantMessage,
  fakeResponses,
  type Seen,
  startOf,
} from "./testing/fake-responses.ts";

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

let available = true;
try {
  codexExecutable();
} catch {
  available = false;
}

describe.skipIf(!available)(
  "the places an MCP server says something, against the pinned codex app-server",
  () => {
    let root: string;
    let turns = 0;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "codex-werft-slots-"));
    });
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    async function turn(reply: Parameters<typeof fakeResponses>[1]) {
      const platform = startSlotServer(BEARER);
      const seen: Seen[] = [];
      const model = fakeResponses(seen, reply);
      turns += 1;
      const work = join(root, `work-${turns}`);
      await Bun.write(join(work, ".keep"), "");
      const base = startOf({
        port: model.port as number,
        work,
        egressToken: "egress-placeholder",
      });
      const start = {
        ...base,
        bundle: {
          ...base.bundle,
          mcpServers: [
            {
              name: "werft",
              binding: "binding-1",
              url: platform.url,
              token: BEARER,
              tools: ["exec_command"],
              platform: true,
              trusted: [TOOL],
            },
          ],
        },
      } as unknown as typeof base;
      const runtime = new CodexAgentRuntime(
        { stateDir: join(root, `state-${turns}`) } as never,
        { ...process.env },
      );
      const run = runtime.start(start);
      const events: RuntimeEvent[] = [];
      try {
        await run.ready();
        const reading = (async () => {
          for await (const event of run.events()) {
            events.push(event);
            if (event.type === "turn.ended") return;
          }
        })();
        run.send({ uuid: "in-1", message: "what are you connected to?" });
        await reading;
      } finally {
        await run.close();
        await model.stop(true);
        await platform.stop();
      }
      return {
        events,
        requests: seen
          .filter((s) => s.path.endsWith("/responses"))
          .map((s) => s.body),
        methods: platform.methods(),
      };
    }

    test("the model reads the instructions and the tool descriptions, and no prompt, resource or skill", async () => {
      const { requests, methods } = await turn(() => [
        assistantMessage("done"),
      ]);
      const first = requests[0] ?? "";
      expect(slotsIn(first)).toEqual({
        instructions: true,
        toolDescription: true,
        resource: false,
        skill: false,
        prompt: false,
      });
      // The instructions are the description of the server's tool namespace.
      expect(first).toContain(
        `"name":"mcp__werft","description":"${SLOT.instructions}"`,
      );
      // It offers the model its own tools for reading a server's resources.
      expect(first).toContain('"name":"list_mcp_resources"');
      expect(first).toContain('"name":"read_mcp_resource"');
      // Prompts are never listed, and no `skills/*` method is asked: this
      // build does not speak the skills extension.
      expect(methods).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
    }, 60_000);

    test("the model can list the resources and read the skill file, with no one asked", async () => {
      const { requests, methods, events } = await turn((call) =>
        call === 1
          ? [
              {
                type: "function_call",
                call_id: "call_list_1",
                name: "list_mcp_resources",
                arguments: JSON.stringify({ server: "werft" }),
              },
            ]
          : call === 2
            ? [
                {
                  type: "function_call",
                  call_id: "call_read_1",
                  name: "read_mcp_resource",
                  arguments: JSON.stringify({
                    server: "werft",
                    uri: "skill://slots/SKILL.md",
                  }),
                },
              ]
            : [assistantMessage("done")],
      );
      expect(events.find((e) => e.type === "turn.ended")).toMatchObject({
        turn: { isError: false },
      });
      expect(events.some((e) => e.type === "approval.requested")).toBe(false);
      expect(requests[1]).toContain("SLOT_SKILL_DESCRIPTION");
      expect(requests[2]).toContain("SLOT_SKILL_BODY");
      // Read as a resource, not loaded as a skill.
      expect(methods).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
        "resources/list",
        "resources/read",
      ]);
    }, 60_000);
  },
);
