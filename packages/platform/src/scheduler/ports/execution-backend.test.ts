import { describe, expect, test } from "bun:test";
import {
  launchSpecFingerprint,
  parseExecutionResources,
} from "./execution-backend.ts";

const IMAGE = `worker@sha256:${"a".repeat(64)}`;
const RESOURCES = { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 };
const LIMITS = { maxTurnSeconds: 600, providerMaxRetries: 2 };

describe("launchSpecFingerprint", () => {
  test("a launch reserved before the worker limits were pinned keeps the spec its label carries", () => {
    // launch-spec/v1 of these values, as hosts before the pin labelled it.
    expect(launchSpecFingerprint(IMAGE, RESOURCES)).toBe(
      new Bun.CryptoHasher("sha256")
        .update(
          JSON.stringify([
            "launch-spec/v1",
            IMAGE,
            RESOURCES.cpus,
            RESOURCES.memoryBytes,
            RESOURCES.pidsLimit,
          ]),
        )
        .digest("hex"),
    );
  });

  test("the pinned limits are part of the spec", () => {
    const pinned = launchSpecFingerprint(IMAGE, {
      ...RESOURCES,
      workerLimits: LIMITS,
    });
    expect(pinned).not.toBe(launchSpecFingerprint(IMAGE, RESOURCES));
    expect(
      launchSpecFingerprint(IMAGE, {
        ...RESOURCES,
        workerLimits: { ...LIMITS, maxTurnSeconds: 1200 },
      }),
    ).not.toBe(pinned);
    expect(
      launchSpecFingerprint(IMAGE, {
        ...RESOURCES,
        workerLimits: { ...LIMITS, providerMaxRetries: 3 },
      }),
    ).not.toBe(pinned);
  });
});

describe("parseExecutionResources", () => {
  test("reads a row with pinned limits, and one from before them", () => {
    expect(
      parseExecutionResources({ ...RESOURCES, workerLimits: LIMITS }),
    ).toEqual({ ...RESOURCES, workerLimits: LIMITS });
    expect(parseExecutionResources(RESOURCES)).toEqual(RESOURCES);
  });

  test("refuses limits no worker would start with", () => {
    for (const workerLimits of [
      null,
      "600",
      { maxTurnSeconds: 0, providerMaxRetries: 2 },
      { maxTurnSeconds: 1.5, providerMaxRetries: 2 },
      { maxTurnSeconds: 600, providerMaxRetries: -1 },
      { maxTurnSeconds: 600 },
    ]) {
      expect(() =>
        parseExecutionResources({ ...RESOURCES, workerLimits }),
      ).toThrow("workerLimits");
    }
  });
});
