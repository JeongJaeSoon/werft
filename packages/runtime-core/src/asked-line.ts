import { lstatSync, readdirSync, realpathSync } from "node:fs";
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
 *   part is a command the policy allows. A single `|` splits it there: what
 *   flows through a pipe is data, and each side is judged as its own part.
 *
 * The Claude engine asks about a line its parser does not read to the end (a
 * file redirect and a heredoc after `&&`), and it does not say why it asked
 * in a way to rely on, so the line is read here rather than taken on the
 * engine's word.
 */
const policy = WORKSPACE_POLICY;

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
  /** The part reads a quoted heredoc's body on its stdin. */
  heredoc?: true;
  /** The part reads what a `|` before it gives. */
  piped?: true;
};

type Token =
  | { kind: "word"; text: string; written: string }
  | { kind: "end"; op: "&&" | ";" | "\n" | "|" }
  | { kind: "redirect"; op: ">" | ">>" }
  | { kind: "heredoc" };

/**
 * The tokens of a line, or why it cannot be split with certainty. A single
 * `|` ends a command only under `pipes`: each side of it is then judged as a
 * command of its own.
 */
function tokensOf(command: string, pipes: boolean): Token[] | string {
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
    if (char === "|" && pipes) {
      // `||` and `|&` stay unsplit.
      const next = command[i + 1];
      if (next === "|" || next === "&") return "a | outside a quote";
      tokens.push({ kind: "end", op: "|" });
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
      tokens.push({ kind: "heredoc" });
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
      } else if (" \t\n;&<>".includes(next) || (pipes && next === "|")) {
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
export function partsOf(command: string, pipes = false): Part[] | string {
  const tokens = tokensOf(command, pipes);
  if (typeof tokens === "string") return tokens;
  const parts: Part[] = [];
  let current: Part = { words: [], written: [] };
  let dangling = false;
  let piped = false;
  const empty = () =>
    current.words.length === 0 && current.redirect === undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    if (piped) current.piped = true;
    if (token.kind === "heredoc") {
      // A heredoc with no command before it feeds nothing.
      if (!empty()) current.heredoc = true;
    } else if (token.kind === "word") {
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
      dangling = token.op === "&&" || token.op === "|";
      piped = token.op === "|";
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

/** The ask rules by the command each starts with; `*` is any run of characters. */
const ASK_RULES = new Map<string, RegExp[]>();
const ASK_RULES_ANY_COMMAND: RegExp[] = [];
for (const pattern of workspaceAskPatterns()) {
  const [head = ""] = pattern.split(" ");
  const rule = new RegExp(`^${globOf(pattern, "[\\s\\S]*")}$`);
  const rules = head.includes("*")
    ? ASK_RULES_ANY_COMMAND
    : ASK_RULES.get(head);
  if (rules === undefined) ASK_RULES.set(head, [rule]);
  else rules.push(rule);
}

/** A command by its name, whatever directory it was called from. */
const nameOf = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** A text longer than this, or more tries than this, is not matched but kept. */
const ASKED_TEXT_READ = 4_000;
const ASKED_TRIES = 32;

/**
 * Whether an ask rule names a command in these words. The rules are written
 * for a command at the start of its text, and the engine takes a wrapper off
 * before it tries them (`env X=1 cmd`, `xargs cmd`, `command cmd`,
 * `X=1 cmd`). Which word starts the command is not known here, so the rules
 * are tried from every word that names one of their commands, by its own
 * name or its base name (`/usr/bin/git` is `git`). A file operand named
 * like such a command starts a try as well; what `echo` prints is text.
 * The tries and the text of each are bounded: past either limit the words
 * count as asked.
 */
function namesAsked(words: readonly string[], tail = ""): boolean {
  const starts = PRINTERS.includes(nameOf(words[0] ?? "")) ? 1 : words.length;
  let tries = 0;
  for (let i = 0; i < Math.max(starts, 1); i += 1) {
    const word = words[i] ?? "";
    if (i > 0 && /\s/.test(word)) continue;
    for (const name of new Set([word, nameOf(word)])) {
      const rules = ASK_RULES.get(name) ?? [];
      if (rules.length === 0 && ASK_RULES_ANY_COMMAND.length === 0) continue;
      tries += 1;
      const text = [name, ...words.slice(i + 1)].join(" ") + tail;
      if (tries > ASKED_TRIES || text.length > ASKED_TEXT_READ) return true;
      if (
        rules.some((rule) => rule.test(text)) ||
        ASK_RULES_ANY_COMMAND.some((rule) => rule.test(text))
      ) {
        return true;
      }
    }
  }
  return false;
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

/** A path as the workspace names it: as it is spelled, and where links lead it. */
type Located = { spelled: string; real: string };

/**
 * The path inside the workspace, or undefined when it leaves: by its
 * spelling, or by a link on the way, as the Claude engine judges one. A
 * `..` is refused outright: after a link it climbs from where the link
 * leads, not from where it is written.
 */
function locate(place: Place, path: string): Located | undefined {
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
  let real: string;
  try {
    real = realpathSync(at);
  } catch {
    return undefined;
  }
  if (!inside(place.root, real)) return undefined;
  const named = (target: string) =>
    relative(place.root, target).split(sep).join("/");
  return {
    spelled: named(full),
    real: named(resolve(real, relative(at, full))),
  };
}

/** A secret, `.git` or engine-settings path, by its name or through a link to one. */
const sensitive = (located: Located) =>
  SENSITIVE.some(
    (rule) => rule.test(located.spelled) || rule.test(located.real),
  );

/**
 * Whether a word plainly names a place outside the workspace: a home, a
 * climb, a link that leads out, or an absolute path whose first name exists.
 * `/re/` in an awk or sed script is a pattern: nothing is called that.
 */
function plainlyOutside(place: Place, word: string): boolean {
  if (word === "/dev/null" || locate(place, word) !== undefined) return false;
  if (!word.startsWith("/")) return true;
  try {
    const first = word.split("/").find((name) => name !== "" && name !== ".");
    // No name at all is the root itself.
    if (first !== undefined) lstatSync(`/${first}`);
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

/**
 * Why a word given to a command that may do anything with it goes to a
 * person: it plainly leaves the workspace, or (when the command may write)
 * it names a secret, `.git` or engine-settings path.
 */
function wordKept(
  place: Place,
  word: string,
  mayWrite: boolean,
): string | null {
  for (const path of pathsIn(word)) {
    if (path === "") continue;
    if (plainlyOutside(place, path)) return "a path outside the workspace";
    const located = mayWrite ? locate(place, path) : undefined;
    if (located !== undefined && sensitive(located)) {
      return "a path that goes to a person";
    }
  }
  return null;
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
  if (located.spelled === "" || located.real === "") {
    return "a write to the workspace itself";
  }
  if (sensitive(located) || (narrow && dotNamed(located.spelled.split("/")))) {
    return "a written path that goes to a person";
  }
  return null;
}

/** Commands that take what comes on stdin as text, never as a name or a path. */
const TEXT_FILTERS = ["cat", "head", "tail", "wc", "grep"];

/** Where gh takes a pull request's or an issue's body as text. */
const GH_BODY_TOPICS = ["pr", "issue"];
const GH_BODY_VERBS = ["create", "comment", "edit", "review"];

/** Whether a value flag in these words is given `-`, stdin. */
const fromStdin = (words: readonly string[], flags: readonly string[]) =>
  words.some(
    (word, at) =>
      flags.some((flag) => flag.startsWith("--") && word === `${flag}=-`) ||
      (flags.includes(word) && words[at + 1] === "-"),
  );

/** Whether these words are a filter that reads stdin as text only. */
function filterReadsText(words: readonly string[]): boolean {
  const [name] = words;
  if (!TEXT_FILTERS.includes(name ?? "")) return false;
  // `wc --files0-from=-` reads the names of files from stdin, and wc takes
  // a long option by any unique start of its name (`--f=-`).
  return !(
    name === "wc" &&
    words.some((word) => {
      const option = word.split("=")[0] as string;
      return option.length > 2 && "--files0-from".startsWith(option);
    })
  );
}

/**
 * Whether these words read stdin as text only: a filter, a commit message,
 * or the body of a pull request or an issue.
 */
function readsHeredocAsText(words: readonly string[]): boolean {
  const [name, verb, action] = words;
  if (TEXT_FILTERS.includes(name ?? "")) return filterReadsText(words);
  if (name === "gh") {
    return (
      GH_BODY_TOPICS.includes(verb ?? "") &&
      GH_BODY_VERBS.includes(action ?? "") &&
      fromStdin(words, ["--body-file", "-F"])
    );
  }
  if (name !== "git" || verb !== "commit") return false;
  // Anything else may read stdin before the message (`--pathspec-from-file=-`,
  // `--patch`), take `-F` as its own value (`-m -F -`), or open an editor
  // that inherits the heredoc (`-e`), so only flags without a value stand
  // beside the one `-F -`. `--file` is an ask rule's.
  const rest = words.slice(2);
  const at = rest.indexOf("-F");
  return (
    at !== -1 &&
    rest[at + 1] === "-" &&
    rest.every(
      (word, index) =>
        index === at || index === at + 1 || COMMIT_FLAGS.includes(word),
    )
  );
}

/** `git commit` flags that take no value and read nothing. */
const COMMIT_FLAGS = [
  "-a",
  "--all",
  "--amend",
  "-s",
  "--signoff",
  "-n",
  "--no-verify",
  "-q",
  "--quiet",
  "--allow-empty",
  "--allow-empty-message",
  "--no-edit",
];

const startsWith = (words: string[], command: string[]) =>
  command.every((token, index) => words[index] === token);

/** git options before its command that change only how it prints or locks. */
const GIT_PLAIN_GLOBALS = [
  "--version",
  "--help",
  "--no-pager",
  "-P",
  "--no-optional-locks",
  "--literal-pathspecs",
  "--no-replace-objects",
];

/**
 * git options whose value is a program git runs: `git grep
 * --open-files-in-pager`, `git difftool --extcmd`, `git rebase --exec`,
 * `git push --exec`, `git fetch --upload-pack`, `git push --receive-pack`.
 */
const GIT_RUNNING_OPTIONS = [
  "--open-files-in-pager",
  "--extcmd",
  "--exec",
  "--upload-pack",
  "--receive-pack",
];
/** The short options of those, by the git command that has one. */
const GIT_RUNNING_SHORT: Readonly<Record<string, string>> = {
  grep: "O",
  difftool: "x",
  rebase: "x",
};
/** git commands that run what the line gives them, whatever the options. */
const GIT_RUNNING_VERBS = ["filter-branch", "send-email"];

/** `git config` options that only read or shape what is read. */
const CONFIG_READ_OPTIONS = [
  "--",
  "--get-urlmatch",
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "-l",
  "--local",
  "--show-origin",
  "--show-scope",
  "--name-only",
  "-z",
  "--null",
  "--all",
  "--bool",
  "--int",
  "--bool-or-int",
  "--path",
  "--expiry-date",
  "--no-type",
];
const CONFIG_READ_ACTIONS = [
  "--get-urlmatch",
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "-l",
];
/** Keys a narrow line may set: who the commits are by, and nothing that runs. */
const CONFIG_KEYS_SET = ["user.name", "user.email"];
/** Verbs of the newer `git config <verb>` form. */
const CONFIG_VERBS = [
  "get",
  "list",
  "set",
  "unset",
  "edit",
  "rename-section",
  "remove-section",
];

const configOption = (word: string) =>
  CONFIG_READ_OPTIONS.includes(word) ||
  /^-[lz]+$/.test(word) ||
  /^--type=\w+$/.test(word);

/**
 * Whether `git config`, after its verb, only reads, or sets who the commits
 * are by. Anything else may set a key that makes git run a program
 * (`core.hooksPath`, `core.editor`, `core.fsmonitor`) or open an editor.
 */
function configReads(rest: readonly string[]): boolean {
  const setOption = (word: string) => word === "--local" || word === "--";
  const options = rest.filter((word) => word.startsWith("-"));
  const operands = rest.filter((word) => !word.startsWith("-"));
  const userKey = (key: string | undefined) =>
    CONFIG_KEYS_SET.includes((key ?? "").toLowerCase());
  const [first] = operands;
  if (first !== undefined && CONFIG_VERBS.includes(first)) {
    if (first === "get" || first === "list") return options.every(configOption);
    return (
      first === "set" &&
      operands.length === 3 &&
      userKey(operands[1]) &&
      options.every(setOption)
    );
  }
  if (operands.length === 2 && userKey(first) && options.every(setOption)) {
    return true;
  }
  if (options.every(configOption)) {
    return (
      options.some(
        (word) =>
          CONFIG_READ_ACTIONS.includes(word) || /^-[lz]*l[lz]*$/.test(word),
      ) || operands.length === 1
    );
  }
  return false;
}

/** grep options that take a value; a short one takes the rest of its cluster or the next word. */
const GREP_SHORT_VALUES = "efmABCdD";
const GREP_LONG_VALUES = [
  "--regexp",
  "--file",
  "--max-count",
  "--after-context",
  "--before-context",
  "--context",
  "--directories",
  "--devices",
  "--label",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "--binary-files",
];
const GREP_LONG_FLAGS = ["--recursive", "--dereference-recursive"];

/** A long grep option by its full name, as GNU getopt takes a unique start of one. */
function grepLong(option: string): string | undefined {
  const known = [...GREP_LONG_VALUES, ...GREP_LONG_FLAGS];
  if (known.includes(option)) return option;
  const starts = known.filter((name) => name.startsWith(option));
  return starts.length === 1 ? starts[0] : undefined;
}

/** What grep is given: whether it recurses, the files it reads, and whether a pattern came by option. */
function grepOperands(words: readonly string[]): {
  recurses: boolean;
  /** What it searches. */
  files: string[];
  /** Files it reads patterns or names from. */
  lists: string[];
} {
  let recurses = false;
  let patterned = false;
  const files: string[] = [];
  const lists: string[] = [];
  const positional: string[] = [];
  const recurse = (value: string) =>
    value !== "" && "recurse".startsWith(value);
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] as string;
    if (word === "--") {
      positional.push(...words.slice(i + 1));
      break;
    }
    if (word.startsWith("--")) {
      const cut = word.indexOf("=");
      const option = grepLong(cut === -1 ? word : word.slice(0, cut));
      if (option === undefined) continue;
      if (GREP_LONG_FLAGS.includes(option)) {
        recurses = true;
        continue;
      }
      let value = word.slice(cut + 1);
      if (cut === -1) {
        i += 1;
        value = words[i] ?? "";
      }
      if (option === "--directories" && recurse(value)) recurses = true;
      if (option === "--regexp" || option === "--file") patterned = true;
      if (option === "--file" || option === "--exclude-from") lists.push(value);
      continue;
    }
    if (word.startsWith("-") && word.length > 1) {
      for (let at = 1; at < word.length; at += 1) {
        const letter = word[at] as string;
        if (letter === "r" || letter === "R") recurses = true;
        if (!GREP_SHORT_VALUES.includes(letter)) continue;
        let value = word.slice(at + 1);
        if (value === "") {
          i += 1;
          value = words[i] ?? "";
        }
        if (letter === "d" && recurse(value)) recurses = true;
        if (letter === "e" || letter === "f") patterned = true;
        if (letter === "f") lists.push(value);
        break;
      }
      continue;
    }
    positional.push(word);
  }
  files.push(...(patterned ? positional : positional.slice(1)));
  return { recurses, files, lists };
}

/** What in a git or gh word may be a path: an option's value, a glued cluster's tail, `@file`, a `file#label`. What follows a `:` is {@link rootRelative}'s. */
function refPathsIn(word: string): string[] {
  const found = new Set([word, ...pathsIn(word)]);
  if (/^-[^-]/.test(word)) {
    for (let at = 2; at < word.length; at += 1) found.add(word.slice(at));
  }
  for (const path of [...found]) {
    if (path.startsWith("@")) found.add(path.slice(1));
    if (path.includes("#")) found.add(path.slice(0, path.indexOf("#")));
  }
  return [...found];
}

/** The paths in a word that git may read from the repository's top: what follows any `:`, with a pathspec's magic taken off. */
function rootRelative(word: string): string[] {
  const found: string[] = [];
  for (let at = word.indexOf(":"); at !== -1; at = word.indexOf(":", at + 1)) {
    const rest = word.slice(at + 1);
    // `:/x` is `:(top)x` in short, as `:!x` and `:^x` leave x out.
    const magic = /^(\([^)]*\)|[^\w.(]*)/.exec(rest);
    found.push(rest, rest.slice(magic?.[0].length ?? 0));
  }
  return found;
}

/**
 * The narrow reading's own checks of a part the policy allows: what git, gh
 * and grep do with the words that the ask rules do not see.
 */
function narrowKept(words: readonly string[], place: Place): string | null {
  const [name] = words;
  // A path is judged where it lands, `..` taken as spelled, and by its name
  // alone as well: git may read it from a tree, not the work tree
  // (`HEAD:.claude/settings.json` with `.claude` a broken link), and
  // `:(icase)` matches any case.
  const keptPath = (path: string, base = place.base): boolean => {
    if (path === "" || path.startsWith("~")) return false;
    const full = resolve(base, path);
    if (!inside(place.root, full)) return false;
    const name = relative(place.root, full).split(sep).join("/");
    const named = (spelled: string) =>
      sensitive({ spelled, real: spelled }) ||
      sensitive({
        spelled: spelled.toLowerCase(),
        real: spelled.toLowerCase(),
      });
    const located = locate({ root: place.root, base: place.root }, name || ".");
    if ((located !== undefined && sensitive(located)) || named(name)) {
      return true;
    }
    // A pathspec is a pattern to git (`.claud[e]/settings.json`, `*.json`),
    // and `*` crosses `/`: it is kept when a kept name in the folder its
    // pattern starts in begins as the pattern does.
    const glob = name.search(/[*?[]/);
    if (glob === -1) return false;
    const lead = name.slice(0, glob);
    const folder = lead.slice(0, lead.lastIndexOf("/") + 1);
    let names: string[];
    try {
      names = readdirSync(resolve(place.root, folder || "."));
    } catch {
      return false;
    }
    return names.some(
      (entry) =>
        entry.startsWith(lead.slice(folder.length)) &&
        keptPath(`${folder}${entry}`, place.root),
    );
  };
  if (name === "git" || name === "gh") {
    // Which option takes a value is not known here (`-F -m`, `-e -m`,
    // `-m --`), so no word is skipped as a message or a value: every word
    // is read as a path and as an option.
    for (const word of words.slice(1)) {
      // git takes a long option by any unique start of its name.
      const option = word.split("=")[0] as string;
      const longStart = (full: string) =>
        option.length > 2 &&
        option.startsWith("--") &&
        (full.startsWith(option) || option.startsWith(full));
      if (name === "git" && longStart("--pathspec-from-file")) {
        return "a path list the line does not show";
      }
      if (name === "git" && GIT_RUNNING_OPTIONS.some(longStart)) {
        return "a git option that runs a program";
      }
      // A secret or engine-settings path given to git or gh: `git checkout
      // HEAD -- .claude/settings.json`, `gh pr create --body-file .env`.
      // `HEAD:<path>`, `:0:<path>` and `:(top)<path>` are from the
      // repository's top, which may not be where the shell stands.
      const paths = refPathsIn(word);
      if (
        paths.some((path) => keptPath(path)) ||
        rootRelative(word).some(
          (path) => keptPath(path) || keptPath(path, place.root),
        )
      ) {
        return "a path that goes to a person";
      }
      // `-nF../../x`: the common check cuts only two letters off a cluster.
      if (
        paths.some(
          (path) =>
            path !== "" && !path.startsWith("~") && plainlyOutside(place, path),
        )
      ) {
        return "a path outside the workspace";
      }
    }
  }
  if (name === "git") {
    // Only options that change how it prints may come before the command:
    // others take a value (`--namespace x`) or change what runs.
    const at = words.findIndex(
      (word, index) => index > 0 && !word.startsWith("-"),
    );
    const globals = words.slice(1, at === -1 ? words.length : at);
    if (globals.some((word) => !GIT_PLAIN_GLOBALS.includes(word))) {
      return "a git option before its command";
    }
    const verb = words[at];
    // A patch names the paths it writes in its text, not in the line.
    if (verb === "apply" || verb === "am") {
      return "a patch the line does not show";
    }
    if (verb === "config" && !configReads(words.slice(at + 1))) {
      return "a git setting the workspace policy keeps for a person";
    }
    const rest = at === -1 ? [] : words.slice(at + 1);
    const short = GIT_RUNNING_SHORT[verb ?? ""];
    if (
      (short !== undefined &&
        rest.some((word) => /^-[^-]/.test(word) && word.includes(short))) ||
      GIT_RUNNING_VERBS.includes(verb ?? "") ||
      (verb === "bisect" && rest.includes("run")) ||
      (verb === "submodule" && rest.includes("foreach"))
    ) {
      return "a git option that runs a program";
    }
  }
  if (name === "grep") {
    const { recurses, files, lists } = grepOperands(words);
    for (const file of [...files, ...lists]) {
      if (keptPath(file)) return "a path that goes to a person";
    }
    if (recurses) {
      // A tree searched is read whole, secrets in it as well: the search
      // must name where it starts, and that may not be the workspace itself.
      if (files.length === 0)
        return "a search of a tree the line does not name";
      for (const file of files) {
        const located = locate(place, file);
        if (located === undefined) return "a path outside the workspace";
        if (located.spelled === "" || located.real === "") {
          return "a search of the workspace or a kept path";
        }
      }
    }
  }
  return null;
}

/** The files gh reads as a body: `--body-file x`, `--body-file=x`, `-F x`, `-Fx`, `-dF x`. */
function ghBodyFiles(words: readonly string[]): string[] {
  const files: string[] = [];
  words.forEach((word, index) => {
    const next = words[index + 1] ?? "";
    if (word === "--body-file") files.push(next);
    else if (word.startsWith("--body-file=")) files.push(word.slice(12));
    else if (/^-[^-]/.test(word) && word.includes("F")) {
      files.push(word.slice(word.indexOf("F") + 1) || next);
    }
  });
  return files.filter((file) => file !== "");
}

/** A word quoted this deep is not read further. */
const NESTED_SCRIPTS = 3;

function partKept(
  part: Part,
  place: Place,
  narrow: boolean,
  depth = 0,
): string | null {
  const name = part.words[0];
  if (narrow) {
    if (name === undefined) return "a redirect without a command";
    if (!NARROW.some((command) => startsWith(part.words, command))) {
      return `${name} is not a command the workspace policy allows`;
    }
    // A heredoc's body is not read here, and a git command may take it as
    // names, paths or directives (`git update-index --stdin`,
    // `git cat-file --batch`, `git apply`): only text and a commit
    // message read one.
    if (part.heredoc && !readsHeredocAsText(part.words)) {
      return `${name} is not a command the workspace policy lets read a heredoc`;
    }
    // A command fed by a pipe may take what flows in as names, paths or
    // directives the line never shows (`git cat-file --batch`,
    // `git update-index --stdin`), so only filters of text read a pipe.
    if (part.piped && !filterReadsText(part.words)) {
      return `${name} is not a command the workspace policy lets read a pipe`;
    }
  }
  const redirect = part.redirect;
  const tail =
    redirect === undefined ? "" : ` ${redirect.op} ${redirect.target}`;
  // The rules were written for the line as typed; a quote taken off must not
  // hide a shape one of them names, nor a quote put on.
  if (namesAsked(part.words, tail) || namesAsked(part.written, tail)) {
    return "a part an ask rule names";
  }
  // `> /dev/null` writes nothing.
  if (redirect !== undefined && redirect.target !== "/dev/null") {
    const kept = writeKept(place, redirect.target, narrow);
    if (kept !== null) return kept;
  }
  // gh sends the file it is given as a body: a secret there leaves the
  // workspace, in either reading (`gh pr create --body-file .env`).
  if (name === "gh") {
    for (const path of ghBodyFiles(part.words)) {
      const located = locate(place, path);
      if (located !== undefined && sensitive(located)) {
        return "a path that goes to a person";
      }
    }
  }
  if (narrow) {
    const kept = narrowKept(part.words, place);
    if (kept !== null) return kept;
  }
  if (name === undefined) return null;
  // The command's own path is not judged: a program found by PATH lives
  // outside the workspace as well, and running one is not a path the policy
  // keeps.
  const command = nameOf(name);
  if (PRINTERS.includes(command)) return null;
  const writes = policy.fs.allow.includes(command);
  const refs = REF_COMMANDS.includes(command);
  const mayWrite = !refs && !READ_ONLY.includes(command);
  // The operands of these are known to be paths; any other command's word is
  // kept only when it plainly names a kept place.
  const pathed = !refs && (narrow || writes || READERS.includes(command));
  // What git or gh is given as a message is text. Which flag takes a value
  // is not known here (`git grep -e -m` gives `-m` as a pattern), so any
  // `--` ends that reading, one given as a message as well: past it every
  // word is judged.
  let options = refs;
  let message = false;
  for (const word of part.words.slice(1)) {
    if (word === "--") options = false;
    if (options) {
      const text =
        message || MESSAGE_FLAGS.some((flag) => word.startsWith(`${flag}=`));
      message = !message && MESSAGE_FLAGS.includes(word);
      if (text) continue;
    }
    if (writes && !word.startsWith("-")) {
      const kept = writeKept(place, word, narrow);
      if (kept !== null) return kept;
    } else if (pathed) {
      if (
        pathsIn(word).some(
          (path) => path !== "" && locate(place, path) === undefined,
        )
      ) {
        return "a path outside the workspace";
      }
    } else {
      // A ref (`origin/main`, `a..b`) is not a path the policy keeps, so
      // git and gh are held to the workspace only. A name may hold blanks.
      const kept = wordKept(place, word, mayWrite);
      if (kept !== null) return kept;
      // A quoted word with blanks in it may also be a script (`sh -c '…'`,
      // `eval "…"`, `ssh host '…'`).
      if (!refs && /\s/.test(word)) {
        const nested =
          depth >= NESTED_SCRIPTS
            ? "a script quoted too deep to read"
            : keptIn(word, place.root, [place.base], depth + 1);
        if (nested !== null) return nested;
      }
    }
  }
  return null;
}

const MESSAGE_FLAGS = ["-m", "--message", "--title", "--body"];
/** More places than this for one line's shell is not a line to answer for. */
const PLACES_FOLLOWED = 8;

/** The places a shell may stand in after a move, each once, or why not. */
function placesAfter(
  bases: readonly string[],
  moved: readonly string[],
): string[] | string {
  const next = [...new Set([...bases, ...moved])];
  return next.length > PLACES_FOLLOWED
    ? "a shell moved more often than the line is followed"
    : next;
}

const MOVERS = ["cd", "pushd", "popd", "chdir"];
/** Words a command may stand behind and still move the shell. */
const MOVER_PREFIXES = [
  "command",
  "builtin",
  "then",
  "do",
  "else",
  "elif",
  "{",
  "!",
  "time",
];
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/**
 * Where a part moves the shell: the directories it may stand in afterwards,
 * undefined when the part moves nothing, or why the line goes to a person.
 */
function movedTo(
  words: readonly string[],
  root: string,
  bases: readonly string[],
): string[] | string | undefined {
  const at = words.findIndex(
    (word) => !MOVER_PREFIXES.includes(word) && !ASSIGNMENT.test(word),
  );
  const name = words[at];
  if (name === undefined || !MOVERS.includes(name)) return undefined;
  const operands = words.slice(at + 1);
  const [to, ...more] = operands[0] === "--" ? operands.slice(1) : operands;
  if (
    name !== "cd" ||
    // `CDPATH=x cd y` goes where the variable says.
    words
      .slice(0, at)
      .some((word) => ASSIGNMENT.test(word)) ||
    to === undefined ||
    more.length > 0 ||
    to.startsWith("-") ||
    /[$`~*?]/.test(to)
  ) {
    return "a shell moved to a place the line does not say";
  }
  const next: string[] = [];
  for (const base of bases) {
    if (locate({ root, base }, to) === undefined) {
      return "a path outside the workspace";
    }
    next.push(resolve(base, to));
  }
  return next;
}

/**
 * Commands with no way to write a path they are given: a kept name there is
 * not a write. `find`, `sort`, `tree`, `diff`, `uniq` and `file` each have one
 * (`-fprint`, `-o`, an output operand), so they are not here.
 */
const READ_ONLY = [...READERS, "rg", "du", "stat", "test", "[", "cd"];

const HEREDOC_START =
  /^[\w./:=@+,%\- \t>|&;]*<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2(?![\w./:=@+,%-])[\w./:=@+,%\- \t>|&;]*$/;

/**
 * The line without the heredoc bodies that are data. A body is taken out
 * only where the shell cannot read it otherwise: no line outside the bodies
 * holds a quote, a backslash or a comment, every `<<` starts a heredoc in
 * plain words, each body ends at its delimiter, and a body the shell expands
 * (an unquoted delimiter) holds no command substitution. Anything else is
 * read whole, bodies included.
 */
function withoutHeredocBodies(command: string): string {
  const kept: string[] = [];
  const lines = command.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    kept.push(line);
    if (!line.includes("<<")) {
      if (/['"\\#]/.test(line)) return command;
      continue;
    }
    const start = HEREDOC_START.exec(line);
    if (start === null) return command;
    const [, dash, quote, delimiter] = start;
    const ends = (candidate: string) =>
      (dash === "-" ? candidate.replace(/^\t+/, "") : candidate) === delimiter;
    const end = lines.findIndex((candidate, at) => at > i && ends(candidate));
    if (end === -1) return command;
    const body = lines.slice(i + 1, end).join("\n");
    if (quote === "" && /\$\(|`/.test(body)) return command;
    i = end;
  }
  return kept.join("\n");
}

const spelledOut = (words: readonly string[]) =>
  words
    .join(" ")
    .replace(/[{},]|\$\{?IFS\}?/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "");

/** The part of a word the shell does not compute, when that part alone can be judged. */
function literalOf(word: string, written: string): string | undefined {
  const cut = word.indexOf("$");
  // In single quotes a dollar sign is a character of the name.
  if (cut === -1 || /^'[^']*'$/.test(written)) return word;
  // Only the spelled start is judged: `.git/$name` starts under `.git`,
  // `$DIR/x` starts nowhere yet.
  return cut === 0 ? undefined : word.slice(0, cut);
}

/**
 * A line that does not split: what the policy keeps for a person is looked
 * for in its text, and what cannot be seen passes. The text is cut at the
 * separators this knows, quoted or not, so a script inside a quote is read
 * as well.
 */
function unsplitKept(
  command: string,
  root: string,
  from: readonly string[],
): string | null {
  const text = withoutHeredocBodies(command);
  let bases = [...from];
  for (const piece of text.split(/&&|\|\||[;|&\n()`]/)) {
    const pairs = piece
      .trim()
      .split(/\s+/)
      .map((word) => ({ written: word, word: word.replace(/['"\\]/g, "") }))
      .filter((pair) => pair.word !== "");
    const written = pairs.map((pair) => pair.written);
    const words = pairs.map((pair) => pair.word);
    if (words.length === 0) continue;
    if (
      namesAsked(words) ||
      namesAsked(written) ||
      // A brace expansion or `$IFS` spells the blanks between words.
      namesAsked(spelledOut(words))
    ) {
      return "a part an ask rule names";
    }
    // Once the text is cut, what a printer is given in its piece is text.
    // The redirect targets the scan below matches are read wherever they
    // stand, inside a printed quote as well: a substitution in double
    // quotes runs.
    if (PRINTERS.includes(nameOf(words[0] as string))) continue;
    const moved = movedTo(words, root, bases);
    if (typeof moved === "string") return moved;
    const lead = words.find(
      (word) => !MOVER_PREFIXES.includes(word) && !ASSIGNMENT.test(word),
    );
    const mayWrite = !READ_ONLY.includes(nameOf(lead ?? ""));
    for (const pair of pairs) {
      const literal = literalOf(pair.word, pair.written);
      if (literal === undefined) continue;
      for (const base of bases) {
        const kept = wordKept({ root, base }, literal, mayWrite);
        if (kept !== null) return kept;
      }
    }
    if (moved !== undefined) {
      const next = placesAfter(bases, moved);
      if (typeof next === "string") return next;
      bases = next;
    }
  }
  // Every base the line may have reached is tried for a redirect's target.
  for (const [, quoted] of text.matchAll(
    />>?\|?[ \t]*((?:"[^"]*"|'[^']*'|[^\s;&|<>()'"])+)/g,
  )) {
    const target = literalOf(
      (quoted as string).replace(/['"\\]/g, ""),
      quoted as string,
    );
    if (target === undefined || target === "/dev/null") continue;
    for (const base of bases) {
      const kept = writeKept({ root, base }, target, false);
      if (kept !== null) return kept;
    }
  }
  return null;
}

/** The wide reading of a line whose shell may stand in any of `from`. */
function keptIn(
  command: string,
  root: string,
  from: readonly string[],
  depth: number,
): string | null {
  const parts = partsOf(command);
  if (typeof parts === "string") return unsplitKept(command, root, from);
  let bases = [...from];
  for (const part of parts) {
    const moved = movedTo(part.words, root, bases);
    if (typeof moved === "string") return moved;
    for (const base of bases) {
      const kept = partKept(part, { root, base }, false, depth);
      if (kept !== null) return kept;
    }
    // A `cd` may not have run (`false && cd x`), so both places stay.
    if (moved !== undefined) {
      const next = placesAfter(bases, moved);
      if (typeof next === "string") return next;
      bases = next;
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
  return typeof place === "string"
    ? place
    : keptIn(command, place.root, [place.base], 0);
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
  const parts = partsOf(command, true);
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
