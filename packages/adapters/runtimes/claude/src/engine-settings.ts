import { z } from "zod";
import { platformAutoMode } from "./auto-mode.ts";
import planSettings from "./settings/plan.json" with { type: "json" };
import { workspaceRules } from "./workspace-permissions.ts";

/** Plan mode promises no side effects, so nothing is pre-approved there. */
const plan = z.object({}).strict().parse(planSettings);

/**
 * The rules the engine gets for a permission mode, next to its attribution:
 * `settings/default.json` for every mode but auto and plan (default,
 * acceptEdits, dontAsk and bypassPermissions too, as before),
 * `settings/auto.json` for auto, `settings/plan.json` (nothing) for plan.
 *
 * Auto mode leaves these calls to its classifier, whose rules know what a
 * secret is; a rule here would settle a commit before the classifier saw it.
 */
export function modeSettings(input: {
  cwd: string;
  permissionMode: string | undefined;
  tools: ReadonlySet<string>;
  trusted: boolean;
}) {
  if (input.permissionMode === "plan") return plan;
  if (input.permissionMode === "auto") {
    return { autoMode: platformAutoMode(input.trusted) };
  }
  const rules = workspaceRules(input.cwd, input.tools);
  return rules.allow.length === 0 ? {} : { permissions: rules };
}
