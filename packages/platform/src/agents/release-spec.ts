import { createHash } from "node:crypto";
import {
  type AgentRelease,
  canonicalJsonOfJson,
  deriveRuntimeSpec,
  type RuntimeSpec,
  runtimeSpecSchema,
  SPEC_DERIVATION_VERSION,
  type SpecSource,
  specSourceSchema,
} from "@werft-ai/contracts";
import type { CatalogConnectionView } from "../sessions/catalog.ts";

// What a release runs as: a `spec_source` made once from its connection and
// the snapshot its id was hashed over, and the `runtime_spec` it means. The
// pair is stored on the release row and copied onto each session, which runs
// from it alone.

export type SpecRelease = Pick<
  AgentRelease,
  "id" | "connection_id" | "runtime_config_snapshot"
>;

export type SpecSourceRefusal = { reason: "invalid_source"; message: string };

function sha256Json(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonOfJson(value), "utf8")
    .digest("hex")}`;
}

function stringsOf(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : null;
}

/**
 * The source a release's spec is made from: the model, tools, mode, runtime
 * and project settings of its snapshot, and the connection it names as the
 * catalog holds it now (a connection never changes what it points at; another
 * endpoint or billing is another id).
 */
export function buildSpecSource(input: {
  release: SpecRelease;
  connection: Pick<CatalogConnectionView, "provider">;
}): { ok: true; source: SpecSource } | ({ ok: false } & SpecSourceRefusal) {
  const { release, connection } = input;
  const snapshot = release.runtime_config_snapshot;
  const candidate = {
    derivation_version: SPEC_DERIVATION_VERSION,
    runtime: snapshot.runtime,
    connection: {
      id: release.connection_id,
      kind: connection.provider.kind,
      endpoint: connection.provider.endpoint,
      billing: connection.provider.billing ?? "per_token",
    },
    model: snapshot.model,
    permission_mode: snapshot.permission_mode,
    tools: stringsOf(snapshot.tools) ?? snapshot.tools,
    ...(snapshot.project_settings === undefined
      ? {}
      : { project_settings: snapshot.project_settings }),
    repository_mode: "optional",
  };
  const parsed = specSourceSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_source",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    };
  }
  return { ok: true, source: parsed.data };
}

export type ReleaseSpecRecord = {
  spec_source: SpecSource;
  runtime_spec: RuntimeSpec;
  spec_source_digest: string;
  spec_digest: string;
};

/** The four values stored together, as the table's CHECK requires. */
export function releaseSpecRecord(source: SpecSource): ReleaseSpecRecord {
  const spec = deriveRuntimeSpec(source);
  return {
    spec_source: source,
    runtime_spec: spec,
    spec_source_digest: sha256Json(source),
    spec_digest: sha256Json(spec),
  };
}

export type SpecVerdict =
  | { ok: true; record: ReleaseSpecRecord }
  | { ok: false; reason: string };

/**
 * Whether a stored pair still means what it says: both parse, the spec is
 * what the source derives, and both digests hold. A reader trusts the spec
 * only when this is ok.
 */
export function verifyReleaseSpec(stored: {
  spec_source: unknown;
  runtime_spec: unknown;
  spec_source_digest: unknown;
  spec_digest: unknown;
}): SpecVerdict {
  const source = specSourceSchema.safeParse(stored.spec_source);
  if (!source.success)
    return { ok: false, reason: "spec_source does not parse" };
  const spec = runtimeSpecSchema.safeParse(stored.runtime_spec);
  if (!spec.success)
    return { ok: false, reason: "runtime_spec does not parse" };
  const record = releaseSpecRecord(source.data);
  if (
    canonicalJsonOfJson(record.runtime_spec) !== canonicalJsonOfJson(spec.data)
  ) {
    return {
      ok: false,
      reason: "runtime_spec is not what spec_source derives",
    };
  }
  if (stored.spec_source_digest !== record.spec_source_digest) {
    return { ok: false, reason: "spec_source_digest does not hold" };
  }
  if (stored.spec_digest !== record.spec_digest) {
    return { ok: false, reason: "spec_digest does not hold" };
  }
  return { ok: true, record };
}
