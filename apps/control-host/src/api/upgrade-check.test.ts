import { describe, expect, test } from "bun:test";
import { createLogger } from "@werft-ai/observability";
import type { UpgradeImage, UpgradeSession } from "@werft-ai/platform";
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
  UPGRADE_DEPLOYED_WORKER_GATEWAY_URL: "http://werft-api-internal:3200",
  WORKER_GATEWAY_URL: "http://werft-api-internal:3200",
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
  listWriters: () => Promise<readonly UpgradeImage[]> = async () => [],
  listWorkers: () => Promise<readonly string[]> = async () => [],
) {
  const lines: string[] = [];
  const code = await runUpgradeCheck({
    environment: { ...environment, ...overrides },
    logger: createLogger({ sinks: [{ write() {} }] }),
    listSessions,
    listWriters,
    listWorkers,
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

  test("a target that keeps no image restoring what the deployed one seals refuses with exit 2", async () => {
    const { code, output } = await run({
      UPGRADE_DEPLOYED_WORKER_IMAGE: "worker@sha256:n-minus-1",
    });
    expect(code).toBe(2);
    expect(output.reason).toContain(
      "workers on worker@sha256:n-minus-1, the deployed newest image",
    );

    // Declared, its runtime is judged instead of its digest.
    const declared = await run({
      UPGRADE_DEPLOYED_WORKER_IMAGE: "worker@sha256:n-minus-1",
      UPGRADE_DEPLOYED_WORKER_IMAGE_RUNTIME: JSON.stringify(previous),
    });
    expect(declared.code).toBe(0);
  });

  test("a live launch the target cannot restore refuses with exit 2, approved or not", async () => {
    const dropped = {
      UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS: "worker@sha256:n-minus-1",
      UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS_RUNTIME: JSON.stringify({
        ...current,
        sdkVersion: "0.3.260",
      }),
      UPGRADE_APPROVED_SESSIONS: '["s-unrecorded"]',
    };
    const writer = async () => [
      { image: "worker@sha256:n-minus-1", runtime: null },
    ];
    const listed = async () => [unrecorded];
    const refused = await run(dropped, listed, undefined, writer);
    expect(refused.code).toBe(2);
    expect(refused.output.reason).toContain(
      "workers on worker@sha256:n-minus-1 still hold a slot",
    );
    expect((await run(dropped, listed)).code).toBe(0);
  });

  describe("workers holding a slot", () => {
    // The chart that moved the gateway to a port of its own, control-host
    // first: the worker image stays, and the address workers are given moves.
    const gatewayMoves = {
      UPGRADE_DEPLOYED_WORKER_IMAGE: "worker@sha256:n",
      UPGRADE_DEPLOYED_WORKER_IMAGE_RUNTIME: JSON.stringify(previous),
      WORKER_IMAGE: "worker@sha256:n",
      WORKER_IMAGE_RUNTIME: JSON.stringify(previous),
      WORKER_IMAGE_PREVIOUS: undefined,
      WORKER_IMAGE_PREVIOUS_RUNTIME: undefined,
      UPGRADE_DEPLOYED_WORKER_GATEWAY_URL: "http://werft-api:3000",
      WORKER_GATEWAY_URL: "http://werft-api-internal:3200",
    };
    const holding = async () => ["s-worker"];
    const check = (overrides: Partial<UpgradeCheckEnvironment>) =>
      run(overrides, undefined, undefined, undefined, holding);

    test("are listed when the target gives workers another gateway address, and refuse until approved exactly", async () => {
      const refused = await check(gatewayMoves);
      expect(refused.code).toBe(2);
      expect(refused.output.verdict).toBe("refused");
      expect(refused.output.affected).toEqual([
        { sessionId: "s-worker", reason: "worker_ends" },
      ]);
      expect(refused.output.reason).toContain(
        "1 worker(s) holding a slot end with this upgrade",
      );

      const approved = await check({
        ...gatewayMoves,
        UPGRADE_APPROVED_SESSIONS: '["s-worker"]',
      });
      expect(approved.code).toBe(0);
      expect(approved.output.affected).toEqual([
        { sessionId: "s-worker", reason: "worker_ends" },
      ]);
    });

    test("are listed on an install with one image and no runtime, where nothing else is compared", async () => {
      const { code, output } = await check({
        ...sameOneImage,
        UPGRADE_DEPLOYED_WORKER_GATEWAY_URL: "http://werft-api:3000",
      });
      expect(code).toBe(2);
      expect(output.affected).toEqual([
        { sessionId: "s-worker", reason: "worker_ends" },
      ]);
      expect(output.reason).toStartWith(
        "the worker image does not change, but",
      );
    });

    test("are not listed when the gateway address stays, however it is spelled", async () => {
      for (const address of [
        "http://werft-api-internal:3200",
        "http://werft-api-internal:3200/",
      ]) {
        const { code, output } = await check({
          ...gatewayMoves,
          UPGRADE_DEPLOYED_WORKER_GATEWAY_URL: address,
        });
        expect(code).toBe(0);
        expect(output.verdict).toBe("proceed");
        expect(output.affected).toEqual([]);
      }
    });

    test("stop the upgrade with exit 1 when either gateway address is missing or not a URL", async () => {
      for (const [overrides, reason] of [
        [
          { UPGRADE_DEPLOYED_WORKER_GATEWAY_URL: "" },
          "UPGRADE_DEPLOYED_WORKER_GATEWAY_URL is not set",
        ],
        [
          { UPGRADE_DEPLOYED_WORKER_GATEWAY_URL: undefined },
          "UPGRADE_DEPLOYED_WORKER_GATEWAY_URL is not set",
        ],
        [{ WORKER_GATEWAY_URL: undefined }, "WORKER_GATEWAY_URL is not set"],
        [
          { WORKER_GATEWAY_URL: "werft-api-internal" },
          "WORKER_GATEWAY_URL is not a URL",
        ],
      ] as const) {
        const { code, output } = await check({ ...gatewayMoves, ...overrides });
        expect(code).toBe(1);
        expect(output.verdict).toBe("check_failed");
        expect(output.reason).toStartWith(reason);
      }
    });

    test("a worker list that cannot be read stops the upgrade with exit 1", async () => {
      const { code, output } = await run(
        gatewayMoves,
        undefined,
        undefined,
        undefined,
        async () => {
          throw new Error("connect ECONNREFUSED");
        },
      );
      expect(code).toBe(1);
      expect(output.reason).toContain("ECONNREFUSED");
    });
  });

  test("a launch list that cannot be read stops the upgrade with exit 1", async () => {
    const { code, output } = await run({}, undefined, undefined, async () => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(code).toBe(1);
    expect(output.reason).toContain("ECONNREFUSED");
  });

  describe("image lists", () => {
    const list = (...images: [string, typeof current, string][]) =>
      JSON.stringify(
        images.map(([image, runtime, released_at]) => ({
          image,
          runtime,
          released_at,
        })),
      );
    const digest = (hex: string) => `worker@sha256:${hex.repeat(64)}`;
    const target = {
      WORKER_IMAGE: undefined,
      WORKER_IMAGE_RUNTIME: undefined,
      WORKER_IMAGE_PREVIOUS: undefined,
      WORKER_IMAGE_PREVIOUS_RUNTIME: undefined,
      WORKER_IMAGES: list(
        [digest("b"), current, "2026-11-15T00:00:00Z"],
        [digest("a"), previous, "2026-11-01T00:00:00Z"],
      ),
    };
    const deployedList = {
      UPGRADE_DEPLOYED_WORKER_IMAGE: "",
      UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS: undefined,
      UPGRADE_DEPLOYED_WORKER_IMAGES: list([
        digest("a"),
        previous,
        "2026-11-01T00:00:00Z",
      ]),
    };

    test("a target list is judged like the single-image settings", async () => {
      const deployed = { UPGRADE_DEPLOYED_WORKER_IMAGE: digest("a") };
      const kept = await run({ ...target, ...deployed });
      expect(kept.code).toBe(0);
      expect(kept.output).toMatchObject({
        targetWorker: digest("b"),
        targetPreviousWorker: digest("a"),
        deployedWorker: digest("a"),
      });
      const refused = await run({ ...target, ...deployed }, async () => [
        unrecorded,
      ]);
      expect(refused.code).toBe(2);
      expect(refused.output.affected).toEqual([
        { sessionId: "s-unrecorded", reason: "unrecorded" },
      ]);
    });

    test("a deployed list, read from the running scheduler, gives the same verdicts", async () => {
      expect((await run({ ...target, ...deployedList })).code).toBe(0);
      const dropped = await run({
        ...deployedList,
        WORKER_IMAGE: "worker@sha256:n1",
        WORKER_IMAGE_PREVIOUS: undefined,
        WORKER_IMAGE_PREVIOUS_RUNTIME: undefined,
      });
      expect(dropped.code).toBe(2);
      expect(dropped.output.reason).toContain(`workers on ${digest("a")}`);
    });

    test("a retraction in either list reaches the judgement and the report", async () => {
      const retracting = {
        ...target,
        ...deployedList,
        WORKER_IMAGES: JSON.stringify([
          {
            image: digest("b"),
            runtime: current,
            released_at: "2026-11-15T00:00:00Z",
          },
          {
            image: digest("a"),
            runtime: previous,
            released_at: "2026-11-01T00:00:00Z",
            retracted: true,
          },
        ]),
      };
      const refused = await run(retracting);
      expect(refused.code).toBe(2);
      expect(refused.output).toMatchObject({
        deployedWorker: digest("a"),
        targetWorker: digest("b"),
        targetPreviousWorker: null,
      });
      expect(refused.output.reason).toContain(
        "no unretracted target image restores them",
      );
      // Deployed retracted, the target lists its fixed build: nothing seals
      // on the retracted image, and its sessions resume on the fix.
      const fixed = await run({
        ...target,
        UPGRADE_DEPLOYED_WORKER_IMAGE: "",
        UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS: undefined,
        UPGRADE_DEPLOYED_WORKER_IMAGES: JSON.stringify([
          {
            image: digest("c"),
            runtime: previous,
            released_at: "2026-10-01T00:00:00Z",
            retracted: true,
          },
        ]),
      });
      expect(fixed.code).toBe(0);
      expect(fixed.output.deployedWorker).toBeNull();
    });

    test.each([
      [
        "a list beside the single-image settings",
        { WORKER_IMAGES: target.WORKER_IMAGES },
        "WORKER_IMAGES replaces",
      ],
      [
        "a malformed deployed list",
        { ...deployedList, UPGRADE_DEPLOYED_WORKER_IMAGES: "[]" },
        "UPGRADE_DEPLOYED_WORKER_IMAGES:",
      ],
      [
        "a deployed list beside a deployed image",
        { ...deployedList, UPGRADE_DEPLOYED_WORKER_IMAGE: "worker@sha256:n" },
        "both set",
      ],
      [
        "a malformed deployed runtime",
        { UPGRADE_DEPLOYED_WORKER_IMAGE_RUNTIME: "{" },
        "UPGRADE_DEPLOYED_WORKER_IMAGE_RUNTIME:",
      ],
    ])("%s is check_failed with exit 1", async (_, overrides, reason) => {
      const { code, output } = await run(overrides);
      expect(code).toBe(1);
      expect(output.reason).toContain(reason);
    });
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
    test("proceeds on an unused database, needing no runtime and no gateway address", async () => {
      const { code, output } = await run(
        {
          ...nothingDeployed,
          UPGRADE_DEPLOYED_WORKER_GATEWAY_URL: "",
          WORKER_GATEWAY_URL: undefined,
        },
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
