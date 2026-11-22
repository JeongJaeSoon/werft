import { describe, expect, test } from "bun:test";
import {
  createLogger,
  MemoryLogSink,
  parseTracingSettings,
} from "@werft-ai/observability";

import { warnCollectorOnEgressAllowlist } from "./tracing-startup.ts";

const ON = {
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4318",
  OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20SECRET-HEADER-VALUE",
  TRACE_INGEST_URL: "http://api.internal:4319",
};

function run(env: Record<string, string>, collector = ON) {
  const sink = new MemoryLogSink();
  const warned = warnCollectorOnEgressAllowlist(
    parseTracingSettings(collector),
    env,
    createLogger({ sinks: [sink] }),
  );
  return { warned, records: sink.records };
}

describe("collector on an egress allowlist", () => {
  test("warns once, naming the host and the list but no secret", () => {
    const { warned, records } = run({
      EGRESS_PRIVATE_ALLOWLIST: "collector.internal:4318",
      EGRESS_ALLOWLIST: "api.anthropic.com:443",
    });
    expect(warned).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "warn",
      event: "tracing.collector_on_egress_allowlist",
      fields: {
        collector_host: "collector.internal",
        allowlists: ["EGRESS_PRIVATE_ALLOWLIST"],
      },
    });
    expect(JSON.stringify(records)).not.toContain("SECRET-HEADER-VALUE");
  });

  test("reads the list as the egress proxy does and compares the host only", () => {
    const listed = (endpoint: string, list: string) =>
      run(
        { EGRESS_ALLOWLIST: list },
        { ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint },
      ).warned;
    const collector = "http://Collector.Internal:4318/v1/traces";
    expect(
      listed(collector, "api.anthropic.com:443, collector.internal:443"),
    ).toBe(true);
    expect(listed(collector, "collector.internal")).toBe(true);
    expect(listed(collector, "other.internal:4318")).toBe(false);
    expect(listed("http://[::1]:4318/v1/traces", "[::1]:4318")).toBe(true);
    // A trailing dot names the same host to the proxy.
    expect(listed(collector, "Collector.Internal.:4318")).toBe(true);
    expect(
      listed("http://collector.internal.:4318", "collector.internal:4318"),
    ).toBe(true);
  });

  test("stays silent for a collector that is not listed, and when export is off", () => {
    expect(run({ EGRESS_PRIVATE_ALLOWLIST: "other.internal:4318" })).toEqual({
      warned: false,
      records: [],
    });
    expect(
      run({ EGRESS_PRIVATE_ALLOWLIST: "collector.internal:4318" }, {} as never),
    ).toEqual({ warned: false, records: [] });
  });
});
