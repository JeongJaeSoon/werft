import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeRuntimeConfig } from "./config.ts";
import {
  expectedPluginSkills,
  missingSkills,
  PluginTreeError,
} from "./plugin-skills.ts";
import { ResumedHistory } from "./resumed-history.ts";
import { ClaudeSdkRun, InputStream } from "./run.ts";
import { ClaudeSdkRuntime } from "./runtime.ts";
import { TurnLedger } from "./turn-ledger.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true });
});

function tree(
  name: string | null,
  skills: string[],
  frontmatter: Record<string, string> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-tree-"));
  made.push(root);
  if (name !== null) {
    mkdirSync(join(root, ".claude-plugin"));
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name }),
    );
  }
  mkdirSync(join(root, "skills"));
  for (const skill of skills) {
    mkdirSync(join(root, "skills", skill));
    writeFileSync(
      join(root, "skills", skill, "SKILL.md"),
      frontmatter[skill] ?? "---\n---\n",
    );
  }
  return root;
}

function run(
  initialization: object,
  expected: readonly string[] | undefined,
): ClaudeSdkRun {
  return new ClaudeSdkRun(
    "run",
    new InputStream(),
    { initializationResult: async () => initialization } as never,
    new AbortController(),
    ResumedHistory.empty(),
    new TurnLedger(),
    undefined,
    undefined,
    expected,
  );
}

describe("expectedPluginSkills", () => {
  test("names every skill of a published tree under the plugin's manifest name", () => {
    const path = tree("lint", ["fix", "check"]);
    expect(expectedPluginSkills([{ path, type: "local" }])).toEqual([
      "lint:check",
      "lint:fix",
    ]);
  });

  test("leaves out a skill the engine does not list because it is not user-invocable", () => {
    const path = tree("lint", ["check", "fix", "helper", "odd"], {
      helper: '---\ndescription: "h"\nuser-invocable: false\n---\nbody\n',
      fix: "---\nuser-invocable: true\n---\n",
      // Not the plain line the registered form has: counted as invocable.
      odd: "---\nuser-invocable: 'false'\n---\n",
    });
    expect(expectedPluginSkills([{ path, type: "local" }])).toEqual([
      "lint:check",
      "lint:fix",
      "lint:odd",
    ]);
  });

  test("a user-invocable: false line outside the frontmatter does not hide a skill", () => {
    const path = tree("lint", ["check"], {
      check: "---\n---\nuser-invocable: false\n",
    });
    expect(expectedPluginSkills([{ path, type: "local" }])).toEqual([
      "lint:check",
    ]);
  });

  test("refuses a tree that cannot be read as a plugin", () => {
    const noManifest = tree(null, ["a"]);
    expect(() =>
      expectedPluginSkills([{ path: noManifest, type: "local" }]),
    ).toThrow(PluginTreeError);
    expect(() =>
      expectedPluginSkills([{ path: "/nonexistent/ext", type: "local" }]),
    ).toThrow(PluginTreeError);
  });
});

describe("missingSkills", () => {
  test("lists the expected names the engine's commands do not carry", () => {
    expect(
      missingSkills(["lint:fix", "lint:check"], [{ name: "lint:fix" }]),
    ).toEqual(["lint:check"]);
    expect(missingSkills([], [])).toEqual([]);
  });
});

describe("a run handed plugins is ready only once the engine loaded them", () => {
  const commands = [{ name: "lint:fix" }, { name: "init" }];

  test("passes when the plugins are applied and every expected skill is reported", async () => {
    await run({ plugins_applied: true, commands }, ["lint:fix"]).ready();
  });

  test("fails when the engine says the plugins were not applied", async () => {
    for (const plugins_applied of [false, undefined]) {
      await expect(
        run({ plugins_applied, commands }, ["lint:fix"]).ready(),
      ).rejects.toThrow("did not load the session's extension bundles");
    }
  });

  test("fails and names the skill the engine did not report", async () => {
    await expect(
      run({ plugins_applied: true, commands }, [
        "lint:fix",
        "lint:check",
      ]).ready(),
    ).rejects.toThrow("lint:check");
  });

  test("a bundle with a user-invocable: false skill starts when the engine reports only the others", async () => {
    const path = tree("lint", ["check", "helper"], {
      helper: "---\nuser-invocable: false\n---\n",
    });
    const expected = expectedPluginSkills([{ path, type: "local" }]);
    await run(
      { plugins_applied: true, commands: [{ name: "lint:check" }] },
      expected,
    ).ready();
    await expect(
      run(
        { plugins_applied: true, commands: [{ name: "lint:helper" }] },
        expected,
      ).ready(),
    ).rejects.toThrow("lint:check");
  });

  test("a run with no plugins is not held to any of it", async () => {
    await run({ commands: [] }, undefined).ready();
  });
});

describe("ClaudeSdkRuntime.start hands the published tree's skills to the readiness check", () => {
  const policy = {
    endpoints: ["https://api.anthropic.com"],
    models: ["primary"],
  };
  const hooks = { onPermission: async () => ({ behavior: "allow" as const }) };

  function started(path: string, initialization: object) {
    const config: ClaudeRuntimeConfig = {
      claudeConfigDir: "/tenant/config",
      correlationId: "start-skills",
      mode: "new",
      cwd: "/tenant/workspace",
      home: "/tenant/home",
      model: "primary",
      profile: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.com",
        auth: { kind: "api_key", value: "placeholder" },
        principal: { ownerScope: "owner-a" },
      },
      identities: { plugins: { [path]: "digest" } },
      plugins: [{ type: "local", path }],
      settingSources: [],
      tools: ["Read"],
    };
    const fake = (() => ({
      initializationResult: async () => initialization,
    })) as never;
    return new ClaudeSdkRuntime(policy, undefined, fake).start(config, hooks);
  }

  test("a tree whose skills the engine reports starts", async () => {
    const path = tree("lint", ["check"]);
    await started(path, {
      plugins_applied: true,
      commands: [{ name: "lint:check" }],
    }).ready();
  });

  test("a tree whose skill the engine does not report fails the start", async () => {
    const path = tree("lint", ["check", "fix"]);
    await expect(
      started(path, {
        plugins_applied: true,
        commands: [{ name: "lint:check" }],
      }).ready(),
    ).rejects.toThrow("lint:fix");
  });

  test("an unreadable tree fails the start before the engine exists", () => {
    expect(() => started("/nonexistent/ext", {})).toThrow(PluginTreeError);
  });

  test("an init reply without a commands list is a clear start failure", async () => {
    const path = tree("lint", ["check"]);
    await expect(
      started(path, { plugins_applied: true }).ready(),
    ).rejects.toThrow("did not list its commands");
  });
});
