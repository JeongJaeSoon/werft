import { z } from "zod";
import { platformAutoMode } from "./auto-mode.ts";
import planSettings from "./settings/plan.json" with { type: "json" };
import { workspaceRules } from "./workspace-permissions.ts";

/** Plan mode promises no side effects, so nothing is pre-approved there. */
const plan = z.object({}).strict().parse(planSettings);

/**
 * The rules the engine gets for a permission mode, next to its attribution:
 * the shared workspace policy's rules for every mode but plan,
 * auto's classifier rules of `settings/auto.json` beside them in auto, and
 * `settings/plan.json` (nothing) for plan.
 *
 * In auto the same routine commands run unasked as in default, and what an
 * `ask` rule carves out goes to a person, never to the classifier. The engine
 * drops an allow rule for an interpreter or script runner (`bun run`,
 * `npm run`, ...) when it enters auto, and the classifier judges those.
 */
export function modeSettings(input: {
  cwd: string;
  permissionMode: string | undefined;
  trusted: boolean;
}) {
  if (input.permissionMode === "plan") return plan;
  const rules = workspaceRules(input.cwd);
  const permissions = rules.allow.length === 0 ? {} : { permissions: rules };
  if (input.permissionMode === "auto") {
    return { ...permissions, autoMode: platformAutoMode(input.trusted) };
  }
  return permissions;
}
