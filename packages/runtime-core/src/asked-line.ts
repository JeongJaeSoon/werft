import { lstatSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { workspaceAskPatterns } from "./workspace-ask-patterns.ts";
import { WORKSPACE_POLICY } from "./workspace-policy.ts";

/**
 * A shell line or a file write an engine asked a person about, read by the
 * workspace policy. What holds a session is its container, the egress
 * allowlist and the token it is given, so an engine's ask is not a gate, and
 * an adapter answers for the engine instead of putting a card to a person.
 * Two readings, both of the same lists the engines' rules are made from:
 *
 * - `keptForPerson`: the wide one. Everything passes but what the policy
 *   still keeps for a person and can be seen in the line: a part an ask rule
 *   names, a write to a secret, `.git` or engine-settings path, and a path
 *   that leaves the workspace. A line that cannot be split with certainty
 *   (a substitution, a pipe, a variable) passes unless one of those shows in
 *   its text.
 * - `askedLineRefusal`: the narrow one, for a mode where another judge (the
 *   Claude engine's auto classifier) stands behind the ask and must not be
 *   overruled. A line passes only when it splits with certainty and every
 *   part is a command the policy allows.
 *
 * The Claude engine asks about a line its parser does not read to the end (a
 * file redirect and a heredoc after `&&`), and it does not say why it asked
 * in a way to rely on, so the line is read here rather than taken on the
 * engine's word.
 */
const policy = WORKSPACE_POLICY;
const ASK_PATTERNS = workspaceAskPatterns();

/**
 * Readers the Claude engine runs unasked on its own, so no allow rule names
 * them. Here nothing has judged the line, so they are named.
 */
const READERS = ["cat", "head", "tail", "wc", "ls", "pwd", "grep"];
/** Their operands are text, never a path. */
const PRINTERS = ["echo", "printf"];
/** `a..b` is a range and `origin/main` a ref there; the ask patterns guard them. */
const REF_COMMANDS = ["git", "gh"];

// `sed` is not in the narrow list: its script is a language of its own.
const NARROW = [
  ...policy.git.allow,
  ...policy.fs.allow,
  ...READERS,
  ...PRINTERS,
].map((command) => command.split(" "));

/**
 * The Claude engine asks for a write under most dot names of its own accord
 * (`.gitmodules`, `.vscode/`, `.husky/`, a shell profile). The narrow
 * reading must not pass what the engine asked about for a rule of its own,
 * so there a written path may name only these.
 */
const OPEN_DOT_DIRECTORY = ".github";
const OPEN_DOT_FILES = [".gitignore", ".editorconfig"];

const BARE = /[\w./:=@+,%-]/;
const DELIMITER = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Part = {
  words: string[];
  /** The words as they were written, quotes included. */
  written: string[];
  redirect?: { op: ">" | ">>"; target: string };
};

type Token =
  | { kind: "word"; text: string; written: string }
  | { kind: "end"; op: "&&" | ";" | "\n" }
  | { kind: "redirect"; op: ">" | ">>" };

/** The tokens of a line, or why it cannot be split with certainty. */
function tokensOf(command: string): Token[] | string {
  const tokens: Token[] = [];
  let pending: string | undefined;
  let i = 0;
  while (i < command.length) {
    const char = command[i] as string;
    if (char === " " || char === "\t") {
      i += 1;
      continue;
    }
    if (char === "\n") {
      i += 1;
      if (pending !== undefined) {
        // The body is data: it runs nothing under a quoted delimiter.
        const close = `\n${pending}`;
        const from = i - 1;
        let end = command.indexOf(close, from);
        while (
          end !== -1 &&
          end + close.length < command.length &&
          command[end + close.length] !== "\n"
        ) {
          end = command.indexOf(close, end + 1);
        }
        if (end === -1) return "a heredoc without its end";
        i = end + close.length;
        pending = undefined;
      }
      tokens.push({ kind: "end", op: "\n" });
      continue;
    }
    if (pending !== undefined) return "text after a heredoc start";
    if (char === "&") {
      if (command[i + 1] !== "&") return "a background job";
      tokens.push({ kind: "end", op: "&&" });
      i += 2;
      continue;
    }
    if (char === ";") {
      tokens.push({ kind: "end", op: ";" });
      i += 1;
      continue;
    }
    if (char === ">") {
      const glued = i > 0 && BARE.test(command[i - 1] as string);
      const op = command[i + 1] === ">" ? ">>" : ">";
      i += op.length;
      if (glued || "&|(>".includes(command[i] ?? "")) {
        return "a redirect that is not a plain file";
      }
      tokens.push({ kind: "redirect", op });
      continue;
    }
    if (char === "<") {
      const quote = command[i + 2];
      if (command[i + 1] !== "<" || (quote !== "'" && quote !== '"')) {
        return "an input redirect other than a quoted heredoc";
      }
      const close = command.indexOf(quote, i + 3);
      const delimiter = close === -1 ? "" : command.slice(i + 3, close);
      if (!DELIMITER.test(delimiter)) return "a heredoc delimiter";
      pending = delimiter;
      i = close + 1;
      continue;
    }
    let text = "";
    const start = i;
    for (; i < command.length; i += 1) {
      const next = command[i] as string;
      if (BARE.test(next)) {
        text += next;
      } else if (next === "'") {
        const close = command.indexOf("'", i + 1);
        if (close === -1) return "an open quote";
        text += command.slice(i + 1, close);
        i = close;
      } else if (next === '"') {
        const close = command.indexOf('"', i + 1);
        if (close === -1) return "an open quote";
        const quoted = command.slice(i + 1, close);
        if (/[$`\\!]/.test(quoted)) return "an expansion in a quote";
        text += quoted;
        i = close;
      } else if (" \t\n;&<>".includes(next)) {
        break;
      } else {
        return `a ${next} outside a quote`;
      }
    }
    tokens.push({ kind: "word", text, written: command.slice(start, i) });
  }
  return pending === undefined ? tokens : "a heredoc without its body";
}

/** The parts of a line, or why it is not a plain list of simple commands. */
export function partsOf(command: string): Part[] | string {
  const tokens = tokensOf(command);
  if (typeof tokens === "string") return tokens;
  const parts: Part[] = [];
  let current: Part = { words: [], written: [] };
  let dangling = false;
  const empty = () =>
    current.words.length === 0 && current.redirect === undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    if (token.kind === "word") {
      current.words.push(token.text);
      current.written.push(token.written);
    } else if (token.kind === "redirect") {
      const target = tokens[i + 1];
      if (target?.kind !== "word" || current.redirect !== undefined) {
        return "a redirect without one target";
      }
      current.redirect = { op: token.op, target: target.text };
      i += 1;
    } else if (!empty()) {
      parts.push(current);
      current = { words: [], written: [] };
      dangling = token.op === "&&";
    } else if (token.op !== "\n") {
      return "an empty command";
    }
  }
  if (!empty()) parts.push(current);
  else if (dangling) return "an empty command";
  return parts.length === 0 ? "an empty command" : parts;
}

const globOf = (pattern: string, any: string) =>
  pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, any);

const compiled = new WeakMap<readonly string[], RegExp[]>();
/** The engines' rule syntax: `*` is any run of characters. */
function asked(patterns: readonly string[], text: string): boolean {
  let rules = compiled.get(patterns);
  if (rules === undefined) {
    rules = patterns.map(
      (pattern) => new RegExp(`^${globOf(pattern, "[\\s\\S]*")}$`),
    );
    compiled.set(patterns, rules);
  }
  return rules.some((rule) => rule.test(text));
}

const SENSITIVE = policy.sensitiveEditPaths.map((pattern) => {
  const source = pattern
    .split("**/")
    .map((piece) =>
      piece
        .split("/**")
        .map((inner) => globOf(inner, "[^/]*"))
        .join("(?:/.*)?"),
    )
    .join("(?:.*/)?");
  return new RegExp(`^${source}$`, "i");
});

/** Where a line runs: the workspace, and the directory its shell stands in. */
export type LinePlace = {
  workspace: string;
  /** Undefined when it is not known; then nothing passes. */
  shell: string | undefined;
};

type Place = { root: string; base: string };

function placeOf(at: LinePlace): Place | string {
  if (at.shell === undefined) return "a shell whose place is not known";
  try {
    const root = realpathSync(at.workspace);
    const base = realpathSync(at.shell);
    return base === root || base.startsWith(root + sep)
      ? { root, base }
      : "a shell outside the workspace";
  } catch {
    return "a workspace that does not resolve";
  }
}

const inside = (root: string, path: string) =>
  path === root || path.startsWith(root + sep);

/**
 * The path as the workspace names it, or undefined when it leaves: by its
 * spelling, or by a link on the way, as the Claude engine judges one. A
 * `..` is refused outright: after a link it climbs from where the link
 * leads, not from where it is written.
 */
function locate(place: Place, path: string): string | undefined {
  if (path.startsWith("~") || path.split("/").includes("..")) return undefined;
  const full = resolve(place.base, path);
  if (!inside(place.root, full)) return undefined;
  let at = full;
  for (;;) {
    try {
      lstatSync(at);
      break;
    } catch {
      if (at === place.root) return undefined;
      at = dirname(at);
    }
  }
  try {
    if (!inside(place.root, realpathSync(at))) return undefined;
  } catch {
    return undefined;
  }
  return relative(place.root, full).split(sep).join("/");
}

/**
 * Whether a word of a command whose operands are not known to be paths
 * plainly names a place outside the workspace: a home, a climb, a link that
 * leads out, or an absolute path under a directory that exists. `/re/` in an
 * awk or sed script is a pattern: nothing of it exists.
 */
function plainlyOutside(place: Place, word: string): boolean {
  if (word === "/dev/null" || locate(place, word) !== undefined) return false;
  if (!word.startsWith("/")) return true;
  try {
    lstatSync(`/${word.split("/")[1]}`);
    return true;
  } catch {
    return false;
  }
}

/** What in a word may be a path: itself, or the value an option or a `key=` carries. */
function pathsIn(word: string): string[] {
  const value = word.includes("=") ? [word.slice(word.indexOf("=") + 1)] : [];
  if (word.startsWith("--")) return value;
  // `-f/etc/hosts` carries a path inside the option.
  return word.startsWith("-") ? [...value, word.slice(2)] : [...value, word];
}

function dotNamed(segments: string[]): boolean {
  return segments.some(
    (segment, index) =>
      segment.startsWith(".") &&
      !(index === 0 && segment === OPEN_DOT_DIRECTORY) &&
      !(index === segments.length - 1 && OPEN_DOT_FILES.includes(segment)),
  );
}

/** Why a write to this path goes to a person, or null. */
function writeKept(place: Place, path: string, narrow: boolean): string | null {
  const located = locate(place, path);
  if (located === undefined) return "a path outside the workspace";
  if (located === "") return "a write to the workspace itself";
  if (
    SENSITIVE.some((rule) => rule.test(located)) ||
    (narrow && dotNamed(located.split("/")))
  ) {
    return "a written path that goes to a person";
  }
  return null;
}

const startsWith = (words: string[], command: string[]) =>
  command.every((token, index) => words[index] === token);

function partKept(part: Part, place: Place, narrow: boolean): string | null {
  const name = part.words[0];
  if (narrow) {
    if (name === undefined) return "a redirect without a command";
    if (!NARROW.some((command) => startsWith(part.words, command))) {
      return `${name} is not a command the workspace policy allows`;
    }
  }
  const redirect = part.redirect;
  const tail =
    redirect === undefined ? "" : ` ${redirect.op} ${redirect.target}`;
  // The rules were written for the line as typed; a quote taken off must not
  // hide a shape one of them names, nor a quote put on.
  if (
    asked(ASK_PATTERNS, part.words.join(" ") + tail) ||
    asked(ASK_PATTERNS, part.written.join(" ") + tail)
  ) {
    return "a part an ask rule names";
  }
  // `> /dev/null` writes nothing.
  if (redirect !== undefined && redirect.target !== "/dev/null") {
    const kept = writeKept(place, redirect.target, narrow);
    if (kept !== null) return kept;
  }
  if (name === undefined) return null;
  if (REF_COMMANDS.includes(name) || PRINTERS.includes(name)) return null;
  const writes = policy.fs.allow.includes(name);
  // The wide reading knows the operands of these alone to be paths; in any
  // other command it keeps a word only when it plainly leaves the workspace.
  const pathed = narrow || writes || READERS.includes(name);
  for (const word of part.words.slice(1)) {
    if (writes && !word.startsWith("-")) {
      const kept = writeKept(place, word, narrow);
      if (kept !== null) return kept;
    } else if (
      pathsIn(word).some(
        (path) =>
          path !== "" &&
          (pathed
            ? locate(place, path) === undefined
            : plainlyOutside(place, path)),
      )
    ) {
      return "a path outside the workspace";
    }
  }
  return null;
}

/** The line without its heredoc bodies: file content, not words of a command. */
function outsideHeredocs(command: string): string {
  const kept: string[] = [];
  let until: string | undefined;
  for (const line of command.split("\n")) {
    if (until !== undefined) {
      if (line.trim() === until) until = undefined;
      continue;
    }
    kept.push(line);
    until = /<<-?[ \t]*["']?([A-Za-z_]\w*)/.exec(line)?.[1];
  }
  return kept.join("\n");
}

/**
 * A line that does not split: what the policy keeps for a person is looked
 * for in its text, and what cannot be seen passes. A heredoc body is text
 * here too, so one that quotes an asked shape asks.
 */
function unsplitKept(command: string, place: Place): string | null {
  for (const piece of command.split(/&&|\|\||[;|&\n]/)) {
    const text = piece.trim();
    if (
      asked(ASK_PATTERNS, text) ||
      asked(ASK_PATTERNS, text.replace(/['"]/g, ""))
    ) {
      return "a part an ask rule names";
    }
  }
  for (const [, quoted] of command.matchAll(
    />>?[ \t]*("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g,
  )) {
    const target = (quoted as string).replace(/^["']|["']$/g, "");
    // A target the shell computes cannot be seen.
    if (target === "/dev/null" || /[$`]/.test(target)) continue;
    const kept = writeKept(place, target, false);
    if (kept !== null) return kept;
  }
  // A word that plainly leaves the workspace, whatever command it is given
  // to. One the shell computes cannot be seen.
  for (const token of outsideHeredocs(command).split(/[\s;|&()<>]+/)) {
    const word = token.replace(/['"]/g, "");
    if (/[$`\\]/.test(word)) continue;
    if (
      pathsIn(word).some((path) => path !== "" && plainlyOutside(place, path))
    ) {
      return "a path outside the workspace";
    }
  }
  return null;
}

/**
 * The wide reading: why the line still goes to a person, or null when the
 * adapter answers for it.
 */
export function keptForPerson(command: string, at: LinePlace): string | null {
  const place = placeOf(at);
  if (typeof place === "string") return place;
  const parts = partsOf(command);
  if (typeof parts === "string") return unsplitKept(command, place);
  for (const part of parts) {
    const kept = partKept(part, place, false);
    if (kept !== null) return kept;
  }
  return null;
}

/**
 * The narrow reading: null when the line splits with certainty and every
 * part is a command the workspace policy allows, else why it is left to the
 * person the engine asked.
 */
export function askedLineRefusal(
  command: string,
  at: LinePlace,
): string | null {
  const parts = partsOf(command);
  if (typeof parts === "string") return parts;
  const place = placeOf(at);
  if (typeof place === "string") return place;
  for (const part of parts) {
    const kept = partKept(part, place, true);
    if (kept !== null) return kept;
  }
  return null;
}

/**
 * A file tool's write, by the wide reading: why it goes to a person, or
 * null. The path is taken from the workspace root.
 */
export function writeKeptForPerson(
  path: string,
  workspace: string,
): string | null {
  const place = placeOf({ workspace, shell: workspace });
  return typeof place === "string" ? place : writeKept(place, path, false);
}
