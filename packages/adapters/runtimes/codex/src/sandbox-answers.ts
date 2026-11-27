import { basename } from "node:path";
import { keptForPerson, writeKeptForPerson } from "@werft-ai/runtime-core";

const SHELLS = ["sh", "bash", "zsh"];
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
        if (inner === "\\" && next !== undefined) {
          text += ESCAPED_IN_DOUBLE.includes(next) ? next : inner + next;
          i += 1;
        } else {
          text += inner;
        }
      }
      word = (word ?? "") + text;
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
 * Undefined when the request does not read back as words.
 */
export function scriptOf(command: string): string | undefined {
  const words = wordsOf(command);
  if (words === undefined) return undefined;
  const [shell, flag, script] = words;
  return words.length === 3 &&
    shell !== undefined &&
    SHELLS.includes(basename(shell)) &&
    (flag === "-lc" || flag === "-c")
    ? script
    : command;
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

/** The same for a file change: every path it names, and no wider grant. */
export function sandboxAnswersChange(
  paths: readonly string[],
  grantRoot: unknown,
  workspace: string,
): boolean {
  return (
    (grantRoot === undefined || grantRoot === null) &&
    paths.length > 0 &&
    paths.every((path) => writeKeptForPerson(path, workspace) === null)
  );
}
