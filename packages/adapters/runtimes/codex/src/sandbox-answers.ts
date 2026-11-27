import { basename } from "node:path";
import { keptForPerson, writeKeptForPerson } from "@werft-ai/runtime-core";

const SHELLS = ["sh", "bash", "zsh"];
/** Programs whose arguments start a shell or another program this cannot place. */
const STARTS_A_SHELL = [...SHELLS, "dash", "ksh", "fish", "env", "sudo", "su"];
const PLAIN = /[\w@%+=:,./-]/;
const ESCAPED_IN_DOUBLE = ["$", "`", '"', "\\"];

/** The argv a shell-quoted join reads back as; undefined when it is more than words. */
function wordsOf(joined: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < joined.length; i += 1) {
    const char = joined[i] as string;
    if (char === " ") {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (char === "'") {
      const end = joined.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word = (word ?? "") + joined.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      let text = "";
      for (i += 1; joined[i] !== '"'; i += 1) {
        const inner = joined[i];
        if (inner === undefined || inner === "$" || inner === "`") {
          return undefined;
        }
        const next = joined[i + 1];
        // The shell takes a backslash and a newline out together.
        if (inner === "\\" && next === "\n") return undefined;
        if (inner === "\\" && next !== undefined) {
          text += ESCAPED_IN_DOUBLE.includes(next) ? next : inner + next;
          i += 1;
        } else {
          text += inner;
        }
      }
      word = (word ?? "") + text;
    } else if (char === "\\" && joined[i + 1] === "\n") {
      return undefined;
    } else if (char === "\\" && i + 1 < joined.length) {
      word = (word ?? "") + joined[i + 1];
      i += 1;
    } else if (PLAIN.test(char)) {
      word = (word ?? "") + char;
    } else {
      return undefined;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/**
 * The line a command request runs. The engine reports argv joined with shell
 * quoting, and a tool call's script arrives inside its own shell
 * (`/bin/zsh -lc '<script>'`); the ask patterns are written for the script.
 * Undefined when the request does not read back as words, or starts a shell
 * in a form this does not know (`bash -c '<script>' name`, `env bash -c`,
 * `bash --login -c`): which script runs there is not certain.
 */
export function scriptOf(command: string): string | undefined {
  const words = wordsOf(command);
  if (words === undefined) return undefined;
  const [first, flag, script] = words;
  if (first === undefined) return undefined;
  if (!STARTS_A_SHELL.includes(basename(first))) return command;
  return words.length === 3 &&
    SHELLS.includes(basename(first)) &&
    (flag === "-lc" || flag === "-c")
    ? script
    : undefined;
}

/**
 * Whether the run answers a command request itself: the same reading the
 * Claude adapter gives its default mode. What it keeps goes to a person.
 */
export function sandboxAnswersCommand(
  params: Record<string, unknown>,
  workspace: string,
): boolean {
  const { command, cwd, kind } = params;
  if (typeof command !== "string" || typeof cwd !== "string") return false;
  if (kind !== undefined && kind !== "command") return false;
  const line = scriptOf(command);
  return (
    line !== undefined &&
    keptForPerson(line, { workspace, shell: cwd }) === null
  );
}

const CHANGE_KINDS = ["add", "update", "delete"];
const MOVE_KEYS = ["move_path", "movePath"];

/**
 * Every path a file change touches, a move's destination included, or
 * undefined when a record is not in a shape this knows: an answer is given
 * only for a change read whole.
 */
export function changeTargets(changes: unknown): string[] | undefined {
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  const targets: string[] = [];
  for (const change of changes) {
    if (typeof change !== "object" || change === null) return undefined;
    const { path, kind, ...more } = change as Record<string, unknown>;
    if (typeof path !== "string" || path === "") return undefined;
    targets.push(path);
    const fields =
      typeof kind === "object" && kind !== null && !Array.isArray(kind)
        ? (kind as Record<string, unknown>)
        : { type: kind };
    if (
      typeof fields.type !== "string" ||
      !CHANGE_KINDS.includes(fields.type)
    ) {
      return undefined;
    }
    // A destination is read wherever the record carries it.
    const { type: _type, ...inKind } = fields;
    const { diff: _diff, ...beside } = more;
    for (const [key, value] of [
      ...Object.entries(beside),
      ...Object.entries(inKind),
    ]) {
      if (!MOVE_KEYS.includes(key)) return undefined;
      if (typeof value === "string" && value !== "") targets.push(value);
      else if (value !== null && value !== undefined) return undefined;
    }
  }
  return targets;
}

/** The same for a file change: every path it touches, and no wider grant. */
export function sandboxAnswersChange(
  changes: unknown,
  grantRoot: unknown,
  workspace: string,
): boolean {
  if (grantRoot !== undefined && grantRoot !== null) return false;
  const targets = changeTargets(changes);
  return (
    targets?.every((path) => writeKeptForPerson(path, workspace) === null) ??
    false
  );
}
