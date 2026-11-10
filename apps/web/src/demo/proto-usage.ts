// Fixed usage and achievement figures for the prototype's in-page API.

const DAY = 86_400_000;
const DEV = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const DOCS = "1b2c3d4e-5f6a-4b7c-8d8e-0f1a2b3c4d5e";
const PR_TYPE = "2c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f";
const DOC_TYPE = "3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a";
const RULE = "4e5f6a7b-8c9d-4e0f-8a1b-3c4d5e6f7a8b";

const iso = (ms: number) => new Date(ms).toISOString();

export function usageSeries(now: number, days: number) {
  const day0 = Math.floor(now / DAY) * DAY;
  return {
    period: { since: iso(day0 - days * DAY), until: iso(day0) },
    refreshed_at: iso(now),
    buckets: Array.from({ length: days }, (_, i) => ({
      date: iso(day0 - (days - i) * DAY).slice(0, 10),
      session_count: 3 + ((i * 7) % 9),
      cost_usd: (4 + ((i * 5) % 11) * 0.8).toFixed(2),
      cost_complete: true,
      token_count: 600_000 + ((i * 37) % 13) * 90_000,
      run_seconds: 2400 + ((i * 11) % 7) * 600,
    })),
  };
}

export function usageSummary(now: number, scope: string, days: number) {
  const series = usageSeries(now, days);
  const sum = (key: "session_count" | "token_count" | "run_seconds") =>
    series.buckets.reduce((n, b) => n + b[key], 0);
  return {
    scope,
    period: series.period,
    refreshed_at: series.refreshed_at,
    session_count: sum("session_count"),
    cost_usd: series.buckets
      .reduce((n, b) => n + Number(b.cost_usd), 0)
      .toFixed(2),
    cost_complete: true,
    token_count: sum("token_count"),
    run_seconds: sum("run_seconds"),
    basis: {
      sessions: "created_in_period",
      cost: "provider_usage_estimate",
      run_time: "turn_wall_clock",
    },
  };
}

const TOOLS = [
  ["Bash", 1840, 21, 13_320_000, 3100, 298_000],
  ["Read", 1204, 2, 1_080_000, 400, 9100],
  ["Edit", 702, 12, 1_620_000, 900, 14_200],
  ["WebFetch", 214, 1, 3_960_000, 12_400, 61_000],
] as const;

export const usageTools = {
  tools: TOOLS.map(([name, calls, failed, total, median, max]) => ({
    name,
    calls,
    failed,
    total_ms: total,
    median_ms: median,
    max_ms: max,
    description: null,
  })),
  findings: [
    { kind: "most_time", name: "Bash" },
    { kind: "fails_often", name: "Edit" },
    { kind: "slowest", name: "WebFetch" },
  ],
};

export function achievementFigures(
  now: number,
  agents: readonly { id: string; name: string }[],
) {
  const series = usageSeries(now, 30);
  return {
    scope: "installation",
    period: series.period,
    refreshed_at: series.refreshed_at,
    session_count: 214,
    sessions_with_achievement_count: 58,
    cost_usd: "412.300000",
    cost_complete: true,
    achievement_count: 73,
    needs_review_count: 3,
    rejected_count: 2,
    judgment_count: 611,
    judge_calls: 1240,
    judge_cost_usd: "0.160000",
    cost_per_achievement_usd: "5.647945",
    by_category: [
      { id: DEV, name: "개발", achievement_count: 71, needs_review_count: 0 },
      { id: DOCS, name: "문서", achievement_count: 2, needs_review_count: 3 },
    ],
    by_type: [
      {
        id: PR_TYPE,
        key: "pull_request",
        name: "GitHub PR",
        achievement_count: 71,
        needs_review_count: 0,
      },
      {
        id: DOC_TYPE,
        key: "document",
        name: "문서",
        achievement_count: 2,
        needs_review_count: 3,
      },
    ],
    by_rule: [
      {
        id: RULE,
        family_id: RULE,
        version: 1,
        title: "머지된 PR",
        category_id: DEV,
        category_name: "개발",
        type_id: PR_TYPE,
        type_key: "pull_request",
        achievement_count: 71,
        needs_review_count: 0,
      },
    ],
    by_agent: agents.slice(0, 4).map((a, i) => ({
      id: a.id,
      name: a.name,
      session_count: 60 - i * 10,
      cost_usd: (120 - i * 20).toFixed(6),
      achievement_count: 30 - i * 6,
      cost_per_achievement_usd: ((120 - i * 20) / (30 - i * 6)).toFixed(6),
    })),
    recent: [
      {
        id: "5f6a7b8c-9d0e-4f1a-8b2c-4d5e6f7a8b9c",
        created_at: iso(now - 3_600_000),
        session_id: null,
        session_title: null,
        rule_id: RULE,
        rule_title: "머지된 PR",
        title: "acme/sample-app#153",
        link: "https://github.com/acme/sample-app/pull/153",
        evidence_kind: "github_pull_request",
        judge: "always",
        review_state: "auto",
      },
    ],
  };
}

export const achievementCategories = {
  items: [DEV, DOCS].map((id, position) => ({
    id,
    name: id === DEV ? "개발" : "문서",
    position,
    created_by: "00000000-0000-4000-8000-000000000001",
    created_at: "2026-10-01T00:00:00.000Z",
    archived_at: null,
    archived_by: null,
  })),
};

export const achievementTypes = {
  items: [
    [PR_TYPE, "pull_request", "GitHub PR", "github_pull_request"],
    [DOC_TYPE, "document", "문서", "out_file"],
  ].map(([id, key, name, evidence]) => ({
    id,
    key,
    name,
    evidence_kind: evidence,
    builtin: true,
    created_by: null,
    created_at: "2026-10-01T00:00:00.000Z",
    archived_at: null,
    archived_by: null,
  })),
};
