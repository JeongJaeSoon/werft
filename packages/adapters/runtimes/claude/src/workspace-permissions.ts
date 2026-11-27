import { realpathSync } from "node:fs";
import { WORKSPACE_POLICY } from "@werft-ai/runtime-core";

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

/**
 * The ask patterns for one reader and every spelling of a secret's name.
 * `git` is for a git verb written as `git *<verb>*`, so a global option may
 * come first: the name pattern then follows the verb directly instead of
 * after an operand. It keeps the `-<letter>f` starts only for `clusters`
 * (`git grep -nf.env`).
 */
function secretReadPatterns(
  command: string,
  options: { git: boolean; clusters: boolean } = { git: false, clusters: true },
): string[] {
  const read = policy.secretRead;
  const letters = [...read.clusterLetters];
  const starts = options.clusters
    ? [...read.nameStarts, ...letters.map((l) => `-${l}f`)]
    : read.nameStarts;
  // `cat <name>` has the name as its first operand; `git *show* <name>` is the
  // same shape with the verb already inside `command`.
  const operand = (start: string, name: string) =>
    options.git
      ? `${command}${start.startsWith("-") ? "*" : ""}${start}${name}*`
      : `${command} *${start}${name}*`;
  const joint = options.git ? "" : " ";
  const names = [
    ...policy.secretNameParts.filter(
      (part) =>
        !read.notAReadName.includes(part) && !read.extensions.includes(part),
    ),
    ...read.extraNames,
  ].flatMap((name) => [
    ...(options.git ? [] : [`${command} ${name}*`]),
    ...starts.map((start) => operand(start, name)),
  ]);
  const extensions = read.extensions.flatMap((extension) => [
    `${command}${joint}*${extension}`,
    ...read.extensionEnds.map(
      (end) => `${command}${joint}*${extension}${end}*`,
    ),
  ]);
  return [...names, ...extensions];
}

function rgHiddenPatterns(): string[] {
  const letters = [...policy.secretRead.clusterLetters];
  return [
    ...policy.rgHidden.ask,
    ...[...policy.rgHidden.letterBeforeUU].flatMap((letter) => [
      `rg -${letter}uu*`,
      `rg * -${letter}uu*`,
    ]),
    // Two of the usual flags before `uu` (`-nHuu`).
    ...letters.flatMap((first) =>
      letters.flatMap((second) => [
        `rg -${first}${second}uu*`,
        `rg * -${first}${second}uu*`,
      ]),
    ),
  ];
}

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

/** The Bash ask patterns without their `Bash(...)` wrapping. */
export function bashAskPatterns(): string[] {
  const ask: string[] = [];
  addBashRules([], ask);
  return ask.map((rule) => rule.slice("Bash(".length, -1));
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
  ask.push(
    ...[
      ...policy.git.ask,
      // `git --no-pager add .env` puts a global option before the verb.
      ...policy.git.askWhenSecretNamed.flatMap((command) =>
        policy.secretNameParts.flatMap((part) => [
          `${command} *${part}*`,
          `git * ${command.slice("git ".length)} *${part}*`,
        ]),
      ),
    ].map((pattern) => `Bash(${pattern})`),
  );
  const letters = [...policy.read.inPlaceLetters];
  const bundles = letters.flatMap((a) => [
    a,
    ...letters.map((b) => `${a}${b}`),
  ]);
  ask.push(
    ...[
      ...policy.read.ask,
      ...bundles.flatMap((b) => [`sed -${b}i*`, `sed * -${b}i*`]),
      ...[...policy.read.addressChars].flatMap((c) => [
        `sed *${c}w*`,
        `sed *${c}W*`,
        // A space or a tab may follow the command letter.
        `sed *${c}e *`,
        `sed *${c}e\t*`,
      ]),
    ].map((pattern) => `Bash(${pattern})`),
  );
  ask.push(
    ...[
      ...policy.fs.ask,
      ...policy.fs.askWhenSecretNamed.flatMap((command) =>
        policy.secretNameParts.map((part) => `${command} *${part}*`),
      ),
    ].map((pattern) => `Bash(${pattern})`),
  );
  for (const command of policy.secretRead.readers) {
    ask.push(...secretReadPatterns(command).map((p) => `Bash(${p})`));
  }
  for (const verb of policy.secretRead.gitReaders) {
    ask.push(
      ...secretReadPatterns(`git *${verb}*`, {
        clusters: verb === "grep",
        git: true,
      }).map((p) => `Bash(${p})`),
    );
  }
  ask.push(...rgHiddenPatterns().map((pattern) => `Bash(${pattern})`));
  for (const command of policy.dev.commands) {
    // `*` stands for the operands before the flag, which may be none.
    for (const flag of policy.dev.ask) {
      ask.push(`Bash(${command}${flag.slice(1)})`, `Bash(${command} ${flag})`);
    }
  }
}
