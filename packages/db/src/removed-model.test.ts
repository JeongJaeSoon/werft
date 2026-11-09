import { describe, expect, test } from "bun:test";
import type { RunnablePair } from "@werft-ai/platform";
import { removedModelOf } from "./worker-unit-of-work.ts";

type Session = Parameters<typeof removedModelOf>[0];

const session = (over: Partial<Session> = {}): Session => ({
  profileId: "p",
  profileFingerprint: "fp-v2",
  model: "model-a",
  repositoryMode: "none",
  repositoryId: null,
  repoUrl: null,
  branch: null,
  githubPolicySource: "agent",
  ...over,
});

const pair = (model: string | null, fingerprint: string): RunnablePair => ({
  profileId: "p",
  profileFingerprint: fingerprint,
  model,
  repositoryId: null,
});

describe("removedModelOf", () => {
  test("names the model when the profile still lists others but not it", () => {
    // Version 2 pairs: one per listed model, one fingerprint; version 1 pairs
    // carry no model and one fingerprint per listed model.
    const pairs = [pair("model-b", "fp-v2"), pair(null, "fp-v1-model-b")];
    expect(removedModelOf(session(), pairs)).toBe("model-a");
    // A version 1 pin names its model in the fingerprint, which no pair holds
    // after the removal; the model still reads as removed.
    expect(
      removedModelOf(session({ profileFingerprint: "fp-v1-model-a" }), pairs),
    ).toBe("model-a");
  });

  test("says nothing while the model is listed, or when the row names none", () => {
    const pairs = [pair("model-a", "fp-v2"), pair("model-b", "fp-v2")];
    expect(removedModelOf(session(), pairs)).toBeNull();
    // Settings changed but the model stayed: the general reason stands.
    expect(
      removedModelOf(session({ profileFingerprint: "other" }), pairs),
    ).toBeNull();
    expect(removedModelOf(session({ model: null }), pairs)).toBeNull();
  });

  test("says nothing when the profile is not offered at all", () => {
    expect(removedModelOf(session(), [])).toBeNull();
    expect(
      removedModelOf(session({ profileId: "gone" }), [
        pair("model-b", "fp-v2"),
      ]),
    ).toBeNull();
  });
});
