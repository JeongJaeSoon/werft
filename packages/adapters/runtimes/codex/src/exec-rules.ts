import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_POLICY, type WorkspacePolicy } from "@werft-ai/runtime-core";

/**
 * The shared workspace policy as the engine's exec policy: `prefix_rule`s in
 * a `.rules` file under `CODEX_HOME/rules`, which the engine loads as the
 * user layer. A rule matches whole argv tokens from the start of a command,
 * and the strictest decision among the matching rules wins, so a `prompt`
 * rule carves a shape out of a broad `allow` the way an ask rule does for
 * the Claude engine.
 *
 * A policy pattern is the Claude rule syntax, where `*` matches any run of
 * characters. Only a few shapes of it have a prefix form; every other pattern
 * (a glob inside a token, a path, a secret's name after a flag) is returned
 * in `unexpressed`.
 */
export type ExecRule = { pattern: string[]; decision: "allow" | "prompt" };

export type ExecRules = { rules: ExecRule[]; unexpressed: string[] };

/** What a rules file can carry as a plain string, with nothing to escape. */
const LITERAL = /^[\w./:=@+,-]+$/;
const OPTION = /^-{1,2}[A-Za-z0-9][\w-]*$/;
/** A verb or a file name, never a path that climbs or starts at the root. */
const WORD = /^[\w.][\w./-]*$/;
const CLUSTER = /^-\*([A-Za-z])\*$/;

function stemOf(token: string): string | undefined {
  const cluster = CLUSTER.exec(token);
  if (cluster !== null) return `-${cluster[1]}`;
  let stem = token;
  if (stem.startsWith("*") && OPTION.test(stem.slice(1).replace(/\*$/, ""))) {
    stem = stem.slice(1);
  }
  if (stem.endsWith("*")) stem = stem.slice(0, -1);
  if (stem.includes("*") || !LITERAL.test(stem)) return undefined;
  if (stem !== token && !OPTION.test(stem) && !WORD.test(stem)) {
    return undefined;
  }
  if (stem.includes("..") || stem.startsWith("/")) return undefined;
  // `alias.*` names every `alias.<name>` token; the token `alias.` alone
  // never occurs, so the shape has no prefix form.
  if (stem !== token && /[.=:/@+,]$/.test(stem)) return undefined;
  return stem;
}

/** The prefix a Claude pattern asks for, or undefined when it has none. */
export function prefixOf(pattern: string): string[] | undefined {
  const tokens = pattern.split(" ").filter((token) => token !== "");
  const prefix: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token === "*" && index > 0) continue;
    const stem = stemOf(token);
    if (stem === undefined) return undefined;
    prefix.push(stem);
  }
  return prefix.length < 2 ? undefined : prefix;
}

/** The Claude ask patterns the policy produces, in the Claude adapter's shape. */
function askPatterns(policy: WorkspacePolicy): string[] {
  const read = policy.secretRead;
  const letters = [...read.clusterLetters];
  const bundles = [...policy.read.inPlaceLetters].flatMap((a) => [
    a,
    ...[...policy.read.inPlaceLetters].map((b) => `${a}${b}`),
  ]);
  const names = [
    ...policy.secretNameParts.filter(
      (part) =>
        !read.notAReadName.includes(part) && !read.extensions.includes(part),
    ),
    ...read.extraNames,
  ];
  const starts = [...read.nameStarts, ...letters.map((l) => `-${l}f`)];
  return [
    ...policy.git.ask,
    ...policy.git.askWhenSecretNamed.flatMap((command) =>
      policy.secretNameParts.map((part) => `${command} *${part}*`),
    ),
    ...policy.read.ask,
    ...bundles.flatMap((b) => [`sed -${b}i*`, `sed * -${b}i*`]),
    ...[...policy.read.addressChars].flatMap((c) => [
      `sed *${c}w*`,
      `sed *${c}e *`,
    ]),
    ...policy.fs.ask,
    ...read.readers.flatMap((command) => [
      ...names.flatMap((name) => [
        `${command} ${name}*`,
        ...starts.map((start) => `${command} *${start}${name}*`),
      ]),
      ...read.extensions.map((extension) => `${command} *${extension}`),
    ]),
    ...read.gitReaders.flatMap((verb) =>
      names.map((name) => `git *${verb}* ${name}*`),
    ),
    ...policy.rgHidden.ask,
    ...[...policy.rgHidden.letterBeforeUU].map((letter) => `rg -${letter}uu*`),
    ...letters.flatMap((a) => letters.map((b) => `rg -${a}${b}uu*`)),
    ...policy.dev.commands.flatMap((command) =>
      policy.dev.ask.map((flag) => `${command} ${flag}`),
    ),
  ];
}

const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((token, index) => token === b[index]);

export function execRulesOf(
  policy: WorkspacePolicy = WORKSPACE_POLICY,
): ExecRules {
  const allow = [
    ...policy.git.allow,
    ...policy.read.allow,
    ...policy.fs.allow,
    ...policy.dev.commands,
  ].map((command) => command.split(" "));
  for (const pattern of allow) {
    if (!pattern.every((token) => LITERAL.test(token))) {
      throw new Error(
        `workspace policy allow ${pattern.join(" ")} is not a plain command`,
      );
    }
  }
  const rules: ExecRule[] = allow.map((pattern) => ({
    pattern,
    decision: "allow",
  }));
  const unexpressed = new Set<string>();
  for (const pattern of askPatterns(policy)) {
    const prefix = prefixOf(pattern);
    if (prefix === undefined) {
      unexpressed.add(pattern);
      continue;
    }
    // A prompt on a whole allowed command would ask for every use of it.
    if (allow.some((allowed) => same(allowed, prefix))) {
      throw new Error(
        `workspace policy ask ${pattern} would ask for all of ${prefix.join(" ")}`,
      );
    }
    if (!rules.some((rule) => same(rule.pattern, prefix))) {
      rules.push({ pattern: prefix, decision: "prompt" });
    }
  }
  return { rules, unexpressed: [...unexpressed] };
}

export function renderExecRules(rules: ExecRule[]): string {
  return [
    "# Written by the Werft Codex adapter from the workspace policy on every start.",
    ...rules.map(
      (rule) =>
        `prefix_rule(pattern=${JSON.stringify(rule.pattern)}, decision="${rule.decision}")`,
    ),
    "",
  ].join("\n");
}

export const EXEC_RULES_FILE = "werft-workspace.rules";

/**
 * Leaves `<home>/rules` holding the platform's file alone, so nothing a
 * session wrote there carries into the next start. With approval `never` a
 * `prompt` rule would refuse the command instead of asking, so none is
 * written. `on-request` (auto) asks for approvals, so it gets them.
 */
export function writeExecRules(
  home: string,
  approval: "untrusted" | "on-request" | "never",
): void {
  const dir = join(home, "rules");
  rmSync(dir, { recursive: true, force: true });
  if (approval === "never") return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, EXEC_RULES_FILE),
    renderExecRules(execRulesOf().rules),
    {
      mode: 0o600,
    },
  );
}
