import { z } from "zod";

import { agentIdSchema, timestampSchema } from "../shared/index.ts";

// User variables: what a workspace or an agent registers and a session's
// engine process receives as environment. The platform sets its own names
// (credentials, proxy, git, loader), so a user name may not collide with them.
// The constants live here because the API, the session accept in `db` and the
// claim all judge the same name, and `db` cannot import `platform`.

export const ENV_VARIABLE_NAME_PATTERN = "^[A-Z][A-Z0-9_]{0,63}$";
export const ENV_VARIABLE_VALUE_MAX_BYTES = 48 * 1024;
/** A secret shorter than this cannot be told from a word when scrubbed. */
export const ENV_SECRET_MIN_BYTES = 8;
export const ENV_WORKSPACE_VARIABLE_LIMIT = 100;
export const ENV_AGENT_VARIABLE_LIMIT = 50;
/** All values of one session together, in UTF-8 bytes. */
export const ENV_SESSION_VALUES_MAX_BYTES = 128 * 1024;
export const ENV_CARD_DECLARATION_LIMIT = 32;

/** Set by the platform itself: credentials, settings, git, loaders. */
export const ENV_RESERVED_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_",
  "WORKER_",
  "EGRESS_",
  "BUN_",
  "AWS_",
  "GIT_",
  "SSL_",
  "GITHUB_",
  "GH_",
  "LD_",
  "DYLD_",
] as const;

/** Run code, bypass the egress proxy or change which TLS roots are trusted. */
export const ENV_RESERVED_NAMES = [
  "PATH",
  "HOME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "PYTHONPATH",
  "PYTHONSTARTUP",
] as const;

export const ENV_NAME_PROBLEM_VALUES = ["invalid", "reserved"] as const;
export type EnvNameProblem = (typeof ENV_NAME_PROBLEM_VALUES)[number];

const namePattern = new RegExp(ENV_VARIABLE_NAME_PATTERN);
const reservedNames = new Set<string>(ENV_RESERVED_NAMES);

/**
 * Why `name` may not be a variable, or null. A lowercase name is invalid, not
 * folded to upper case, so the lowercase twins of the proxy variables
 * (`http_proxy`) can never be registered either.
 */
export function envNameProblem(name: string): EnvNameProblem | null {
  if (!namePattern.test(name)) return "invalid";
  if (
    reservedNames.has(name) ||
    ENV_RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) {
    return "reserved";
  }
  return null;
}

export const ENV_VALUE_PROBLEM_VALUES = [
  "invalid_text",
  "too_large",
  "too_short_secret",
] as const;
export type EnvValueProblem = (typeof ENV_VALUE_PROBLEM_VALUES)[number];

// ignoreBOM keeps a leading U+FEFF: it is text, and decoding must not drop it.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Why `value` may not be stored, or null. Counts UTF-8 bytes, not characters,
 * since the limit is what lands in the process environment. A lone surrogate
 * is not valid UTF-8, so it is refused rather than replaced.
 */
export function envValueProblem(
  value: string,
  kind: "plain" | "secret",
): EnvValueProblem | null {
  if (value.includes("\0")) return "invalid_text";
  const bytes = new TextEncoder().encode(value);
  try {
    // Encoding replaced a lone surrogate with U+FFFD; the round trip differs.
    if (strictUtf8.decode(bytes) !== value) return "invalid_text";
  } catch {
    return "invalid_text";
  }
  if (bytes.byteLength > ENV_VARIABLE_VALUE_MAX_BYTES) return "too_large";
  if (kind === "secret" && bytes.byteLength < ENV_SECRET_MIN_BYTES) {
    return "too_short_secret";
  }
  return null;
}

export const envVariableNameSchema = z
  .string()
  .regex(namePattern, "must be an upper-case variable name")
  .refine((name) => envNameProblem(name) !== "reserved", {
    message: "is a name the platform sets itself",
  });

export const ENV_VARIABLE_KIND_VALUES = ["plain", "secret"] as const;
export const envVariableKindSchema = z.enum(ENV_VARIABLE_KIND_VALUES);

/** A secret is never read back, so no shape that is read may carry its value. */
const NO_SECRET_VALUE = "a secret variable carries no value";
const holdsNoSecretValue = (entry: {
  kind: string;
  value?: string | undefined;
}) => entry.kind !== "secret" || entry.value === undefined;

/** Where a name's value came from, narrowest scope first when they overlap. */
export const ENV_VARIABLE_SCOPE_VALUES = ["workspace", "agent"] as const;
export const envVariableScopeSchema = z.enum(ENV_VARIABLE_SCOPE_VALUES);

/**
 * The names a card says it takes, `capabilities.env`. Optional on the card, so
 * a card written before it keeps its content hash.
 */
export const cardEnvDeclarationSchema = z
  .array(
    z
      .object({
        // The shape only. A reserved name is judged where a card is saved and
        // where its release is activated, so the answer is
        // `VARIABLE_NAME_RESERVED`, and a card saved before the list grew
        // still reads.
        name: z
          .string()
          .regex(namePattern, "must be an upper-case variable name"),
      })
      .strict(),
  )
  .max(ENV_CARD_DECLARATION_LIMIT)
  .refine(
    (entries) => new Set(entries.map((e) => e.name)).size === entries.length,
    "env must not repeat a name",
  );

// A value reaches the process environment only as text, so one string per name.
const valueSchema = z.string().superRefine((value, ctx) => {
  const problem = envValueProblem(value, "plain");
  if (problem === "invalid_text" || problem === "too_large") {
    ctx.addIssue({ code: "custom", message: problem });
  }
});

/** `runtime_config.env`: absent when the session has no variables. */
export const runtimeEnvSchema = z
  .record(envVariableNameSchema, valueSchema)
  .refine((env) => Object.keys(env).length > 0, "env must not be empty");

// ---- API -----------------------------------------------------------------

export const envVariableSchema = z
  .object({
    name: envVariableNameSchema,
    kind: envVariableKindSchema,
    /** Plain variables only; a secret is never read back. */
    value: z.string().optional(),
    /** Secret variables only: the value's last four characters. */
    last4: z.string().max(4).optional(),
    version: z.number().int().positive(),
    grant_all: z.boolean(),
    grant_version: z.number().int().positive(),
    granted_agents: z.array(agentIdSchema),
    engine_delivery: z.boolean(),
    updated_by: z.string().min(1).nullable(),
    updated_at: timestampSchema,
  })
  .strict()
  .refine(holdsNoSecretValue, NO_SECRET_VALUE);
export type EnvVariable = z.infer<typeof envVariableSchema>;

export const envVariableListSchema = z
  .object({ items: z.array(envVariableSchema) })
  .strict();
export type EnvVariableList = z.infer<typeof envVariableListSchema>;

/**
 * PUT body's shape, without the value check: the route parses with this so the
 * service can answer a bad value with its own code (`VARIABLE_VALUE_INVALID`,
 * `VARIABLE_VALUE_TOO_LARGE`) instead of a generic 400.
 */
export const putEnvVariableFieldsSchema = z
  .object({
    kind: envVariableKindSchema,
    value: z.string(),
    engine_delivery: z.boolean().optional(),
    /** The owner or admin has read what engine delivery exposes. */
    acknowledge_engine_exposure: z.boolean().optional(),
    /** Agent-level secrets only; a workspace secret keeps it on the grant. */
    allow_automation: z.boolean().optional(),
  })
  .strict();

export type PutEnvVariableFields = z.infer<typeof putEnvVariableFieldsSchema>;

/** PUT body; `If-None-Match: *` creates, `If-Match: <version>` replaces. */
export const putEnvVariableRequestSchema =
  putEnvVariableFieldsSchema.superRefine((body, ctx) => {
    const problem = envValueProblem(body.value, body.kind);
    if (problem !== null) {
      ctx.addIssue({ code: "custom", path: ["value"], message: problem });
    }
  });

export const putEnvVariableResponseSchema = z
  .object({
    name: envVariableNameSchema,
    version: z.number().int().positive(),
    grant_version: z.number().int().positive(),
  })
  .strict();
export type PutEnvVariableResponse = z.infer<
  typeof putEnvVariableResponseSchema
>;

/**
 * Path names stay free text here: the service judges them, so a lower-case or
 * reserved name answers `VARIABLE_NAME_INVALID` / `VARIABLE_NAME_RESERVED`.
 */
const variableNameParam = z.string().min(1);
export const workspaceVariableParamsSchema = z.object({
  name: variableNameParam,
});
export const agentVariableParamsSchema = z.object({
  id: agentIdSchema,
  name: variableNameParam,
});

export const putEnvVariableGrantsResponseSchema = z
  .object({
    name: envVariableNameSchema,
    grant_version: z.number().int().positive(),
  })
  .strict();
export type PutEnvVariableGrantsResponse = z.infer<
  typeof putEnvVariableGrantsResponseSchema
>;

export const deleteEnvVariableResponseSchema = z
  .object({
    /** Agents that received the value and sessions not closed yet. */
    affected_agents: z.number().int().nonnegative(),
    open_sessions: z.number().int().nonnegative(),
  })
  .strict();
export type DeleteEnvVariableResponse = z.infer<
  typeof deleteEnvVariableResponseSchema
>;

/** PUT body of `/grants`, the whole set replaced; `If-Match: <grant_version>`. */
export const putEnvVariableGrantsRequestSchema = z
  .object({
    grant_all: z.boolean(),
    agents: z.array(
      z
        .object({
          id: agentIdSchema,
          allow_automation: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .refine(
    (body) => new Set(body.agents.map((a) => a.id)).size === body.agents.length,
    "agents must not repeat an agent",
  );
export type PutEnvVariableGrantsRequest = z.infer<
  typeof putEnvVariableGrantsRequestSchema
>;

export const agentEnvEffectiveSchema = z
  .object({
    name: envVariableNameSchema,
    kind: envVariableKindSchema,
    source: envVariableScopeSchema,
    shadows_workspace: z.boolean(),
    workspace_value_ungranted: z.boolean(),
  })
  .strict();

export const agentEnvVariablesSchema = z
  .object({
    effective: z.array(agentEnvEffectiveSchema),
    items: z.array(envVariableSchema),
    granted_workspace_values: z.array(
      z
        .object({
          name: envVariableNameSchema,
          kind: envVariableKindSchema,
          value: z.string().optional(),
        })
        .strict()
        .refine(holdsNoSecretValue, NO_SECRET_VALUE),
    ),
  })
  .strict();
export type AgentEnvVariables = z.infer<typeof agentEnvVariablesSchema>;

// ---- Session start -------------------------------------------------------

/**
 * `sessions.env_start`: the names a session took when it was accepted. A plain
 * entry holds its value so claims, retries and restores replay it; a secret
 * entry holds none, only the version that was current. Not strict, so a later
 * field does not make an older image refuse the snapshot.
 */
export const envStartEntrySchema = z
  .object({
    name: envVariableNameSchema,
    scope: envVariableScopeSchema,
    kind: envVariableKindSchema,
    version: z.number().int().positive(),
    value: z.string().optional(),
  })
  .refine(holdsNoSecretValue, NO_SECRET_VALUE);
export const envStartSchema = z.object({
  entries: z.array(envStartEntrySchema),
  /** Names left out for a reason the requester must not see. */
  skipped: z.array(envVariableNameSchema),
});
export type EnvStart = z.infer<typeof envStartSchema>;

/** Why a session's variables were refused (`reject_session_env` receipt). */
export const ENV_REFUSAL_VALUES = [
  "unresolved",
  "not_granted",
  "reserved_name",
  "too_large",
  "runtime_unsupported",
] as const;
export const envRefusalSchema = z.enum(ENV_REFUSAL_VALUES);
export type EnvRefusal = z.infer<typeof envRefusalSchema>;
