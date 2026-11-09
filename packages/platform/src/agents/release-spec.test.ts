import { describe, expect, test } from "bun:test";
import { type AgentCard, agentCardSchema } from "@werft-ai/contracts";
import type { CatalogProfile } from "../sessions/catalog.ts";
import {
  cardContentSha256,
  deriveReleaseId,
  type ReleaseIdentity,
  resolveReleaseContent,
} from "./release-ids.ts";
import {
  buildSpecSource,
  releaseSpecRecord,
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
