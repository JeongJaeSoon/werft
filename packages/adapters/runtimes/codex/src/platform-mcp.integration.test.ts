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

const BEARER = "platform-mcp-local";
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
    ) {
      const platform = startFakePlatformMcp({ ...server, bearer: BEARER });
      const seen: Seen[] = [];
      // A server with nothing to serve has no tool for the model to call.
      const served = server.bare === true ? [] : [TOOL];
      const model = fakeResponses(seen, (call) =>
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
          : [assistantMessage("done")],
      );
      turns += 1;
      const work = join(root, `work-${turns}`);
      await Bun.write(join(work, ".keep"), "");
      const base = startOf({
        port: model.port as number,
        work,
        egressToken: "egress-local",
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
        await model.stop(true);
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
