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
import {
  type CatalogProfile,
  profileFingerprint,
  repositoryModeOf,
} from "../sessions/catalog.ts";
import { type ReleaseIdentity, releaseIdVersion } from "./release-ids.ts";

// What a release runs as without its profile: a `spec_source` made once from
// the profile the release was cut from, and the `runtime_spec` it means. The
// pair is stored on the release row; after that nothing needs the profile.

type SpecRelease = ReleaseIdentity & Pick<AgentRelease, "id">;

export type SpecSourceRefusal =
  | { reason: "profile_changed" }
  | { reason: "connection_missing" }
  | { reason: "invalid_source"; message: string };

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
 * The source a release's spec is made from. `connectionId` is what
 * `connectionMatcher` found for the profile's provider.
 *
 * The raw inputs come from the profile, so they are only the release's own
 * when the profile still fingerprints to the digest the release pinned; a
 * profile edited since then says nothing about what the release ran. The
 * model, tools, mode and project settings are read from the release's own
 * snapshot, which is what its id was hashed over.
 */
export function buildSpecSource(input: {
  release: SpecRelease;
  profile: CatalogProfile;
  connectionId: string | null;
}): { ok: true; source: SpecSource } | ({ ok: false } & SpecSourceRefusal) {
  const { release, profile, connectionId } = input;
  if (profileFingerprint(profile) !== release.profile_digest) {
    return { ok: false, reason: "profile_changed" };
  }
  if (connectionId === null) return { ok: false, reason: "connection_missing" };
  const snapshot = release.runtime_config_snapshot;
  const candidate = {
    derivation_version: SPEC_DERIVATION_VERSION,
    origin: "profile",
    release_id: release.id,
    release_id_version: releaseIdVersion(release),
    profile_id: release.runtime_profile_id,
    profile_digest: release.profile_digest,
    runtime: { kind: profile.runtime_kind, version: profile.runtime_version },
    connection: {
      id: connectionId,
      kind: profile.provider.kind,
      endpoint: profile.provider.endpoint,
      billing: profile.provider.billing ?? "per_token",
    },
    model: snapshot.model,
    permission_mode: snapshot.permission_mode,
    tools: stringsOf(snapshot.tools) ?? snapshot.tools,
    ...(snapshot.project_settings === undefined
      ? {}
      : { project_settings: snapshot.project_settings }),
    ...(snapshot.mcp_deny === undefined ? {} : { mcp_deny: snapshot.mcp_deny }),
    repository_mode: repositoryModeOf(profile),
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
 * what the source derives, both digests hold, and the source names this
 * release. A reader trusts the spec only when this is ok.
 */
export function verifyReleaseSpec(
  releaseId: string,
  stored: {
    spec_source: unknown;
    runtime_spec: unknown;
    spec_source_digest: unknown;
    spec_digest: unknown;
  },
): SpecVerdict {
  const source = specSourceSchema.safeParse(stored.spec_source);
  if (!source.success)
    return { ok: false, reason: "spec_source does not parse" };
  const spec = runtimeSpecSchema.safeParse(stored.runtime_spec);
  if (!spec.success)
    return { ok: false, reason: "runtime_spec does not parse" };
  if (source.data.release_id !== releaseId) {
    return { ok: false, reason: "spec_source names another release" };
  }
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
