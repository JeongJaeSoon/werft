import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConversationRuntimeTurn,
  conversationRuntimeTurnSchema,
} from "@werft-ai/contracts";
import { installedRuntimes } from "@werft-ai/runtime-registry";
import {
  type FakeAnthropicServer,
  type ReplyResolver,
  startFakeAnthropicServer,
  textReply,
  toolReply,
  toolsReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  type CredentialProxyServer,
  startCredentialProxy,
} from "../apps/egress-proxy/src/credential.ts";
import { createProxyLogger } from "../apps/egress-proxy/src/logger.ts";
import { TopicDirectories } from "../apps/worker/src/conversation/topic-directories.ts";
import { createConversationTurnRunner } from "../apps/worker/src/conversation/turn-runner.ts";
import { until } from "./until.ts";

/**
 * A conversation turn as the conversation runtime runs it, minus the
 * container: the worker's turn runner and the pinned engine it starts, the
 * egress proxy's credential listener in-process, an authorizer that grants a
 * turn's permit the way the control host's does (each new exchange a call of
 * its own, its regrant the same call, each with the permit's limits), and a
 * local fake Messages API behind the proxy.
 */

const AUTHORIZER_BEARER = ["authorizer", "bearer", "for", "this", "test"].join(
  "-",
);
// What only the proxy may hold: it must reach the provider and no file or
// request of the runtime's.
const PROVIDER_KEY = [
  "provider",
  "key",
  "the",
  "runtime",
  "never",
  "holds",
].join("-");
const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 1_024;

// Each exchange the permit was granted for, and the call it became; at most
// `limit` of them, as the server's own count of a turn's calls holds it.
type Grant = { calls: Map<string, string>; limit: number };

let root: string | undefined;
let provider: FakeAnthropicServer | undefined;
let authorizer: ReturnType<typeof Bun.serve> | undefined;
let proxy: CredentialProxyServer | undefined;

afterEach(async () => {
  proxy?.stop();
  authorizer?.stop(true);
  provider?.stop();
  if (root !== undefined) await rm(root, { force: true, recursive: true });
  root = provider = authorizer = proxy = undefined;
});

async function stack(
  replies: ReplyResolver,
  options: { calls?: number; limitMs?: number; runnerLimits?: boolean } = {},
) {
  root = await realpath(await mkdtemp(join(tmpdir(), "conversation-flow-")));
  provider = startFakeAnthropicServer(replies);
  const upstreamPort = Number(new URL(provider.url).port);
  const grants = new Map<string, Grant>();
  const asked: Array<{ token: string; granted: boolean }> = [];
  const reported: Array<{
    conversation_call_id?: string;
    exchange_id?: string;
  }> = [];
  authorizer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (
        request.headers.get("authorization") !== `Bearer ${AUTHORIZER_BEARER}`
      ) {
        return new Response("no", { status: 401 });
      }
      const path = new URL(request.url).pathname;
      if (path === "/usage") {
        reported.push((await request.json()) as (typeof reported)[number]);
        return Response.json({});
      }
      const { token } = (await request.json()) as { token: string };
      const exchange = request.headers.get("x-werft-exchange-id");
      const grant = grants.get(token);
      const granted =
        grant !== undefined &&
        exchange !== null &&
        (grant.calls.has(exchange) || grant.calls.size < grant.limit);
      asked.push({ token, granted });
      if (!granted || grant === undefined) {
        return new Response("unknown", { status: 401 });
      }
      const callId = grant.calls.get(exchange) ?? crypto.randomUUID();
      grant.calls.set(exchange, callId);
      return Response.json({
        conversation_call_id: callId,
        upstream: {
          url: `http://upstream.test:${upstreamPort}`,
          headers: [["x-api-key", PROVIDER_KEY]],
        },
        request_limits: {
          path: "/v1/messages",
          model: MODEL,
          max_tokens: MAX_TOKENS,
          max_request_bytes: 96 * 1024,
        },
      });
    },
  });
  proxy = startCredentialProxy({
    authorizer: {
      url: `http://127.0.0.1:${authorizer.port}`,
      token: AUTHORIZER_BEARER,
    },
    hostname: "127.0.0.1",
    logger: createProxyLogger("error", () => {}),
    policy: {
      allow: [],
      allowPrivate: [{ host: "upstream.test", port: upstreamPort }],
    },
    port: 0,
    resolve: async (host) => (host === "upstream.test" ? ["127.0.0.1"] : []),
  });
  const [runtime] = installedRuntimes;
  if (runtime === undefined) throw new Error("no runtime installed");
  const topics = new TopicDirectories(root);
  const runner = createConversationTurnRunner({
    runtime,
    egressCredentialUrl: `http://127.0.0.1:${proxy.port}`,
    topics,
    ...(options.limitMs === undefined ? {} : { limitMs: options.limitMs }),
    // A runtime that got past its own count: the engine's stop is far off too.
    ...(options.runnerLimits === false
      ? { modelCallLimit: 100, toolCallLimit: 100 }
      : {}),
  });
  /** A turn with a fresh permit the authorizer grants, unless `known` is false. */
  const turn = (
    topicId: string,
    text: string,
    known = true,
  ): ConversationRuntimeTurn & { token: string } => {
    const token = ["wct", crypto.randomUUID()].join("_");
    if (known) {
      grants.set(token, {
        calls: new Map(),
        limit: options.calls ?? Number.POSITIVE_INFINITY,
      });
    }
    return {
      ...conversationRuntimeTurnSchema.parse({
        turn_id: crypto.randomUUID(),
        lease_id: crypto.randomUUID(),
        lease_expires_at: new Date(Date.now() + 150_000).toISOString(),
        scope: {
          workspace_id: crypto.randomUUID(),
          agent_id: crypto.randomUUID(),
          conversation_id: crypto.randomUUID(),
          topic_id: topicId,
        },
        model: MODEL,
        provider: {
          kind: "anthropic",
          endpoint: "https://api.anthropic.com",
          auth: { kind: "egress_token", token },
        },
        call: { max_tokens: MAX_TOKENS },
        input: { id: crypto.randomUUID(), text },
      }),
      token,
    };
  };
  const live = new AbortController().signal;
  return {
    root,
    provider,
    topics,
    runner,
    turn,
    asked,
    reported,
    grants,
    live,
  };
}

/** Every regular file under `directory`, with its text. */
async function filesUnder(directory: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const name of await readdir(directory, { recursive: true })) {
    const path = join(directory, name);
    // The engine removes its own pid file as it exits: gone is not a file.
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null) found.set(path, text);
  }
  return found;
}

const requestText = (request: FakeAnthropicServer["requests"][number]) =>
  JSON.stringify(request.body);

describe("a conversation turn on the pinned engine, behind the egress proxy", () => {
  test("runs to its end on one provider call, which the proxy credentials and the call's limits hold", async () => {
    const s = await stack(() => textReply("the answer"));
    const turn = s.turn(crypto.randomUUID(), "what is the status?");

    expect(await s.runner.run(turn, s.live)).toEqual({
      outcome: "completed",
      text: "the answer",
    });

    // One call, and the provider saw the proxy's credential, not the token.
    expect(s.provider.requests).toHaveLength(1);
    const [request] = s.provider.requests;
    expect(request?.headers["x-api-key"]).toBe(PROVIDER_KEY);
    expect(JSON.stringify(request?.headers)).not.toContain(turn.token);
    expect(request?.body.model).toBe(MODEL);
    // The engine asked for no more output than the call was reserved with.
    expect(request?.body.max_tokens).toBe(MAX_TOKENS);
    expect(s.asked).toEqual([{ token: turn.token, granted: true }]);
    // Settled on the call the proxy was granted for that exchange.
    const report = await until(
      async () => s.reported[0],
      "the call's usage report",
    );
    expect(report.conversation_call_id).toBe(
      [...(s.grants.get(turn.token)?.calls.values() ?? [])][0],
    );
  }, 60_000);

  test("a turn whose token the control host does not grant never reaches the provider", async () => {
    const s = await stack(() => textReply("unreachable"));
    const turn = s.turn(crypto.randomUUID(), "hello", false);

    expect((await s.runner.run(turn, s.live)).outcome).toBe("failed");

    expect(s.asked.length).toBeGreaterThan(0);
    expect(s.asked.every((ask) => !ask.granted)).toBe(true);
    expect(s.provider.requests).toHaveLength(0);
  }, 60_000);

  test("offers the model no tool, and runs none the model calls anyway", async () => {
    let s: Awaited<ReturnType<typeof stack>> | undefined;
    const probe = () => join(s?.root ?? "", "ran-by-a-tool");
    let calls = 0;
    s = await stack(() => {
      calls += 1;
      return calls === 1
        ? toolReply("Bash", {
            command: `touch ${probe()}`,
            description: "probe",
          })
        : calls === 2
          ? toolReply("Write", { file_path: probe(), content: "x" })
          : textReply("done");
    });

    const shell = await s.runner.run(
      s.turn(crypto.randomUUID(), "run it"),
      s.live,
    );
    const write = await s.runner.run(
      s.turn(crypto.randomUUID(), "write it"),
      s.live,
    );

    // Each tool call went nowhere: the model was told so and called again,
    // and the first turn ended on its third call's answer.
    expect(shell).toEqual({ outcome: "completed", text: "done" });
    expect(write).toEqual({ outcome: "completed", text: "done" });
    expect(s.provider.requests).toHaveLength(4);
    for (const request of s.provider.requests) {
      expect(request.body.tools ?? []).toEqual([]);
    }
    expect(await stat(probe()).catch(() => null)).toBeNull();
  }, 90_000);

  test("keeps each topic's files and session to its own directory, and removes them with the topic", async () => {
    const s = await stack(() => textReply("noted"));
    const [topicA, topicB] = [crypto.randomUUID(), crypto.randomUUID()];
    const markerA = `marker-a-${crypto.randomUUID()}`;
    const markerB = `marker-b-${crypto.randomUUID()}`;
    const turnA = s.turn(topicA, `remember ${markerA}`);
    const turnB = s.turn(topicB, `remember ${markerB}`);

    expect((await s.runner.run(turnA, s.live)).outcome).toBe("completed");
    // Topic A is still held: what it left is there for B to find, if B could.
    expect((await s.runner.run(turnB, s.live)).outcome).toBe("completed");

    const [requestA, requestB] = s.provider.requests;
    expect(requestText(requestA as never)).toContain(markerA);
    expect(requestText(requestB as never)).toContain(markerB);
    expect(requestText(requestB as never)).not.toContain(markerA);

    const files = await filesUnder(s.root);
    const holding = (marker: string) =>
      [...files]
        .filter(([, text]) => text.includes(marker))
        .map(([path]) => path);
    // The engine kept each session, and only under its own topic.
    expect(holding(markerA).length).toBeGreaterThan(0);
    expect(holding(markerB).length).toBeGreaterThan(0);
    expect(
      holding(markerA).every((path) => path.startsWith(join(s.root, topicA))),
    ).toBe(true);
    expect(
      holding(markerB).every((path) => path.startsWith(join(s.root, topicB))),
    ).toBe(true);

    // No provider credential and no call token in any file, and no checkout.
    for (const [path, text] of files) {
      expect({ path, key: text.includes(PROVIDER_KEY) }).toEqual({
        path,
        key: false,
      });
      expect({
        path,
        token: text.includes(turnA.token) || text.includes(turnB.token),
      }).toEqual({ path, token: false });
      expect(path).not.toContain(`${join("/", ".git")}/`);
    }
    expect(await readdir(join(s.root, topicA, "work"))).toEqual([]);

    await s.topics.drop(topicA as never);
    expect(await stat(join(s.root, topicA)).catch(() => null)).toBeNull();
    // Dropping one topic leaves the other.
    expect((await stat(join(s.root, topicB))).isDirectory()).toBe(true);
  }, 90_000);
});

/** The processes whose command line names `directory`: the engine a topic started. */
async function processesUnder(directory: string): Promise<string[]> {
  const listed = await Bun.$`ps -axww -o command=`.quiet().text();
  return listed.split("\n").filter((line) => line.includes(directory));
}

describe("a conversation turn's limits, counted by the runner on the pinned engine", () => {
  test("a turn whose every call asks for a tool is cut before its ninth provider call, and leaves no engine running", async () => {
    const s = await stack(
      (_request, index) => toolReply("Bash", { command: `echo ${index}` }),
      // A ninth call the engine sends before the cut lands is the server's
      // to refuse, as the turn's permit does.
      { calls: 8 },
    );
    const turn = s.turn(crypto.randomUUID(), "keep going");

    expect(await s.runner.run(turn, s.live)).toEqual({
      outcome: "failed",
      reason: "model_call_limit",
    });
    expect(s.provider.requests).toHaveLength(8);
    expect(await processesUnder(s.root)).toEqual([]);
  }, 120_000);

  test("a response asking for thirteen tool calls cuts the turn before any of them runs", async () => {
    const s = await stack(
      () =>
        toolsReply(
          Array.from({ length: 13 }, (_, index) => ({
            id: `toolu_${index}`,
            name: "Bash",
            input: { command: `echo ${index}` },
          })),
        ),
      { calls: 1 },
    );

    expect(
      await s.runner.run(s.turn(crypto.randomUUID(), "all at once"), s.live),
    ).toEqual({ outcome: "failed", reason: "tool_call_limit" });
    expect(s.provider.requests).toHaveLength(1);
    expect(await processesUnder(s.root)).toEqual([]);
  }, 90_000);

  test("a turn within its limits ends on the model's answer", async () => {
    const s = await stack(
      (_request, index) =>
        index < 3
          ? toolsReply(
              Array.from({ length: 4 }, (_, call) => ({
                id: `toolu_${index}_${call}`,
                name: "Bash",
                input: { command: "true" },
              })),
            )
          : textReply("done"),
      { calls: 4 },
    );

    expect(
      await s.runner.run(s.turn(crypto.randomUUID(), "go"), s.live),
    ).toEqual({ outcome: "completed", text: "done" });
    // Twelve tool calls over four provider calls: both counts at their limit or under.
    expect(s.provider.requests).toHaveLength(4);
  }, 90_000);

  test("a turn still waiting on its provider call at the time limit is cut there, and leaves no engine running", async () => {
    let seenEngine: string[] = [];
    let s: Awaited<ReturnType<typeof stack>> | undefined;
    s = await stack(
      async () => {
        seenEngine = await processesUnder(s?.root ?? "/nowhere");
        await Bun.sleep(20_000);
        return textReply("too late");
      },
      { limitMs: 3_000 },
    );
    const turn = s.turn(crypto.randomUUID(), "take your time");

    expect(await s.runner.run(turn, s.live)).toEqual({
      outcome: "failed",
      reason: "time_limit",
    });
    // The check sees an engine while one runs, and none once the turn is cut.
    expect(seenEngine.length).toBeGreaterThan(0);
    expect(
      await until(
        async () =>
          (await processesUnder(s?.root ?? "")).length === 0 || undefined,
        "the engine gone",
      ),
    ).toBe(true);
    expect(s.provider.requests).toHaveLength(1);
  }, 60_000);
});

describe("a conversation turn's limits behind a runtime that does not count", () => {
  test("its calls stop at the permit's count, whatever the runtime asks for", async () => {
    const s = await stack(
      (_request, index) => toolReply("Bash", { command: `echo ${index}` }),
      // The server's count of a turn's calls, as the permit holds it.
      { calls: 8, runnerLimits: false },
    );

    const ended = await s.runner.run(s.turn(crypto.randomUUID(), "go"), s.live);

    expect(ended).toMatchObject({ outcome: "failed", reason: "engine_failed" });
    expect(s.provider.requests).toHaveLength(8);
    expect(s.asked.filter((ask) => !ask.granted)).toHaveLength(1);
    expect(await processesUnder(s.root)).toEqual([]);
  }, 120_000);
});
