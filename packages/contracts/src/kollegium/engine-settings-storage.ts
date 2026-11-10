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

/**
 * What one source may save, so that the largest settings a claim can merge
 * still fit the worker's contract (128 permission rules and 64 sentences a
 * list, and the engine's 100,000 byte limit on the settings it starts with).
 *
 * A claim merges the workspace's, the inherited `admin_deny`, and the agent's
 * twice (the settings it started with and the current ones):
 * 48 + 32 + 24 + 24 = 128 rules in a permission list; 16 + 16 + 16 = 48
 * sentences in an auto mode list. Bytes are the JSON text of the whole
 * `permissions` or `auto_mode` object, escapes included.
 *
 * Measured against the claude adapter: the default and bypass modes start at
 * 75,870 bytes of the engine's 100,000, so the permission rules of one claim
 * (6 KB workspace + 3 KB agent twice + 4 KB inherited = 16 KB, plus up to
 * 64 whole-tool names) must stay near 20 KB. Auto mode sentences only count
 * in auto mode, which starts at 3,253 bytes. The adapter's
 * `engine-settings-claim.test.ts` composes these maxima and fails first when
 * a limit here is raised past what starts.
 */
export const ENGINE_SETTINGS_LIMITS = {
  workspace: {
    permissionRules: 48,
    permissionBytes: 6 * 1024,
    autoModeRules: 16,
    autoModeBytes: 6 * 1024,
  },
  agent: {
    permissionRules: 24,
    permissionBytes: 3 * 1024,
    autoModeRules: 16,
    autoModeBytes: 4 * 1024,
  },
} as const;
export type EngineSettingsSource = keyof typeof ENGINE_SETTINGS_LIMITS;

/** Inherited restrictions in `agent_engine_settings.admin_deny`, all entries together. */
export const ADMIN_DENY_RULES_MAX = 32;
export const ADMIN_DENY_RULES_BYTES_MAX = 4 * 1024;
/** The releases that existed when an entry was made; stored data the engine never gets. */
export const ADMIN_DENY_EXEMPT_BYTES_MAX = 256 * 1024;

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
      /** Empty, or the rule that sits in the wrong list of `admin_deny`. */
      readonly rule: string;
      readonly message: string;
    }
  | {
      /** An `mcp__` rule is enforced by the platform per call, which only knows how to deny. */
      readonly reason_code: "mcp_rule_verdict";
      readonly rule: string;
      readonly message: string;
    }
  | {
      readonly reason_code: "settings_too_large";
      readonly rule: "";
      readonly message: string;
    };

const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

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
  source: EngineSettingsSource,
):
  | { readonly settings: StoredEngineSettings }
  | { readonly refusal: EngineSettingsRefusal } {
  const limits = ENGINE_SETTINGS_LIMITS[source];
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
    if (key !== "deny") {
      const mcp = parsed.rules.find((rule) => rule.kind === "mcp");
      if (mcp !== undefined) {
        return {
          refusal: {
            reason_code: "mcp_rule_verdict",
            rule: mcp.rule,
            message: `${mcp.rule} can only be denied: the platform checks an mcp__ tool per call and has no ask or allow for it`,
          },
        };
      }
    }
    if (parsed.rules.length > limits.permissionRules) {
      return {
        refusal: {
          reason_code: "too_many_rules",
          rule: "",
          message: `A ${source} list holds at most ${limits.permissionRules} rules`,
        },
      };
    }
    permissions[key] = parsed.rules.map((rule) => rule.rule);
  }
  if (jsonBytes(permissions) > limits.permissionBytes) {
    return {
      refusal: {
        reason_code: "settings_too_large",
        rule: "",
        message: `The permission rules of a ${source} are at most ${limits.permissionBytes} bytes`,
      },
    };
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
    if (unique.length > limits.autoModeRules) {
      return {
        refusal: {
          reason_code: "auto_mode_rule_syntax",
          rule: "",
          message: `A ${source} list holds at most ${limits.autoModeRules} sentences`,
        },
      };
    }
    autoMode[key] = unique;
  }
  if (jsonBytes(autoMode) > limits.autoModeBytes) {
    return {
      refusal: {
        reason_code: "settings_too_large",
        rule: "",
        message: `The auto mode sentences of a ${source} are at most ${limits.autoModeBytes} bytes`,
      },
    };
  }

  return {
    settings: storedEngineSettingsSchema.parse({
      permissions,
      auto_mode: autoMode,
    }),
  };
}

/**
 * One entry of `agent_engine_settings.admin_deny`: a restriction an agent
 * inherits from what its profile and the installation blocked, written by an
 * operator and never by the web API. It applies to a session only when the
 * session's release is not one of `exempt_release_ids`, the releases the agent
 * already had when the entry was made. A release that existed keeps what it
 * was pinned with, including after a rollback to it.
 */
export const adminDenyEntrySchema = z
  .object({
    exempt_release_ids: z.array(z.string().min(1).max(128)),
    permissions_deny: z.array(z.string().min(1)),
    mcp_deny: z.array(z.string().min(1)),
  })
  .strict();
export type AdminDenyEntry = z.infer<typeof adminDenyEntrySchema>;
export const adminDenySchema = z.array(adminDenyEntrySchema);

/**
 * The entries as they would be stored, or why not. Every rule goes through the
 * same parser as a saved rule; `permissions_deny` takes tool and pattern rules
 * and `mcp_deny` only `mcp__` rules, because the two reach the engine by
 * different routes. The rule budget counts the union of all entries: an
 * entry's deny holds for every release it covers, so entries add up.
 */
export function validateAdminDeny(
  catalog: ToolCatalogView,
  input: unknown,
):
  | { readonly entries: AdminDenyEntry[] }
  | { readonly refusal: EngineSettingsRefusal } {
  const shape = adminDenySchema.safeParse(input);
  if (!shape.success) {
    return {
      refusal: {
        reason_code: "settings_shape",
        rule: "",
        message:
          "admin_deny is a list of exempt_release_ids, permissions_deny and mcp_deny",
      },
    };
  }
  const entries: AdminDenyEntry[] = [];
  const union = new Set<string>();
  for (const entry of shape.data) {
    const out: AdminDenyEntry = {
      exempt_release_ids: [...new Set(entry.exempt_release_ids)],
      permissions_deny: [],
      mcp_deny: [],
    };
    for (const key of ["permissions_deny", "mcp_deny"] as const) {
      if (entry[key].length === 0) continue;
      const parsed = parsePermissionRules(catalog, entry[key]);
      if ("refusal" in parsed) return parsed;
      for (const rule of parsed.rules) {
        if ((rule.kind === "mcp") !== (key === "mcp_deny")) {
          return {
            refusal: {
              reason_code: "settings_shape",
              rule: rule.rule,
              message:
                key === "mcp_deny"
                  ? `${rule.rule} is not an mcp__ rule`
                  : `${rule.rule} is an mcp__ rule: it goes in mcp_deny`,
            },
          };
        }
        union.add(rule.rule);
        if (!out[key].includes(rule.rule)) out[key].push(rule.rule);
      }
    }
    entries.push(out);
  }
  const bodies = entries.map(({ permissions_deny, mcp_deny }) => ({
    permissions_deny,
    mcp_deny,
  }));
  if (union.size > ADMIN_DENY_RULES_MAX) {
    return {
      refusal: {
        reason_code: "too_many_rules",
        rule: "",
        message: `The inherited restrictions of an agent are at most ${ADMIN_DENY_RULES_MAX} rules`,
      },
    };
  }
  if (jsonBytes(bodies) > ADMIN_DENY_RULES_BYTES_MAX) {
    return {
      refusal: {
        reason_code: "settings_too_large",
        rule: "",
        message: `The inherited restrictions of an agent are at most ${ADMIN_DENY_RULES_BYTES_MAX} bytes`,
      },
    };
  }
  if (
    jsonBytes(entries.map((entry) => entry.exempt_release_ids)) >
    ADMIN_DENY_EXEMPT_BYTES_MAX
  ) {
    return {
      refusal: {
        reason_code: "settings_too_large",
        rule: "",
        message: `The release lists of the inherited restrictions are at most ${ADMIN_DENY_EXEMPT_BYTES_MAX} bytes`,
      },
    };
  }
  return { entries };
}
