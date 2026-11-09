import { realpathSync } from "node:fs";
import { z } from "zod";
import defaultSettings from "./settings/default.json" with { type: "json" };

/**
 * What a session needs to make a pull request, decided without asking a
 * person: file edits under its own workspace and the local git and test
 * commands. Handed to the engine as flag settings, which a repository's
 * `.claude/settings.json` cannot widen or drop.
 *
 * The lists live in `settings/default.json`: adding a command to allow or a
 * pattern to ask is an edit of that file. This module holds what the lists
 * mean, which the file cannot say.
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

/** A list that guards something is never empty: an emptied one is an error. */
const patterns = z.array(z.string().min(1)).min(1);

const policySchema = z
  .object({
    /**
     * File name parts that mark a secret. A command line is matched by text,
     * so this list is what `git add` and `git commit` are checked against;
     * keep it in step with `sensitiveEditPaths`.
     */
    secretNameParts: patterns,
    /** Edits under the workspace that still go to a person. */
    sensitiveEditPaths: patterns,
    git: z
      .object({
        /**
         * Git that stays on this machine. Each entry is the narrowest shape
         * that does its job, because the way to stay safe is to allow little:
         * whatever is not listed (`git checkout <path>`, `git restore` of the
         * working tree, `git switch -f`, `git stash drop`, `git reset`,
         * `git clean`, ...) is not allowed and so asks, however its flags are
         * spelled. A listed shape is followed by an ask pattern for any
         * further option, so an abbreviated or bundled flag (`--forc`, `-fA`,
         * `-df`) cannot slip past. `git restore --staged` only unstages;
         * restoring the working tree discards edits that no object or reflog
         * keeps, so it is not listed.
         */
        allow: patterns,
        /** Bare forms that must not also take the `*` of the shapes above. */
        exact: patterns,
        /**
         * Options that turn a listed shape into one that discards work,
         * stages a secret or reaches beyond the repository. An option can
         * come after the operands, so each is matched anywhere in the line.
         */
        ask: patterns,
        /**
         * `git commit <path>` commits that file's current content without an
         * add, so each of these asks when a secret name is on the line.
         */
        askWhenSecretNamed: patterns,
      })
      .strict(),
    fs: z
      .object({
        /**
         * A sample PR starts with `mkdir -p notes && echo ... > notes/x`, and
         * the engine does not run `mkdir` unasked outside acceptEdits. An
         * empty directory is cheap to undo; a path that leaves the workspace
         * still asks.
         */
        allow: patterns,
        ask: patterns,
      })
      .strict(),
    /**
     * Read-only inspection (`ls`, `cat`, `grep`, `git remote -v`,
     * `git branch -a`, `find`, ...) is not listed in `allow`: the engine runs
     * those unasked inside the workspace and itself asks for an outside path,
     * `find -exec|-delete|-fprint`, `tree -o` and `rg --pre`. What it does not
     * see is that `.env` is a secret, so the readers of file content ask when
     * a secret's name is on the line. By name only: `cat .e*`, `grep -r . .`
     * and a symlink named innocently get past it, as they do past the Read
     * tool, which the engine allows in the workspace. The container and the
     * egress proxy are what hold the content in.
     */
    secretRead: z
      .object({
        readers: patterns,
        /**
         * Where a file name begins in a command line: the first operand, or
         * after one of these. Matching them anywhere would ask for
         * `process.env` and `src/credentials.ts`, which are code and not
         * secrets. `-f` and `-<letter>f` are a pattern file named right after
         * the flag (`grep -f.env`, `grep -nf.env`).
         */
        nameStarts: patterns,
        /** The usual one-letter flags that can come before `f` or `uu`. */
        clusterLetters: z.string().min(1),
        /** Matched where the name ends, so `object.keys.ts` is not a key. */
        extensions: patterns,
        extensionEnds: patterns,
        /** Name parts that are code as often as secrets; see `extraNames`. */
        notAReadName: patterns,
        /**
         * Names matched from where they begin, beside the secret parts. Only
         * the JSON key files, as in `sensitiveEditPaths`: `service-account.ts`
         * is code.
         */
        extraNames: patterns,
      })
      .strict(),
    /**
     * `rg` skips hidden files (dotenv files among them) unless told not to,
     * and `-uu` turns that off. It can be spelled `-uu`, `-nuu`, `-u -u` or
     * `-unu`, so any flag that starts with `-u` asks, and so does one letter
     * then `uu`. `*` crosses spaces, so a bare `-*uu*` would ask for
     * `rg -n uuid src`. A `u` in the middle of a longer cluster (`-nunu`,
     * `-ninuu`) is not caught.
     */
    rgHidden: z
      .object({ ask: patterns, letterBeforeUU: z.string().min(1) })
      .strict(),
    dev: z
      .object({
        /** Test and script runners; the workspace's own code runs through them. */
        commands: patterns,
        /** Ways those runners are pointed at code or a shell outside it. */
        ask: patterns,
      })
      .strict(),
  })
  .strict();

const policy = policySchema.parse(defaultSettings);

/** The ask patterns for one reader and every spelling of a secret's name. */
function secretReadPatterns(command: string): string[] {
  const read = policy.secretRead;
  const letters = [...read.clusterLetters];
  const starts = [...read.nameStarts, ...letters.map((l) => `-${l}f`)];
  const names = [
    ...policy.secretNameParts.filter(
      (part) =>
        !read.notAReadName.includes(part) && !read.extensions.includes(part),
    ),
    ...read.extraNames,
  ].flatMap((name) => [
    `${command} ${name}*`,
    ...starts.map((start) => `${command} *${start}${name}*`),
  ]);
  const extensions = read.extensions.flatMap((extension) => [
    `${command} *${extension}`,
    ...read.extensionEnds.map((end) => `${command} *${extension}${end}*`),
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
      for (const path of policy.sensitiveEditPaths) {
        ask.push(`Edit(/${root}/${path})`);
      }
    }
  }
  if (tools.has("Bash")) {
    for (const command of [
      ...policy.git.allow,
      ...policy.fs.allow,
      ...policy.dev.commands,
    ]) {
      allow.push(`Bash(${command})`, `Bash(${command} *)`);
    }
    allow.push(...policy.git.exact.map((command) => `Bash(${command})`));
    ask.push(
      ...[
        ...policy.git.ask,
        ...policy.git.askWhenSecretNamed.flatMap((command) =>
          policy.secretNameParts.map((part) => `${command} *${part}*`),
        ),
      ].map((pattern) => `Bash(${pattern})`),
    );
    ask.push(...policy.fs.ask.map((pattern) => `Bash(${pattern})`));
    for (const command of policy.secretRead.readers) {
      ask.push(...secretReadPatterns(command).map((p) => `Bash(${p})`));
    }
    ask.push(...rgHiddenPatterns().map((pattern) => `Bash(${pattern})`));
    for (const command of policy.dev.commands) {
      // `*` stands for the operands before the flag, which may be none.
      for (const flag of policy.dev.ask) {
        ask.push(
          `Bash(${command}${flag.slice(1)})`,
          `Bash(${command} ${flag})`,
        );
      }
    }
  }
  return { allow, ask };
}
