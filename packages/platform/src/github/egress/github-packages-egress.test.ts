import { describe, expect, test } from "bun:test";
import type {
  GitHubPackageFetchRecord,
  GitHubPackagesSessionState,
  GitHubPackagesStore,
} from "../ports/github-packages.ts";
import { createGitHubPackagesEgress } from "./github-packages-egress.ts";

const BOT = "fake-bot-credential-for-tests";
const AGENT = "00000000-0000-4000-8000-0000000000aa";

function stateOf(
  overrides: Partial<GitHubPackagesSessionState>,
): GitHubPackagesSessionState {
  return {
    ownerId: "ws-1",
    workspaceId: "ws-1",
    agentId: AGENT,
    releaseId: "rel-1",
    actor: null,
    token: { value: BOT, expiresAt: null },
    allowlist: [
      {
        registry: "npm",
        owner: "acme",
        name: "*",
        repository_id: null,
        agent_id: null,
      },
      {
        registry: "rubygems",
        owner: "acme",
        name: "acme-auth",
        repository_id: "billing",
        agent_id: null,
      },
    ],
    ...overrides,
  };
}

function harness(
  overrides: Partial<GitHubPackagesSessionState> | null,
  recordFetch?: () => Promise<void>,
) {
  const recorded: GitHubPackageFetchRecord[] = [];
  const store = {
    sessionState: async () => (overrides === null ? null : stateOf(overrides)),
    recordFetch:
      recordFetch ??
      (async (record: GitHubPackageFetchRecord) => {
        recorded.push(record);
      }),
  } as unknown as GitHubPackagesStore;
  const decide = createGitHubPackagesEgress({
    store,
    upstreams: { npm: "http://fake-npm.test" },
    now: () => new Date("2026-11-01T00:00:00Z"),
  });
  return { decide, recorded };
}

const ask = {
  sessionId: "sess-1",
  attemptId: "att-1",
  repositoryId: null,
  regrant: false,
};

describe("GitHub Packages egress", () => {
  test("an allowed read gets the bot token and leaves a succeeded receipt", async () => {
    const { decide, recorded } = harness({});
    const decision = await decide({
      ...ask,
      registry: "npm",
      path: "/download/@acme/ui/1.2.3/abcdef01",
    });
    expect(decision).toEqual({
      kind: "granted",
      upstream: {
        url: "http://fake-npm.test",
        headers: [["authorization", `Bearer ${BOT}`]],
      },
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      ownerId: "ws-1",
      sessionId: "sess-1",
      status: "succeeded",
      result: {
        attempt_id: "att-1",
        agent_id: AGENT,
        registry: "npm",
        owner: "acme",
        package: "ui",
        version: "1.2.3",
        reason_code: null,
      },
    });
    expect(JSON.stringify(recorded)).not.toContain(BOT);
  });

  test("each refusal names its reason on a failed receipt and hands out nothing", async () => {
    const cases = [
      {
        state: { token: null },
        path: "/@acme%2fui",
        reason: "token_not_configured",
      },
      {
        state: {
          token: { value: BOT, expiresAt: new Date("2026-10-31T00:00:00Z") },
        },
        path: "/@acme%2fui",
        reason: "token_expired",
      },
      { state: {}, path: "/-/whoami", reason: "path_not_recognized" },
      { state: {}, path: "/@other%2fui", reason: "package_not_allowed" },
    ] as const;
    for (const { state, path, reason } of cases) {
      const { decide, recorded } = harness(state);
      const decision = await decide({ ...ask, registry: "npm", path });
      expect(decision).toEqual({
        kind: "refused",
        reason,
        receiptId: recorded[0]?.id ?? "missing",
      });
      expect(recorded[0]).toMatchObject({
        status: "failed",
        result: { reason_code: reason },
      });
    }
  });

  test("an entry narrowed to a repository allows only that repository's sessions", async () => {
    const path = "/acme/gems/acme-auth-1.0.0.gem";
    const elsewhere = harness({});
    expect(
      (await elsewhere.decide({ ...ask, registry: "rubygems", path })).kind,
    ).toBe("refused");
    const billing = harness({});
    expect(
      await billing.decide({
        ...ask,
        repositoryId: "billing",
        registry: "rubygems",
        path,
      }),
    ).toMatchObject({
      kind: "granted",
      upstream: { url: "https://rubygems.pkg.github.com" },
    });
    expect(billing.recorded[0]?.result).toMatchObject({
      repository_id: "billing",
      package: "acme-auth",
      version: "1.0.0",
    });
  });

  test("a regrant is judged again but not recorded again", async () => {
    const { decide, recorded } = harness({});
    const decision = await decide({
      ...ask,
      regrant: true,
      registry: "npm",
      path: "/@acme%2fui",
    });
    expect(decision.kind).toBe("granted");
    expect(recorded).toHaveLength(0);
  });

  test("a session that is gone is refused without a receipt", async () => {
    const { decide, recorded } = harness(null);
    expect(
      await decide({ ...ask, registry: "npm", path: "/@acme%2fui" }),
    ).toEqual({
      kind: "refused",
      reason: "token_not_configured",
      receiptId: null,
    });
    expect(recorded).toHaveLength(0);
  });

  test("a receipt that cannot be written refuses the fetch", async () => {
    const { decide } = harness({}, async () => {
      throw new Error("db down");
    });
    await expect(
      decide({ ...ask, registry: "npm", path: "/@acme%2fui" }),
    ).rejects.toThrow("db down");
  });
});
