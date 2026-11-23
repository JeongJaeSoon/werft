import { z } from "zod";

import { type ProviderKind, providerKindSchema } from "./provider-kind.ts";
import {
  RUNTIME_KINDS_WITH_AUTO_MODE,
  runtimeKindSchema,
} from "./runtime-kind.ts";

// What a release runs as. A release holds two documents: `spec_source`, the
// raw inputs it was made from (its connection, the card's model and the
// runtime the image ships), and `runtime_spec`, what those inputs mean now.
// The spec is a pure function of its source (`deriveRuntimeSpec`), so a
// stored pair can be checked from the source alone. Neither holds a
// credential: the connection is named by id and endpoint, and the worker
// gets its token at claim.
//
// The mode and repository enums below repeat api/session.ts and
// api/repository-ceiling.ts, which this module cannot import without a cycle
// (api/session.ts imports the agents contract that will import this).
// runtime-spec.test.ts holds them to the originals. The runtime kind comes
// from the import-free shared/runtime-kind.ts, which api/session.ts re-exports.

export const RUNTIME_SPEC_VERSION = 1;
export const SPEC_DERIVATION_VERSION = 2;

export const EXECUTION_MODE_VALUES = ["auto", "bypass"] as const;
export const executionModeSchema = z.enum(EXECUTION_MODE_VALUES);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

// The two modes a release is made with (`permissionModeOf`).
const sourcePermissionModeSchema = z.enum(["default", "auto"]);
const repositoryModeSchema = z.enum(["required", "optional", "none"]);
// No length caps: the catalog sets none on a model, a tool or an endpoint, and
// a cap here would make a release on a valid connection underivable.
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
    kind: providerKindSchema,
    endpoint: endpointSchema,
    billing: z.enum(["per_token", "none"]),
  })
  .strict();

const projectSettingsSchema = z.object({ claude_md: z.boolean() }).strict();

/**
 * The inputs, as they were when the release was made. The release id is
 * hashed over this document. `permission_mode` is the mode it was made with;
 * a run decides it again (`permissionModeOf`) and does not read this one.
 */
export const specSourceSchema = z
  .object({
    derivation_version: z.literal(SPEC_DERIVATION_VERSION),
    runtime: runtimeSchema,
    connection: connectionSchema,
    model: nonEmpty,
    permission_mode: sourcePermissionModeSchema,
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
 * Whether a connection of `kind` serves `model` as a Claude model. The Claude
 * engine's classifier is a Claude model reached over the session's own
 * connection, so `auto` holds only there: an `anthropic` connection, or a
 * `litellm` one whose model id names Claude: `claude-…`, `anthropic/claude-…`,
 * or exactly one of the engine's family aliases, with or without `[1m]`. A
 * family name inside another id (`my-sonnet-proxy`) does not count: the
 * connection records nothing else about its upstream.
 */
const CLAUDE_MODEL_ID =
  /^(?:(?:anthropic\/)?claude-.+|(?:sonnet|opus|haiku|fable)(?:\[1m\])?)$/;

/**
 * The mode a spec runs, decided from its runtime, connection and model each
 * time it is read: `auto` for a runtime whose engine has a classifier of its
 * own, on a connection that serves the model as Claude; `default` (a person
 * answers what the rules leave open) otherwise. The mode a release recorded
 * is not read, so a release made under an earlier rule runs this one and
 * keeps its id.
 */
export function permissionModeOf(source: {
  runtime: { kind: z.infer<typeof runtimeKindSchema> };
  connection: { kind: ProviderKind };
  model: string;
}): SpecSource["permission_mode"] {
  const claude =
    source.connection.kind === "anthropic" ||
    (source.connection.kind === "litellm" &&
      CLAUDE_MODEL_ID.test(source.model));
  return RUNTIME_KINDS_WITH_AUTO_MODE.includes(source.runtime.kind) && claude
    ? "auto"
    : "default";
}

/** The spec a source means. Pure: the same source is always the same spec. */
export function deriveRuntimeSpec(source: SpecSource): RuntimeSpec {
  return {
    spec_version: RUNTIME_SPEC_VERSION,
    runtime: source.runtime,
    connection: source.connection,
    model: source.model,
    // Both modes a source records judge with the classifier or a person.
    execution_mode: "auto",
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
