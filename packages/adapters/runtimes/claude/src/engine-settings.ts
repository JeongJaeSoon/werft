import type { EngineSettings } from "@werft-ai/contracts";
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
  trusted: boolean;
}) {
  if (input.permissionMode === "plan") return plan;
  if (input.permissionMode === "auto") {
    return { autoMode: platformAutoMode(input.trusted) };
  }
  const rules = workspaceRules(input.cwd);
  return rules.allow.length === 0 ? {} : { permissions: rules };
}

type RuleLists = Partial<Record<"allow" | "ask" | "deny", readonly string[]>>;

function joined(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): string[] | undefined {
  const all = [...(first ?? []), ...(second ?? [])];
  return all.length === 0 ? undefined : all;
}

function withoutEmpty<T extends Record<string, readonly string[] | undefined>>(
  lists: T,
): Record<string, readonly string[]> | undefined {
  const entries = Object.entries(lists).filter(
    (entry): entry is [string, readonly string[]] => entry[1] !== undefined,
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * The mode's baseline settings extended with the rules the platform merged for
 * this claim (workspace first, then agent). Each list is the baseline followed
 * by the claim's, so nothing the baseline holds is dropped or reordered; a
 * `deny` the baseline has none of is simply the claim's.
 *
 * Plan mode promises no side effects and pre-approves nothing, so it takes the
 * claim's `ask` and `deny` and leaves its `allow` out. An `autoMode` section
 * only means something to auto mode, so no other mode is given one.
 */
export function withEngineSettings(
  base: ReturnType<typeof modeSettings>,
  permissionMode: string | undefined,
  extra: EngineSettings | undefined,
): Record<string, unknown> {
  if (extra === undefined) return base;
  const baseline = base as {
    permissions?: RuleLists;
    autoMode?: Partial<Record<AutoModeSection, readonly string[]>>;
  };
  const plan = permissionMode === "plan";
  const permissions = withoutEmpty({
    allow: plan
      ? undefined
      : joined(baseline.permissions?.allow, extra.permissions?.allow),
    ask: joined(baseline.permissions?.ask, extra.permissions?.ask),
    deny: joined(baseline.permissions?.deny, extra.permissions?.deny),
  });
  const autoMode =
    permissionMode === "auto"
      ? withoutEmpty(
          Object.fromEntries(
            AUTO_MODE_SECTIONS.map((section) => [
              section,
              classifierRules(
                baseline.autoMode?.[section],
                extra.autoMode?.[section],
              ),
            ]),
          ),
        )
      : undefined;
  return {
    ...(permissions === undefined ? {} : { permissions }),
    ...(autoMode === undefined ? {} : { autoMode }),
  };
}

// A classifier section that is set without "$defaults" replaces the engine's
// own rules for it, so a section the baseline leaves unset (hard_deny) keeps
// them only if the claim's rules are put after "$defaults".
function classifierRules(
  baseline: readonly string[] | undefined,
  extra: readonly string[] | undefined,
): string[] | undefined {
  if (extra === undefined || extra.length === 0)
    return joined(baseline, undefined);
  return baseline === undefined || baseline.length === 0
    ? ["$defaults", ...extra]
    : [...baseline, ...extra];
}

const AUTO_MODE_SECTIONS = [
  "allow",
  "soft_deny",
  "hard_deny",
  "environment",
] as const;
type AutoModeSection = (typeof AUTO_MODE_SECTIONS)[number];
