import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimePlugin } from "./config.ts";

export class PluginTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginTreeError";
  }
}

/** `<plugin name>:<skill>` names of the published trees, sorted. */
export type PluginSkills = {
  all: string[];
  /** Without the `user-invocable: false` ones, which the engine's commands leave out. */
  userInvocable: string[];
  /** Without the `disable-model-invocation: true` ones, which its skill reload leaves out. */
  modelInvocable: string[];
};

export function expectedPluginSkills(
  plugins: readonly RuntimePlugin[],
): PluginSkills {
  const all: string[] = [];
  const userInvocable: string[] = [];
  const modelInvocable: string[] = [];
  for (const plugin of plugins) {
    const manifest = readManifestName(plugin.path);
    for (const skill of skillDirectories(plugin.path)) {
      const name = `${manifest}:${skill}`;
      const head = frontmatterOf(plugin.path, skill);
      all.push(name);
      if (!flagged(head, "user-invocable", "false")) userInvocable.push(name);
      if (!flagged(head, "disable-model-invocation", "true")) {
        modelInvocable.push(name);
      }
    }
  }
  return {
    all: all.sort(),
    userInvocable: userInvocable.sort(),
    modelInvocable: modelInvocable.sort(),
  };
}

export type SkillSetDifference = { missing: string[]; extra: string[] };

/**
 * Compares only plugin-namespaced names. The engine's own commands and
 * skills carry no namespace, and with no setting sources the only plugins
 * are the ones the adapter passed, so every namespaced name has to be one of
 * the session's. Null when the sets match exactly.
 */
export function skillSetDifference(
  expected: readonly string[],
  reported: readonly string[],
): SkillSetDifference | null {
  const namespaced = new Set(reported.filter((name) => name.includes(":")));
  const wanted = new Set(expected);
  const missing = expected.filter((name) => !namespaced.has(name));
  const extra = [...namespaced].filter((name) => !wanted.has(name)).sort();
  return missing.length === 0 && extra.length === 0 ? null : { missing, extra };
}

/** A start the engine's skill set does not match; the session fails, no tool having run. */
export class SkillSetMismatchError extends Error {
  readonly code = "skill_set_mismatch";

  constructor(list: string, difference: SkillSetDifference) {
    const parts = [
      ...(difference.missing.length === 0
        ? []
        : [`missing ${difference.missing.join(", ")}`]),
      ...(difference.extra.length === 0
        ? []
        : [`not attached ${difference.extra.join(", ")}`]),
    ];
    super(
      `skill_set_mismatch: the engine's ${list} differ from the session's skills (${parts.join("; ")})`,
    );
    this.name = "SkillSetMismatchError";
  }
}

function frontmatterOf(path: string, skill: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(path, "skills", skill, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
  return /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
}

/** Only the plain line the registered form has; anything else the start check settles. */
function flagged(
  head: string | undefined,
  key: string,
  value: string,
): boolean {
  return (
    head !== undefined &&
    new RegExp(`^${key}:[ \\t]+${value}[ \\t]*$`, "m").test(head)
  );
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
