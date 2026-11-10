import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeStart } from "@werft-ai/runtime-core";
import {
  ADAPTER_CONFORMANCE,
  type AdapterConformanceHarness,
} from "@werft-ai/runtime-core/testing/conformance";

import { codexLaunch, modeRunOf } from "./config.ts";
import { CodexAgentRuntime } from "./contract.ts";
import {
  assistantMessage,
  fakeResponses,
  startOf as realStartOf,
  type Seen,
} from "./testing/fake-responses.ts";

function startOf(overrides: {
  gitEnvironment?: unknown;
  mcp?: boolean;
}): RuntimeStart {
  return {
    bindings: {
      provider: {
        kind: "openai_responses",
        endpoint: "https://api.openai.example/",
        auth: {
          kind: "egress_token",
          token: "conformance-egress",
          transport: "http://egress.internal:8080/provider",
        },
      },
      principal: { ownerScope: "owner-a" },
    },
    bundle: {
      instructions: [],
      repoInstructions: null,
      mcpServers: overrides.mcp === true ? [{ name: "github" }] : [],
    },
    config: {
      mode: "new",
      correlationId: "conformance",
      cwd: "/tenant/workspace",
      home: "/tenant/home",
      model: "primary",
      permissionMode: "default",
      tools: ["exec_command"],
      ...(overrides.gitEnvironment === undefined
        ? {}
        : { gitEnvironment: overrides.gitEnvironment }),
    },
  } as unknown as RuntimeStart;
}

const DEPS = { stateDir: "/state" };

/**
 * What the pinned engine would put in a commit message or a pull request
 * description: it is run for one turn in `permissionMode` and the requests it
 * sent are searched for the text it is built to add on its own. Nothing is
 * inferred from the launch arguments.
 */
async function signatureOf(permissionMode: string) {
  // A mode the engine refuses to start in writes nothing, so it signs nothing.
  try {
    modeRunOf(permissionMode as never);
  } catch {
    return { commit: "", pr: "" };
  }
  const root = await mkdtemp(join(tmpdir(), "codex-signature-"));
  const seen: Seen[] = [];
  const server = fakeResponses(seen, () => [assistantMessage("ok")]);
  try {
    const run = new CodexAgentRuntime({
      stateDir: join(root, "state"),
    } as never).start(
      realStartOf({
        port: server.port as number,
        work: root,
        egressToken: "conformance-egress",
        permissionMode,
      }),
    );
    try {
      await run.ready();
      const ended = (async () => {
        for await (const event of run.events()) {
          if (event.type === "turn.ended") return;
        }
      })();
      run.send({ uuid: "sig-1", message: "hello" });
      await ended;
    } finally {
      await run.close();
    }
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
  if (seen.length === 0) throw new Error("The engine sent no request");
  const bodies = seen.map((s) => s.body).join("\n");
  return {
    commit: /Co-authored-by: Codex/.test(bodies) ? "Co-authored-by: Codex" : "",
    pr: /Generated with \[?Codex/.test(bodies) ? "Generated with Codex" : "",
  };
}

const harness: AdapterConformanceHarness = {
  engineSignature: signatureOf,
  engineLaunch(gitEnvironment) {
    const launch = codexLaunch(startOf({ gitEnvironment }), DEPS, {});
    return {
      environment: (
        launch.threadConfig.shell_environment_policy as {
          set: Record<string, string>;
        }
      ).set,
      rest: { args: launch.args, processEnv: launch.env },
    };
  },
  async mcpBundle() {
    try {
      codexLaunch(startOf({ mcp: true }), DEPS, {});
      return "started";
    } catch {
      return "refused";
    }
  },
};

describe("Codex adapter conformance", () => {
  for (const item of ADAPTER_CONFORMANCE) {
    test(item.name, () => item.check(harness), 60_000);
  }

  test("item 3 is not satisfied by a harness that shows nothing", async () => {
    const empty: AdapterConformanceHarness = {
      engineSignature: harness.engineSignature,
      engineLaunch: harness.engineLaunch,
    };
    const item = ADAPTER_CONFORMANCE[2];
    await expect(Promise.resolve(item?.check(empty))).rejects.toThrow(
      "mcpBundle",
    );
  });

  test("item 1 fails for an engine that does sign", async () => {
    const signing: AdapterConformanceHarness = {
      ...harness,
      engineSignature: () => ({ commit: "Co-authored-by: Codex", pr: "" }),
    };
    await expect(
      Promise.resolve(ADAPTER_CONFORMANCE[0]?.check(signing)),
    ).rejects.toThrow();
  });
});
