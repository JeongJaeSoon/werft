import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger, MemoryLogSink } from "../index.ts";
import { parseTracingSettings, type SamplerKind } from "./config.ts";
import {
  createTelemetryPolicy,
  effectiveContentMode,
  endpointOnEgressAllowlist,
} from "./telemetry-policy.ts";
import { sampleByTraceId } from "./tracer.ts";

const ON = {
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
  TRACE_INGEST_URL: "http://api.internal:4319",
};

function settings(extra: Record<string, string> = {}) {
  const parsed = parseTracingSettings({ ...ON, ...extra });
  if (parsed === undefined) throw new Error("tracing should be on");
  return parsed;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function headersFile(content: string, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), "trace-headers-"));
  dirs.push(dir);
  const path = join(dir, "headers.json");
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

describe("sampler keys", () => {
  test("default to always_on with ratio 1.0", () => {
    expect(settings().sampler).toEqual({ kind: "always_on", ratio: 1 });
    expect(settings({ OTEL_TRACES_SAMPLER: "traceidratio" }).sampler).toEqual({
      kind: "traceidratio",
      ratio: 1,
    });
  });

  test("accept only the three kinds and a 0..1 ratio", () => {
    const kinds: SamplerKind[] = ["always_on", "always_off", "traceidratio"];
    for (const kind of kinds) {
      expect(settings({ OTEL_TRACES_SAMPLER: kind }).sampler.kind).toBe(kind);
    }
    for (const kind of [
      "parentbased_always_on",
      "jaeger_remote",
      "ALWAYS_ON",
    ]) {
      expect(() => settings({ OTEL_TRACES_SAMPLER: kind })).toThrow(
        "OTEL_TRACES_SAMPLER",
      );
    }
    for (const arg of ["-0.1", "1.5", "abc"]) {
      expect(() =>
        settings({
          OTEL_TRACES_SAMPLER: "traceidratio",
          OTEL_TRACES_SAMPLER_ARG: arg,
        }),
      ).toThrow("OTEL_TRACES_SAMPLER_ARG");
    }
    expect(
      settings({
        OTEL_TRACES_SAMPLER: "traceidratio",
        OTEL_TRACES_SAMPLER_ARG: "0.25",
      }).sampler.ratio,
    ).toBe(0.25);
  });

  test("traceidratio reads the low 8 bytes against floor(ratio * 2^64)", () => {
    const high = "ffffffffffffffff";
    // Only the low 8 bytes decide: the high half is ignored.
    expect(sampleByTraceId(`${high}0000000000000000`, 0.5)).toBe(true);
    expect(sampleByTraceId(`0000000000000000${high}`, 0.5)).toBe(false);
    // 0x8000000000000000 is exactly floor(0.5 * 2^64): not below it.
    expect(sampleByTraceId("00000000000000008000000000000000", 0.5)).toBe(
      false,
    );
    expect(sampleByTraceId("00000000000000007fffffffffffffff", 0.5)).toBe(true);
    // The two vectors of the decision document §6.
    expect(sampleByTraceId("0".repeat(32), 0.5)).toBe(true);
    expect(sampleByTraceId("f".repeat(32), 0.5)).toBe(false);
  });
});

describe("content and ingest keys", () => {
  test("a bare otlp installation gets the documented defaults", () => {
    const s = settings();
    expect(s.content).toEqual({ mode: "full", maxBytes: 32_768 });
    expect(s.ingest).toEqual({
      url: "http://api.internal:4319",
      port: 4319,
      maxRequestBytes: 4_194_304,
      maxBytesPerMinute: 33_554_432,
      maxBytesPerTrace: 20_971_520,
      fencedGraceSec: 300,
    });
  });

  test("an off installation reads none of them", () => {
    expect(
      parseTracingSettings({
        TRACE_CONTENT_MODE: "bogus",
        TRACE_INGEST_PORT: "-1",
      }),
    ).toBeUndefined();
  });

  test("a bad value stops startup and names its key", () => {
    const bad: [string, string][] = [
      ["TRACE_CONTENT_MODE", "partial"],
      ["TRACE_CONTENT_MAX_BYTES", "-1"],
      ["TRACE_CONTENT_MAX_BYTES", "0"],
      ["TRACE_CONTENT_MAX_BYTES", "1e3"],
      ["TRACE_INGEST_PORT", "70000"],
      ["TRACE_INGEST_PORT", "abc"],
      ["TRACE_INGEST_MAX_REQUEST_BYTES", "-4"],
      ["TRACE_INGEST_MAX_BYTES_PER_MIN", "0"],
      ["TRACE_MAX_BYTES_PER_TRACE", "-1"],
      ["TRACE_FENCED_GRACE_SEC", "-300"],
      ["TRACE_INGEST_URL", "ftp://api:4319"],
      ["TRACE_INGEST_URL", "not a url"],
    ];
    for (const [key, value] of bad) {
      expect(() => settings({ [key]: value })).toThrow(key);
    }
  });

  test("TRACE_INGEST_URL is required once export is on", () => {
    expect(() =>
      parseTracingSettings({
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      }),
    ).toThrow("TRACE_INGEST_URL");
  });

  test("a protocol other than http/protobuf is refused", () => {
    expect(() => settings({ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" })).toThrow(
      "OTEL_EXPORTER_OTLP_PROTOCOL",
    );
  });
});

describe("content mode ceiling", () => {
  test("a workspace can lower the installation's mode but never raise it", () => {
    expect(effectiveContentMode("full", undefined)).toBe("full");
    expect(effectiveContentMode("full", "metadata")).toBe("metadata");
    expect(effectiveContentMode("metadata", "full")).toBe("metadata");
    expect(effectiveContentMode("metadata", undefined)).toBe("metadata");
  });

  test("TRACE_CONTENT_MODE=metadata wins in both the claim and nextInput", () => {
    const policy = createTelemetryPolicy(
      settings({ TRACE_CONTENT_MODE: "metadata" }),
    );
    const claim = policy.claim("full");
    expect(claim).toMatchObject({ enabled: true, content_mode: "metadata" });
    expect(policy.contentMode("full")).toBe("metadata");
  });
});

describe("claim telemetry from settings", () => {
  test("an installation with no keys sends enabled: false and no content mode", () => {
    const policy = createTelemetryPolicy(parseTracingSettings({}));
    expect(policy.claim()).toEqual({ enabled: false });
    expect(policy.contentMode("full")).toBeUndefined();
  });

  test("carries the ingest address, limits and sampler", () => {
    const policy = createTelemetryPolicy(
      settings({
        OTEL_TRACES_SAMPLER: "traceidratio",
        OTEL_TRACES_SAMPLER_ARG: "0.1",
        TRACE_CONTENT_MAX_BYTES: "1000",
      }),
    );
    expect(policy.claim()).toEqual({
      enabled: true,
      ingest_url: "http://api.internal:4319",
      content_mode: "full",
      content_max_bytes: 1000,
      sampler: "traceidratio",
      sampler_arg: 0.1,
    });
  });
});

describe("egress allowlist", () => {
  test("matches the collector host regardless of port or case", () => {
    const collector = "http://Collector.Internal:4318/v1/traces";
    expect(
      endpointOnEgressAllowlist(
        collector,
        "api.anthropic.com:443, collector.internal:4318",
      ),
    ).toBe(true);
    expect(endpointOnEgressAllowlist(collector, "collector.internal")).toBe(
      true,
    );
    expect(endpointOnEgressAllowlist(collector, "other.internal:4318")).toBe(
      false,
    );
    expect(endpointOnEgressAllowlist(collector, undefined)).toBe(false);
    expect(
      endpointOnEgressAllowlist("http://[::1]:4318/v1/traces", "[::1]:4318"),
    ).toBe(true);
  });
});

describe("tenant headers file", () => {
  test("adds per-workspace headers that win a shared name over TRACE_TENANT_HEADER", () => {
    const file = headersFile(
      JSON.stringify({
        "ws-1": { "X-Scope-OrgID": "tenant-from-file", "X-Extra": "1" },
      }),
    );
    const s = settings({
      TRACE_TENANT_HEADER: "X-Scope-OrgID: {workspace_id}",
      TRACE_TENANT_HEADERS_FILE: file,
    });
    expect(s.tenantHeaders("ws-1")).toEqual({
      "x-scope-orgid": "tenant-from-file",
      "x-extra": "1",
    });
    expect(s.tenantHeaders("ws-2")).toEqual({ "x-scope-orgid": "ws-2" });
  });

  test("a file that is not mode 600 is refused without its content", () => {
    const file = headersFile(
      JSON.stringify({ "ws-1": { Authorization: "SECRET-FILE-VALUE" } }),
      0o644,
    );
    try {
      settings({ TRACE_TENANT_HEADERS_FILE: file });
      throw new Error("expected a throw");
    } catch (error) {
      expect(String(error)).toContain("TRACE_TENANT_HEADERS_FILE");
      expect(String(error)).not.toContain("SECRET-FILE-VALUE");
    }
  });

  test.each([
    ["not json SECRET-FILE-VALUE", "valid JSON"],
    [JSON.stringify(["SECRET-FILE-VALUE"]), "object of workspace id"],
    [JSON.stringify({ w: "SECRET-FILE-VALUE" }), "object of workspace id"],
    [
      JSON.stringify({ w: { "bad name": "SECRET-FILE-VALUE" } }),
      "invalid header name",
    ],
    [JSON.stringify({ w: { ok: "SECRET\n€" } }), "invalid value for ok"],
  ])("a malformed file never echoes its values (%#)", (content, message) => {
    try {
      settings({ TRACE_TENANT_HEADERS_FILE: headersFile(content) });
      throw new Error("expected a throw");
    } catch (error) {
      expect(String(error)).toContain(message);
      expect(String(error)).not.toContain("SECRET");
    }
  });

  test("a missing file is named by key, not by path", () => {
    expect(() =>
      settings({ TRACE_TENANT_HEADERS_FILE: "/nonexistent/secret-dir/h.json" }),
    ).toThrow("TRACE_TENANT_HEADERS_FILE cannot be read");
  });
});

describe("secrets never reach a log line", () => {
  test("a startup failure logged with its message carries no header value", () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ sinks: [sink] });
    try {
      settings({ OTEL_EXPORTER_OTLP_HEADERS: "SECRET-HEADER-VALUE" });
    } catch (error) {
      logger.error("Refusing to start", {
        error: error instanceof Error ? error.message : "error",
      });
    }
    expect(sink.records).toHaveLength(1);
    expect(JSON.stringify(sink.records)).toContain(
      "OTEL_EXPORTER_OTLP_HEADERS",
    );
    expect(JSON.stringify(sink.records)).not.toContain("SECRET-HEADER-VALUE");
  });
});
