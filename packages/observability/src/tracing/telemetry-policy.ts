import type { ContentMode, SamplerKind, TracingSettings } from "./config.ts";

/**
 * What the API tells a worker about tracing. Shaped like the worker protocol's
 * claim `telemetry` without importing it; the consumer owns the port and this
 * satisfies it structurally.
 */
export type ClaimTelemetry =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly ingest_url: string;
      readonly content_mode: ContentMode;
      readonly content_max_bytes: number;
      readonly sampler: SamplerKind;
      readonly sampler_arg: number;
    };

export interface TelemetryPolicy {
  /** The `telemetry` block of a bootstrap claim. */
  claim(workspaceContentMode?: ContentMode): ClaimTelemetry;
  /** The `content_mode` of a nextInput; undefined while tracing is off. */
  contentMode(workspaceContentMode?: ContentMode): ContentMode | undefined;
}

/** A workspace can only lower the installation's ceiling, never raise it. */
export function effectiveContentMode(
  installation: ContentMode,
  workspace: ContentMode | undefined,
): ContentMode {
  return installation === "metadata" || workspace === "metadata"
    ? "metadata"
    : "full";
}

/** `settings` is what `parseTracingSettings` returned: undefined means off. */
export function createTelemetryPolicy(
  settings: TracingSettings | undefined,
): TelemetryPolicy {
  return {
    claim(workspaceContentMode) {
      if (settings === undefined) return { enabled: false };
      return {
        enabled: true,
        ingest_url: settings.ingest.url,
        content_mode: effectiveContentMode(
          settings.content.mode,
          workspaceContentMode,
        ),
        content_max_bytes: settings.content.maxBytes,
        sampler: settings.sampler.kind,
        sampler_arg: settings.sampler.ratio,
      };
    },
    contentMode(workspaceContentMode) {
      return settings === undefined
        ? undefined
        : effectiveContentMode(settings.content.mode, workspaceContentMode);
    },
  };
}

/**
 * Whether `endpoint`'s host is on an egress allowlist
 * (`host[:port],host[:port]`). The collector must not be there: workers reach
 * it through the ingest listener, never directly. Compared by host only.
 */
export function endpointOnEgressAllowlist(
  endpoint: string,
  allowlist: string | undefined,
): boolean {
  const host = new URL(endpoint).hostname.toLowerCase();
  return (allowlist ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "")
    .some((entry) => {
      const bare = entry.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
      // URL#hostname keeps the brackets of an IPv6 literal.
      return bare === host || `[${bare}]` === host;
    });
}
