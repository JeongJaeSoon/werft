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
import type { RuntimeEvent, RuntimeStart } from "@werft-ai/runtime-core";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";

import { codexExecutable } from "./binary.ts";
import { CodexAgentRuntime, codexRuntimeModule } from "./contract.ts";

const TOKEN = "egress-token-integration";

type Seen = {
  method: string;
  path: string;
  authorization: string | null;
  body: string;
};

function sse(events: unknown[]): string {
  return events
    .map(
      (e) =>
        `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`,
    )
    .join("");
}

function upstream(seen: Seen[], answer: (call: number) => unknown[]) {
  let call = 0;
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.get("authorization"),
        body: await req.text(),
      });
      if (!url.pathname.endsWith("/responses"))
        return new Response("{}", { status: 404 });
      call += 1;
      const id = `resp_${call}`;
      const items = answer(call);
      return new Response(
        sse([
          { type: "response.created", response: { id } },
          ...items.flatMap((item, i) => [
            { type: "response.output_item.added", output_index: i, item },
            { type: "response.output_item.done", output_index: i, item },
          ]),
          {
            type: "response.completed",
            response: {
              id,
              usage: {
                input_tokens: 10,
                input_tokens_details: null,
                output_tokens: 5,
                output_tokens_details: null,
                total_tokens: 15,
              },
            },
          },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
}

const message = (text: string) => ({
  type: "message",
  id: "msg",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

function startOf(
  port: number,
  work: string,
  mode: "new" | "resume",
  resume?: string,
): RuntimeStart {
  return {
    bindings: {
      provider: {
        kind: "openai_responses",
        endpoint: "https://api.openai.example/",
        auth: {
          kind: "egress_token",
          token: TOKEN,
          transport: `http://127.0.0.1:${port}/provider`,
        },
      },
      principal: { ownerScope: "owner-1" },
    },
    bundle: { instructions: [], repoInstructions: null, mcpServers: [] },
    config: {
      mode,
      ...(resume === undefined ? {} : { resume }),
      correlationId: "c-1",
      cwd: work,
      home: work,
      model: "gpt-test",
      permissionMode: "default",
      tools: ["exec_command"],
    },
  } as unknown as RuntimeStart;
}

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
    const server = upstream(seen, () => [message("hello back")]);
    const first = join(root, "first");
    const second = join(root, "second");
    const work = join(root, "work");
    await Bun.write(join(work, ".keep"), "");
    let threadId = "";
    try {
      const runtime = new CodexAgentRuntime({ stateDir: first } as never);
      const run = runtime.start(startOf(server.port as number, work, "new"));
      try {
        const events = await turn(run, "in-1", "say hello");
        const ended = events.find((e) => e.type === "turn.ended");
        expect(ended).toMatchObject({
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

        const prepared = await run.prepareCheckpoint("turn_end");
        expect(prepared).toMatchObject({
          status: "ready",
          checkpoint: { resume: threadId },
        });

        // Reaches only the route it was given, with the attempt's token.
        expect(seen.length).toBeGreaterThan(0);
        expect(new Set(seen.map((s) => s.path))).toEqual(
          new Set(["/provider/v1/responses"]),
        );
        expect(seen.every((s) => s.authorization === `Bearer ${TOKEN}`)).toBe(
          true,
        );
        // The engine adds no signature of its own to commits or pull requests.
        // The body is the real prompt (it carries the person's text and the
        // tool), so an empty match means the engine left the text out.
        const first = seen.find((s) => s.path.endsWith("/responses"));
        expect(first?.body).toContain("say hello");
        expect(first?.body).toContain("exec_command");
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
        startOf(server.port as number, work, "resume", threadId),
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
      await server.stop(true);
    }
  }, 60_000);
});
