/**
 * Runs the pinned `codex app-server` itself against a fake Responses upstream.
 * The unit tests answer for the adapter's side of the protocol; this one is
 * for what only the real build can say: that it accepts every setting the
 * adapter passes, reaches only the route it was given, and resumes a thread
 * from a rollout written to another directory.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@werft-ai/runtime-core";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";

import { codexExecutable } from "./binary.ts";
import { CodexAgentRuntime, codexRuntimeModule } from "./contract.ts";
import {
  assistantMessage,
  fakeResponses,
  type Seen,
  startOf,
} from "./testing/fake-responses.ts";

const EGRESS = "egress-token-integration";

async function turn(
  run: ReturnType<CodexAgentRuntime["start"]>,
  uuid: string,
  text: string,
) {
  const events: RuntimeEvent[] = [];
  await run.ready();
  const reading = (async () => {
    for await (const event of run.events()) {
      events.push(event);
      if (event.type === "turn.ended") return;
    }
  })();
  run.send({ uuid, message: text });
  await reading;
  return events;
}

let available = true;
try {
  codexExecutable();
} catch {
  available = false;
}

describe.skipIf(!available)("the pinned codex app-server", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "codex-real-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("answers a turn through the egress route and resumes it from a restored rollout", async () => {
    const seen: Seen[] = [];
    const server = fakeResponses(seen, () => [assistantMessage("hello back")]);
    const first = join(root, "first");
    const second = join(root, "second");
    const work = join(root, "work");
    await Bun.write(join(work, ".keep"), "");
    const port = server.port as number;
    let threadId = "";
    // A forward proxy that records where the engine tries to go and refuses:
    // the egress route bypasses it, so any attempt is a host other than the
    // provider (the default plugin sync went to github.com and chatgpt.com).
    const attempts: string[] = [];
    const proxy = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          attempts.push(
            (Buffer.from(data).toString("utf8").split("\r\n")[0] ?? "").slice(
              0,
              120,
            ),
          );
          socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
          socket.end();
        },
      },
    });
    const proxyVariables = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
    ];
    const savedProxy = proxyVariables.map((name) => process.env[name]);
    for (const name of proxyVariables) {
      process.env[name] = `http://127.0.0.1:${proxy.port}`;
    }
    try {
      const runtime = new CodexAgentRuntime({ stateDir: first } as never);
      const run = runtime.start(startOf({ port, work, egressToken: EGRESS }));
      try {
        const events = await turn(run, "in-1", "say hello");
        // Background work the engine starts on its own shows up in this window.
        await Bun.sleep(4000);
        expect(attempts).toEqual([]);
        expect(events.find((e) => e.type === "turn.ended")).toMatchObject({
          turn: { isError: false, inputs: ["in-1"] },
        });
        const init = events.find(
          (e) => e.type === "public" && e.event.event === "system",
        );
        threadId = String(
          (init as { event: { data: { session_id?: string } } }).event.data
            .session_id,
        );
        expect(threadId).not.toBe("");

        // A checkpoint needs the engine's children to be listable: Linux has
        // that, elsewhere the run says it cannot tell instead of calling it quiet.
        const prepared = await run.prepareCheckpoint("turn_end");
        if (process.platform === "linux") {
          expect(prepared).toMatchObject({
            status: "ready",
            checkpoint: { resume: threadId },
          });
        } else {
          expect(prepared).toMatchObject({
            status: "rejected",
            reason: "background_writer",
          });
        }

        // Reaches only the route it was given, with the attempt's token.
        expect(seen.length).toBeGreaterThan(0);
        expect(new Set(seen.map((s) => s.path))).toEqual(
          new Set(["/provider/v1/responses"]),
        );
        expect(seen.every((s) => s.authorization === `Bearer ${EGRESS}`)).toBe(
          true,
        );
        // The body is the real prompt (it carries the person's text and the
        // tool), so an empty match means the engine left the text out.
        const firstRequest = seen.find((s) => s.path.endsWith("/responses"));
        expect(firstRequest?.body).toContain("say hello");
        expect(firstRequest?.body).toContain("exec_command");
        for (const request of seen) {
          expect(request.body).not.toMatch(
            /Co-authored-by: Codex|Generated with \[?Codex|git_attribution/,
          );
        }
      } finally {
        await run.close();
      }

      // Capture the rollout, restore it into another state directory, resume.
      const objects = createMemoryCheckpointObjectStore();
      const writer = codexRuntimeModule.openTranscriptStore({
        generation: 1,
        objects,
        prefix: "sessions/s1/mirror",
        engineDirectory: join(first, "projects"),
      });
      const captured = await writer.captureTranscripts(threadId);
      if (captured === null) throw new Error("the engine wrote no rollout");
      const reader = codexRuntimeModule.openTranscriptStore({
        generation: 2,
        objects,
        prefix: "sessions/s1/mirror",
        engineDirectory: join(second, "projects"),
        inherit: { sessionId: threadId, transcripts: captured },
      });
      await reader.verifyInherited();
      await reader.materialize(join(second, "projects"));

      const before = seen.length;
      const resumed = new CodexAgentRuntime({
        stateDir: second,
      } as never).start(
        startOf({
          port,
          work,
          egressToken: EGRESS,
          mode: "resume",
          resume: threadId,
        }),
      );
      try {
        // The restored thread already holds in-1: it is not asked again.
        await resumed.ready();
        expect(await resumed.holdsInput("in-1")).toBe(true);
        const events = await turn(resumed, "in-2", "and again");
        expect(events.find((e) => e.type === "turn.ended")).toMatchObject({
          turn: { isError: false, inputs: ["in-2"] },
        });
        // The new turn carries the earlier one: the engine replayed the rollout.
        const request = seen
          .slice(before)
          .find((s) => s.path.endsWith("/responses"));
        expect(request?.body).toContain("say hello");
        expect(request?.body).toContain("and again");
      } finally {
        await resumed.close();
      }
    } finally {
      proxyVariables.forEach((name, i) => {
        const value = savedProxy[i];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
      proxy.stop(true);
      await server.stop(true);
    }
  }, 60_000);
});
