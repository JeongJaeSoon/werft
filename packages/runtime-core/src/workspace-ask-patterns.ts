import { WORKSPACE_POLICY, type WorkspacePolicy } from "./workspace-policy.ts";

/**
 * The ask patterns for one reader and every spelling of a secret's name.
 * `git` is for a git verb written as `git *<verb>*`, so a global option may
 * come first: the name pattern then follows the verb directly instead of
 * after an operand. It keeps the `-<letter>f` starts only for `clusters`
 * (`git grep -nf.env`).
 */
function secretReadPatterns(
  policy: WorkspacePolicy,
  command: string,
  options: { git: boolean; clusters: boolean } = { git: false, clusters: true },
): string[] {
  const read = policy.secretRead;
  const letters = [...read.clusterLetters];
  const starts = options.clusters
    ? [...read.nameStarts, ...letters.map((l) => `-${l}f`)]
    : read.nameStarts;
  // `cat <name>` has the name as its first operand; `git *show* <name>` is the
  // same shape with the verb already inside `command`.
  const operand = (start: string, name: string) =>
    options.git
      ? `${command}${start.startsWith("-") ? "*" : ""}${start}${name}*`
      : `${command} *${start}${name}*`;
  const joint = options.git ? "" : " ";
  const names = [
    ...policy.secretNameParts.filter(
      (part) =>
        !read.notAReadName.includes(part) && !read.extensions.includes(part),
    ),
    ...read.extraNames,
  ].flatMap((name) => [
    ...(options.git ? [] : [`${command} ${name}*`]),
    ...starts.map((start) => operand(start, name)),
  ]);
  const extensions = read.extensions.flatMap((extension) => [
    `${command}${joint}*${extension}`,
    ...read.extensionEnds.map(
      (end) => `${command}${joint}*${extension}${end}*`,
    ),
  ]);
  return [...names, ...extensions];
}

function rgHiddenPatterns(policy: WorkspacePolicy): string[] {
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

/**
 * The shell commands the policy keeps for a person, as patterns over one
 * command's text (`*` is any run of characters). One list for every engine:
 * the Claude adapter hands it to the engine as its ask rules, and an adapter
 * that answers an engine's ask itself reads the line against it.
 */
export function workspaceAskPatterns(
  policy: WorkspacePolicy = WORKSPACE_POLICY,
): string[] {
  const letters = [...policy.read.inPlaceLetters];
  const bundles = letters.flatMap((a) => [
    a,
    ...letters.map((b) => `${a}${b}`),
  ]);
  return [
    ...policy.git.ask,
    // `git --no-pager add .env` puts a global option before the verb.
    ...policy.git.askWhenSecretNamed.flatMap((command) =>
      policy.secretNameParts.flatMap((part) => [
        `${command} *${part}*`,
        `git * ${command.slice("git ".length)} *${part}*`,
      ]),
    ),
    ...policy.read.ask,
    ...bundles.flatMap((b) => [`sed -${b}i*`, `sed * -${b}i*`]),
    ...[...policy.read.addressChars].flatMap((c) => [
      `sed *${c}w*`,
      `sed *${c}W*`,
      // A space or a tab may follow the command letter.
      `sed *${c}e *`,
      `sed *${c}e\t*`,
    ]),
    ...policy.fs.ask,
    ...policy.fs.askWhenSecretNamed.flatMap((command) =>
      policy.secretNameParts.map((part) => `${command} *${part}*`),
    ),
    ...policy.secretRead.readers.flatMap((command) =>
      secretReadPatterns(policy, command),
    ),
    ...policy.secretRead.gitReaders.flatMap((verb) =>
      secretReadPatterns(policy, `git *${verb}*`, {
        clusters: verb === "grep",
        git: true,
      }),
    ),
    ...rgHiddenPatterns(policy),
    // `*` stands for the operands before the flag, which may be none.
    ...policy.dev.commands.flatMap((command) =>
      policy.dev.ask.flatMap((flag) => [
        `${command}${flag.slice(1)}`,
        `${command} ${flag}`,
      ]),
    ),
  ];
}
