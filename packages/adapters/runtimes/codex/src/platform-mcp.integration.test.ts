/**
 * The pinned `codex app-server` itself, with a platform MCP server behind the
 * relay: what only the real build can say is whether the server's own words
 * reach the model.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@werft-ai/runtime-core";
import {
  FAKE_PLATFORM_INSTRUCTIONS,
  startFakePlatformMcp,
} from "@werft-ai/testkit/fake-platform-mcp";

import { codexExecutable } from "./binary.ts";
import { CodexAgentRuntime } from "./contract.ts";
import {
  assistantMessage,
  fakeResponses,
  type Seen,
  startOf,
} from "./testing/fake-responses.ts";

const [REDACTED] = "[REDACTED]";
const TOOL = "mcp__werft__probe";

let available = true;
try {
  codexExecutable();
} catch {
  available = false;
}

describe.skipIf(!available)(
  "a platform MCP server against the pinned codex app-server",
  () => {
    let root: string;
    let turns = 0;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "codex-platform-mcp-"));
    });
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    /**
     * One turn with a platform server that comes up as `server` says: the
     * run's events, what the model was sent, and the calls its tool got.
     */
    async function turn(
      server: Omit<Parameters<typeof startFakePlatformMcp>[0], "bearer"> = {},
      model?: { name: string; answer: (call: number) => unknown[] },
    ) {
      const platform = startFakePlatformMcp({ ...server, bearer: [REDACTED] });
      const seen: Seen[] = [];
      // A server with nothing to serve has no tool for the model to call.
      const served = server.bare === true ? [] : [TOOL];
      const upstream = fakeResponses(
        seen,
        model?.answer ??
          ((call) =>
            call === 1 && served.length > 0
              ? [
                  {
                    type: "function_call",
                    call_id: "call_probe_1",
                    namespace: "mcp__werft",
                    name: "probe",
                    arguments: "{}",
                  },
                ]
              : [assistantMessage("done")]),
      );
      turns += 1;
      const work = join(root, `work-${turns}`);
      await Bun.write(join(work, ".keep"), "");
      const base = startOf({
        port: upstream.port as number,
        work,
        egressToken: "[REDACTED]",
      });
      const start = {
        ...base,
        config: { ...base.config, model: model?.name ?? base.config.model },
        bundle: {
          ...base.bundle,
          mcpServers: [
            {
              name: "werft",
              binding: "binding-1",
              url: platform.url,
              token: [REDACTED],
              // No release pins the server's tool: it is in no allowlist.
              tools: ["exec_command"],
              platform: true,
              trusted: served,
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
        await upstream.stop(true);
        await platform.stop();
      }
      return {
        events,
        requests: seen
          .filter((s) => s.path.endsWith("/responses"))
          .map((s) => s.body),
        calls: platform.calls(),
      };
    }

    test("the model is given the server's instructions and runs the tool it serves unasked", async () => {
      const { events, requests, calls } = await turn();
      expect(events.find((e) => e.type === "turn.ended")).toMatchObject({
        turn: { isError: false },
      });
      // The server's own words, in what the model reads before its first answer.
      expect(requests[0]).toContain(FAKE_PLATFORM_INSTRUCTIONS);
      expect(requests[0]).toContain('"name":"mcp__werft"');
      // The tool ran with no one asked, and its answer went back to the model.
      expect(events.some((e) => e.type === "approval.requested")).toBe(false);
      expect(calls).toBe(1);
      expect(requests.at(-1)).toContain("probe:ok");
    }, 60_000);

    test("a server that refuses once and then answers its handshake late still has its instructions with the model", async () => {
      // The engine waits for the relay, and the relay for the server.
      const { requests, calls } = await turn({
        refuseFirst: 1,
        handshakeDelayMs: 6_000,
      });
      expect(requests[0]).toContain(FAKE_PLATFORM_INSTRUCTIONS);
      expect(requests[0]).toContain('"name":"mcp__werft"');
      expect(calls).toBe(1);
    }, 60_000);

    // A model that searches for its tools (as gpt-5.5 does in this build) is
    // shown no MCP server up front: the engine defers every MCP tool behind
    // `tool_search`. The server and its instructions reach the model with
    // the search's answer, and its tool then runs unasked as before.
    // A model that searches for its tools (gpt-5.5 in this build) is shown
    // every MCP server as a deferred namespace instead: its tools and the
    // rest of its instructions come only with a `tool_search` answer. So
    // the first line of a server's instructions is all such a model reads
    // before it searches.
    test("a model that searches for its tools reads the first line of the instructions up front and the rest with the search's answer", async () => {
      const first = "FIRST_PARAGRAPH Ask this server first about the platform.";
      const second = "SECOND_PARAGRAPH It answers from the installed docs.";
      const { events, requests, calls } = await turn(
        { instructions: `${first}\n\n${second}` },
        {
          name: "gpt-5.5",
          answer: (call) =>
            call === 1
              ? [
                  {
                    type: "tool_search_call",
                    id: "ts_1",
                    call_id: "call_search_1",
                    execution: "client",
                    arguments: { query: "platform probe" },
                    status: "completed",
                  },
                ]
              : call === 2
                ? [
                    {
                      type: "function_call",
                      call_id: "call_probe_1",
                      namespace: "mcp__werft",
                      name: "probe",
                      arguments: "{}",
                    },
                  ]
                : [assistantMessage("done")],
        },
      );
      expect(events.find((e) => e.type === "turn.ended")).toMatchObject({
        turn: { isError: false },
      });
      // Up front: the server as a deferred namespace, described by the first
      // line of its instructions alone, and none of its tools.
      expect(requests[0]).toContain('"type":"tool_search"');
      // The body is JSON: the line ends in an escaped newline.
      expect(requests[0]).toContain(`- mcp__werft: ${first}\\n`);
      expect(requests[0]).not.toContain(second);
      expect(requests[0]).not.toContain('"name":"mcp__werft"');
      // With the search's answer: the namespace, its tool and the whole text.
      expect(requests[1]).toContain('"type":"tool_search_output"');
      expect(requests[1]).toContain('"name":"mcp__werft"');
      expect(requests[1]).toContain(second);
      // The tool it found ran unasked, and its answer went back to the model.
      expect(events.some((e) => e.type === "approval.requested")).toBe(false);
      expect(calls).toBe(1);
      expect(requests.at(-1)).toContain("probe:ok");
    }, 60_000);

    // What this build of the engine does, pinned so a change of it shows:
    // it tells the model of a server only once it shows a tool of it. The
    // server's instructions reach a Codex session with the first tool it
    // serves, as the test above has it.
    test("a server with nothing to serve yet starts with the session, and the model is told nothing of it", async () => {
      const { events, requests } = await turn({ bare: true });
      expect(events.find((e) => e.type === "turn.ended")).toMatchObject({
        turn: { isError: false },
      });
      expect(requests[0]).not.toContain(FAKE_PLATFORM_INSTRUCTIONS);
    }, 60_000);
  },
);
