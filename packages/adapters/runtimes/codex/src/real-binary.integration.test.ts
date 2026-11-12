/**
 * Runs the pinned `codex app-server` itself against a fake Responses upstream.
 * The unit tests answer for the adapter's side of the protocol; this one is
 * for what only the real build can say: that it accepts every setting the
 * adapter passes, reaches only the route it was given, and resumes a thread
 * from a rollout written to another directory.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@werft-ai/runtime-core";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";
import { sha256Hex, startFakeMcp } from "@werft-ai/testkit/fake-mcp";

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
    // The engine gets its own copy of the environment: the suites share one
    // process in CI, and a proxy set in process.env (even briefly) sent later
    // loopback fetches of other files to a closed port. A NO_PROXY of `*` or a
    // listed host would send the engine around the recorder, so it is cleared
    // (the adapter adds the egress host to it itself).
    const proxied: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ["NO_PROXY", "no_proxy"]) delete proxied[name];
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
    ]) {
      proxied[name] = `http://127.0.0.1:${proxy.port}`;
    }
    const proxyEnvBefore = [process.env.HTTP_PROXY, process.env.NO_PROXY];
    try {
      const runtime = new CodexAgentRuntime(
        { stateDir: first } as never,
        proxied,
      );
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
      const resumed = new CodexAgentRuntime(
        { stateDir: second } as never,
        proxied,
      ).start(
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
        // The resumed engine too reaches no other host.
        await Bun.sleep(2000);
        expect(attempts).toEqual([]);
        // Nothing is left behind in this process: the other suites share it.
        expect([process.env.HTTP_PROXY, process.env.NO_PROXY]).toEqual(
          proxyEnvBefore,
        );
      } finally {
        await resumed.close();
      }
    } finally {
      proxy.stop(true);
      await server.stop(true);
    }
  }, 60_000);

  /** One turn in which the model calls the platform tool, the run judging it with `refusal`. */
  async function platformToolTurn(refusal: string | null) {
    const upstream = await startFakeMcp({
      bearer: "upstream-bearer-real",
      marker: "real",
    });
    const seen: Seen[] = [];
    const server = fakeResponses(seen, (call) =>
      call === 1
        ? [
            {
              type: "function_call",
              call_id: "call_mcp_1",
              namespace: "mcp__fake",
              name: "whoami",
              arguments: "{}",
            },
          ]
        : [assistantMessage("done")],
    );
    const label = refusal === null ? "ok" : "no";
    const work = join(root, `work-mcp-${label}`);
    await Bun.write(join(work, ".keep"), "");
    const base = startOf({
      port: server.port as number,
      work,
      egressToken: "egress-token-mcp",
    });
    const tool = "mcp__fake__whoami";
    const start = {
      ...base,
      bundle: {
        ...base.bundle,
        mcpServers: [
          {
            name: "fake",
            binding: "release-real",
            url: `http://127.0.0.1:${upstream.port}/mcp`,
            token: "upstream-bearer-real",
            tools: [tool],
            platform: true,
            trusted: [tool],
          },
        ],
      },
      config: { ...base.config, tools: ["exec_command", tool] },
    } as unknown as typeof base;
    const asked: string[] = [];
    const runtime = new CodexAgentRuntime(
      {
        stateDir: join(root, `mcp-state-${label}`),
        precheckTool: async (name: string) => {
          asked.push(name);
          return refusal;
        },
      } as never,
      { ...process.env },
    );
    const run = runtime.start(start);
    try {
      const events = await turn(run, "in-1", "who am i");
      return { events, seen, asked, tool, reached: upstream.calls() };
    } finally {
      await run.close();
      await server.stop(true);
      await upstream.stop();
    }
  }

  test("a platform tool is reached only through the relay, judged per call, with the server's own bearer", async () => {
    const { events, seen, asked, tool, reached } = await platformToolTurn(null);
    expect(events.find((e) => e.type === "turn.ended")).toMatchObject({
      turn: { isError: false },
    });
    // The engine lists the server's tools in the namespace `mcp__<server>`,
    // called one, and the judgment ran for exactly that call.
    const first = JSON.parse(
      seen.find((s) => s.path.endsWith("/responses"))?.body ?? "{}",
    ) as { tools?: unknown };
    expect(JSON.stringify(first.tools)).toContain('"name":"mcp__fake"');
    expect(asked).toEqual([tool]);
    // The server was called once, with its own bearer and nothing else.
    expect(reached.calls).toBe(1);
    expect(reached.authorization_sha256).toEqual([
      sha256Hex("upstream-bearer-real"),
    ]);
    // The model got the server's answer back.
    expect(seen.at(-1)?.body).toContain("ok:real");
    // The public events carry the tool under the platform's name.
    const names = events.flatMap((e) =>
      e.type === "tool.called" ? [e.tool] : [],
    );
    expect(names).toContain(tool);
  }, 60_000);

  test("a call the run refuses never reaches the server, and the model reads why", async () => {
    const { events, seen, asked, tool, reached } = await platformToolTurn(
      "refused: unrelated_history",
    );
    expect(asked).toEqual([tool]);
    expect(reached.calls).toBe(0);
    expect(seen.at(-1)?.body).toContain("refused: unrelated_history");
    expect(events.find((e) => e.type === "turn.ended")).toMatchObject({
      turn: { isError: false },
    });
  }, 60_000);

  // Why the descriptor says `approvalCheckpoint: false`. A build that asks
  // again after a resume makes this fail, which is when to look again.
  test("an approval pending when the process ended is not asked again after a resume, and its call reads as aborted", async () => {
    const CALL = "call_pending_1";
    const egressToken = "egress-pending-approval";
    const seen: Seen[] = [];
    const server = fakeResponses(seen, (call) =>
      call === 1
        ? [
            {
              type: "function_call",
              call_id: CALL,
              name: "exec_command",
              arguments: JSON.stringify({
                cmd: "echo pending | tee asked.txt",
              }),
            },
          ]
        : [assistantMessage("carried on")],
    );
    const port = server.port as number;
    const atApproval = join(root, "pending-first");
    const restored = join(root, "pending-second");
    const work = join(root, "work-pending");
    await Bun.write(join(work, ".keep"), "");
    const asks = (events: readonly RuntimeEvent[]) =>
      events.filter((event) => event.type === "approval.requested");
    const until = async (what: string, met: () => boolean) => {
      for (let waited = 0; !met(); waited += 100) {
        if (waited >= 30_000) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(100);
      }
    };
    try {
      // A turn that stops at an approval nobody answers.
      const run = new CodexAgentRuntime({ stateDir: atApproval } as never, {
        ...process.env,
      }).start(startOf({ port, work, egressToken }));
      const before: RuntimeEvent[] = [];
      let threadId = "";
      try {
        await run.ready();
        void (async () => {
          for await (const event of run.events()) before.push(event);
        })();
        run.send({ uuid: "in-1", message: "run the command" });
        await until("the approval", () => asks(before).length === 1);
        expect(asks(before)[0]).toMatchObject({
          request: { toolCallId: CALL },
        });
        const init = before.find(
          (e) => e.type === "public" && e.event.event === "system",
        );
        threadId = String(
          (init as { event: { data: { session_id?: string } } }).event.data
            .session_id,
        );
        expect(threadId).not.toBe("");
        // The engine's state as an approval checkpoint would take it.
        await cp(atApproval, restored, { recursive: true });
      } finally {
        run.abort();
      }

      const calls = seen.length;
      const resumed = new CodexAgentRuntime({ stateDir: restored } as never, {
        ...process.env,
      }).start(
        startOf({
          port,
          work,
          egressToken,
          mode: "resume",
          resume: threadId,
        }),
      );
      const after: RuntimeEvent[] = [];
      try {
        await resumed.ready();
        void (async () => {
          for await (const event of resumed.events()) after.push(event);
        })();
        // Left alone, the resumed thread neither asks again nor calls the model.
        await Bun.sleep(3_000);
        expect(asks(after)).toEqual([]);
        expect(seen.length).toBe(calls);

        // The next input tells the model the call was aborted; it never ran.
        resumed.send({ uuid: "in-2", message: "carry on" });
        await until("the next model call", () => seen.length > calls);
        const input = (
          JSON.parse(seen[calls]?.body ?? "{}") as {
            input?: { call_id?: string; output?: unknown; type?: string }[];
          }
        ).input?.filter((item) => item.call_id === CALL);
        expect(input).toMatchObject([
          { type: "function_call" },
          { type: "function_call_output", output: "aborted" },
        ]);
        await until("the turn to end", () =>
          after.some((event) => event.type === "turn.ended"),
        );
        expect(asks(after)).toEqual([]);
        expect(await Bun.file(join(work, "asked.txt")).exists()).toBe(false);
      } finally {
        resumed.abort();
      }
    } finally {
      await server.stop(true);
    }
  }, 120_000);
});
