import { afterEach, describe, expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
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
import type { ClaudeRuntimeConfig } from "./config.ts";
import { InputStream } from "./run.ts";
import { buildSdkOptions, WEB_FETCH_PREFLIGHT_REASON } from "./runtime.ts";

/**
 * The engine's WebFetch host check (`skipWebFetchPreflight`) against the
 * pinned engine. Every address but loopback goes through a proxy that lets
 * nothing through and records each connection's first line, so the check
 * never reaches a live Anthropic service and always fails.
 */

const FETCH_CALL = "toolu_preflight_fetch";

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;
let target: Bun.TCPSocketListener<undefined> | undefined;
let proxy: Bun.TCPSocketListener<{ at: number }> | undefined;

afterEach(async () => {
  server?.stop();
  target?.stop(true);
  proxy?.stop(true);
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
  target = undefined;
  proxy = undefined;
});

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join(" ");
  if (content !== null && typeof content === "object" && "text" in content) {
    return String((content as { text: unknown }).text);
  }
  return "";
}

async function run(skipWebFetchPreflight: boolean) {
  isolated = await createIsolatedWorkspace({ prefix: "web-fetch-preflight-" });
  const { home, workspace } = isolated;
  const outside: string[] = [];
  let fetched = 0;
  target = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        fetched += 1;
        socket.end();
      },
      data() {},
    },
  });
  proxy = Bun.listen<{ at: number }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { at: outside.push("") - 1 };
      },
      data(socket, chunk) {
        const line = chunk.toString("latin1").split("\r\n")[0] ?? "";
        outside[socket.data.at] = line;
        socket.end();
      },
    },
  });
  let result: { isError: boolean; text: string } | undefined;
  // What the model is sent after the call: the tool result and any context a
  // hook added beside it.
  const after: string[] = [];
  let calls = 0;
  server = startFakeAnthropicServer((request) => {
    const messages = (request.body.messages ?? []) as Array<{
      content?: unknown;
    }>;
    if (!JSON.stringify(messages[0]?.content ?? "").includes("FETCH_PROBE")) {
      return textReply("auxiliary reply");
    }
    calls += 1;
    if (calls === 1) {
      return toolReply(
        "WebFetch",
        {
          url: `http://127.0.0.1:${target?.port}/page`,
          prompt: "Summarize the page",
        },
        FETCH_CALL,
      );
    }
    after.push(JSON.stringify(messages));
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type === "tool_result" && block.tool_use_id === FETCH_CALL) {
          result = {
            isError: block.is_error === true,
            text: textOf(block.content),
          };
        }
      }
    }
    return textReply("done");
  });
  const config: ClaudeRuntimeConfig = {
    claudeConfigDir: home,
    correlationId: "web-fetch-preflight",
    mode: "new",
    cwd: workspace,
    home,
    maxTurns: 4,
    model: "claude-sonnet-4-5",
    permissionMode: "bypassPermissions",
    profile: {
      kind: "anthropic",
      endpoint: server.url,
      auth: { kind: "api_key", value: "placeholder-local" },
      principal: { ownerScope: "owner-a" },
    },
    settingSources: [],
    tools: ["WebFetch"],
    ...(skipWebFetchPreflight ? { skipWebFetchPreflight: true as const } : {}),
  };
  const abortController = new AbortController();
  const options = buildSdkOptions(
    config,
    { onPermission: async () => ({ behavior: "allow" }) },
    undefined,
    abortController,
  );
  const proxyUrl = `http://127.0.0.1:${proxy.port}`;
  const loopback = "127.0.0.1,localhost";
  options.env = {
    ...options.env,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: loopback,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    no_proxy: loopback,
  };
  const input = new InputStream();
  const consume = (async () => {
    for await (const message of query({ prompt: input, options })) {
      if (message.type === "result") input.finish();
    }
  })();
  input.push({
    message: "FETCH_PROBE: fetch the page",
    uuid: crypto.randomUUID(),
  });
  const timer = setTimeout(() => abortController.abort(), 50_000);
  await consume.finally(() => clearTimeout(timer));
  return { outside, fetched, result, after: after.join("\n") };
}

describe("the WebFetch host check against the pinned engine", () => {
  test("on: WebFetch asks Anthropic first, fetches nothing when that fails, and the model is given the reason", async () => {
    const seen = await run(false);
    expect(seen.outside).toEqual(["CONNECT api.anthropic.com:443 HTTP/1.1"]);
    expect(seen.fetched).toBe(0);
    expect(seen.result).toEqual({
      isError: true,
      text: expect.stringContaining(
        "Unable to verify if domain 127.0.0.1 is safe to fetch",
      ),
    });
    expect(seen.after).toContain(WEB_FETCH_PREFLIGHT_REASON);
  }, 60_000);

  test("off: WebFetch dials its target without asking Anthropic", async () => {
    const seen = await run(true);
    expect(seen.outside).toEqual([]);
    expect(seen.fetched).toBeGreaterThan(0);
    expect(seen.after).not.toContain(WEB_FETCH_PREFLIGHT_REASON);
  }, 60_000);
});
