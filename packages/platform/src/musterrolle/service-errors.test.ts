import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ACTOR_INACTIVE,
  NOT_FOUND,
  OUTRANKED,
  SessionServiceError,
} from "./service-errors.ts";

const digest = (error: SessionServiceError) =>
  createHash("sha256")
    .update(JSON.stringify([error.name, error.message, error]))
    .digest("hex");

const factories = { NOT_FOUND, OUTRANKED, ACTOR_INACTIVE };

const originals = {
  NOT_FOUND: () => new SessionServiceError("NOT_FOUND", "Resource not found"),
  OUTRANKED: () =>
    new SessionServiceError(
      "FORBIDDEN",
      "The caller no longer holds this right",
      undefined,
      { reason_code: "role" },
    ),
  ACTOR_INACTIVE: () =>
    new SessionServiceError(
      "FORBIDDEN",
      "This principal is no longer a member of the workspace",
    ),
};

describe("shared service error compatibility", () => {
  test.each([
    ["agent-admin-service.ts", "NOT_FOUND"],
    ["agent-identity-service.ts", "NOT_FOUND"],
    ["agent-identity-service.ts", "OUTRANKED"],
    ["agent-identity-service.ts", "ACTOR_INACTIVE"],
    ["api-key-service.ts", "NOT_FOUND"],
    ["api-key-service.ts", "OUTRANKED"],
    ["api-key-service.ts", "ACTOR_INACTIVE"],
    ["credential-binding-service.ts", "NOT_FOUND"],
    ["credential-binding-service.ts", "OUTRANKED"],
    ["credential-binding-service.ts", "ACTOR_INACTIVE"],
    ["session-share-service.ts", "NOT_FOUND"],
    ["slack-app-service.ts", "NOT_FOUND"],
    ["slack-app-service.ts", "ACTOR_INACTIVE"],
    ["slack-app-service.ts", "OUTRANKED"],
    ["slack-install-service.ts", "NOT_FOUND"],
    ["slack-link-app-service.ts", "NOT_FOUND"],
    ["slack-link-app-service.ts", "ACTOR_INACTIVE"],
    ["slack-link-app-service.ts", "OUTRANKED"],
    ["slack-secret-service.ts", "ACTOR_INACTIVE"],
    ["slack-secret-service.ts", "OUTRANKED"],
    ["slack-secret-service.ts", "NOT_FOUND"],
    ["team-service.ts", "NOT_FOUND"],
    ["agent-service.ts", "NOT_FOUND"],
    ["agent-service.ts", "ACTOR_INACTIVE"],
  ] as const)("%s %s", (_site, factory) => {
    const original = originals[factory]();
    const shared = factories[factory]();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(factories[factory]());
  });
});
