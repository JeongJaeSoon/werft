import type { RuntimeConfig } from "@werft-ai/contracts";

import type {
  FeatureKey,
  RuntimeCapabilityTable,
  Support,
} from "./descriptor.ts";

/** The features a session's settings cannot run without. */
export type RuntimeRequirements = { features: readonly FeatureKey[] };

export function runtimeRequirementsOf(
  runtimeConfig: Pick<RuntimeConfig, "permission_mode"> &
    Partial<Pick<RuntimeConfig, "extensions" | "mcp_servers">>,
): RuntimeRequirements {
  const features: FeatureKey[] = [];
  if ((runtimeConfig.mcp_servers ?? []).length > 0) features.push("mcp");
  if ((runtimeConfig.extensions ?? []).length > 0) features.push("skills");
  if (runtimeConfig.permission_mode === "auto") {
    features.push("classifier_review");
  }
  return { features };
}

/** How an engine offers a feature: the table's word for it, else the extras', else none. */
export function featureSupport(
  table: RuntimeCapabilityTable,
  extra: Partial<Record<FeatureKey, Support>>,
  key: FeatureKey,
): Support {
  switch (key) {
    case "mcp":
      return table.mcp;
    case "skills":
      return table.skills;
    case "session_resume":
      return table.resume && table.checkpoint ? "native" : "none";
    case "approval_park":
      // Parking cuts the turn at an approval and resumes it from a
      // checkpoint taken there, so the engine has to offer that checkpoint.
      return table.interrupt &&
        table.checkpoint &&
        table.approvalCheckpoint &&
        table.resume
        ? "native"
        : "none";
    case "classifier_review":
      return table.permissionModes.auto;
    default:
      return extra[key] ?? "none";
  }
}

const UNSUPPORTED_FEATURES =
  " cannot run this session's settings: it does not support ";

/**
 * Why a worker refuses a claim whose settings need features its engine does
 * not offer. The same engine refuses on every launch, so the control plane
 * stops the session on the first one (`isUnsupportedFeaturesReason`).
 */
export function unsupportedFeaturesReason(
  runtime: { kind: string; version: string },
  unmet: readonly FeatureKey[],
): string {
  return `Runtime ${runtime.kind} ${runtime.version}${UNSUPPORTED_FEATURES}${unmet.join(", ")}`;
}

/** Whether a release reason is `unsupportedFeaturesReason`'s, bounded or not. */
export function isUnsupportedFeaturesReason(reason: string): boolean {
  return reason.startsWith("Runtime ") && reason.includes(UNSUPPORTED_FEATURES);
}

/** The required features the engine does not offer at all, in request order. */
export function unmetFeatures(
  table: RuntimeCapabilityTable,
  extra: Partial<Record<FeatureKey, Support>>,
  requirements: RuntimeRequirements,
): FeatureKey[] {
  return requirements.features.filter(
    (key) => featureSupport(table, extra, key) === "none",
  );
}
