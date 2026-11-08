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

/** Git that stays on this machine. */
const LOCAL_GIT = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git add",
  "git commit",
  "git branch",
  // Not a bare `git checkout`: with a path it restores the working tree.
  "git checkout -b",
  "git switch",
  "git stash",
  // Only the unstaging form; a restore of the working tree discards edits
  // that no object or reflog keeps.
  "git restore --staged",
];

/**
 * Forms of those commands that discard work, stage a secret or reach beyond
 * the repository. An option can come after the operands, so each is matched
 * anywhere in the line.
 */
const GIT_ASK = [
  "git * --force*",
  "git * --discard-changes*",
  "git * --output*",
  "git * --ext-diff*",
  "git * -f",
  "git * -f *",
  "git * -D",
  "git * -D *",
  // Short flags can be bundled; `*` is the only wildcard the engine reads,
  // so the usual bundles are spelled out.
  ...["qf", "fq", "cf", "fc", "qD", "Dq"].flatMap((bundle) => [
    `git * -${bundle}`,
    `git * -${bundle} *`,
  ]),
  "git restore *--worktree*",
  "git restore *W*",
  "git stash drop*",
  "git stash clear*",
  "git add *.env*",
  "git add *.pem*",
  "git add *.key*",
  "git add *id_rsa*",
  "git add *id_ecdsa*",
  "git add *id_ed25519*",
  "git add *credentials*",
  "git add *service-account*",
];

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
    ask.push(...GIT_ASK.map((pattern) => `Bash(${pattern})`));
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
