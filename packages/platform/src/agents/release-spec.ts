import { createHash } from "node:crypto";
import {
  type AgentRelease,
  canonicalJsonOfJson,
  deriveRuntimeSpec,
  type RuntimeConfig,
  type RuntimeSpec,
  runtimeSpecSchema,
  SPEC_DERIVATION_VERSION,
  type SpecSource,
  specSourceSchema,
} from "@werft-ai/contracts";
import {
  type CatalogProfile,
  pinnedRuntimeVersion,
  repositoryModeOf,
} from "../sessions/catalog.ts";
import { type ReleaseIdentity, releaseIdVersion } from "./release-ids.ts";

// What a release runs as without its profile: a `spec_source` made once from
// the profile the release was cut from, and the `runtime_spec` it means. The
// pair is stored on the release row; after that nothing needs the profile.

export type SpecRelease = ReleaseIdentity & Pick<AgentRelease, "id">;

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
 *
 * The repository mode is the exception: the fingerprint leaves it out, so it
 * is the profile's value as of now. That is also what a session of this
 * release is held to today, so freezing it here keeps what runs at the
 * moment the spec starts to be read. No pairing of the release's repository
 * and the mode is refused: the agent and workspace policy paths run a release
 * whatever the mode says, so a refusal would leave a runnable release
 * without a spec.
 */
export function buildSpecSource(input: {
  release: SpecRelease;
  profile: CatalogProfile;
  connectionId: string | null;
  /** `acceptedRuntimeVersions` of the catalog: engines a release may predate. */
  acceptedVersions?: readonly string[];
}): { ok: true; source: SpecSource } | ({ ok: false } & SpecSourceRefusal) {
  const { release, profile, connectionId } = input;
  // The release runs while its digest names the profile under any accepted
  // runtime version; the version it names is the one it ran on.
  const runtimeVersion = pinnedRuntimeVersion(
    profile,
    release.profile_digest,
    input.acceptedVersions ?? [],
  );
  if (runtimeVersion === undefined) {
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
    runtime: { kind: profile.runtime_kind, version: runtimeVersion },
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

export type SpecBackfillStore = {
  /** Releases with no spec yet, by id after `after`, at most `limit`. */
  pending(after: string | null, limit: number): Promise<SpecRelease[]>;
  /** False when another writer stored a spec first. */
  save(releaseId: string, record: ReleaseSpecRecord): Promise<boolean>;
};

export type SpecBackfillReport = {
  stored: number;
  raced: number;
  skipped: { release_id: string; reason: string }[];
};

/**
 * Gives every release without a spec one, where its profile and connection
 * still say what it ran. Safe to run again and from two places: a release is
 * only written when it has no spec, and one that cannot be derived is listed,
 * not guessed.
 */
export async function backfillReleaseSpecs(
  store: SpecBackfillStore,
  resolve: (release: SpecRelease) =>
    | {
        profile: CatalogProfile;
        connectionId: string | null;
        acceptedVersions?: readonly string[];
      }
    // No profile to read: `profile_blocked` when the operator blocked it (it
    // runs again once unblocked), else `profile_gone`. Null is the latter.
    | { skip: "profile_blocked" | "profile_gone" }
    | null,
  pageSize = 200,
): Promise<SpecBackfillReport> {
  const report: SpecBackfillReport = { stored: 0, raced: 0, skipped: [] };
  let after: string | null = null;
  for (;;) {
    const page = await store.pending(after, pageSize);
    if (page.length === 0) return report;
    for (const release of page) {
      after = release.id;
      const found = resolve(release);
      if (found === null || "skip" in found) {
        report.skipped.push({
          release_id: release.id,
          reason: found === null ? "profile_gone" : found.skip,
        });
        continue;
      }
      const built = buildSpecSource({ release, ...found });
      if (!built.ok) {
        report.skipped.push({ release_id: release.id, reason: built.reason });
        continue;
      }
      if (await store.save(release.id, releaseSpecRecord(built.source))) {
        report.stored += 1;
      } else {
        report.raced += 1;
      }
    }
  }
}

/**
 * The runtime config a spec means, shaped as `runtimeConfigOf` shapes one from
 * a profile. The two execution modes map back to the engine's own: `bypass`
 * is `bypassPermissions`, `auto` is `auto`. The spec's tools are the release's
 * list, already narrowed, so nothing is taken within a profile.
 */
export function runtimeConfigFromSpec(
  spec: RuntimeSpec,
  providerToken: string,
  hasRepository: boolean,
): RuntimeConfig {
  return {
    model: spec.model,
    tools: [...spec.tools],
    permission_mode:
      spec.execution_mode === "bypass" ? "bypassPermissions" : "auto",
    provider: {
      kind: spec.connection.kind,
      endpoint: spec.connection.endpoint,
      auth: { kind: "egress_token", token: providerToken },
    },
    ...(hasRepository && spec.project_settings?.claude_md === true
      ? { project_settings: spec.project_settings }
      : {}),
  };
}
