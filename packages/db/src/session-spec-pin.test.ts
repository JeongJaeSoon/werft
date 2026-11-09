import { describe, expect, test } from "bun:test";
import { releaseSpecRecord, verifyReleaseSpec } from "@werft-ai/platform";
import { sessionPinFromRelease } from "./session-spec-pin.ts";

const source = {
  derivation_version: 1,
  origin: "agent",
  release_id: "rel-1",
  release_id_version: 5,
  profile_id: "p",
  profile_digest: "digest",
  runtime: { kind: "claude_agent_sdk", version: "0.3.270" },
  connection: {
    id: "conn-1",
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    billing: "per_token",
  },
  model: "sonnet-5-0",
  permission_mode: "default",
  tools: ["Read"],
  repository_mode: "none",
} as const;

const stored = (override?: Partial<typeof source>) => {
  const record = releaseSpecRecord({ ...source, ...override } as never);
  return {
    spec_source: record.spec_source,
    runtime_spec: record.runtime_spec,
    spec_source_digest: record.spec_source_digest,
    spec_digest: record.spec_digest,
  };
};

describe("sessionPinFromRelease", () => {
  test("keeps the release's pair when the model is the same or unknown", () => {
    const release = stored();
    for (const model of [null, "sonnet-5-0"]) {
      const pin = sessionPinFromRelease("rel-1", release, model);
      expect(pin?.specDigest).toBe(release.spec_digest);
      expect(pin?.specSourceDigest).toBe(release.spec_source_digest);
    }
  });

  test("swaps only the model, still names the release, and verifies as the release does", () => {
    const release = stored();
    const pin = sessionPinFromRelease("rel-1", release, "sonnet-5-1");
    expect(pin).not.toBeNull();
    expect(pin?.specSource.model).toBe("sonnet-5-1");
    expect(pin?.runtimeSpec.model).toBe("sonnet-5-1");
    expect(pin?.specSource.release_id).toBe("rel-1");
    expect(pin?.specDigest).not.toBe(release.spec_digest);
    expect(
      verifyReleaseSpec("rel-1", {
        spec_source: pin?.specSource,
        runtime_spec: pin?.runtimeSpec,
        spec_source_digest: pin?.specSourceDigest,
        spec_digest: pin?.specDigest,
      }).ok,
    ).toBe(true);
    // The release's own pair is untouched.
    expect(release.spec_source.model).toBe("sonnet-5-0");
  });

  test("leaves a session unpinned when the release has no verified spec", () => {
    const empty = {
      spec_source: null,
      runtime_spec: null,
      spec_source_digest: null,
      spec_digest: null,
    };
    expect(sessionPinFromRelease("rel-1", empty, "sonnet-5-1")).toBeNull();
    const tampered = { ...stored(), spec_digest: "0".repeat(64) };
    expect(sessionPinFromRelease("rel-1", tampered, "sonnet-5-1")).toBeNull();
    expect(sessionPinFromRelease("rel-2", stored(), "sonnet-5-1")).toBeNull();
  });
});
