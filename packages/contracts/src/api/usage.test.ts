import { describe, expect, test } from "bun:test";
import {
  usageBreakdownQuerySchema,
  usageBreakdownResponseSchema,
  usageSeriesQuerySchema,
  usageSeriesResponseSchema,
  usageSummaryQuerySchema,
} from "./usage.ts";

describe("usageBreakdownResponseSchema", () => {
  const figures = {
    session_count: 131,
    input_tokens: 2_000,
    output_tokens: 700,
    cache_read_input_tokens: 6_400,
    cache_creation_input_tokens: 700,
    token_count: 9_800,
    cost_usd: "41.27",
  };

  // The shape the operations screens build: string keys and labels.
  test("reads the operations fixture's proposed response", () => {
    expect(
      usageBreakdownResponseSchema.parse({
        rows: [{ key: "agt_review", label: "리뷰 봇", ...figures }],
        totals: figures,
      }).rows[0]?.key,
    ).toBe("agt_review");
  });

  test("reads the row without an agent or model as null key and label", () => {
    const parsed = usageBreakdownResponseSchema.parse({
      rows: [{ key: null, label: null, ...figures }],
      totals: figures,
    });
    expect(parsed.rows[0]).toMatchObject({ key: null, label: null });
  });

  test("asks for by=model or by=agent", () => {
    const ok = (by?: string) =>
      usageBreakdownQuerySchema.safeParse({
        scope: "me",
        since: "2026-10-01",
        ...(by === undefined ? {} : { by }),
      }).success;
    expect([ok("model"), ok("agent"), ok("team"), ok()]).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("usageSeriesQuerySchema", () => {
  test("buckets by day unless told otherwise, and only by day", () => {
    expect(
      usageSeriesQuerySchema.parse({ scope: "me", since: "2026-10-01" }).bucket,
    ).toBe("day");
    expect(
      usageSeriesQuerySchema.safeParse({
        scope: "me",
        since: "2026-10-01",
        bucket: "week",
      }).success,
    ).toBe(false);
  });

  test("spans at most 366 days, the summary's period rules included", () => {
    const ok = (since: string, until?: string) =>
      usageSeriesQuerySchema.safeParse({
        scope: "installation",
        since,
        ...(until === undefined ? {} : { until }),
      }).success;
    expect(ok("2023-10-01", "2024-10-01")).toBe(true);
    expect(ok("2023-10-01", "2024-10-02")).toBe(false);
    expect(ok("2026-10-02", "2026-10-01")).toBe(false);
    expect(ok("2000-01-01")).toBe(false);
  });
});

describe("usageSeriesResponseSchema", () => {
  // The shape the operations screens build, values as they print them.
  test("reads the operations fixture's proposed response", () => {
    const parsed = usageSeriesResponseSchema.parse({
      period: {
        since: "2026-10-22T00:00:00Z",
        until: "2026-10-24T00:00:00Z",
      },
      refreshed_at: "2026-10-24T12:40:00Z",
      buckets: [
        {
          date: "2026-10-22",
          session_count: 13,
          cost_usd: "41.27",
          cost_complete: true,
          token_count: 1527000,
          run_seconds: 7020,
        },
        {
          date: "2026-10-23",
          session_count: 2,
          cost_usd: "6.00",
          cost_complete: false,
          token_count: 222000,
          run_seconds: 1080,
        },
      ],
    });
    expect(parsed.buckets).toHaveLength(2);
  });
});

describe("usageSummaryQuerySchema", () => {
  const bounds = (query: Record<string, string>) => {
    const parsed = usageSummaryQuerySchema.parse({ scope: "me", ...query });
    return [parsed.since.toISOString(), parsed.until?.toISOString()];
  };

  test("a date is that day's 00:00 UTC and an offset moves to UTC", () => {
    expect(bounds({ since: "2026-10-01", until: "2026-11-01" })).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
    ]);
    expect(
      bounds({
        since: "2026-10-01T09:00:00+09:00",
        until: "2026-10-31T19:00:00-05:00",
      }),
    ).toEqual(["2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
    expect(bounds({ since: "2026-10-01T00:00:00Z" })).toEqual([
      "2026-10-01T00:00:00.000Z",
      undefined,
    ]);
  });

  test("refuses a missing since, a local time, an impossible day and an empty period", () => {
    for (const query of [
      {},
      { since: "2026-10-01T00:00:00" },
      { since: "2026-02-30" },
      { since: "0000-01-01", until: "2000-01-01" },
      { since: "yesterday" },
      { since: "2026-10-01", until: "2026-10-01" },
      { since: "2026-10-02", until: "2026-10-01" },
      // Without until the period ends now, so a future since is empty.
      { since: "2099-01-01" },
    ]) {
      expect(
        usageSummaryQuerySchema.safeParse({ scope: "me", ...query }).success,
        JSON.stringify(query),
      ).toBe(false);
    }
    expect(
      usageSummaryQuerySchema.safeParse({ scope: "team", since: "2026-10-01" })
        .success,
    ).toBe(false);
  });
});
