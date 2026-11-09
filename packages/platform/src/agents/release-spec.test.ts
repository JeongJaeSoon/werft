import { describe, expect, test } from "bun:test";
import { type AgentCard, agentCardSchema } from "@werft-ai/contracts";
import {
  type CatalogProfile,
  profileFingerprintV1,
  runtimeConfigOf,
} from "../sessions/catalog.ts";
import {
  cardContentSha256,
  deriveReleaseId,
  type ReleaseIdentity,
  resolveReleaseContent,
} from "./release-ids.ts";
import {
  backfillReleaseSpecs,
  buildSpecSource,
  releaseSpecRecord,
  runtimeConfigFromSpec,
  verifyReleaseSpec,
} from "./release-spec.ts";

const profile: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Grep", "Edit", "Bash"],
  permission_mode: "bypassPermissions",
  mcp_deny: ["mcp__docs__write"],
  provider: {
    kind: "litellm",
    endpoint: "http://litellm.internal:4000",
    billing: "none",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};

const card: AgentCard = agentCardSchema.parse({
  role: "재무 분석가",
  instructions: "분기 보고서를 읽고 이상치를 요약한다.",
  model: "claude-sonnet-5",
  capabilities: { mcp: null, forbidden: [] },
});

function releaseOf(against: CatalogProfile = profile) {
  const resolved = resolveReleaseContent(card, "coding", against);
  if (!resolved.ok) throw new Error(resolved.error.message);
  const identity: ReleaseIdentity = {
    agent_id: "019a0000-0000-7000-8000-0000000000a1",
    card_sha256: cardContentSha256(card),
    repository_id: null,
    ...resolved.content,
  };
  return { ...identity, id: deriveReleaseId(identity) };
}

function sourceOf(against: CatalogProfile = profile) {
  const built = buildSpecSource({
    release: releaseOf(against),
    profile: against,
    connectionId: "conn-1",
  });
  if (!built.ok) throw new Error(built.reason);
  return built.source;
}

describe("buildSpecSource", () => {
  test("keeps the raw inputs the release ran with", () => {
    const release = releaseOf();
    const source = sourceOf();
    expect(source).toMatchObject({
      origin: "profile",
      release_id: release.id,
      release_id_version: 2,
      profile_id: "coding",
      profile_digest: release.profile_digest,
      runtime: { kind: "claude_agent_sdk", version: "0.3.270" },
      connection: {
        id: "conn-1",
        kind: "litellm",
        endpoint: "http://litellm.internal:4000",
        billing: "none",
      },
      model: "claude-sonnet-5",
      permission_mode: "bypassPermissions",
      tools: ["Read", "Grep", "Edit", "Bash"],
      mcp_deny: ["mcp__docs__write"],
      repository_mode: "required",
    });
    expect(releaseSpecRecord(source).runtime_spec.execution_mode).toBe(
      "bypass",
    );
  });

  test("a billing the profile leaves out is per_token", () => {
    const { billing: _billing, ...provider } = profile.provider;
    const plain: CatalogProfile = {
      ...profile,
      provider: { ...provider, endpoint: "https://gateway.example.test" },
    };
    expect(sourceOf(plain).connection.billing).toBe("per_token");
  });

  // A profile edited after the release says nothing about what it ran.
  test("a profile that no longer fingerprints to the release's digest gets no source", () => {
    const edited: CatalogProfile = { ...profile, tools: ["Read"] };
    expect(
      buildSpecSource({
        release: releaseOf(),
        profile: edited,
        connectionId: "conn-1",
      }),
    ).toEqual({ ok: false, reason: "profile_changed" });
  });

  // The fingerprint leaves the repository mode out, so the source takes the
  // profile's mode as of the backfill, which is what sessions are held to now.
  test("the repository mode is the profile's current one", () => {
    const optional: CatalogProfile = { ...profile, repository: "optional" };
    expect(sourceOf(optional).repository_mode).toBe("optional");
  });

  // The policy paths run such a release today, so it must get a spec.
  test("a release that names a repository still gets a source under none", () => {
    const none: CatalogProfile = { ...profile, repository: "none" };
    const built = buildSpecSource({
      release: { ...releaseOf(none), repository_id: "repo-1" },
      profile: none,
      connectionId: "conn-1",
    });
    expect(built.ok && built.source.repository_mode).toBe("none");
  });

  // The engine moved on and the old one stays accepted: such a release runs
  // today, and its source names the engine it was cut under.
  test("a release cut under an older accepted runtime version gets a source", () => {
    const older = releaseOf();
    const upgraded: CatalogProfile = { ...profile, runtime_version: "0.3.280" };
    const input = {
      release: older,
      profile: upgraded,
      connectionId: "conn-1",
    };
    expect(buildSpecSource(input)).toEqual({
      ok: false,
      reason: "profile_changed",
    });
    const built = buildSpecSource({
      ...input,
      acceptedVersions: ["0.3.270", "0.3.280"],
    });
    expect(built.ok && built.source.runtime.version).toBe("0.3.270");
  });

  test("a release whose digest is a version 1 fingerprint gets a source", () => {
    const legacy = {
      ...releaseOf(),
      profile_digest: profileFingerprintV1(profile),
    };
    const built = buildSpecSource({
      release: legacy,
      profile,
      connectionId: "conn-1",
    });
    expect(built.ok && built.source.profile_digest).toBe(legacy.profile_digest);
  });

  test("a provider that matches no connection gets no source", () => {
    expect(
      buildSpecSource({
        release: releaseOf(),
        profile,
        connectionId: null,
      }),
    ).toEqual({ ok: false, reason: "connection_missing" });
  });
});

describe("verifyReleaseSpec", () => {
  const stored = () => releaseSpecRecord(sourceOf());

  test("a record made from a source verifies", () => {
    const record = stored();
    const verdict = verifyReleaseSpec(record.spec_source.release_id, record);
    expect(verdict.ok).toBe(true);
    expect(record.spec_source_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.spec_digest).not.toBe(record.spec_source_digest);
  });

  test.each([
    [
      "a spec that is not what the source derives",
      (r: ReturnType<typeof stored>) => ({
        ...r,
        runtime_spec: { ...r.runtime_spec, execution_mode: "auto" },
      }),
    ],
    [
      "a source digest that does not hold",
      (r: ReturnType<typeof stored>) => ({
        ...r,
        spec_source_digest: `sha256:${"0".repeat(64)}`,
      }),
    ],
    [
      "a spec digest that does not hold",
      (r: ReturnType<typeof stored>) => ({
        ...r,
        spec_digest: `sha256:${"0".repeat(64)}`,
      }),
    ],
    [
      "a source that does not parse",
      (r: ReturnType<typeof stored>) => ({
        ...r,
        spec_source: { ...r.spec_source, secret: "x" },
      }),
    ],
  ])("refuses %s", (_name, tamper) => {
    const record = stored();
    expect(
      verifyReleaseSpec(record.spec_source.release_id, tamper(record)).ok,
    ).toBe(false);
  });

  test("refuses a source made for another release", () => {
    const record = stored();
    expect(verifyReleaseSpec("sha256:other", record).ok).toBe(false);
  });
});

describe("backfillReleaseSpecs", () => {
  // An in-memory store with the same rules as the table: pending is the
  // releases with no record, by id; save writes only over none.
  function memoryStore(releases: ReturnType<typeof releaseOf>[]) {
    const saved = new Map<string, unknown>();
    return {
      saved,
      pending: async (after: string | null, limit: number) =>
        releases
          .filter((r) => !saved.has(r.id) && (after === null || r.id > after))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, limit),
      save: async (id: string, record: unknown) => {
        if (saved.has(id)) return false;
        saved.set(id, record);
        return true;
      },
    };
  }

  const other: CatalogProfile = { ...profile, tools: ["Read"] };

  test("stores what it can derive, lists the rest, and a second run changes nothing", async () => {
    const ok = releaseOf();
    const gone = releaseOf(other);
    const store = memoryStore([ok, gone]);
    // `gone` was cut from a profile that has since changed to this one.
    const resolve = () => ({ profile, connectionId: "conn-1" });
    const first = await backfillReleaseSpecs(store, resolve, 1);
    expect(first.stored).toBe(1);
    expect(first.skipped).toEqual([
      { release_id: gone.id, reason: "profile_changed" },
    ]);
    expect(store.saved.has(ok.id)).toBe(true);
    const second = await backfillReleaseSpecs(store, resolve, 1);
    expect(second).toEqual({
      stored: 0,
      raced: 0,
      skipped: [{ release_id: gone.id, reason: "profile_changed" }],
    });
  });

  test("a release whose profile is gone is listed, and a lost race is counted", async () => {
    const release = releaseOf();
    const store = memoryStore([release]);
    expect((await backfillReleaseSpecs(store, () => null)).skipped).toEqual([
      { release_id: release.id, reason: "profile_gone" },
    ]);
    const racing = {
      ...store,
      save: async () => false,
    };
    expect(
      (
        await backfillReleaseSpecs(racing, () => ({
          profile,
          connectionId: "conn-1",
        }))
      ).raced,
    ).toBe(1);
  });
});

describe("runtimeConfigFromSpec", () => {
  // Where the two modes agree with the engine's own, the config is the one a
  // profile makes; only a mode the spec folds into `auto` differs.
  test.each(["bypassPermissions", "auto"] as const)(
    "is what runtimeConfigOf makes for a %s profile",
    (permission_mode) => {
      const against: CatalogProfile = {
        ...profile,
        permission_mode,
        project_settings: { claude_md: true },
      };
      const spec = releaseSpecRecord(sourceOf(against)).runtime_spec;
      for (const hasRepository of [true, false]) {
        expect(
          runtimeConfigFromSpec(spec, "egress-token", hasRepository),
        ).toEqual(runtimeConfigOf(against, "egress-token", hasRepository));
      }
    },
  );

  test("a mode the spec folds into auto runs as auto", () => {
    const against: CatalogProfile = { ...profile, permission_mode: "plan" };
    const spec = releaseSpecRecord(sourceOf(against)).runtime_spec;
    expect(runtimeConfigFromSpec(spec, "t", false).permission_mode).toBe(
      "auto",
    );
  });

  test("carries no credential but the egress token", () => {
    const config = runtimeConfigFromSpec(
      releaseSpecRecord(sourceOf()).runtime_spec,
      "egress-token",
      true,
    );
    expect(config.provider.auth).toEqual({
      kind: "egress_token",
      token: "egress-token",
    });
    expect(JSON.stringify(config)).not.toContain("catalog-provider-key");
  });
});
