import { describe, expect, test } from "bun:test";
import { APPROVAL_CHECKPOINT_FAILURE_VALUES } from "../api/event.ts";
import { registerPendingRequestSchema } from "./index.ts";

const body = (extra: Record<string, unknown> = {}) => ({
  session_id: "00000000-0000-4000-8000-000000000001",
  turn_id: "1",
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 1,
  request_id: "req_1",
  input_hash: "a".repeat(64),
  request: { kind: "permission", tool: "Bash", input: { command: "ls" } },
  ...extra,
});
const checkpoint = {
  revision: 0,
  manifest_ref: "sessions/s/checkpoints/0000000000/att_1/m/manifest.json",
  manifest_sha256: "c".repeat(64),
  answers_through: 0,
};

describe("registerPendingRequestSchema checkpoint_failure", () => {
  test("a body without either field still parses, as older workers send it", () => {
    expect(registerPendingRequestSchema.safeParse(body()).success).toBe(true);
  });

  test("carries each failure reason through", () => {
    for (const reason of APPROVAL_CHECKPOINT_FAILURE_VALUES) {
      expect(
        registerPendingRequestSchema.parse(body({ checkpoint_failure: reason }))
          .checkpoint_failure,
      ).toBe(reason);
    }
  });

  test("refuses an unknown reason", () => {
    expect(
      registerPendingRequestSchema.safeParse(
        body({ checkpoint_failure: "publish_failed" }),
      ).success,
    ).toBe(false);
  });

  test("refuses a checkpoint and a failure together", () => {
    expect(
      registerPendingRequestSchema.safeParse(body({ checkpoint })).success,
    ).toBe(true);
    expect(
      registerPendingRequestSchema.safeParse(
        body({ checkpoint, checkpoint_failure: "capture_failed" }),
      ).success,
    ).toBe(false);
  });
});
