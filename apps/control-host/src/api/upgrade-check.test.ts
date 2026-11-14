import { describe, expect, test } from "bun:test";
import { createLogger } from "@werft-ai/observability";
import type { UpgradeSession } from "@werft-ai/platform";
import {
  runUpgradeCheck,
  type UpgradeCheckEnvironment,
} from "./upgrade-check.ts";

const current = {
  cliVersion: "2.1.280",
  engine: "claude",
  profileDigestScheme: 1,
  sdkVersion: "0.3.280",
};
const previous = { ...current, cliVersion: "2.1.270", sdkVersion: "0.3.270" };

const environment: UpgradeCheckEnvironment = {
  DATABASE_URL: "postgres://upgrade-check.invalid/db",
  UPGRADE_DEPLOYED_WORKER_IMAGE: "worker@sha256:n",
  UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS: "",
  WORKER_IMAGE: "worker@sha256:n1",
  WORKER_IMAGE_RUNTIME: JSON.stringify(current),
  WORKER_IMAGE_PREVIOUS: "worker@sha256:n",
  WORKER_IMAGE_PREVIOUS_RUNTIME: JSON.stringify(previous),
};

const unrecorded: UpgradeSession = {
  sessionId: "s-unrecorded",
  pointer: { kind: "unrecorded" },
};

const noRuntime = {
  WORKER_IMAGE_RUNTIME: undefined,
  WORKER_IMAGE_PREVIOUS: undefined,
  WORKER_IMAGE_PREVIOUS_RUNTIME: undefined,
};
// What the chart renders on a real cluster with no scheduler Deployment.
const nothingDeployed = {
  ...noRuntime,
  UPGRADE_DEPLOYED_WORKER_IMAGE: "",
  UPGRADE_DEPLOYED_STATE: "absent",
};
// What it renders for a release deployed on one image with no runtime, the
// same values upgraded.
const sameOneImage = {
  ...noRuntime,
  UPGRADE_DEPLOYED_WORKER_IMAGE: "worker@sha256:n1",
  UPGRADE_DEPLOYED_STATE: "unpinned",
};

async function run(
  overrides: Partial<UpgradeCheckEnvironment>,
  listSessions: () => Promise<readonly UpgradeSession[]> = async () => [],
  databaseUnused: () => Promise<boolean> = async () => {
    throw new Error("the database use was read");
  },
) {
  const lines: string[] = [];
  const code = await runUpgradeCheck({
    environment: { ...environment, ...overrides },
    logger: createLogger({ sinks: [{ write() {} }] }),
    listSessions,
    databaseUnused,
    write: (line) => lines.push(line),
  });
  expect(lines).toHaveLength(1);
  return { code, output: JSON.parse(lines[0] as string) };
}

describe("runUpgradeCheck", () => {
  test("no affected session proceeds with exit 0", async () => {
    const { code, output } = await run({});
    expect(code).toBe(0);
    expect(output).toEqual({
      verdict: "proceed",
      deployedWorker: "worker@sha256:n",
      targetWorker: "worker@sha256:n1",
      targetPreviousWorker: "worker@sha256:n",
      affected: [],
      approved: [],
    });
  });

  test("an affected session refuses with exit 2 until UPGRADE_APPROVED_SESSIONS names exactly it", async () => {
    const refused = await run({}, async () => [unrecorded]);
    expect(refused.code).toBe(2);
    expect(refused.output.verdict).toBe("refused");
    expect(refused.output.affected).toEqual([
      { sessionId: "s-unrecorded", reason: "unrecorded" },
    ]);

    const approved = await run(
      { UPGRADE_APPROVED_SESSIONS: '["s-unrecorded"]' },
      async () => [unrecorded],
    );
    expect(approved.code).toBe(0);
    expect(approved.output.approved).toEqual(["s-unrecorded"]);
  });

  test("a target whose previous image is not the deployed one refuses with exit 2", async () => {
    const { code, output } = await run({
      UPGRADE_DEPLOYED_WORKER_IMAGE: "worker@sha256:n-minus-1",
    });
    expect(code).toBe(2);
    expect(output.reason).toContain("is not the deployed one");
  });

  describe("the worker image stays and the deployed previous image goes", () => {
    const dropped = {
      UPGRADE_DEPLOYED_WORKER_IMAGE: "worker@sha256:n1",
      UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS: "worker@sha256:n",
      WORKER_IMAGE_PREVIOUS: undefined,
      WORKER_IMAGE_PREVIOUS_RUNTIME: undefined,
    };
    const sealedOnPrevious: UpgradeSession = {
      sessionId: "s-previous",
      pointer: { kind: "recorded", runtime: previous },
    };

    test("refuses a session sealed on the dropped image until it is approved", async () => {
      const refused = await run(dropped, async () => [sealedOnPrevious]);
      expect(refused.code).toBe(2);
      expect(refused.output.affected).toEqual([
        { sessionId: "s-previous", reason: "no_image" },
      ]);

      const approved = await run(
        { ...dropped, UPGRADE_APPROVED_SESSIONS: '["s-previous"]' },
        async () => [sealedOnPrevious],
      );
      expect(approved.code).toBe(0);
    });

    test("proceeds when no session needs it, and when the previous image is kept", async () => {
      expect((await run(dropped)).code).toBe(0);
      const kept = await run(
        {
          ...dropped,
          WORKER_IMAGE_PREVIOUS: "worker@sha256:n",
          WORKER_IMAGE_PREVIOUS_RUNTIME: JSON.stringify(previous),
        },
        async () => [sealedOnPrevious],
      );
      expect(kept.code).toBe(0);
    });

    test("is check_failed, never proceed, when the deployed previous image is not said", async () => {
      let read = false;
      const { code, output } = await run(
        { ...dropped, UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS: undefined },
        async () => {
          read = true;
          return [sealedOnPrevious];
        },
      );
      expect(code).toBe(1);
      expect(output.verdict).toBe("check_failed");
      expect(output.reason).toContain(
        "UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS is not set",
      );
      expect(read).toBe(false);
    });

    test("is check_failed when the target also drops its runtime", async () => {
      const { code, output } = await run({
        ...dropped,
        WORKER_IMAGE_RUNTIME: undefined,
      });
      expect(code).toBe(1);
      expect(output.reason).toContain("WORKER_IMAGE_RUNTIME is not set");
    });
  });

  test("an unreadable database stops the upgrade with exit 1 and no override", async () => {
    const { code, output } = await run(
      { UPGRADE_APPROVED_SESSIONS: '["s-unrecorded"]' },
      async () => {
        throw new Error("connect ECONNREFUSED");
      },
    );
    expect(code).toBe(1);
    expect(output.verdict).toBe("check_failed");
    expect(output.reason).toContain("ECONNREFUSED");
  });

  test.each([
    [
      "an empty deployed image (helm template, --dry-run)",
      { UPGRADE_DEPLOYED_WORKER_IMAGE: "" },
      "could not be read",
    ],
    [
      "no target runtime",
      {
        WORKER_IMAGE_RUNTIME: undefined,
        WORKER_IMAGE_PREVIOUS_RUNTIME: undefined,
      },
      "WORKER_IMAGE_RUNTIME is not set",
    ],
    [
      "a malformed target runtime",
      { WORKER_IMAGE_RUNTIME: "{" },
      "WORKER_IMAGE_RUNTIME",
    ],
    [
      "a previous image without its runtime",
      { WORKER_IMAGE_PREVIOUS_RUNTIME: undefined },
      "go together",
    ],
    [
      "approvals that are not a list of ids",
      { UPGRADE_APPROVED_SESSIONS: '"s-1"' },
      "JSON array of session ids",
    ],
    ["no database url", { DATABASE_URL: undefined }, "DATABASE_URL"],
    [
      "a list of images, which it cannot judge",
      { WORKER_IMAGES: "[]" },
      "WORKER_IMAGES is set",
    ],
  ])("%s is check_failed with exit 1", async (_, overrides, reason) => {
    let read = false;
    const { code, output } = await run(overrides, async () => {
      read = true;
      return [];
    });
    expect(code).toBe(1);
    expect(output.verdict).toBe("check_failed");
    expect(output.reason).toContain(reason);
    expect(read).toBe(false);
  });

  describe("a release with no scheduler Deployment", () => {
    test("proceeds on an unused database, needing no runtime", async () => {
      const { code, output } = await run(
        nothingDeployed,
        async () => {
          throw new Error("sessions were read");
        },
        async () => true,
      );
      expect(code).toBe(0);
      expect(output).toEqual({
        verdict: "proceed",
        deployedWorker: null,
        targetWorker: "worker@sha256:n1",
        targetPreviousWorker: null,
        affected: [],
        approved: [],
      });
    });

    test("is check_failed on a database something used, even with sessions approved", async () => {
      const { code, output } = await run(
        { ...nothingDeployed, UPGRADE_APPROVED_SESSIONS: '["s-1"]' },
        async () => [],
        async () => false,
      );
      expect(code).toBe(1);
      expect(output.verdict).toBe("check_failed");
      expect(output.reason).toContain("the database has been used");
    });

    test("is check_failed when the database cannot be read", async () => {
      const { code, output } = await run(
        nothingDeployed,
        async () => [],
        async () => {
          throw new Error("connect ECONNREFUSED");
        },
      );
      expect(code).toBe(1);
      expect(output.verdict).toBe("check_failed");
      expect(output.reason).toContain("ECONNREFUSED");
    });

    test("refuses an approval left in the values", async () => {
      const { code, output } = await run(
        { ...nothingDeployed, UPGRADE_APPROVED_SESSIONS: '["s-1"]' },
        async () => [],
        async () => true,
      );
      expect(code).toBe(2);
      expect(output.verdict).toBe("refused");
      expect(output.reason).toContain("must be empty");
    });

    test.each([
      ["with a previous image and no runtime", { WORKER_IMAGE_PREVIOUS: "w" }],
      ["with a malformed runtime", { WORKER_IMAGE_RUNTIME: "{" }],
    ])("is check_failed %s", async (_, overrides) => {
      const { code, output } = await run(
        { ...nothingDeployed, ...overrides },
        async () => [],
        async () => true,
      );
      expect(code).toBe(1);
      expect(output.verdict).toBe("check_failed");
    });
  });

  test.each([
    ["no state, as `helm template` renders", ""],
    ["no state, as an older chart renders", undefined],
    ["a state that does not say absent", "unpinned"],
  ])("an empty deployed image with %s is check_failed", async (_, state) => {
    const { code, output } = await run(
      { ...nothingDeployed, UPGRADE_DEPLOYED_STATE: state },
      async () => [],
      async () => true,
    );
    expect(code).toBe(1);
    expect(output.reason).toContain("could not be read");
  });

  describe("no target runtime", () => {
    test("proceeds when one image stays and none was pinned", async () => {
      const { code, output } = await run(sameOneImage);
      expect(code).toBe(0);
      expect(output).toEqual({
        verdict: "proceed",
        deployedWorker: "worker@sha256:n1",
        targetWorker: "worker@sha256:n1",
        targetPreviousWorker: null,
        affected: [],
        approved: [],
      });
    });

    test("still reads the database, which stops it when unreadable", async () => {
      const { code, output } = await run(sameOneImage, async () => {
        throw new Error("connect ECONNREFUSED");
      });
      expect(code).toBe(1);
      expect(output.reason).toContain("ECONNREFUSED");
    });

    test("refuses an approval left in the values", async () => {
      const { code, output } = await run({
        ...sameOneImage,
        UPGRADE_APPROVED_SESSIONS: '["s-1"]',
      });
      expect(code).toBe(2);
      expect(output.reason).toContain("must be empty");
    });

    test.each([
      [
        "the worker image changes",
        { ...sameOneImage, WORKER_IMAGE: "worker@sha256:n2" },
      ],
      [
        "the deployed release had a runtime or previous image to drop",
        { ...sameOneImage, UPGRADE_DEPLOYED_STATE: "" },
      ],
      [
        "the chart says nothing about the deployed release",
        { ...sameOneImage, UPGRADE_DEPLOYED_STATE: undefined },
      ],
      [
        "the target keeps a previous image",
        { ...sameOneImage, WORKER_IMAGE_PREVIOUS: "worker@sha256:n" },
      ],
    ])("is check_failed when %s", async (_, overrides) => {
      const { code, output } = await run(overrides);
      expect(code).toBe(1);
      expect(output.verdict).toBe("check_failed");
      expect(output.reason).toContain("WORKER_IMAGE_RUNTIME is not set");
    });
  });
});
