import { expect, test } from "bun:test";
import { protectedCommitsRequestSchema } from "./index.ts";

const scope = {
  session_id: "00000000-0000-4000-8000-000000000001",
  turn_id: "1",
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 1,
};

// The control plane remembers which workspace bundles it verified. A worker
// asks for the protected commits and has no field to say what verified.
test("a protected-commits request is the worker's fence and nothing else: it cannot carry a verdict, a key or a digest", () => {
  expect(protectedCommitsRequestSchema.safeParse(scope).success).toBe(true);
  for (const extra of [
    { verdict: "restorable" },
    { verdict_key: "0".repeat(64) },
    { bundle_sha256: "0".repeat(64) },
    { verified_revisions: [0, 1] },
  ]) {
    expect(
      protectedCommitsRequestSchema.safeParse({ ...scope, ...extra }).success,
    ).toBe(false);
  }
});
