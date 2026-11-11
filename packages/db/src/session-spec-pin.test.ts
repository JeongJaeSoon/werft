import { describe, expect, test } from "bun:test";
import type { SpecSource } from "@werft-ai/contracts";
import { releaseSpecRecord, verifyReleaseSpec } from "@werft-ai/platform";
import { sessionPinFromRelease } from "./session-spec-pin.ts";

const source: SpecSource = {
  derivation_version: 2,
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
};

const stored = (override: Partial<SpecSource> = {}) => {
  const record = releaseSpecRecord({ ...source, ...override });
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
      const pin = sessionPinFromRelease(release, model);
      expect(pin?.specDigest).toBe(release.spec_digest);
      expect(pin?.specSourceDigest).toBe(release.spec_source_digest);
    }
  });

  test("swaps only the model, keeps the connection, and verifies as the release does", () => {
    const release = stored();
    const pin = sessionPinFromRelease(release, "sonnet-5-1");
    expect(pin).not.toBeNull();
    expect(pin?.specSource.model).toBe("sonnet-5-1");
    expect(pin?.runtimeSpec.model).toBe("sonnet-5-1");
    expect(pin?.specSource.connection).toEqual(source.connection);
    expect(pin?.specDigest).not.toBe(release.spec_digest);
    expect(
      verifyReleaseSpec({
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
    expect(sessionPinFromRelease(empty, "sonnet-5-1")).toBeNull();
    const tampered = { ...stored(), spec_digest: "0".repeat(64) };
    expect(sessionPinFromRelease(tampered, "sonnet-5-1")).toBeNull();
    // A source from before the connection-only derivation does not parse.
    const old = {
      ...stored(),
      spec_source: { ...stored().spec_source, derivation_version: 1 },
    };
    expect(sessionPinFromRelease(old, "sonnet-5-1")).toBeNull();
  });
});
