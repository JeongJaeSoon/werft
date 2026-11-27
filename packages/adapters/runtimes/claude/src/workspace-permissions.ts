import { realpathSync } from "node:fs";
import { WORKSPACE_POLICY, workspaceAskPatterns } from "@werft-ai/runtime-core";

/**
 * The shared workspace policy (`WORKSPACE_POLICY` in runtime-core) as this
 * engine's permission rules, handed to it as flag settings, which a
 * repository's `.claude/settings.json` cannot widen or drop.
 *
 * The engine judges deny, then ask, then allow, and the first match wins, so
 * the `ask` list carves the paths and flags that must still reach a person out
 * of the broad `allow`. A compound command (`a && b`, `a; b`, `a | b`, `$(b)`)
 * is split by the engine and every part has to match an allow rule; one part
 * outside asks for the whole. The engine resolves symlinks before it matches a
 * path rule, so a link inside the workspace that points out is judged by where
 * it leads, and it checks a redirect target the same way.
 *
 * These are text rules, a safety net and not a boundary. Code the session
 * writes into its workspace and then runs (a test, a package script, a git
 * hook the repository ships) is not inspected; the container and its egress
 * proxy are what hold that.
 */

const policy = WORKSPACE_POLICY;

export type WorkspaceRules = { allow: string[]; ask: string[] };

/**
 * A path the rule syntax cannot carry literally is left out, so the file
 * rules vanish and the engine asks, rather than a glob or a bracket widening
 * the rule past the workspace.
 */
const LITERAL_PATH = /^\/[\w./@+,:=-]*$/;

function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function workspaceRoots(cwd: string): string[] {
  const roots = new Set<string>();
  for (const candidate of [cwd, tryRealpath(cwd)]) {
    const trimmed = candidate.replace(/\/+$/, "");
    if (trimmed !== "" && LITERAL_PATH.test(trimmed)) roots.add(trimmed);
  }
  return [...roots];
}

/**
 * The rules for a session, whatever its tool surface. They are written for
 * every tool and widen nothing: a tool the release's tool list or the rules deny
 * is out of the model's list, and a deny beats an allow in every layer.
 */
export function workspaceRules(cwd: string): WorkspaceRules {
  const allow: string[] = [];
  const ask: string[] = [];
  // The engine applies an Edit rule to every file-writing tool.
  for (const root of workspaceRoots(cwd)) {
    allow.push(`Edit(/${root}/**)`);
    for (const path of policy.sensitiveEditPaths) {
      ask.push(`Edit(/${root}/${path})`);
    }
  }
  addBashRules(allow, ask);
  return { allow, ask };
}

function addBashRules(allow: string[], ask: string[]): void {
  for (const command of [
    ...policy.git.allow,
    ...policy.read.allow,
    ...policy.fs.allow,
    ...policy.dev.commands,
  ]) {
    allow.push(`Bash(${command})`, `Bash(${command} *)`);
  }
  ask.push(...workspaceAskPatterns().map((pattern) => `Bash(${pattern})`));
}
