import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimePlugin } from "./config.ts";

/** A published bundle tree the engine was pointed at cannot be read as one. */
export class PluginTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginTreeError";
  }
}

/**
 * `<plugin name>:<skill>` for every skill directory of each published tree.
 * The worker verified the tree's content hash before publishing it, so what is
 * listed here is what the engine must report back; a skill it does not report
 * means the bundle was not loaded as published.
 */
export function expectedPluginSkills(
  plugins: readonly RuntimePlugin[],
): string[] {
  const names: string[] = [];
  for (const plugin of plugins) {
    const manifest = readManifestName(plugin.path);
    for (const skill of skillDirectories(plugin.path)) {
      names.push(`${manifest}:${skill}`);
    }
  }
  return names.sort();
}

/** The expected skills the engine's command list does not carry. */
export function missingSkills(
  expected: readonly string[],
  commands: readonly { name: string }[],
): string[] {
  const reported = new Set(commands.map((command) => command.name));
  return expected.filter((skill) => !reported.has(skill));
}

function readManifestName(path: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(join(path, ".claude-plugin", "plugin.json"), "utf8"),
    );
  } catch {
    throw new PluginTreeError(`${path} has no readable plugin manifest`);
  }
  const name =
    typeof parsed === "object" && parsed !== null && "name" in parsed
      ? parsed.name
      : undefined;
  if (typeof name !== "string" || name === "") {
    throw new PluginTreeError(`${path} has a plugin manifest without a name`);
  }
  return name;
}

function skillDirectories(path: string): string[] {
  try {
    return readdirSync(join(path, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    throw new PluginTreeError(`${path} has no skills directory`);
  }
}
