import { z } from "zod";
import autoSettings from "./settings/auto.json" with { type: "json" };

/**
 * The auto mode classifier's platform rules, handed to the engine as flag
 * settings: the engine reads `autoMode` only from user, flag and policy
 * settings, so a repository's `.claude/settings.json` cannot widen or drop
 * them. "$defaults" keeps the engine's own rules around them.
 *
 * The rules are in `settings/auto.json`. Each names a kind of action, not a
 * tool; the environment entry is where tool names map to those actions.
 * `full` is for a run whose tools the classifier still judges; `trusted` is
 * for a run whose push, pull request and repository-read tools skip the
 * classifier because the platform decides each of those on the server, so no
 * rule describes them. What is left there is the engine's own work
 * (committing) and the tools the classifier still judges (merging, reviews
 * and workflows).
 */
const rules = z
  .object({
    allow: z.array(z.string().min(1)),
    soft_deny: z.array(z.string().min(1)),
    environment: z.array(z.string().min(1)),
  })
  .strict();

const file = z
  .object({ full: rules, trusted: rules })
  .strict()
  .parse(autoSettings);

export const PLATFORM_AUTO_MODE = file.full;
export const TRUSTED_PLATFORM_AUTO_MODE = file.trusted;

/**
 * The full rules unless the platform vouched for its tools: a control host
 * from before `trusted` sends none, and then the classifier still judges
 * the push, pull request and repository-read tools by the first set.
 */
export function platformAutoMode(trusted: boolean) {
  return trusted ? TRUSTED_PLATFORM_AUTO_MODE : PLATFORM_AUTO_MODE;
}
