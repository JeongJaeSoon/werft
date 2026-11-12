import { describe, expect, test } from "bun:test";
import type { WorkerUnitOfWork } from "../ports/worker-unit-of-work.ts";
import type { JudgmentEgressStore } from "../sessions/achievements/achievement-judgment-store.ts";
import { hashJudgmentToken } from "../sessions/achievements/judgment-token.ts";
import type { SessionCatalog } from "../sessions/catalog.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const JUDGMENT = "6a1d2f3e-4b5c-4d6e-8f70-81a2b3c4d5e6";
const NOW = new Date("2026-11-02T15:30:00.000Z");
const catalog: SessionCatalog = { connections: {}, repositories: {} };
const LUNA = {
  url: "https://decisions.example.invalid",
  headers: [["authorization", "Bearer judge-key"]] as Array<[string, string]>,
};

type Authorized = Awaited<ReturnType<JudgmentEgressStore["authorizeToken"]>>;

const OK: Authorized = {
  outcome: "ok",
  judgmentId: JUDGMENT,
  connectionId: "conn-1",
  dailyBudgetUsd: 1,
  spentUsd: 0.25,
};

const USAGE = {
  model: "gpt-6-luna",
  inputTokens: 600,
  outputTokens: 2,
  cacheCreationInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheReadInputTokens: 0,
  speed: "standard",
  inferenceGeo: "unknown",
  webSearchRequests: 0,
  webFetchRequests: 0,
  codeExecutionRequests: 0,
  estimated: false,
};

function harness(
  options: {
    authorized?: Authorized;
    upstream?: ((connectionId: string) => Promise<typeof LUNA | null>) | null;
    recorded?: Awaited<ReturnType<JudgmentEgressStore["recordUsage"]>>;
  } = {},
) {
  const asked: Array<{ tokenHash: Uint8Array }> = [];
  const usage: Array<Parameters<JudgmentEgressStore["recordUsage"]>[0]> = [];
  const sessionCalls: string[] = [];
  const store: JudgmentEgressStore = {
    issueToken: async () => true,
    async authorizeToken(input) {
      asked.push(input);
      return options.authorized ?? OK;
    },
    async recordUsage(input) {
      usage.push(input);
      return options.recorded ?? { outcome: "recorded", costUsd: 0.00006 };
    },
  };
  const work = {
    async authorizeEgressAtomic() {
      sessionCalls.push("authorizeEgressAtomic");
      return { outcome: "invalid_token" };
    },
    async recordProviderUsageAtomic() {
      sessionCalls.push("recordProviderUsageAtomic");
      return { outcome: "unknown_attempt" };
    },
  } as unknown as WorkerUnitOfWork;
  const upstream =
    options.upstream === undefined ? async () => LUNA : options.upstream;
  const instance = createWorkerGateway({
    work,
    catalog,
    checkpoints: acceptAllCheckpoints,
    judgments: {
      store,
      ...(upstream === null ? {} : { upstream }),
    },
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 30_000,
      now: () => NOW,
    },
  });
  return { instance, asked, usage, sessionCalls };
}

describe("judgment requests on the judgment route", () => {
  test("a judgment token is granted the judge's upstream under its judgment, with no session or attempt", async () => {
    const { instance, asked } = harness();
    const grant = await instance.authorizeJudgmentEgress({
      token: "wej_judge",
    });
    expect(grant).toEqual({ judgment_id: JUDGMENT, upstream: LUNA });
    expect(Object.keys(grant)).not.toContain("session_id");
    expect(Object.keys(grant)).not.toContain("attempt_id");
    expect(asked).toEqual([{ tokenHash: hashJudgmentToken("wej_judge") }]);
  });

  test("only a judgment token is asked about; an unknown one is refused", async () => {
    const other = harness();
    await expect(
      other.instance.authorizeJudgmentEgress({ token: "wep_engine" }),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(other.asked).toEqual([]);
    expect(other.sessionCalls).toEqual([]);

    const unknown = harness({ authorized: { outcome: "invalid_token" } });
    await expect(
      unknown.instance.authorizeJudgmentEgress({ token: "wej_gone" }),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  test("a workspace that spent the day's judgment budget gets no call", async () => {
    const { instance } = harness({
      authorized: { ...OK, spentUsd: 1, dailyBudgetUsd: 1 },
    });
    await expect(
      instance.authorizeJudgmentEgress({ token: "wej_judge" }),
    ).rejects.toMatchObject({ status: 403, code: "BUDGET_EXCEEDED" });
  });

  test("without a connection or a way to reach it, the judgment route is unavailable", async () => {
    const noConnection = harness({ authorized: { ...OK, connectionId: null } });
    await expect(
      noConnection.instance.authorizeJudgmentEgress({ token: "wej_judge" }),
    ).rejects.toMatchObject({ status: 503, code: "BACKEND_UNAVAILABLE" });
    const noUpstream = harness({ upstream: null });
    await expect(
      noUpstream.instance.authorizeJudgmentEgress({ token: "wej_judge" }),
    ).rejects.toMatchObject({ status: 503, code: "BACKEND_UNAVAILABLE" });
    const unknown = harness({ upstream: async () => null });
    await expect(
      unknown.instance.authorizeJudgmentEgress({ token: "wej_judge" }),
    ).rejects.toMatchObject({ status: 503, code: "BACKEND_UNAVAILABLE" });
  });

  test("a judgment token is no session egress token on any session route", async () => {
    const { instance, asked } = harness();
    for (const purpose of ["provider", "repository"] as const) {
      await expect(
        instance.authorizeEgress({ token: "wej_judge", purpose }),
      ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    }
    await expect(
      instance.authorizePackagesEgress({ token: "wej_judge", registry: "npm" }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      instance.authorizeObjectAccess({ token: "wej_judge" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(asked).toEqual([]);
  });

  test("a judgment call's use is priced at the judge's rate and lands on the judgment, never on a session", async () => {
    const { instance, usage, sessionCalls } = harness();
    expect(
      await instance.recordJudgmentUsage({
        exchangeId: "8c9d0e1f-2a3b-4c5d-8e6f-7a8b9c0d1e2f",
        judgmentId: JUDGMENT,
        usage: USAGE,
      }),
    ).toEqual({ costUsd: 0.00006, pricedBy: "table" });
    expect(usage).toEqual([
      {
        exchangeId: "8c9d0e1f-2a3b-4c5d-8e6f-7a8b9c0d1e2f",
        judgmentId: JUDGMENT,
        inputTokens: 600,
        costUsd: 0.00006,
      },
    ]);
    expect(sessionCalls).toEqual([]);

    const report = {
      exchangeId: "8c9d0e1f-2a3b-4c5d-8e6f-7a8b9c0d1e2f",
      judgmentId: JUDGMENT,
      usage: USAGE,
    };
    const replayed = harness({
      recorded: { outcome: "replayed", costUsd: 0.00007 },
    });
    expect(await replayed.instance.recordJudgmentUsage(report)).toEqual({
      costUsd: 0.00007,
      pricedBy: "table",
    });
    const gone = harness({ recorded: { outcome: "unknown_judgment" } });
    await expect(
      gone.instance.recordJudgmentUsage(report),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    const other = harness({ recorded: { outcome: "conflict" } });
    await expect(
      other.instance.recordJudgmentUsage(report),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
  });
});
