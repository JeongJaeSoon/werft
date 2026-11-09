import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  expectedPluginSkills,
  missingSkills,
  PluginTreeError,
} from "./plugin-skills.ts";
import { ResumedHistory } from "./resumed-history.ts";
import { ClaudeSdkRun, InputStream } from "./run.ts";
import { TurnLedger } from "./turn-ledger.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true });
});

function tree(name: string | null, skills: string[]): string {
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
    writeFileSync(join(root, "skills", skill, "SKILL.md"), "---\n---\n");
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

  test("a run with no plugins is not held to any of it", async () => {
    await run({ commands: [] }, undefined).ready();
  });
});
