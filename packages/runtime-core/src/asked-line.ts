import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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
  /** A `~` or `^` inside a word, unquoted: a git revision's (`HEAD~1`, `HEAD^`). */
  revision?: string;
  /** The words as they were written, quotes included. */
  written: string[];
  redirect?: { op: ">" | ">>"; target: string };
  /** The part reads a quoted heredoc's body on its stdin. */
  heredoc?: true;
  /** The part reads what a `|` before it gives. */
  piped?: true;
};

type Token =
  | { kind: "word"; text: string; written: string; revision?: string }
  | { kind: "end"; op: "&&" | ";" | "\n" | "|" }
  | { kind: "redirect"; op: ">" | ">>" }
  | { kind: "heredoc" };

/**
 * The tokens of a line, or why it cannot be split with certainty. A single
 * `|` ends a command only under `pipes`: each side of it is then judged as a
 * command of its own. Under `revisions`, a `~` or `^` inside a word is a
 * letter of it: the shell reads `~` as a home only where a word or a value
 * after `=` or `:` starts, so `HEAD~1` and `HEAD^` are revisions.
 */
function tokensOf(
  command: string,
  pipes: boolean,
  revisions = false,
): Token[] | string {
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
    let revision: string | undefined;
    const start = i;
    for (; i < command.length; i += 1) {
      const next = command[i] as string;
      const before = command[i - 1] ?? "";
      if (BARE.test(next)) {
        text += next;
      } else if (
        revisions &&
        (next === "~" || next === "^") &&
        i > start &&
        // After a `/` it starts a name: a pattern to a shell with extended globs.
        (/[\w.@+,%-]/.test(before) || before === "~" || before === "^")
      ) {
        text += next;
        revision ??= next;
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
    tokens.push({
      kind: "word",
      text,
      written: command.slice(start, i),
      ...(revision === undefined ? {} : { revision }),
    });
  }
  return pending === undefined ? tokens : "a heredoc without its body";
}

/** The parts of a line, or why it is not a plain list of simple commands. */
export function partsOf(
  command: string,
  pipes = false,
  revisions = false,
): Part[] | string {
  const tokens = tokensOf(command, pipes, revisions);
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
      if (token.revision !== undefined) current.revision ??= token.revision;
    } else if (token.kind === "redirect") {
      const target = tokens[i + 1];
      if (target?.kind !== "word" || current.redirect !== undefined) {
        return "a redirect without one target";
      }
      // A file written is no revision.
      if (target.revision !== undefined) {
        return `a ${target.revision} outside a quote`;
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
  "--authors-prog",
];
/**
 * The short options of those, by the git command that has one, with the
 * letters whose value is the rest of a cluster (`git grep -eFOO` is a pattern).
 */
const GIT_RUNNING_SHORT: Readonly<Record<string, [string, string]>> = {
  grep: ["O", "efABCm"],
  difftool: ["x", "t"],
  rebase: ["x", "sXCS"],
  "ls-remote": ["u", "o"],
};
/** git commands that run what the line gives them, whatever the options. */
const GIT_RUNNING_VERBS = ["filter-branch", "send-email", "instaweb", "daemon"];

/** Whether a short-option cluster sets `letter` before a letter that takes the rest as its value. */
function clusterSets(
  word: string,
  [letter, values]: [string, string],
): boolean {
  if (!/^-[^-]/.test(word)) return false;
  for (const char of word.slice(1)) {
    if (char === letter) return true;
    if (values.includes(char)) return false;
  }
  return false;
}

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
// Joined strings: tests/architecture.test.ts reads a quote right after the
// word from as an import.
const GREP_LONG_VALUES = [
  "--regexp --file --max-count --after-context --before-context --context",
  "--directories --devices --label --include --exclude --exclude-dir",
  "--exclude-from --binary-files",
]
  .join(" ")
  .split(" ");
/** grep options whose value is a file of patterns or names. */
const GREP_LISTS = "--exclude-from --file".split(" ");
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
      if (GREP_LISTS.includes(option)) lists.push(value);
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
function refPathsIn(word: string, globbed = false): string[] {
  const found = new Set([word, ...pathsIn(word)]);
  // A cluster of short options ends in the last one's value (`-nF.env`):
  // a value may start after any option letter.
  if (/^-[^-]/.test(word)) {
    for (
      let at = 2;
      at < word.length &&
      at <= CLUSTER_LETTERS + 1 &&
      /\w/.test(word[at - 1] ?? "");
      at += 1
    ) {
      found.add(word.slice(at));
    }
  }
  for (const path of [...found]) {
    if (path.startsWith("@")) found.add(path.slice(1));
    if (path.includes("#")) found.add(path.slice(0, path.indexOf("#")));
    // A shell with extended globs reads `a~b` as a less b.
    if (globbed) for (const piece of path.split(/[~^]/)) found.add(piece);
  }
  return [...found];
}

/** The paths in a word that git may read from the repository's top: what follows any `:`, with a pathspec's magic taken off. */
function rootRelative(word: string): string[] {
  const found: string[] = [];
  // git splits `<rev>:<path>` at the first `:` outside `@{…}`, and
  // `:<n>:<path>` at the second.
  const colons: number[] = [];
  let depth = 0;
  for (let at = 0; at < word.length && colons.length < 3; at += 1) {
    if (word[at] === "{") depth += 1;
    else if (word[at] === "}" && depth > 0) depth -= 1;
    else if (word[at] === ":" && depth === 0) colons.push(at);
  }
  for (const at of colons) {
    const rest = word.slice(at + 1);
    // `:/x` is `:(top)x` in short, as `:!x` and `:^x` leave x out.
    const magic = /^(\([^)]*\)|[^\w.(]*)/.exec(rest);
    found.push(rest, rest.slice(magic?.[0].length ?? 0));
  }
  return found;
}

/** What a git verb is given past its options, by the options that take a value. */
function gitOperands(
  rest: readonly string[],
  shortValues: string,
  longValues: readonly string[],
): { operands: string[]; pathspecs: string[] | undefined } {
  const operands: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i] as string;
    if (word === "--") return { operands, pathspecs: rest.slice(i + 1) };
    if (word.startsWith("--")) {
      // git takes a long option by any unique start of its name.
      const option = word.split("=")[0] as string;
      if (
        !word.includes("=") &&
        option.length > 2 &&
        longValues.some((full) => full.startsWith(option))
      ) {
        i += 1;
      }
      continue;
    }
    if (word.startsWith("-") && word !== "-") {
      const at = [...word.slice(1)].findIndex((l) => shortValues.includes(l));
      if (at !== -1 && at + 2 === word.length) i += 1;
      continue;
    }
    operands.push(word);
  }
  return { operands, pathspecs: undefined };
}

/**
 * Which of these options the words before any `--` leave set, by their long
 * name: a short cluster's letter or a long option by its name or a start of
 * it, the last of it and its `--no-` form winning. An option that takes a
 * value takes the next word when none is glued to it.
 */
function optionsSet(
  words: readonly string[],
  options: readonly (readonly [letter: string, long: string])[],
  shortValues = "",
  longValues: readonly string[] = [],
): Set<string> {
  const longs = options.map(([, long]) => long);
  const named = (option: string) =>
    option.length > 2 ? longs.filter((full) => full.startsWith(option)) : [];
  const set = new Set<string>();
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as string;
    if (word === "--") break;
    if (word.startsWith("--")) {
      const option = word.split("=")[0] as string;
      const on = named(option);
      for (const long of on) set.add(long);
      if (on.length === 0 && option.startsWith("--no-")) {
        for (const long of named(`--${option.slice(5)}`)) set.delete(long);
      }
      if (
        !word.includes("=") &&
        option.length > 2 &&
        longValues.some((full) => full.startsWith(option))
      ) {
        i += 1;
      }
      continue;
    }
    if (!/^-[^-]/.test(word)) continue;
    for (let at = 1; at < word.length; at += 1) {
      const letter = word[at] as string;
      for (const [short, long] of options) {
        if (short === letter) set.add(long || `-${short}`);
      }
      if (shortValues.includes(letter)) {
        if (at + 1 === word.length) i += 1;
        break;
      }
    }
  }
  return set;
}

/**
 * Whether git would read `word` as a revision when it is also a path: a
 * branch, tag or remote-tracking branch of that name (git checks out a
 * remote's branch by its short name), a revision spelling, or an object
 * name, in the repository git runs in from `dir`. A repository it cannot
 * find counts as one.
 */
function namesRevision(word: string, from: string): boolean {
  if (/[~^:]|@\{|^@$|^-|^[0-9a-f]{4,40}$|^[A-Z_]*HEAD$/.test(word)) {
    return true;
  }
  let gitDir: string | undefined;
  for (let dir = from; gitDir === undefined; dir = dirname(dir)) {
    const dotGit = resolve(dir, ".git");
    try {
      gitDir = lstatSync(dotGit).isDirectory()
        ? dotGit
        : resolve(
            dir,
            (
              /^gitdir: (.*)$/m.exec(readFileSync(dotGit, "utf8"))?.[1] ?? ""
            ).trim(),
          );
    } catch {
      if (dirname(dir) === dir) return true;
    }
  }
  let common = gitDir;
  try {
    common = resolve(
      gitDir,
      readFileSync(resolve(gitDir, "commondir"), "utf8").trim(),
    );
  } catch {}
  const names = [`refs/heads/${word}`, `refs/tags/${word}`];
  const exists = (path: string) => {
    try {
      return lstatSync(path).isFile();
    } catch {
      return false;
    }
  };
  if (
    names.some(
      (name) => exists(resolve(common, name)) || exists(resolve(gitDir, name)),
    )
  ) {
    return true;
  }
  try {
    for (const remote of readdirSync(resolve(common, "refs/remotes"))) {
      if (exists(resolve(common, "refs/remotes", remote, word))) return true;
    }
  } catch {}
  try {
    const packed = readFileSync(resolve(common, "packed-refs"), "utf8");
    return packed.split("\n").some((line) => {
      const ref = line.split(" ")[1] ?? "";
      return (
        names.includes(ref) ||
        ref.replace(/^refs\/remotes\/[^/]+\//, "\0") === `\0${word}`
      );
    });
  } catch {
    return false;
  }
}

/**
 * Why a git verb writes the whole work tree, or what in it the line does not
 * name, over a kept path: a pathspec of the workspace's top (`.`, `:/`), one
 * that only leaves paths out (`:!x`), another branch's tree, or ignored and
 * untracked files cleaned or stashed away.
 */
function workTreeKept(
  verb: string,
  rest: readonly string[],
  place: Place,
): string | null {
  const whole = "a write of the whole work tree";
  // A pathspec by its magic: `:(top,exclude)x`, `:/!x`, `:^x`.
  const spans = (pathspec: string) => {
    let path = pathspec;
    let top = false;
    let exclude = false;
    if (path.startsWith(":")) {
      const long = /^:\(([^)]*)\)/.exec(path);
      if (long !== null) {
        const magic = (long[1] as string).split(",");
        top = magic.includes("top");
        exclude = magic.includes("exclude");
        path = path.slice(long[0].length);
      } else {
        const short = /^:([^\w.(:]*):?/.exec(path) as RegExpExecArray;
        const magic = short[1] as string;
        top = magic.includes("/");
        exclude = magic.includes("!") || magic.includes("^");
        path = path.slice(short[0].length);
      }
    }
    const base = top ? place.root : place.base;
    return { exclude, root: resolve(base, path || ".") === place.root };
  };
  const coversAll = (pathspecs: readonly string[]) => {
    const read = pathspecs.map(spans);
    return (
      read.some((spec) => !spec.exclude && spec.root) ||
      (read.length > 0 && read.every((spec) => spec.exclude))
    );
  };
  const onDisk = (word: string) => {
    try {
      lstatSync(resolve(place.base, word));
      return true;
    } catch {
      return false;
    }
  };
  if (verb === "checkout") {
    const { operands, pathspecs } = gitOperands(rest, "bB", [
      "--orphan",
      "--conflict",
    ]);
    const set = optionsSet(
      rest,
      [
        ["f", "--force"],
        ["", "--detach"],
        ["", "--orphan"],
        ["b", ""],
        ["B", ""],
      ],
      "bB",
      ["--orphan", "--conflict"],
    );
    const force = set.has("--force");
    if (pathspecs !== undefined && pathspecs.length > 0) {
      return coversAll(pathspecs) ? whole : null;
    }
    // A new branch from a start point is how work begins (`git checkout -b x
    // origin/main`); the tree it brings is not read here. `-f` throws every
    // change away.
    if (
      set.has("-b") ||
      set.has("-B") ||
      set.has("--orphan") ||
      operands.length === 0
    ) {
      return force ? whole : null;
    }
    if (pathspecs !== undefined) return "a switch to another tree";
    // git takes one operand as a branch when it names one, a file of the
    // same name or not: only a path on disk that names no revision is read
    // as a path. More operands are a tree and its paths, or paths alone.
    const path = (word: string) =>
      onDisk(word) && !namesRevision(word, place.base);
    const [first] = operands as [string];
    if (operands.length === 1) {
      return !path(first) || set.has("--detach")
        ? "a switch to another tree"
        : coversAll(operands)
          ? whole
          : null;
    }
    return coversAll(path(first) ? operands : operands.slice(1)) ? whole : null;
  }
  if (verb === "switch") {
    const values = ["--create", "--force-create", "--orphan", "--conflict"];
    const { operands, pathspecs } = gitOperands(rest, "cC", values);
    const set = optionsSet(
      rest,
      [
        ["f", "--force"],
        ["", "--discard-changes"],
        ["", "--orphan"],
        ["c", "--create"],
        ["C", "--force-create"],
      ],
      "cC",
      values,
    );
    // An orphan starts from no tree: every tracked file leaves the work tree.
    if (
      set.has("--force") ||
      set.has("--discard-changes") ||
      set.has("--orphan")
    ) {
      return whole;
    }
    if (set.has("--create") || set.has("--force-create")) return null;
    return operands.length > 0 || (pathspecs?.length ?? 0) > 0
      ? "a switch to another tree"
      : null;
  }
  if (verb === "restore") {
    const values = ["--source", "--conflict", "--pathspec-from-file"];
    const { operands, pathspecs } = gitOperands(rest, "s", values);
    const set = optionsSet(
      rest,
      [
        ["S", "--staged"],
        ["W", "--worktree"],
      ],
      "s",
      values,
    );
    if (set.has("--staged") && !set.has("--worktree")) return null;
    return coversAll(pathspecs ?? operands) ? whole : null;
  }
  if (verb === "rm") {
    const values = ["--pathspec-from-file"];
    const { operands, pathspecs } = gitOperands(rest, "", values);
    if (optionsSet(rest, [["", "--cached"]], "", values).size > 0) return null;
    return coversAll(pathspecs ?? operands) ? whole : null;
  }
  if (verb === "reset") {
    const modes = optionsSet(
      rest,
      [
        ["", "--hard"],
        ["", "--merge"],
        ["", "--keep"],
      ],
      "",
      ["--pathspec-from-file"],
    );
    return modes.size > 0 ? whole : null;
  }
  if (verb === "read-tree") {
    return optionsSet(rest, [["u", ""]], "", ["--index-output", "--prefix"])
      .size > 0
      ? "a switch to another tree"
      : null;
  }
  if (verb === "clean") {
    if (optionsSet(rest, [["n", "--dry-run"]], "e", ["--exclude"]).size > 0) {
      return null;
    }
    const { operands, pathspecs } = gitOperands(rest, "e", ["--exclude"]);
    const given = pathspecs ?? operands;
    return given.length === 0 || coversAll(given) ? whole : null;
  }
  if (verb === "stash") {
    const [action] = rest;
    const pushes =
      action === undefined ||
      action.startsWith("-") ||
      action === "push" ||
      action === "save";
    const untracked = optionsSet(
      rest,
      [
        ["u", "--include-untracked"],
        ["a", "--all"],
      ],
      "m",
      ["--message", "--pathspec-from-file"],
    );
    return pushes && untracked.size > 0 ? whole : null;
  }
  return null;
}

/**
 * The checks of git, gh and grep words that the ask rules do not see. The
 * narrow reading runs them all on a part the policy allows; the wide one
 * runs them but the work-tree ones (`wide`).
 */
function narrowKept(
  words: readonly string[],
  place: Place,
  wide = false,
  written?: readonly string[],
): string | null {
  const [name] = words;
  // A path is judged where it lands, `..` taken as spelled, and by its name
  // alone as well: git may read it from a tree, not the work tree
  // (`HEAD:.claude/settings.json` with `.claude` a broken link), and
  // `:(icase)` matches any case.
  let keptHere: string[] | undefined;
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
    // and `*` crosses `/`: it is kept when it matches a kept name. git never
    // takes what is in `.git` as a path of the work tree.
    if (!/[*?[\\]/.test(name)) return false;
    const pieces = globPieces(name);
    keptHere ??= keptNames(place.root);
    const names = [...KEPT_SAMPLES, ...keptHere];
    if (names.some((kept) => globMatches(pieces, kept))) return true;
    // A rule of any folder (`**/.env`) keeps that name wherever it is, and
    // `*` and `?` may stand for the `/` before it (`apps/web*.env`): an
    // end of the pattern that matches `/<name>` reaches one. An end of `*`
    // alone (`git add 'foo*'`) names no kept name; a secret inside a folder
    // the line names is not read here.
    let letters = 0;
    const fits = pieces.map(() => false);
    for (let at = pieces.length - 1; at >= 0; at -= 1) {
      if (pieces[at] !== "*") letters += 1;
      fits[at] = letters > 0 && letters <= KEPT_ANYWHERE_LONGEST + 1;
    }
    if (
      pieces.some(
        (_, from) =>
          fits[from] &&
          KEPT_ANYWHERE.some((kept) =>
            globMatches(pieces.slice(from), `/${kept}`),
          ),
      )
    ) {
      return true;
    }
    // A file under a kept folder may be gone from the work tree and come
    // back from the index (`git restore '.claud?/settings.json'`).
    const slash = name.indexOf("/");
    const head = globPieces(name.slice(0, slash));
    return (
      slash !== -1 &&
      !head.includes("*") &&
      [...KEPT_FOLDERS, ...names.filter((kept) => !kept.includes("/"))].some(
        (folder) => globMatches(head, folder),
      )
    );
  };
  if (name === "git" || name === "gh") {
    // Which option takes a value is not known here (`-F -m`, `-e -m`,
    // `-m --`), so no word is skipped as a message or a value: every word
    // is read as a path and as an option.
    // The wide reading takes what follows a message flag as text, up to a
    // `--`, as its own reading of gh and of git's message verbs does
    // (`git grep -e -m` gives `-m` as a pattern).
    const gitVerb = words.find(
      (word, index) => index > 0 && !word.startsWith("-"),
    );
    let options =
      wide && (name === "gh" || GIT_MESSAGE_VERBS.includes(gitVerb ?? ""));
    let message = false;
    const valued =
      name === "git" ? GIT_MESSAGE_VALUES[gitVerb ?? ""] : undefined;
    for (const [index, word] of words.slice(1).entries()) {
      if (word === "--") options = false;
      if (options) {
        const text =
          message || MESSAGE_FLAGS.some((flag) => word.startsWith(`${flag}=`));
        // `-F -m` gives `-m` as a file: a flag right after an option
        // that takes a value is not read as one.
        message =
          !message &&
          MESSAGE_FLAGS.includes(word) &&
          !takesValue(words[index] ?? "", valued);
        if (text) continue;
      }
      // git takes a long option by any unique start of its name.
      const option = word.split("=")[0] as string;
      const longStart = (full: string) =>
        option.length > 2 &&
        option.startsWith("--") &&
        (full.startsWith(option) || option.startsWith(full));
      // Every command with it has `--pathspec-file-nul` too, so git takes
      // no start shorter than `--pathspec-fr` for it.
      if (
        name === "git" &&
        option.length >= "--pathspec-fr".length &&
        longStart("--pathspec-from-file")
      ) {
        return "a path list the line does not show";
      }
      // `--author` is an option of its own (`git log --author=x`), not a
      // start of `--authors-prog`.
      if (
        name === "git" &&
        option !== "--author" &&
        GIT_RUNNING_OPTIONS.some(longStart)
      ) {
        return "a git option that runs a program";
      }
      // A secret or engine-settings path given to git or gh: `git checkout
      // HEAD -- .claude/settings.json`, `gh pr create --body-file .env`.
      // `HEAD:<path>`, `:0:<path>` and `:(top)<path>` are from the
      // repository's top, which may not be where the shell stands.
      // Tails are read for so many letters only; git takes a flag again and
      // again (`-nnn…nF<file>`), so a longer cluster is not answered for.
      if (new RegExp(`^-\\w{${CLUSTER_LETTERS + 1}}`).test(word)) {
        return "a cluster of short options too long to read";
      }
      // Only a letter the shell sees: `'.mcp.json~old'` is a name.
      const globbed = /[~^]/.test(
        (written?.[index + 1] ?? "").replace(/'[^']*'|"[^"]*"/g, ""),
      );
      const paths = refPathsIn(word, globbed);
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
      (short !== undefined && rest.some((word) => clusterSets(word, short))) ||
      GIT_RUNNING_VERBS.includes(verb ?? "") ||
      (verb === "bisect" && rest.includes("run")) ||
      // `git submodule--helper foreach` is what `git submodule foreach` runs.
      ((verb ?? "").startsWith("submodule") && rest.includes("foreach"))
    ) {
      return "a git option that runs a program";
    }
    // Files git leaves out by .gitignore are where secrets live; a search
    // that takes them in reads every one (`git grep --untracked
    // --no-exclude-standard KEY`).
    if (
      verb === "grep" &&
      rest.some(
        (word) =>
          word.length >= "--no-exc".length &&
          "--no-exclude-standard".startsWith(word.split("=")[0] as string),
      )
    ) {
      return "a search of the workspace or a kept path";
    }
    if (!wide && verb !== undefined) {
      const kept = workTreeKept(verb, rest, place);
      if (kept !== null) return kept;
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

const WRAPPERS = ["env", "command", "builtin", "exec", "nohup", "time"];
/** A git trace is written to a file its value names, unless the value is a switch or a descriptor. */
const TRACE_ENV = /^GIT_TRACE\w*$/;
const TRACE_SWITCH = /^(\d?|true|false)$/i;
const TOOLS = ["git", "gh", "grep"];
/** Settings of a git or gh environment that run nothing. */
const QUIET_ENV =
  /^(LC_\w+|LANG|LANGUAGE|TZ|TERM|COLUMNS|NO_COLOR|FORCE_COLOR|CLICOLOR(_FORCE)?|CI|GIT_OPTIONAL_LOCKS|GIT_CONFIG_NOSYSTEM|GIT_TERMINAL_PROMPT|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)|GH_REPO|GH_HOST|GH_PROMPT_DISABLED|GH_NO_UPDATE_NOTIFIER|GH_FORCE_TTY)$/;
/** A pager or an editor, and the values of one that run nothing. */
const PROGRAM_ENV =
  /^(GIT_PAGER|GH_PAGER|PAGER|GIT_EDITOR|GH_EDITOR|EDITOR|VISUAL|GIT_SEQUENCE_EDITOR)$/;
const QUIET_PROGRAMS = ["", "cat", "true", ":"];
/** A redirect before a command: `2>/dev/null`, `&>`, `<in`, not `<<` or `<(`. */
const REDIRECT = /^(?:\d+|&)?(?:>&|<&|<>|>>?\|?|<(?![<(]))/;
const SHELL_KEYWORDS = [
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "!",
  "{",
];

/**
 * The wide reading of git, gh and grep: {@link narrowKept} but the work-tree
 * checks, on the command behind any wrapper or setting (`env X=1 git`,
 * `/usr/bin/grep`). A setting of git's or gh's environment may name a program
 * (`GIT_PAGER=sh`, `GIT_DIR=.claude`), so only those known to run nothing pass.
 */
function wideKept(
  words: readonly string[],
  place: Place,
  written?: readonly string[],
): string | null {
  // The command is read without what the shell takes away before it runs:
  // a keyword that starts a compound command (`if grep -r x .; then`) and
  // a redirect anywhere (`2>/dev/null grep`, `grep -r x dir &> /dev/null`).
  const read: number[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as string;
    if (read.length === 0 && SHELL_KEYWORDS.includes(word)) continue;
    // Only in a line read as text: a split one has its redirects taken out,
    // and a quoted `'>'` is an argument.
    const raw = written?.[i];
    const redirect = raw === undefined ? null : REDIRECT.exec(raw);
    if (redirect !== null) {
      if (redirect[0] === raw) i += 1;
      continue;
    }
    read.push(i);
  }
  if (read.length < words.length) {
    return wideKept(
      read.map((i) => words[i] as string),
      place,
      written === undefined ? undefined : read.map((i) => written[i] as string),
    );
  }
  // Read left to right as the shell and each wrapper do: settings, then a
  // wrapper and its options, until git, gh or grep. Right after `env` any
  // `NAME=VALUE` is a setting, a name the shell would not take
  // (`env '>X=1' grep`) among them; after `command` it is a path.
  const settings: string[] = [];
  const wrappers: string[] = [];
  const options: string[] = [];
  // The options of the last wrapper, and whether a `--` ended them.
  let own: string[] = [];
  let ended = false;
  let at = -1;
  for (const [index, word] of words.entries()) {
    const last = wrappers.at(-1);
    const name = nameOf(word);
    // A path that starts with `-` and names a tool runs it
    // (`env X=1 -tools/grep`); reading it as the tool only parks more.
    const program = word.includes("/") && TOOLS.includes(name);
    if (last !== undefined && !ended && word.startsWith("-") && !program) {
      options.push(word);
      own.push(word);
      ended = word === "--";
      continue;
    }
    // `command -v git` only looks names up.
    // Only `command` as the line's first word is surely the builtin
    // (`env command` and `time command` run a program of that name), and
    // only on options of its own.
    if (
      words[0] === "command" &&
      wrappers.length === 1 &&
      own.length > 0 &&
      own.length === options.length &&
      own.every((option) => /^-[vV]+$/.test(option))
    ) {
      return null;
    }
    // A shell setting is read wherever it stands before the tool: the
    // `time` keyword passes it on (`time time X=1 git`), and where the shell
    // would run it as a program instead, reading it as a setting only
    // parks more.
    if (ASSIGNMENT.test(word) || (last === "env" && word.includes("="))) {
      settings.push(word);
    } else if (TOOLS.includes(name)) {
      at = index;
      break;
    } else if (WRAPPERS.includes(name)) {
      wrappers.push(name);
      own = [];
      ended = false;
    } else {
      // A word after a wrapper's option may be its value (`env -u X git`).
      return options.length > 0 &&
        words.slice(index).some((later) => TOOLS.includes(nameOf(later)))
        ? "a wrapper the line does not read"
        : null;
    }
  }
  if (at === -1) return null;
  // A wrapper's option may take a value (`env -u X`, `env -C dir`).
  if (options.length > 0) return "a wrapper the line does not read";
  const tool = nameOf(words[at] as string);
  if (tool !== "grep") {
    for (const word of settings) {
      const cut = word.indexOf("=");
      const key = word.slice(0, cut);
      const value = word.slice(cut + 1);
      if (
        !QUIET_ENV.test(key) &&
        !(TRACE_ENV.test(key) && TRACE_SWITCH.test(value)) &&
        !(PROGRAM_ENV.test(key) && QUIET_PROGRAMS.includes(value))
      ) {
        return "a setting that may make git or gh run a program";
      }
    }
  }
  return narrowKept(
    [tool, ...words.slice(at + 1)],
    place,
    true,
    written?.slice(at),
  );
}

/** The files gh reads as a body: `--body-file x`, `--body-file=x`, `-F x`, `-Fx`, `-dF x`. */
function ghBodyFiles(words: readonly string[]): string[] {
  const files: string[] = [];
  words.forEach((word, index) => {
    const next = words[index + 1] ?? "";
    if (word === "--body-file") files.push(next);
    else if (word.startsWith("--body-file=")) files.push(word.slice(12));
    else if (/^-[^-]/.test(word) && word.includes("F")) {
      // pflag takes `-F=x` as `x`.
      files.push(word.slice(word.indexOf("F") + 1).replace(/^=/, "") || next);
    }
  });
  return files.filter((file) => file !== "");
}

/** One letter of a pathspec pattern, or `*`, which stands for any run of letters, `/` among them. */
type GlobPiece = "*" | ((letter: string) => boolean);

/** POSIX classes git takes inside brackets. */
const POSIX_CLASSES: Readonly<Record<string, RegExp>> = {
  alpha: /[a-z]/i,
  digit: /[0-9]/,
  alnum: /[a-z0-9]/i,
  lower: /[a-z]/,
  upper: /[A-Z]/,
  xdigit: /[0-9a-f]/i,
  space: /\s/,
  blank: /[ \t]/,
  punct: /[!-/:-@[-`{-~]/,
};

/**
 * A git pathspec pattern as letters: `*` and `?` cross `/`, a backslash
 * keeps the letter after it as it is, `[!a]` and `[[:alpha:]]` are classes,
 * and a range backwards (`[z-a]`) is left out of its class as git leaves it.
 * A class git knows and this does not is any one letter. Case is aside.
 */
function globPieces(glob: string): GlobPiece[] {
  const same = (letter: string) => (other: string) =>
    other.toLowerCase() === letter.toLowerCase();
  const pieces: GlobPiece[] = [];
  const closing = glob.lastIndexOf("]");
  for (let at = 0; at < glob.length; at += 1) {
    const char = glob[at] as string;
    if (char === "*") {
      if (pieces.at(-1) !== "*") pieces.push("*");
    } else if (char === "?") pieces.push(() => true);
    else if (char === "\\" && at + 1 < glob.length) {
      at += 1;
      pieces.push(same(glob[at] as string));
    } else if (char === "[" && closing > at + 1) {
      let end = at + 1;
      const negated = glob[end] === "!" || glob[end] === "^";
      if (negated) end += 1;
      const tests: ((letter: string) => boolean)[] = [];
      let known = true;
      // One letter of the class, a backslash keeping the next as it is.
      const letter = () => {
        const next = glob[end] as string;
        if (next === "\\" && end + 1 < glob.length) {
          end += 2;
          return glob[end - 1] as string;
        }
        end += 1;
        return next;
      };
      for (let first = true; end < glob.length; first = false) {
        if (glob[end] === "]" && !first) break;
        const posix = /^\[:(\w+):\]/.exec(glob.slice(end));
        if (posix !== null) {
          const range = POSIX_CLASSES[posix[1] as string];
          if (range === undefined) known = false;
          else tests.push((other) => range.test(other));
          end += posix[0].length;
          continue;
        }
        const from = letter();
        if (
          glob[end] === "-" &&
          end + 1 < glob.length &&
          glob[end + 1] !== "]"
        ) {
          end += 1;
          const to = letter();
          tests.push((other) => from <= other && other <= to);
        } else tests.push((other) => other === from);
      }
      if (end >= glob.length) pieces.push(same(char));
      else {
        pieces.push(
          // Either case in or out of the class, so the pattern is read as
          // matching whenever git might match it.
          known
            ? (other) =>
                [other.toLowerCase(), other.toUpperCase()].some(
                  (cased) => tests.some((test) => test(cased)) !== negated,
                )
            : () => true,
        );
        at = end;
      }
    } else pieces.push(same(char));
  }
  return pieces;
}

/** Whether pattern letters match a name, going back only to the last `*`. */
function globMatches(pieces: readonly GlobPiece[], name: string): boolean {
  let piece = 0;
  let at = 0;
  let star = -1;
  let mark = 0;
  while (at < name.length) {
    const next = pieces[piece];
    if (next === "*") {
      star = piece;
      mark = at;
      piece += 1;
    } else if (next?.(name[at] as string)) {
      piece += 1;
      at += 1;
    } else if (star !== -1) {
      piece = star + 1;
      mark += 1;
      at = mark;
    } else return false;
  }
  while (pieces[piece] === "*") piece += 1;
  return piece === pieces.length;
}

/** Kept names a pattern may reach: the kept entries at the top and what is below them, but not `.git`. */
function keptNames(root: string): string[] {
  const names: string[] = [];
  const walk = (folder: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(resolve(root, folder || "."));
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = folder === "" ? entry : `${folder}/${entry}`;
      if (name === ".git" || names.length >= KEPT_NAMES_READ) continue;
      const located = locate({ root, base: root }, name);
      const kept = located !== undefined && sensitive(located);
      if (kept) names.push(name);
      if ((kept || depth > 0) && depth < 3) walk(name, depth + 1);
    }
  };
  walk("", 0);
  return names;
}
// Names for each kept rule but those of `.git`, its `*` filled a few ways:
// `.claude/**` gives `.claude/settings.json`, `**/credentials*` gives
// `credentials.json`.
const keptSamples = (rule: string) =>
  ["", "x", ".json", "-x"].map((fill) =>
    rule
      .replace(/^\*\*\//, "")
      .replace(/\/\*\*$/, "/settings.json")
      .replaceAll("*", fill),
  );
const KEPT_SAMPLES = policy.sensitiveEditPaths
  .filter((rule) => !rule.startsWith(".git/"))
  .flatMap(keptSamples);
/** The names kept in any folder, and how long the longest is. */
const KEPT_ANYWHERE = policy.sensitiveEditPaths
  .filter((rule) => rule.startsWith("**/"))
  .flatMap(keptSamples);
const KEPT_ANYWHERE_LONGEST = Math.max(
  ...KEPT_ANYWHERE.map((name) => name.length),
);
/** The kept folders at the top but `.git`. */
const KEPT_FOLDERS = policy.sensitiveEditPaths
  .filter((rule) => rule.endsWith("/**") && !rule.startsWith("**/"))
  .map((rule) => rule.slice(0, -3))
  .filter((folder) => folder !== ".git");
/** More kept names than this are not read for a pattern. */
const KEPT_NAMES_READ = 500;

/** More letters than this in one cluster of short options is not a cluster. */
const CLUSTER_LETTERS = 32;

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
    // Only git has revisions; elsewhere the letter stays unread.
    if (part.revision !== undefined && name !== "git") {
      return `a ${part.revision} outside a quote`;
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
  const tools = narrow
    ? narrowKept(part.words, place, false, part.written)
    : wideKept(part.words, place);
  if (tools !== null) return tools;
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
/** git verbs whose `-m` is a message, with the options of each that take a value. */
const GIT_MESSAGE_VALUES: Readonly<
  Record<string, readonly [string, readonly string[]]>
> = {
  commit: [
    "FCct",
    [
      "--file",
      "--author",
      "--date",
      "--template",
      "--reuse-message",
      "--reedit-message",
      "--fixup",
      "--squash",
      "--trailer",
      "--cleanup",
      "--pathspec-from-file",
    ],
  ],
  tag: ["Fu", ["--file", "--local-user", "--cleanup", "--format"]],
  notes: ["FCc", ["--file", "--reuse-message", "--reedit-message", "--ref"]],
  stash: ["", ["--pathspec-from-file"]],
  merge: [
    "FsX",
    ["--file", "--strategy", "--strategy-option", "--into-name", "--cleanup"],
  ],
};
const GIT_MESSAGE_VERBS = Object.keys(GIT_MESSAGE_VALUES);

/** Whether an option takes the next word as its value, by the options that take one. */
function takesValue(
  word: string,
  valued: readonly [string, readonly string[]] | undefined,
): boolean {
  if (valued === undefined || !word.startsWith("-") || word.includes("=")) {
    return false;
  }
  const [letters, longs] = valued;
  if (word.startsWith("--")) {
    return word.length > 2 && longs.some((full) => full.startsWith(word));
  }
  const at = [...word.slice(1)].findIndex((letter) => letters.includes(letter));
  return at !== -1 && at + 2 === word.length;
}
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

/**
 * The text without the bodies of `$(cat <<'EOF'` … `EOF` `)` the shell runs:
 * under a quoted delimiter the body is printed as written, and it ends at
 * the first line that is the delimiter alone. The text before each is read
 * as the shell does (quotes, a backslash, a comment), so a start inside a
 * comment or a single quote is left in place.
 */
function withoutCatBodies(text: string): string {
  const start =
    /\$\(cat <<(['"])([A-Za-z_]\w*)\1\n(?:(?!\2\n)[^\n]*\n)*\2\n\)/g;
  let out = "";
  let read = 0;
  // A `$( )` opens quotes and comments of its own, inside a double quote
  // too; `parens` counts the `( )` it holds and `cases` the `case` whose
  // patterns end in `)`, so only its own `)` ends it.
  const frames: { quote: "" | "'" | '"'; parens: number; cases: number }[] = [
    { quote: "", parens: 0, cases: 0 },
  ];
  // `case` and `esac` as a command's first word, not an argument.
  const word = (name: string) =>
    text.startsWith(name, read) &&
    /(^|[\n;&|(])[ \t]*(?:(?:if|then|elif|else|while|until|do|time|time[ \t]+-p|!|\{)[ \t]+)*$/.test(
      text.slice(Math.max(0, read - 80), read),
    ) &&
    /^$|[\s;&|)]/.test(text[read + name.length] ?? "");
  let comment = false;
  let escaped = false;
  const scan = (to: number) => {
    for (; read < to; read += 1) {
      const char = text[read] as string;
      const frame = frames[frames.length - 1] as (typeof frames)[number];
      out += char;
      if (comment) {
        if (char === "\n") comment = false;
      } else if (escaped) {
        escaped = false;
      } else if (frame.quote === "'") {
        if (char === "'") frame.quote = "";
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "$" && text[read + 1] === "(") {
        out += "(";
        read += 1;
        frames.push({ quote: "", parens: 0, cases: 0 });
      } else if (frame.quote === '"') {
        if (char === '"') frame.quote = "";
      } else if (char === "'" || char === '"') {
        frame.quote = char;
      } else if (char === "#" && /^$|[\s;&|()]/.test(text[read - 1] ?? "")) {
        comment = true;
      } else if (char === "(") {
        frame.parens += 1;
      } else if (char === ")") {
        if (frame.parens > 0) frame.parens -= 1;
        else if (frame.cases === 0 && frames.length > 1) frames.pop();
      } else if (word("case")) {
        frame.cases += 1;
      } else if (word("esac") && frame.cases > 0) {
        frame.cases -= 1;
      }
    }
  };
  for (const match of text.matchAll(start)) {
    const at = match.index;
    if (at < read) continue;
    scan(at);
    const frame = frames[frames.length - 1] as (typeof frames)[number];
    if (comment || escaped || frame.quote === "'") continue;
    out += "$()";
    read = at + match[0].length;
  }
  scan(text.length);
  return out;
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
  // git, gh and grep are looked for outside the bodies `$(cat <<'EOF' …)`
  // gives as text: a pull request's body may show a command it does not run.
  // A redirect's `&` and `|` (`2>&1`, `&>`, `>|`) do not end a command.
  for (const piece of withoutCatBodies(text).split(
    /&&|\|\||(?<!(?<!\\)[<>])&(?!>)|(?<!(?<!\\)>)\||[;\n()`]/,
  )) {
    const written = piece
      .trim()
      .split(/\s+/)
      .filter((word) => word.replace(/['"\\]/g, "") !== "");
    const words = written.map((word) => word.replace(/['"\\]/g, ""));
    for (const base of bases) {
      const kept = wideKept(words, { root, base }, written);
      if (kept !== null) return kept;
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
  const parts = partsOf(command, true, true);
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
