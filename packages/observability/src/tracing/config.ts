// Reads the tracing keys of the API service (the only process that reads them).
// Pure parsing: no OpenTelemetry import, so it can run before the adapter loads.

import { readFileSync, statSync } from "node:fs";

export type SamplerKind = "always_on" | "always_off" | "traceidratio";

/** What span attributes may carry: `metadata` keeps prompts and tool I/O out. */
export type ContentMode = "full" | "metadata";

export interface TracingSettings {
  readonly serviceName: string;
  readonly sampler: { readonly kind: SamplerKind; readonly ratio: number };
  /** The installation's ceiling; a workspace may only lower it. */
  readonly content: { readonly mode: ContentMode; readonly maxBytes: number };
  /** Where workers send spans, and the limits the listener enforces. */
  readonly ingest: {
    /** The address a worker reaches the listener at. Operator-set only. */
    readonly url: string;
    readonly port: number;
    readonly maxRequestBytes: number;
    readonly maxBytesPerMinute: number;
    readonly maxBytesPerTrace: number;
    readonly fencedGraceSec: number;
  };
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

// An invalid header makes the HTTP client throw at export time, outside any
// caller's handling, so both parts are checked at startup. Names are lowercased
// because HTTP treats them case-insensitively and precedence depends on it.
// `%` is a legal token character but the SDK percent-decodes names from its
// own env reading, so one that decodes to an invalid name would crash at export.
const HEADER_NAME = /^[!#$&'*+.^_`|~0-9A-Za-z-]+$/;
// Tab, space and printable ASCII only: the HTTP client also rejects anything
// above U+00FF, and a non-ASCII byte is rarely what an operator meant.
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

function validHeaderValue(value: string): boolean {
  return HEADER_VALUE.test(value);
}

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

/**
 * `k1=v1,k2=v2` as the OTLP headers keys spell it. Errors name the key and the
 * header, never a value. The SDK reads both keys from the environment itself,
 * so both are validated here or a bad one would crash at the first export.
 */
function parseHeaderList(
  key: string,
  raw: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw?.split(",") ?? []) {
    if (pair.trim() === "") continue;
    const at = pair.indexOf("=");
    const name = at < 0 ? "" : pair.slice(0, at).trim();
    if (name === "") {
      throw new Error(`${key} must be comma-separated key=value pairs`);
    }
    if (!HEADER_NAME.test(name)) {
      throw new Error(`${key} has an invalid header name`);
    }
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(at + 1).trim());
    } catch {
      throw new Error(`${key} has an undecodable value for ${name}`);
    }
    if (!validHeaderValue(value)) {
      throw new Error(`${key} has an invalid value for ${name}`);
    }
    headers[name.toLowerCase()] = value;
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
  if (name === "" || !HEADER_NAME.test(name)) {
    throw new Error(
      "TRACE_TENANT_HEADER must look like '<header name>: <value template>'",
    );
  }
  const template = raw.slice(at + 1).trim();
  if (!validHeaderValue(template)) {
    throw new Error("TRACE_TENANT_HEADER has an invalid value template");
  }
  return { name: name.toLowerCase(), template };
}

type Env = Readonly<Record<string, string | undefined>>;

function parseContentMode(env: Env): ContentMode {
  const raw = blankToUndefined(env.TRACE_CONTENT_MODE) ?? "full";
  if (raw !== "full" && raw !== "metadata") {
    throw new Error(
      `TRACE_CONTENT_MODE must be full or metadata, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/** Digits only: `1e3`, `-5`, `0x10` and `12.5` all stop the process by name. */
function parseLimit(env: Env, key: string, fallback: number, max?: number) {
  const raw = blankToUndefined(env[key]);
  if (raw === undefined) return fallback;
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > (max ?? Infinity)) {
    throw new Error(
      `${key} must be a positive integer${max === undefined ? "" : ` up to ${max}`}, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

function parseIngestUrl(env: Env): string {
  const raw = blankToUndefined(env.TRACE_INGEST_URL);
  if (raw === undefined) {
    throw new Error(
      "TRACE_INGEST_URL is required when OTEL_TRACES_EXPORTER=otlp: the address workers send spans to",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("TRACE_INGEST_URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TRACE_INGEST_URL must use http or https");
  }
  return raw;
}

type HeaderMap = Readonly<Record<string, string>>;

/**
 * `{"<workspace_id>": {"<header>": "<value>"}}`. The file holds secrets, so
 * only an owner-only regular file is read, and no error repeats its content.
 */
function readTenantHeadersFile(path: string): Map<string, HeaderMap> {
  const key = "TRACE_TENANT_HEADERS_FILE";
  let text: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("not a file");
    // 0o600 exactly: a group or world bit on a secret file is refused.
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error(`${key} must have mode 600`);
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.includes("mode 600")) {
      throw error;
    }
    throw new Error(`${key} cannot be read`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${key} is not valid JSON`);
  }
  const shape = `${key} must be an object of workspace id to header map`;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(shape);
  }
  const byWorkspace = new Map<string, HeaderMap>();
  for (const [workspaceId, headers] of Object.entries(parsed)) {
    if (
      typeof headers !== "object" ||
      headers === null ||
      Array.isArray(headers)
    ) {
      throw new Error(shape);
    }
    const checked: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!HEADER_NAME.test(name)) {
        throw new Error(`${key} has an invalid header name`);
      }
      if (typeof value !== "string" || !validHeaderValue(value)) {
        throw new Error(`${key} has an invalid value for ${name}`);
      }
      checked[name.toLowerCase()] = value;
    }
    byWorkspace.set(workspaceId, checked);
  }
  return byWorkspace;
}

/**
 * Returns undefined when tracing is off (OTEL_TRACES_EXPORTER unset or `none`),
 * so the caller keeps `noopTracer` and no exporter is ever built. A bad value
 * throws with the key's name, so the process stops at startup.
 */
export function parseTracingSettings(env: Env): TracingSettings | undefined {
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
  const headers = {
    ...parseHeaderList(
      "OTEL_EXPORTER_OTLP_HEADERS",
      env.OTEL_EXPORTER_OTLP_HEADERS,
    ),
    ...parseHeaderList(
      "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
      env.OTEL_EXPORTER_OTLP_TRACES_HEADERS,
    ),
  };
  const sampler = parseSampler(env);
  const tenantHeader = parseTenantHeader(
    blankToUndefined(env.TRACE_TENANT_HEADER),
  );
  const installTenant = blankToUndefined(env.TRACE_INSTALL_TENANT);
  const tenantFile = blankToUndefined(env.TRACE_TENANT_HEADERS_FILE);
  const fileHeaders =
    tenantFile === undefined ? undefined : readTenantHeadersFile(tenantFile);

  return {
    serviceName: blankToUndefined(env.OTEL_SERVICE_NAME) ?? "werft-api",
    sampler,
    content: {
      mode: parseContentMode(env),
      maxBytes: parseLimit(env, "TRACE_CONTENT_MAX_BYTES", 32_768),
    },
    ingest: {
      url: parseIngestUrl(env),
      port: parseLimit(env, "TRACE_INGEST_PORT", 4319, 65_535),
      maxRequestBytes: parseLimit(
        env,
        "TRACE_INGEST_MAX_REQUEST_BYTES",
        4 * 1024 * 1024,
      ),
      maxBytesPerMinute: parseLimit(
        env,
        "TRACE_INGEST_MAX_BYTES_PER_MIN",
        32 * 1024 * 1024,
      ),
      maxBytesPerTrace: parseLimit(
        env,
        "TRACE_MAX_BYTES_PER_TRACE",
        20 * 1024 * 1024,
      ),
      fencedGraceSec: parseLimit(env, "TRACE_FENCED_GRACE_SEC", 300),
    },
    endpoint,
    headers,
    tenantHeaders(workspaceId) {
      const tenant = workspaceId ?? installTenant;
      if (tenant === undefined) return {};
      const fromTemplate: Record<string, string> = {};
      if (tenantHeader !== undefined) {
        const value = tenantHeader.template.replaceAll(
          "{workspace_id}",
          tenant,
        );
        // The workspace id comes from a span attribute; never let it break the request.
        if (validHeaderValue(value)) fromTemplate[tenantHeader.name] = value;
      }
      // The file is the more specific source, so it wins a shared name.
      return { ...fromTemplate, ...fileHeaders?.get(tenant) };
    },
  };
}
