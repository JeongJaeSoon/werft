import { z } from "zod";

// What a release runs as, with no runtime profile in the way. A release holds
// two documents: `spec_source`, the raw inputs it was made from, and
// `runtime_spec`, what those inputs mean now. The spec is a pure function of
// its source (`deriveRuntimeSpec`), so a stored pair can be checked from the
// source alone, long after the profile it came from is gone. Neither holds a
// credential: the connection is named by id and endpoint, and the worker
// gets its token at claim.
//
// The enums below repeat api/session.ts and api/profiles.ts, which this
// module cannot import without a cycle (api/session.ts imports the agents
// contract that will import this). runtime-spec.test.ts holds them to the
// originals.

export const RUNTIME_SPEC_VERSION = 1;
export const SPEC_DERIVATION_VERSION = 1;

export const EXECUTION_MODE_VALUES = ["auto", "bypass"] as const;
export const executionModeSchema = z.enum(EXECUTION_MODE_VALUES);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

const runtimeKindSchema = z.enum([
  "claude_agent_sdk",
  "codex_app_server",
  "pi_coding_agent",
]);
const legacyPermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "dontAsk",
  "plan",
  "bypassPermissions",
  "auto",
]);
const repositoryModeSchema = z.enum(["required", "optional", "none"]);
// No length caps: the catalog sets none on a model, a tool or an endpoint, and
// a cap here would make a release made from a valid profile underivable.
const nonEmpty = z.string().min(1);

// The catalog's own rule for a provider endpoint (catalog.ts webUrl): the URL
// rides every fingerprint and snapshot, so it carries no credential, and the
// egress proxy takes only http(s) with no fragment.
const endpointSchema = z.string().refine((value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}, "must be an http(s) URL with no credential, query or fragment");

const runtimeSchema = z
  .object({ kind: runtimeKindSchema, version: nonEmpty })
  .strict();

// Where the model is called. The connection is named by id: it is what picks
// the credential, and a provider that matches no connection row runs nothing
// today (`connection_missing`), so a release made from one gets no spec until
// its connection exists. `kind`, `endpoint` and `billing` are what the id
// pointed at when the release was made; the catalog's `per_token` is a
// billing that is absent there.
const connectionSchema = z
  .object({
    id: nonEmpty,
    kind: z.enum(["anthropic", "litellm"]),
    endpoint: endpointSchema,
    billing: z.enum(["per_token", "none"]),
  })
  .strict();

const projectSettingsSchema = z.object({ claude_md: z.boolean() }).strict();

/**
 * The inputs, as they were when the release was made. `permission_mode` is
 * the profile's own value, kept so the mapping to an execution mode stays
 * auditable. `profile_id` and `profile_digest` are the originals the release
 * id was hashed over.
 */
export const specSourceSchema = z
  .object({
    derivation_version: z.literal(SPEC_DERIVATION_VERSION),
    origin: z.enum(["profile", "agent"]),
    release_id: nonEmpty,
    release_id_version: z.number().int().min(1).max(5),
    profile_id: nonEmpty.nullable(),
    profile_digest: nonEmpty.nullable(),
    runtime: runtimeSchema,
    connection: connectionSchema,
    model: nonEmpty,
    permission_mode: legacyPermissionModeSchema,
    tools: z.array(nonEmpty),
    project_settings: projectSettingsSchema.optional(),
    mcp_deny: z.array(nonEmpty).optional(),
    repository_mode: repositoryModeSchema,
  })
  .strict();
export type SpecSource = z.infer<typeof specSourceSchema>;

export const runtimeSpecSchema = z
  .object({
    spec_version: z.literal(RUNTIME_SPEC_VERSION),
    runtime: runtimeSchema,
    connection: connectionSchema,
    model: nonEmpty,
    execution_mode: executionModeSchema,
    tools: z.array(nonEmpty),
    project_settings: projectSettingsSchema.optional(),
    mcp_deny: z.array(nonEmpty).optional(),
    repository_mode: repositoryModeSchema,
  })
  .strict();
export type RuntimeSpec = z.infer<typeof runtimeSpecSchema>;

/**
 * Two execution modes. `bypassPermissions` stays; every other mode, `auto`
 * included, becomes `auto`, where the classifier judges a call and a person
 * is asked when it cannot decide.
 */
export function executionModeOf(
  permissionMode: SpecSource["permission_mode"],
): ExecutionMode {
  return permissionMode === "bypassPermissions" ? "bypass" : "auto";
}

/** The spec a source means. Pure: the same source is always the same spec. */
export function deriveRuntimeSpec(source: SpecSource): RuntimeSpec {
  return {
    spec_version: RUNTIME_SPEC_VERSION,
    runtime: source.runtime,
    connection: source.connection,
    model: source.model,
    execution_mode: executionModeOf(source.permission_mode),
    tools: source.tools,
    ...(source.project_settings === undefined
      ? {}
      : { project_settings: source.project_settings }),
    ...(source.mcp_deny === undefined || source.mcp_deny.length === 0
      ? {}
      : { mcp_deny: source.mcp_deny }),
    repository_mode: source.repository_mode,
  };
}
