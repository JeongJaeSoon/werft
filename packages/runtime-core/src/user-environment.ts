import { envNameProblem, envValueProblem } from "@werft-ai/contracts";

/**
 * The user variables (`runtime_config.env`) an adapter applies to the engine
 * side of a run: the process the engine starts in, or, for a runtime whose
 * descriptor says `tool_scoped`, the processes its tools start. Read from the
 * claim at every start, so never part of a checkpoint's fingerprint.
 */
export type UserEnvironment = Readonly<Record<string, string>>;

/**
 * Throws unless every name may be a user variable and every value fits the
 * environment. The adapter's last line of defence: the API and the claim
 * already judged these, but a name added to the reserved list later must stop
 * a value stored before it, and an adapter merges user names first and its own
 * keys after, so a reserved name that slipped through is also overwritten.
 *
 * The reserved list is a denylist over an open set of names, unlike
 * `assertGitEnvironment`, which accepts a closed set; it does not promise that
 * no unlisted name changes the engine's behaviour.
 */
export function assertUserEnvironment(
  environment: UserEnvironment,
): UserEnvironment {
  for (const [name, value] of Object.entries(environment)) {
    const nameProblem = envNameProblem(name);
    if (nameProblem !== null) {
      throw new Error(`userEnvironment carries ${name}: ${nameProblem} name`);
    }
    // Never echo the value: it may be a secret.
    if (envValueProblem(value, "plain") !== null) {
      throw new Error(`userEnvironment's ${name} is not a valid value`);
    }
  }
  return environment;
}
