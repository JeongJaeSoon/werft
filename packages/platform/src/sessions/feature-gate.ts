import type { RuntimeConfig, RuntimeKind } from "@werft-ai/contracts";
import {
  type FeatureKey,
  featureSupport,
  type RuntimeDescriptor,
  runtimeRequirementsOf,
  unmetFeatures,
} from "@werft-ai/runtime-core";

import type { CatalogProfileConfig } from "./catalog.ts";

type GatedSettings = Pick<RuntimeConfig, "permission_mode"> &
  Partial<Pick<RuntimeConfig, "mcp_servers">>;

/**
 * Refuses settings a runtime cannot run before a session is made on them:
 * a kind no installed runtime serves, or a feature its descriptor declares
 * `none`. The descriptors come from the composition root, since this
 * package cannot import an adapter. The worker checks the same against the
 * engine it started, for an image that differs from these descriptors.
 */
export class ProfileFeatureGate {
  private readonly descriptors = new Map<RuntimeKind, RuntimeDescriptor>();

  constructor(descriptors: readonly RuntimeDescriptor[]) {
    for (const descriptor of descriptors) {
      this.descriptors.set(descriptor.kind, descriptor);
    }
  }

  /** Whether the runtime of `kind` offers `feature` at all (not `none`). */
  offers(kind: RuntimeKind, feature: FeatureKey): boolean {
    const descriptor = this.descriptors.get(kind);
    return (
      descriptor !== undefined &&
      featureSupport(
        descriptor.capabilities,
        descriptor.extraFeatures,
        feature,
      ) !== "none"
    );
  }

  /** Why a runtime of `kind` cannot run these settings; null when it can. */
  refusal(kind: RuntimeKind, settings: GatedSettings): string | null {
    const descriptor = this.descriptors.get(kind);
    if (descriptor === undefined) {
      const installed = [...this.descriptors.keys()].join(", ") || "none";
      return `Runtime ${kind} is not installed (installed: ${installed})`;
    }
    const missing = unmetFeatures(
      descriptor.capabilities,
      descriptor.extraFeatures,
      runtimeRequirementsOf(settings),
    );
    return missing.length === 0
      ? null
      : `Runtime ${kind} does not support ${missing.join(", ")}`;
  }

  /** Throws naming every profile refused. A profile alone names no MCP server: a release adds it. */
  assertProfiles(
    profiles: Readonly<
      Record<
        string,
        Pick<CatalogProfileConfig, "runtime_kind" | "permission_mode">
      >
    >,
  ): void {
    const refused = Object.entries(profiles).flatMap(([id, profile]) => {
      const reason = this.refusal(profile.runtime_kind, profile);
      return reason === null ? [] : [`${id}: ${reason}`];
    });
    if (refused.length > 0) {
      throw new Error(`Catalog profile(s) refused: ${refused.join("; ")}`);
    }
  }
}
