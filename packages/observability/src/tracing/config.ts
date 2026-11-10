// Reads the tracing keys of the API service (the only process that reads them).
// Pure parsing: no OpenTelemetry import, so it can run before the adapter loads.

export type SamplerKind = "always_on" | "always_off" | "traceidratio";

export interface TracingSettings {
  readonly serviceName: string;
  readonly sampler: { readonly kind: SamplerKind; readonly ratio: number };
  /** The full traces URL the exporter posts to. */
  readonly endpoint: string;
  /** Sent with every batch. Secret: never log the values. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Headers for one batch. `workspaceId` is undefined for spans created before
   * the workspace is known; those go to the install tenant.
   */
  readonly tenantHeaders: (
    workspaceId: string | undefined,
  ) => Readonly<Record<string, string>>;
}

const SAMPLERS: readonly SamplerKind[] = [
  "always_on",
  "always_off",
  "traceidratio",
];

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseEndpoint(env: Readonly<Record<string, string | undefined>>) {
  const traces = blankToUndefined(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const base = blankToUndefined(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const raw =
    traces ??
    (base === undefined ? undefined : `${base.replace(/\/+$/, "")}/v1/traces`);
  if (raw === undefined) {
    throw new Error(
      "OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is required when OTEL_TRACES_EXPORTER=otlp",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The OTLP traces endpoint is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The OTLP traces endpoint must use http or https");
  }
  return raw;
}

/** `k1=v1,k2=v2` as OTEL_EXPORTER_OTLP_HEADERS spells it. Errors never echo a value. */
function parseHeaderList(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw?.split(",") ?? []) {
    if (pair.trim() === "") continue;
    const at = pair.indexOf("=");
    const name = at < 0 ? "" : pair.slice(0, at).trim();
    if (name === "") {
      throw new Error(
        "OTEL_EXPORTER_OTLP_HEADERS must be comma-separated key=value pairs",
      );
    }
    try {
      headers[name] = decodeURIComponent(pair.slice(at + 1).trim());
    } catch {
      throw new Error(
        `OTEL_EXPORTER_OTLP_HEADERS has an undecodable value for ${name}`,
      );
    }
  }
  return headers;
}

function parseSampler(env: Readonly<Record<string, string | undefined>>) {
  const kind = (blankToUndefined(env.OTEL_TRACES_SAMPLER) ??
    "always_on") as SamplerKind;
  if (!SAMPLERS.includes(kind)) {
    throw new Error(
      `OTEL_TRACES_SAMPLER must be one of ${SAMPLERS.join("|")}, got ${JSON.stringify(kind)}`,
    );
  }
  if (kind !== "traceidratio") {
    return { kind, ratio: kind === "always_on" ? 1 : 0 };
  }
  const rawArg = blankToUndefined(env.OTEL_TRACES_SAMPLER_ARG) ?? "1.0";
  const ratio = Number(rawArg);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error(
      `OTEL_TRACES_SAMPLER_ARG must be a number from 0 to 1, got ${JSON.stringify(rawArg)}`,
    );
  }
  return { kind, ratio };
}

function parseTenantHeader(raw: string | undefined) {
  if (raw === undefined) return undefined;
  const at = raw.indexOf(":");
  const name = at < 0 ? "" : raw.slice(0, at).trim();
  if (name === "") {
    throw new Error(
      "TRACE_TENANT_HEADER must look like '<header name>: <value template>'",
    );
  }
  return { name, template: raw.slice(at + 1).trim() };
}

/**
 * Returns undefined when tracing is off (OTEL_TRACES_EXPORTER unset or `none`),
 * so the caller keeps `noopTracer` and no exporter is ever built. A bad value
 * throws with the key's name, so the process stops at startup.
 */
export function parseTracingSettings(
  env: Readonly<Record<string, string | undefined>>,
): TracingSettings | undefined {
  const exporter = blankToUndefined(env.OTEL_TRACES_EXPORTER) ?? "none";
  if (exporter === "none") return undefined;
  if (exporter !== "otlp") {
    throw new Error(
      `OTEL_TRACES_EXPORTER must be none or otlp, got ${JSON.stringify(exporter)}`,
    );
  }
  const protocol =
    blankToUndefined(env.OTEL_EXPORTER_OTLP_PROTOCOL) ?? "http/protobuf";
  if (protocol !== "http/protobuf") {
    throw new Error(
      `OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf, got ${JSON.stringify(protocol)}`,
    );
  }

  const endpoint = parseEndpoint(env);
  const headers = parseHeaderList(env.OTEL_EXPORTER_OTLP_HEADERS);
  const sampler = parseSampler(env);
  const tenantHeader = parseTenantHeader(
    blankToUndefined(env.TRACE_TENANT_HEADER),
  );
  const installTenant = blankToUndefined(env.TRACE_INSTALL_TENANT);

  return {
    serviceName: blankToUndefined(env.OTEL_SERVICE_NAME) ?? "werft-api",
    sampler,
    endpoint,
    headers,
    tenantHeaders(workspaceId) {
      const tenant = workspaceId ?? installTenant;
      if (tenantHeader === undefined || tenant === undefined) return {};
      return {
        [tenantHeader.name]: tenantHeader.template.replaceAll(
          "{workspace_id}",
          tenant,
        ),
      };
    },
  };
}
