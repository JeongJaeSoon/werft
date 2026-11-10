import { z } from "zod";

import {
  PERMISSION_RULE_MAX_LENGTH,
  PERMISSION_RULES_MAX,
  type PermissionRuleRefusal,
  parsePermissionRules,
} from "../api/permission-rules.ts";
import type { ToolCatalogView } from "../api/profile-tools.ts";

/**
 * What an agent's saved engine settings hold: the permission rules and the
 * auto mode sentences the engine is started with, kept per agent and outside
 * the card. A change makes no release; a session follows it by
 * `effectiveEngineSettings` in the platform.
 *
 * Nothing writes this yet. The write API and the screen ship with the merge
 * that sends the settings to the engine, so a rule a person can save is a rule
 * the engine gets.
 */

/** Auto mode sentences are not tool patterns: free text, bounded. */
export const ENGINE_AUTO_MODE_RULES_MAX = 64;
export const ENGINE_AUTO_MODE_RULE_MAX_LENGTH = 1024;

export const STORED_PERMISSION_KEYS = ["allow", "ask", "deny"] as const;
export const STORED_AUTO_MODE_KEYS = [
  "allow",
  "soft_deny",
  "hard_deny",
  "environment",
] as const;

/**
 * Characters, not UTF-16 units: the table's CHECK counts characters, and a
 * limit counted the other way would refuse a row the database accepted.
 */
const characters = (text: string) => [...text].length;
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .refine((text) => characters(text) <= max, `at most ${max} characters`);

const permissionListSchema = z
  .array(boundedText(PERMISSION_RULE_MAX_LENGTH))
  .max(PERMISSION_RULES_MAX);
const autoModeListSchema = z
  .array(boundedText(ENGINE_AUTO_MODE_RULE_MAX_LENGTH))
  .max(ENGINE_AUTO_MODE_RULES_MAX);

/** A key left out means no rules of that kind; an empty list is the same. */
export const storedPermissionsSchema = z
  .object({
    allow: permissionListSchema.optional(),
    ask: permissionListSchema.optional(),
    deny: permissionListSchema.optional(),
  })
  .strict();
export const storedAutoModeSchema = z
  .object({
    allow: autoModeListSchema.optional(),
    soft_deny: autoModeListSchema.optional(),
    hard_deny: autoModeListSchema.optional(),
    environment: autoModeListSchema.optional(),
  })
  .strict();

export const storedEngineSettingsSchema = z
  .object({
    permissions: storedPermissionsSchema,
    auto_mode: storedAutoModeSchema,
  })
  .strict();
export type StoredEngineSettings = z.infer<typeof storedEngineSettingsSchema>;

/**
 * What a session keeps of the settings it started with: the content and the
 * `agent_engine_settings.revision` it came from, read together. Not strict,
 * so a later field does not make an older image refuse the snapshot; one that
 * does not parse closes the session's agent rules.
 */
export const engineSettingsStartSchema = z.object({
  permissions: storedPermissionsSchema,
  auto_mode: storedAutoModeSchema,
  revision: z.number().int().positive(),
});
export type EngineSettingsStart = z.infer<typeof engineSettingsStartSchema>;

export type EngineSettingsRefusal =
  | PermissionRuleRefusal
  | {
      readonly reason_code: "auto_mode_rule_syntax";
      readonly rule: string;
      readonly message: string;
    }
  | {
      readonly reason_code: "settings_shape";
      readonly rule: "";
      readonly message: string;
    };

/**
 * The settings a person sends, as they would be stored, or why not. The
 * permission lists go through the platform's rule parser, which refuses a rule
 * the engine would drop without a word (`Skill(name)`, an unknown tool, a
 * glob) and writes an older tool name as the current one; a length limit alone
 * does not make a rule right. Auto mode sentences are checked for shape only:
 * the classifier reads them as prose.
 */
export function validateEngineSettings(
  catalog: ToolCatalogView,
  input: unknown,
):
  | { readonly settings: StoredEngineSettings }
  | { readonly refusal: EngineSettingsRefusal } {
  const shape = z
    .object({
      permissions: z
        .object({
          allow: z.array(z.string()).optional(),
          ask: z.array(z.string()).optional(),
          deny: z.array(z.string()).optional(),
        })
        .strict(),
      auto_mode: z
        .object({
          allow: z.array(z.string()).optional(),
          soft_deny: z.array(z.string()).optional(),
          hard_deny: z.array(z.string()).optional(),
          environment: z.array(z.string()).optional(),
        })
        .strict(),
    })
    .strict()
    .safeParse(input);
  if (!shape.success) {
    return {
      refusal: {
        reason_code: "settings_shape",
        rule: "",
        message: "Settings are permissions and auto_mode lists of strings",
      },
    };
  }

  const permissions: Record<string, string[]> = {};
  for (const key of STORED_PERMISSION_KEYS) {
    const raws = shape.data.permissions[key];
    if (raws === undefined || raws.length === 0) continue;
    const parsed = parsePermissionRules(catalog, raws);
    if ("refusal" in parsed) return parsed;
    permissions[key] = parsed.rules.map((rule) => rule.rule);
  }

  const autoMode: Record<string, string[]> = {};
  for (const key of STORED_AUTO_MODE_KEYS) {
    const sentences = shape.data.auto_mode[key];
    if (sentences === undefined || sentences.length === 0) continue;
    const unique: string[] = [];
    for (const sentence of sentences) {
      const text = sentence.trim();
      if (text === "" || characters(text) > ENGINE_AUTO_MODE_RULE_MAX_LENGTH) {
        return {
          refusal: {
            reason_code: "auto_mode_rule_syntax",
            rule: sentence.slice(0, 32),
            message: `A sentence is 1 to ${ENGINE_AUTO_MODE_RULE_MAX_LENGTH} characters`,
          },
        };
      }
      if (!unique.includes(text)) unique.push(text);
    }
    if (unique.length > ENGINE_AUTO_MODE_RULES_MAX) {
      return {
        refusal: {
          reason_code: "auto_mode_rule_syntax",
          rule: "",
          message: `A list holds at most ${ENGINE_AUTO_MODE_RULES_MAX} sentences`,
        },
      };
    }
    autoMode[key] = unique;
  }

  return {
    settings: storedEngineSettingsSchema.parse({
      permissions,
      auto_mode: autoMode,
    }),
  };
}
