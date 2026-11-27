import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { WORKSPACE_POLICY } from "@werft-ai/runtime-core";
import { bashAskPatterns } from "./workspace-permissions.ts";

/**
 * A Bash line the engine asked a person about, read again by the workspace
 * policy. The engine's parser stops at a file redirect and a heredoc after
 * `&&`, `||` or `|` (`mkdir -p d && cat > d/f <<'EOF'`), and a line it did
 * not read to the end is never matched against the allow rules. It does not
 * say so in a way to rely on: the reason it gives differs with what follows
 * the heredoc and is absent for some lines. So every asked Bash line is split
 * here into its parts, and each part is judged by the lists the engine's
 * rules are made from.
 *
 * A line passes only when it can be split with certainty and every part is
 * allowed; anything else goes to the person as before. A substitution, a
 * subshell, a pipe, a variable, a glob or an escape is not split. A line the
 * engine asked about for a rule of its own must not pass here, so this is
 * the stricter reading: the ask rules are matched against each part with and
 * without its quotes, a written path may not name a dot directory, and the
 * shell must stand at the workspace root.
 *
 * Like the rules, it is a net and not a boundary: what holds a session is
 * its container, the egress allowlist and the token it is given.
 */
const policy = WORKSPACE_POLICY;

/**
 * Readers the engine runs unasked on its own, so no allow rule names them.
 * Here nothing has judged the line, so they are named.
 */
const READERS = ["cat", "head", "tail", "wc", "ls", "pwd", "grep"];
/** Their operands are text, never a path. */
const PRINTERS = ["echo", "printf"];
/** `a..b` is a range and `origin/main` a ref there; the ask patterns guard them. */
const REF_COMMANDS = ["git", "gh"];

// `sed` is left out: its script is a language of its own, and the rules
// that guard it read the quotes this splitter takes off.
const ALLOWED = [
  ...policy.git.allow,
  ...policy.fs.allow,
  ...READERS,
  ...PRINTERS,
].map((command) => command.split(" "));
/** In auto mode the engine gives these to its classifier, so they stay asked. */
const RUNNERS = policy.dev.commands.map((command) => command.split(" "));

/**
 * The engine asks for a write under most dot names of its own accord
 * (`.gitmodules`, `.vscode/`, `.husky/`, a shell profile) and its list is
 * not ours to copy, so a written path may name only these.
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

let askRules: RegExp[] | undefined;
/** The engine's rule syntax: `*` is any run of characters. */
function asked(text: string): boolean {
  askRules ??= bashAskPatterns().map(
    (pattern) => new RegExp(`^${globOf(pattern, "[\\s\\S]*")}$`),
  );
  return askRules.some((rule) => rule.test(text));
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

const segmentsOf = (path: string) =>
  path.split("/").filter((segment) => segment !== "" && segment !== ".");

/** A path written the way that leaves the workspace, or points at a home. */
function leaves(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("~") ||
    segmentsOf(path).includes("..")
  );
}

/** Where the path leads once links are followed, as the engine judges one. */
function resolvesInside(root: string, path: string): boolean {
  let at = join(root, ...segmentsOf(path));
  for (;;) {
    try {
      lstatSync(at);
      break;
    } catch {
      if (at === root) return false;
      at = dirname(at);
    }
  }
  try {
    const real = realpathSync(at);
    return real === root || real.startsWith(root + sep);
  } catch {
    return false;
  }
}

const startsWith = (words: string[], command: string[]) =>
  command.every((token, index) => words[index] === token);

function dotNamed(segments: string[]): boolean {
  return segments.some(
    (segment, index) =>
      segment.startsWith(".") &&
      !(index === 0 && segment === OPEN_DOT_DIRECTORY) &&
      !(index === segments.length - 1 && OPEN_DOT_FILES.includes(segment)),
  );
}

function partRefusal(
  part: Part,
  root: string,
  runners: boolean,
): string | null {
  const name = part.words[0];
  if (name === undefined) return "a redirect without a command";
  const allowed = runners ? [...ALLOWED, ...RUNNERS] : ALLOWED;
  if (!allowed.some((command) => startsWith(part.words, command))) {
    return `${name} is not a command the workspace policy allows`;
  }
  const redirect = part.redirect;
  const tail =
    redirect === undefined ? "" : ` ${redirect.op} ${redirect.target}`;
  // The rules were written for the line as typed; a quote taken off must not
  // hide a shape one of them names, nor a quote put on.
  if (
    asked(part.words.join(" ") + tail) ||
    asked(part.written.join(" ") + tail)
  ) {
    return `${name} matches an ask rule`;
  }
  const writes = policy.fs.allow.includes(name);
  const paths =
    redirect === undefined ? [] : [{ path: redirect.target, written: true }];
  if (!REF_COMMANDS.includes(name) && !PRINTERS.includes(name)) {
    for (const word of part.words.slice(1)) {
      if (!word.startsWith("-")) {
        paths.push({ path: word, written: writes });
        continue;
      }
      // `--file=/etc/hosts` and `-f/etc/hosts` carry a path inside the option.
      const value = word.includes("=")
        ? word.slice(word.indexOf("=") + 1)
        : word.startsWith("--")
          ? ""
          : word.slice(2);
      if (leaves(value)) return `${name} is given a path outside the workspace`;
    }
  }
  for (const { path, written } of paths) {
    if (leaves(path) || !resolvesInside(root, path)) {
      return `${name} is given a path outside the workspace`;
    }
    if (!written) continue;
    const segments = segmentsOf(path);
    const relative = segments.join("/");
    if (relative === "") return `${name} writes the workspace itself`;
    if (dotNamed(segments) || SENSITIVE.some((rule) => rule.test(relative))) {
      return `${name} writes a path that goes to a person`;
    }
  }
  return null;
}

/**
 * Null when every part of the line is work the workspace policy lets run
 * unasked, else why the line still goes to a person. `shell` is where the
 * engine's shell stands: a relative path means something else once it has
 * left the workspace root, so then nothing passes.
 */
export function askedBashRefusal(
  command: string,
  at: { workspace: string; shell: string | undefined; runners: boolean },
): string | null {
  const parts = partsOf(command);
  if (typeof parts === "string") return parts;
  let root: string;
  try {
    root = realpathSync(at.workspace);
    if (at.shell === undefined || realpathSync(at.shell) !== root) {
      return "a shell that is not at the workspace root";
    }
  } catch {
    return "a workspace that does not resolve";
  }
  for (const part of parts) {
    const refusal = partRefusal(part, root, at.runners);
    if (refusal !== null) return refusal;
  }
  return null;
}
