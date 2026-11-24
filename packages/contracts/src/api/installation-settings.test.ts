import { describe, expect, test } from "bun:test";
import { CONNECTION_KIND_VALUES } from "../shared/provider-kind.ts";
import { createSettingsConnectionRequestSchema } from "./installation-settings.ts";

// A connection is the installation's own key for a provider API: an API key,
// or a bearer token for its own LiteLLM gateway. A claude.ai login or a
// subscription's credential has no field to arrive in.
const valid = {
  id: "console",
  kind: "anthropic",
  auth_kind: "api_key",
  value: "example-key",
};

describe("creating a connection takes only the installation's API key", () => {
  test("the kinds are the four provider APIs, and no other", () => {
    expect([...CONNECTION_KIND_VALUES]).toEqual([
      "anthropic",
      "litellm",
      "openai_responses",
      "openai_decisions",
    ]);
  });

  test("the request takes an API key or a bearer token for every kind; the catalog holds each kind to its own", () => {
    for (const kind of CONNECTION_KIND_VALUES) {
      for (const auth_kind of ["api_key", "bearer"]) {
        expect(
          createSettingsConnectionRequestSchema.safeParse({
            ...valid,
            kind,
            auth_kind,
          }).success,
        ).toBe(true);
      }
    }
  });

  test("a login or subscription credential kind is refused", () => {
    for (const auth_kind of [
      "oauth",
      "subscription",
      "claude_ai",
      "session",
      "setup_token",
    ]) {
      expect(
        createSettingsConnectionRequestSchema.safeParse({ ...valid, auth_kind })
          .success,
      ).toBe(false);
    }
  });

  test("a connection kind outside the list is refused", () => {
    for (const kind of ["claude_ai", "claude_code", "bedrock", "vertex"]) {
      expect(
        createSettingsConnectionRequestSchema.safeParse({ ...valid, kind })
          .success,
      ).toBe(false);
    }
  });

  test("no field carries a login, an OAuth token or a subscription", () => {
    for (const field of [
      "oauth_token",
      "refresh_token",
      "session_key",
      "subscription",
      "login",
    ]) {
      expect(
        createSettingsConnectionRequestSchema.safeParse({
          ...valid,
          [field]: "example",
        }).success,
      ).toBe(false);
    }
  });
});
