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
  test.each(["NOT_FOUND", "OUTRANKED", "ACTOR_INACTIVE"] as const)(
    "%s",
    (factory) => {
      const original = originals[factory]();
      const shared = factories[factory]();
      expect(shared).toBeInstanceOf(SessionServiceError);
      expect(digest(shared)).toBe(digest(original));
      expect(shared).not.toBe(factories[factory]());
    },
  );
});
