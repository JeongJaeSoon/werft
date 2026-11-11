/**
 * The git settings a session's engine runs every git under, at git's command
 * line level: they outrank a repository's own config (husky's core.hooksPath,
 * a local user.name) and lose only to an explicit `git -c` or GIT_AUTHOR_*.
 * They travel as GIT_CONFIG_COUNT/KEY_n/VALUE_n in the engine's process
 * environment, never as arguments, so no process listing shows them.
 */
export type GitEnvironment = Readonly<Record<string, string>>;

const GIT_ENVIRONMENT_KEYS = [
  "core.hooksPath",
  "user.name",
  "user.email",
] as const;

export type GitEnvironmentKey = (typeof GIT_ENVIRONMENT_KEYS)[number];

const UNSAFE = /[\r\n\0]/;

/** The environment for `entries`, or undefined for none. */
export function gitEnvironment(
  entries: readonly { key: GitEnvironmentKey; value: string }[],
): GitEnvironment | undefined {
  if (entries.length === 0) return undefined;
  const environment: Record<string, string> = {
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(({ key, value }, index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return assertGitEnvironment(environment);
}

/**
 * Throws unless `environment` is exactly what `gitEnvironment` builds: an
 * adapter checks before handing it to an engine, since anything else in it
 * would reach every process the engine starts.
 */
export function assertGitEnvironment(
  environment: GitEnvironment,
): GitEnvironment {
  const count = Number(environment.GIT_CONFIG_COUNT);
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > GIT_ENVIRONMENT_KEYS.length
  ) {
    throw new Error("gitEnvironment needs GIT_CONFIG_COUNT of 1 to 3");
  }
  const expected = new Set(["GIT_CONFIG_COUNT"]);
  const seen = new Set<string>();
  for (let index = 0; index < count; index++) {
    const key = environment[`GIT_CONFIG_KEY_${index}`];
    const value = environment[`GIT_CONFIG_VALUE_${index}`];
    expected.add(`GIT_CONFIG_KEY_${index}`).add(`GIT_CONFIG_VALUE_${index}`);
    if (!(GIT_ENVIRONMENT_KEYS as readonly string[]).includes(key ?? "")) {
      throw new Error(
        `gitEnvironment sets ${key ?? "nothing"}, not a git setting it may set`,
      );
    }
    if (seen.has(key as string))
      throw new Error(`gitEnvironment sets ${key} twice`);
    seen.add(key as string);
    if (value === undefined || value === "" || UNSAFE.test(value)) {
      throw new Error(`gitEnvironment's ${key} is empty or breaks a line`);
    }
  }
  for (const name of Object.keys(environment)) {
    if (!expected.has(name)) {
      throw new Error(`gitEnvironment carries ${name}`);
    }
  }
  return environment;
}
