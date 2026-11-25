import { afterEach, describe, expect, test } from "bun:test";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  FAKE_PLATFORM_INSTRUCTIONS,
  type FakePlatformMcp,
  startFakePlatformMcp,
} from "@werft-ai/testkit/fake-platform-mcp";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";
import { remoteMcpRelay } from "./remote-mcp.ts";
import { ClaudeSdkRuntime } from "./runtime.ts";

const BEARER = "platform-mcp-local";
const TOOL = "mcp__werft__probe";

let isolated: IsolatedWorkspace | undefined;
let model: FakeAnthropicServer | undefined;
let platform: FakePlatformMcp | undefined;

afterEach(async () => {
  model?.stop();
  await platform?.stop();
  await isolated?.dispose();
  isolated = undefined;
  model = undefined;
  platform = undefined;
});

/**
 * One turn of the pinned engine, with a platform MCP server behind the relay
 * that comes up as `server` says: what the model was sent, and which tools
 * someone was asked about.
 */
async function turn(
  server: Omit<Parameters<typeof startFakePlatformMcp>[0], "bearer"> = {},
) {
  isolated = await createIsolatedWorkspace({ prefix: "platform-mcp-" });
  const { home, workspace } = isolated;
  platform = startFakePlatformMcp({ ...server, bearer: BEARER });
  // A server with nothing to serve has no tool for the model to call.
  const served = server.bare === true ? [] : [TOOL];
  model = startFakeAnthropicServer((_request, index) =>
    index === 0 && served.length > 0 ? toolReply(TOOL, {}) : textReply("done"),
  );
  const runtime = new ClaudeSdkRuntime({
    endpoints: [model.url],
    models: ["claude-sonnet-4-5"],
  });
  const asked: string[] = [];
  const run = runtime.start(
    {
      claudeConfigDir: home,
      correlationId: "platform-mcp",
      mode: "new" as const,
      cwd: workspace,
      home,
      maxTurns: 4,
      model: "claude-sonnet-4-5",
      profile: {
        kind: "anthropic" as const,
        endpoint: model.url,
        auth: { kind: "api_key" as const, value: "placeholder-local" },
        principal: { ownerScope: "owner-a" },
      },
      settingSources: [],
      // No release pins the server's tool: it is in no allowlist.
      tools: [],
      servedTools: served,
      identities: { mcpServers: { werft: "binding-1" } },
      mcpServers: {
        werft: remoteMcpRelay({
          name: "werft",
          url: platform.url,
          token: BEARER,
          tools: served,
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
  return {
    requests: model.requests.map((request) => JSON.stringify(request.body)),
    asked,
    calls: platform.calls(),
  };
}

/**
 * The pinned engine itself, with a platform MCP server behind the relay: what
 * only the real build can say is whether the server's own words reach the
 * model.
 */
describe("a platform MCP server against the actual SDK", () => {
  test("the model is given the server's instructions and runs the tool it serves unasked", async () => {
    const { requests, asked, calls } = await turn();
    expect(requests).toHaveLength(2);
    // The server's own words, in what the model reads before its first answer.
    expect(requests[0]).toContain(FAKE_PLATFORM_INSTRUCTIONS);
    expect(requests[0]).toContain(TOOL);
    // The tool ran with no one asked, and its answer went back to the model.
    expect(asked).toEqual([]);
    expect(calls).toBe(1);
    expect(requests[1]).toContain("probe:ok");
  }, 90_000);

  test("a server that refuses once and then answers its handshake late still has its instructions with the model", async () => {
    // The engine waits for the relay, and the relay for the server.
    const { requests, calls } = await turn({
      refuseFirst: 1,
      handshakeDelayMs: 6_000,
    });
    expect(requests[0]).toContain(FAKE_PLATFORM_INSTRUCTIONS);
    expect(requests[0]).toContain(TOOL);
    expect(calls).toBe(1);
  }, 90_000);

  // Unlike the Codex engine, which tells the model of a server only once it
  // shows a tool of it.
  test("a server with nothing to serve yet still has its instructions with the model", async () => {
    const { requests } = await turn({ bare: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain(FAKE_PLATFORM_INSTRUCTIONS);
  }, 90_000);
});
