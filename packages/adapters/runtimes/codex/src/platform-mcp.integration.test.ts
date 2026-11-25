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

const ROUTE_BEARER = "route-bearer-for-the-test";
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
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "codex-platform-mcp-"));
    });
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    test("the model is given the server's instructions and runs the tool it serves unasked", async () => {
      const platform = startFakePlatformMcp({ bearer: ROUTE_BEARER });
      const seen: Seen[] = [];
      const model = fakeResponses(seen, (call) =>
        call === 1
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
      const work = join(root, "work");
      await Bun.write(join(work, ".keep"), "");
      const base = startOf({
        port: model.port as number,
        work,
        egressToken: "egress-token-platform-mcp",
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
              token: ROUTE_BEARER,
              // No release pins the server's tool: it is in no allowlist.
              tools: ["exec_command"],
              platform: true,
              trusted: [TOOL],
            },
          ],
        },
      } as unknown as typeof base;
      const runtime = new CodexAgentRuntime(
        { stateDir: join(root, "state") } as never,
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

      expect(events.find((e) => e.type === "turn.ended")).toMatchObject({
        turn: { isError: false },
      });
      const requests = seen
        .filter((s) => s.path.endsWith("/responses"))
        .map((s) => s.body);
      // The server's own words, in what the model reads before its first answer.
      expect(requests[0]).toContain(FAKE_PLATFORM_INSTRUCTIONS);
      expect(requests[0]).toContain('"name":"mcp__werft"');
      // The tool ran with no one asked, and its answer went back to the model.
      expect(events.some((e) => e.type === "approval.requested")).toBe(false);
      expect(platform.calls()).toBe(1);
      expect(requests.at(-1)).toContain("probe:ok");
    }, 60_000);
  },
);
