import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  claimTelemetrySampler,
  claimTelemetrySchema,
  nextInputResponseSchema,
} from "./index.ts";

const on = {
  enabled: true,
  ingest_url: "http://api.internal:4319",
  content_mode: "full",
  content_max_bytes: 32768,
} as const;

describe("claim telemetry", () => {
  test("off is `enabled: false` alone", () => {
    expect(claimTelemetrySchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(() =>
      claimTelemetrySchema.parse({ enabled: false, content_mode: "full" }),
    ).toThrow();
  });

  test("on needs the address, mode and byte limit", () => {
    expect(claimTelemetrySchema.parse(on)).toEqual(on);
    for (const key of ["ingest_url", "content_mode", "content_max_bytes"]) {
      const { [key as keyof typeof on]: _omit, ...rest } = on;
      expect(() => claimTelemetrySchema.parse(rest)).toThrow();
    }
    expect(() =>
      claimTelemetrySchema.parse({ ...on, ingest_url: "not a url" }),
    ).toThrow();
    expect(() =>
      claimTelemetrySchema.parse({ ...on, content_mode: "partial" }),
    ).toThrow();
    expect(() =>
      claimTelemetrySchema.parse({ ...on, content_max_bytes: -1 }),
    ).toThrow();
  });

  test("sampler and sampler_arg are optional and carried through", () => {
    const parsed = claimTelemetrySchema.parse({
      ...on,
      sampler: "traceidratio",
      sampler_arg: 0.25,
    });
    expect(parsed).toMatchObject({
      sampler: "traceidratio",
      sampler_arg: 0.25,
    });
    expect(() =>
      claimTelemetrySchema.parse({ ...on, sampler: "parentbased_always_on" }),
    ).toThrow();
    for (const arg of [-0.1, 1.1]) {
      expect(() =>
        claimTelemetrySchema.parse({
          ...on,
          sampler: "traceidratio",
          sampler_arg: arg,
        }),
      ).toThrow();
    }
  });

  test("a claim without sampler and sampler_arg reads as always_on", () => {
    expect(claimTelemetrySampler(claimTelemetrySchema.parse(on))).toEqual({
      kind: "always_on",
      ratio: 1,
    });
    // An older API sends no telemetry at all, and a worker traces nothing.
    expect(claimTelemetrySampler(undefined)).toEqual({
      kind: "always_on",
      ratio: 1,
    });
  });

  test("reads each sampler as the kind and ratio sampleByTraceId takes", () => {
    const read = (extra: object) =>
      claimTelemetrySampler(claimTelemetrySchema.parse({ ...on, ...extra }));
    expect(read({ sampler: "always_off" })).toEqual({
      kind: "always_off",
      ratio: 0,
    });
    expect(read({ sampler: "traceidratio", sampler_arg: 0.1 })).toEqual({
      kind: "traceidratio",
      ratio: 0.1,
    });
    // The ratio's key default is 1.0, so a missing arg samples everything.
    expect(read({ sampler: "traceidratio" })).toEqual({
      kind: "traceidratio",
      ratio: 1,
    });
    // An arg without its sampler names no ratio sampler.
    expect(read({ sampler_arg: 0.1 })).toEqual({ kind: "always_on", ratio: 1 });
  });
});

describe("telemetry on the wire", () => {
  test("a bootstrap claim schema accepts telemetry and keeps working without it", () => {
    const shape = bootstrapClaimResponseSchema.shape;
    expect(shape.telemetry.parse(undefined)).toBeUndefined();
    expect(shape.telemetry.parse({ enabled: false })).toEqual({
      enabled: false,
    });
  });

  test("nextInput carries a content_mode and still parses without one", () => {
    const base = {
      turn_id: "1",
      input_id: "7",
      message: "go",
      delivery_started_at: "2026-11-10T00:00:00.000Z",
    };
    const wrap = (extra: object) => ({
      input: { ...base, ...extra },
      lease_expires_at: "2026-11-10T00:00:30.000Z",
    });
    expect(nextInputResponseSchema.parse(wrap({})).input?.content_mode).toBe(
      undefined,
    );
    expect(
      nextInputResponseSchema.parse(wrap({ content_mode: "metadata" })).input
        ?.content_mode,
    ).toBe("metadata");
    expect(() =>
      nextInputResponseSchema.parse(wrap({ content_mode: "none" })),
    ).toThrow();
  });
});
