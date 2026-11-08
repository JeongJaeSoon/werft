import { realpathSync } from "node:fs";

/**
 * What a session needs to make a pull request, decided without asking a
 * person: file edits under its own workspace and the local git and test
 * commands. Handed to the engine as flag settings, which a repository's
 * `.claude/settings.json` cannot widen or drop.
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

/**
 * File name parts that mark a secret. A command line is matched by text, so
 * this list is what `git add` and `git commit` are checked against; keep it
 * in step with SENSITIVE_PATHS below.
 */
const SECRET_NAME_PARTS = [
  ".env",
  ".npmrc",
  ".yarnrc",
  ".pypirc",
  ".netrc",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore",
  "id_rsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "service-account",
];

/** Edits under the workspace that still go to a person. */
const SENSITIVE_PATHS = [
  ".git/**",
  ".claude/**",
  ".mcp.json",
  ".aws/**",
  ".ssh/**",
  ".docker/**",
  ".kube/**",
  "**/.env",
  "**/.env.*",
  "**/.npmrc",
  "**/.yarnrc.yml",
  "**/.pypirc",
  "**/.netrc",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.keystore",
  "**/id_rsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/credentials*",
  "**/service-account*.json",
];

/**
 * Git that stays on this machine. Each entry is the narrowest shape that does
 * its job, because the way to stay safe is to allow little: whatever is not
 * listed (`git checkout <path>`, `git restore` of the working tree,
 * `git switch -f`, `git stash drop`, `git reset`, `git clean`, ...) is not
 * allowed and so asks, however its flags are spelled. A listed shape is
 * followed by an ask pattern for any further option.
 */
const LOCAL_GIT = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git add",
  "git commit",
  "git checkout -b",
  "git switch -c",
  "git switch --create",
  // Unstaging only; restoring the working tree discards edits that no object
  // or reflog keeps.
  "git restore --staged",
  "git stash list",
  "git stash show",
  "git stash push",
  "git stash pop",
  "git stash apply",
];

/** Bare forms that must not also take the `*` of the shapes above. */
const GIT_EXACT = ["git stash"];

/**
 * Options that turn a listed shape into one that discards work, stages a
 * secret or reaches beyond the repository, and secret names. An option can
 * come after the operands, so each is matched anywhere in the line.
 */
const GIT_ASK = [
  "git * --force*",
  "git * --discard-changes*",
  "git * --output*",
  "git * --ext-diff*",
  // Any further option on a shape that is only safe without one, so an
  // abbreviated or bundled flag (`--forc`, `-fA`, `-df`) cannot slip past.
  "git add --*",
  "git add * --*",
  "git add -*f*",
  "git add * -*f*",
  "git checkout -b * -*",
  "git switch -c * -*",
  "git switch --create * -*",
  "git restore --staged -*",
  "git restore --staged * -*",
  // `git commit <path>` commits that file's current content without an add.
  ...["git add", "git commit"].flatMap((command) =>
    SECRET_NAME_PARTS.map((part) => `${command} *${part}*`),
  ),
];

/**
 * Read-only inspection (`ls`, `cat`, `grep`, `git remote -v`, `git branch -a`,
 * `find`, ...) is not listed in `allow`: the engine runs those unasked inside
 * the workspace and itself asks for an outside path, `find -exec|-delete|-fprint`,
 * `tree -o` and `rg --pre`. What it does not see is that `.env` is a secret, so
 * the readers of file content ask when a secret's name is on the line. By
 * name only: `cat .e*`, `grep -r . .` and a symlink named innocently get past
 * it, as they do past the Read tool, which the engine allows in the workspace.
 * The container and the egress proxy are what hold the content in.
 */
const SECRET_READERS = ["cat", "head", "tail", "grep", "rg"];

/** The secret names above, minus `credentials`, which also names source files. */
const SECRET_READ_PARTS = [
  ...SECRET_NAME_PARTS.filter((part) => part !== "credentials"),
  ".git/config",
];

/** `rg` skips hidden files (`.env` among them) unless told not to. */
const RG_HIDDEN_ASK = ["--hidden", "-uu", "--no-ignore", "--unrestricted"];

/** Test and script runners; the workspace's own code runs through them. */
const DEV_COMMANDS = [
  "bun test",
  "bun run",
  "npm test",
  "npm run",
  "pnpm test",
  "pnpm run",
  "yarn test",
  "yarn run",
];

/** Ways those runners are pointed at code or a shell outside the workspace. */
const DEV_ASK = [
  "* --prefix*",
  "* --script-shell*",
  "* --cwd*",
  "* -C *",
  "* /*",
  "* ..*",
  "* */../*",
];

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
 * The rules for a session whose tool surface is `tools`. A rule for a tool
 * the profile does not list is never produced: the allowlist stays the only
 * thing that widens the surface.
 */
export function workspaceRules(
  cwd: string,
  tools: ReadonlySet<string>,
): WorkspaceRules {
  const allow: string[] = [];
  const ask: string[] = [];
  // The engine applies an Edit rule to every file-writing tool.
  if (["Write", "Edit", "NotebookEdit"].some((tool) => tools.has(tool))) {
    for (const root of workspaceRoots(cwd)) {
      allow.push(`Edit(/${root}/**)`);
      for (const path of SENSITIVE_PATHS) ask.push(`Edit(/${root}/${path})`);
    }
  }
  if (tools.has("Bash")) {
    for (const command of [...LOCAL_GIT, ...DEV_COMMANDS]) {
      allow.push(`Bash(${command})`, `Bash(${command} *)`);
    }
    allow.push(...GIT_EXACT.map((command) => `Bash(${command})`));
    ask.push(...GIT_ASK.map((pattern) => `Bash(${pattern})`));
    for (const command of SECRET_READERS) {
      for (const part of SECRET_READ_PARTS) {
        ask.push(`Bash(${command} *${part}*)`);
      }
    }
    for (const option of RG_HIDDEN_ASK) ask.push(`Bash(rg *${option}*)`);
    for (const command of DEV_COMMANDS) {
      // `*` stands for the operands before the flag, which may be none.
      for (const flag of DEV_ASK) {
        ask.push(
          `Bash(${command}${flag.slice(1)})`,
          `Bash(${command} ${flag})`,
        );
      }
    }
  }
  return { allow, ask };
}
