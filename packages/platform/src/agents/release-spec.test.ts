import { describe, expect, test } from "bun:test";
import { type AgentCard, agentCardSchema } from "@werft-ai/contracts";
import { testConnection } from "../testing/catalog-fakes.ts";
import {
  cardContentSha256,
  deriveReleaseId,
  type ReleaseIdentity,
  type ReleaseRun,
  resolveReleaseContent,
} from "./release-ids.ts";
import {
  buildSpecSource,
  releaseSpecRecord,
  runtimeConfigOfSpec,
  specWithModel,
  verifyReleaseSpec,
} from "./release-spec.ts";

const connection = testConnection({
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
  models: ["claude-sonnet-5", "claude-opus-5"],
});

const run: ReleaseRun = {
  connection_id: "conn-1",
  connection,
  runtime: { kind: "claude_agent_sdk", version: "0.3.270" },
  tools: ["Read", "Grep", "Edit", "Bash"],
  permission_mode: "auto",
  project_settings: { claude_md: true },
};

const card: AgentCard = agentCardSchema.parse({
  role: "재무 분석가",
  instructions: "분기 보고서를 읽고 이상치를 요약한다.",
  model: "claude-sonnet-5",
  capabilities: { mcp: null, forbidden: [] },
});

function releaseOf(against: ReleaseRun = run) {
  const resolved = resolveReleaseContent(card, against);
  if (!resolved.ok) throw new Error(resolved.error.message);
  const identity: ReleaseIdentity = {
    agent_id: "019a0000-0000-7000-8000-0000000000a1",
    card_sha256: cardContentSha256(card),
    repository_id: null,
    ...resolved.content,
  };
  return { ...identity, id: deriveReleaseId(identity) };
}

function sourceOf(against: ReleaseRun = run) {
  const built = buildSpecSource({
    release: releaseOf(against),
    connection: against.connection,
  });
  if (!built.ok) throw new Error(built.message);
  return built.source;
}

describe("buildSpecSource", () => {
  test("keeps the run the release was made with, and no release id", () => {
    const source = sourceOf();
    expect(source).toEqual({
      derivation_version: 2,
      runtime: { kind: "claude_agent_sdk", version: "0.3.270" },
      connection: {
        id: "conn-1",
        kind: "litellm",
        endpoint: "http://litellm.internal:4000",
        billing: "none",
      },
      model: "claude-sonnet-5",
      permission_mode: "auto",
      tools: ["Read", "Grep", "Edit", "Bash"],
      project_settings: { claude_md: true },
      repository_mode: "optional",
    });
    expect(JSON.stringify(source)).not.toContain("catalog-provider-key");
    expect(releaseSpecRecord(source).runtime_spec.execution_mode).toBe("auto");
  });

  test("a billing the connection leaves out is per_token", () => {
    const { billing: _billing, ...provider } = connection.provider;
    const plain = {
      ...run,
      connection: {
        ...connection,
        provider: { ...provider, endpoint: "https://gateway.example.test" },
      },
    };
    expect(sourceOf(plain).connection.billing).toBe("per_token");
  });

  test("a repository the release names does not change the mode", () => {
    const built = buildSpecSource({
      release: { ...releaseOf(), repository_id: "repo-1" } as never,
      connection,
    });
    expect(built.ok && built.source.repository_mode).toBe("optional");
  });

  test("a snapshot that does not make a source is refused with why", () => {
    const release = releaseOf();
    const built = buildSpecSource({
      release: {
        ...release,
        runtime_config_snapshot: {
          ...release.runtime_config_snapshot,
          runtime: undefined,
        },
      },
      connection,
    });
    expect(built.ok).toBe(false);
    expect(!built.ok && built.reason).toBe("invalid_source");
    expect(!built.ok && built.message).toContain("runtime");
  });
});

describe("verifyReleaseSpec", () => {
  const stored = () => releaseSpecRecord(sourceOf());

  test("a record made from a source verifies, as it is stored", () => {
    const record = stored();
    const verdict = verifyReleaseSpec(record);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.record).toEqual(record);
    expect(record.spec_source_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.spec_digest).not.toBe(record.spec_source_digest);
  });

  test.each([
    [
      "a spec that is not what the source derives",
      (r: ReturnType<typeof stored>) => ({
        ...r,
        runtime_spec: { ...r.runtime_spec, execution_mode: "bypass" },
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
    [
      "a source of the profile era, which named its release",
      (r: ReturnType<typeof stored>) => ({
        ...r,
        spec_source: { ...r.spec_source, release_id: "sha256:x" },
      }),
    ],
  ])("refuses %s", (_name, tamper) => {
    expect(verifyReleaseSpec(tamper(stored())).ok).toBe(false);
  });
});

describe("specWithModel", () => {
  test("another model is another spec; the same model is the same source", () => {
    const source = sourceOf();
    expect(specWithModel(source, source.model)).toBe(source);
    const moved = specWithModel(source, "claude-opus-5");
    expect(moved).toEqual({ ...source, model: "claude-opus-5" });
    expect(releaseSpecRecord(moved).spec_digest).not.toBe(
      releaseSpecRecord(source).spec_digest,
    );
  });
});

describe("runtimeConfigOfSpec", () => {
  test("runs the source's model, tools and mode over its connection", () => {
    const config = runtimeConfigOfSpec(sourceOf(), "egress-token", true);
    expect(config).toEqual({
      model: "claude-sonnet-5",
      tools: ["Read", "Grep", "Edit", "Bash"],
      permission_mode: "auto",
      provider: {
        kind: "litellm",
        endpoint: "http://litellm.internal:4000",
        auth: { kind: "egress_token", token: "egress-token" },
      },
      project_settings: { claude_md: true },
    });
  });

  test("a session without a repository reads no CLAUDE.md", () => {
    expect(
      runtimeConfigOfSpec(sourceOf(), "t", false).project_settings,
    ).toBeUndefined();
  });

  test("carries no credential but the egress token", () => {
    const config = runtimeConfigOfSpec(sourceOf(), "egress-token", true);
    expect(JSON.stringify(config)).not.toContain("catalog-provider-key");
  });
});
