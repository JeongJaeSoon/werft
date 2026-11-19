import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";
import type { AgentFrame } from "./driver.ts";
import { ClaudeSdkRuntime } from "./runtime.ts";

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

const REMEMBERED = "ENGINE_MEMORY_SENTINEL";

/**
 * The worker's layout: `<config dir>/projects` is a link onto the workspace
 * volume, so whatever the engine keeps there travels with a checkpoint and
 * is on disk again for the next session of the same agent.
 */
async function layout() {
  isolated = await createIsolatedWorkspace({ prefix: "engine-memory-" });
  const { home, workspace } = isolated;
  const projects = join(workspace, ".git", "agent-platform-transcripts-x");
  await mkdir(projects, { recursive: true });
  await symlink(projects, join(home, "projects"));
  const canonical = (await realpath(workspace)).normalize("NFC");
  const project = join(projects, canonical.replaceAll(/[^a-zA-Z0-9]/g, "-"));
  server = startFakeAnthropicServer(textReply("done"));
  return { home, project, projects, workspace };
}

/** What a session with engine memory on would have left for the next one. */
async function leaveMemory(project: string) {
  const memory = join(project, "memory");
  await mkdir(memory, { recursive: true });
  await writeFile(join(memory, "MEMORY.md"), `- ${REMEMBERED}\n`);
}

async function session(
  paths: { home: string; workspace: string },
  resume?: string,
): Promise<string> {
  const endpoint = server?.url ?? "";
  const run = new ClaudeSdkRuntime({
    endpoints: [endpoint],
    models: ["claude-sonnet-4-5"],
  }).start(
    {
      claudeConfigDir: paths.home,
      correlationId: "engine-memory",
      cwd: paths.workspace,
      home: paths.home,
      maxTurns: 1,
      model: "claude-sonnet-4-5",
      profile: {
        kind: "anthropic",
        endpoint,
        auth: { kind: "api_key", value: "placeholder-local" },
        principal: { ownerScope: "owner-a" },
      },
      settingSources: [],
      tools: ["Read", "Write"],
      ...(resume === undefined
        ? { mode: "new" as const }
        : { localTranscriptResume: true, mode: "resume" as const, resume }),
    },
    {
      onPermission: async () => ({
        behavior: "deny",
        message: "No tools expected",
      }),
    },
  );
  const frames: AgentFrame[] = [];
  const consume = (async () => {
    for await (const frame of run) frames.push(frame);
  })();
  run.send({ message: "hello", uuid: crypto.randomUUID() });
  run.finishInput();
  await consume;
  const id = frames
    .map((frame) => frame.envelope.message.session_id)
    .find((value): value is string => typeof value === "string");
  if (id === undefined) throw new Error("the engine emitted no session id");
  return id;
}

function sentToModel(): string {
  return JSON.stringify(
    server?.requests.map(({ body }) => [body.system, body.messages]),
  );
}

describe("the engine's own memory is off", () => {
  test("a session neither creates a memory file nor is told of one", async () => {
    const paths = await layout();
    await session(paths);
    expect(server?.requests.length).toBeGreaterThan(0);
    expect(await readdir(paths.projects, { recursive: true })).not.toContain(
      join(paths.project.slice(paths.projects.length + 1), "memory"),
    );
    expect(sentToModel()).not.toContain(join(paths.project, "memory"));
    // Nor is it handed the Messages API memory tool (`memory_*` type).
    const tools = server?.requests.flatMap(({ body }) => body.tools ?? []);
    expect(JSON.stringify(tools)).not.toMatch(/"(name|type)":"memory/);
  }, 30_000);

  test("a session resumed from a checkpoint reads no memory the checkpoint carried", async () => {
    const paths = await layout();
    const id = await session(paths);
    await leaveMemory(paths.project);
    const before = server?.requests.length ?? 0;
    await session(paths, id);
    expect(server?.requests.length).toBeGreaterThan(before);
    expect(sentToModel()).not.toContain(REMEMBERED);
  }, 30_000);

  test("a second session of the same agent sees nothing the first one left", async () => {
    const paths = await layout();
    await session(paths);
    await leaveMemory(paths.project);
    await session(paths);
    expect(server?.requests.length).toBeGreaterThan(1);
    expect(sentToModel()).not.toContain(REMEMBERED);
  }, 30_000);
});
