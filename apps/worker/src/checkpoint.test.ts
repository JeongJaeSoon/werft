import { describe, expect, test } from "bun:test";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import { unwiredCheckpoints } from "./testing/unwired-checkpoints.ts";

describe("unwiredCheckpoints", () => {
  test("refuses a restore", async () => {
    const claim = await new FakeWorkerGateway().bootstrapClaim({
      execution_id: "execution-1",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: "nonce" },
    });
    const signal = new AbortController().signal;
    expect(await unwiredCheckpoints.restorePlan(claim, signal)).toEqual({
      mode: "new",
    });
    await expect(
      unwiredCheckpoints.restorePlan(
        {
          ...claim,
          restore: {
            revision: 2,
            manifest_ref: "checkpoints/2.json",
            manifest_sha256: "b".repeat(64),
          },
        },
        signal,
      ),
    ).rejects.toThrow("no restorer bound");
  });
});
