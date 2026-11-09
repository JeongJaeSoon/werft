import { describe, expect, test } from "bun:test";
import {
  type CatalogProfile,
  profileFingerprint,
  profileWithModel,
  sessionProfile,
} from "./catalog.ts";

const profile: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "fixture-one",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};

const PIN =
  "sha256:4a6521dca081535c61beba67569e43f79104afa33edf73f5f8705c786494db57";

describe("profile fingerprints without storage", () => {
  test.each<{ name: string; change: Partial<CatalogProfile> }>([
    { name: "the original settings", change: {} },
    {
      name: "a rotated credential behind the same reference",
      change: {
        provider: {
          ...profile.provider,
          auth: {
            kind: "api_key",
            value: "fixture-two",
            ref: { value_env: "PROVIDER_KEY" },
          },
        },
      },
    },
    { name: "an expanded model menu", change: { models: ["claude-opus-5-5"] } },
    { name: "another selected model", change: { model: "claude-opus-5-5" } },
  ])("$name keeps the literal pin", ({ change }) => {
    expect(profileFingerprint({ ...profile, ...change })).toBe(PIN);
  });

  test.each<{ name: string; change: Partial<CatalogProfile> }>([
    { name: "tools", change: { tools: ["Read", "Bash"] } },
    { name: "permission mode", change: { permission_mode: "acceptEdits" } },
    { name: "runtime version", change: { runtime_version: "0.3.319" } },
    {
      name: "credential reference",
      change: {
        provider: {
          ...profile.provider,
          auth: {
            kind: "api_key",
            value: "fixture-one",
            ref: { value_env: "OTHER_KEY" },
          },
        },
      },
    },
  ])("changing $name refuses the old pin", ({ change }) => {
    expect(
      sessionProfile(
        { ...profile, ...change },
        { fingerprint: PIN, model: "claude-sonnet-5" },
        [],
      ),
    ).toBeNull();
  });

  test("an omitted model defaults to the profile model, without its menu", () => {
    expect(
      profileWithModel<CatalogProfile>({
        ...profile,
        models: ["claude-opus-5-5"],
      }),
    ).toEqual(profile);
  });

  test.each<[string, CatalogProfile, string]>([
    [
      "a menu without the requested model",
      { ...profile, models: ["claude-opus-5-5"] },
      "claude-fable-5-1",
    ],
    ["a profile without a menu", profile, "claude-opus-5-5"],
  ])("%s refuses an unoffered model", (_name, offered, model) => {
    expect(profileWithModel(offered, model)).toBeNull();
  });

  test("an accepted earlier runtime version still holds a stored pin", () => {
    expect(
      sessionProfile(
        { ...profile, runtime_version: "0.3.319" },
        { fingerprint: PIN, model: "claude-sonnet-5" },
        ["0.3.270"],
      )?.runtime_version,
    ).toBe("0.3.319");
  });
});
