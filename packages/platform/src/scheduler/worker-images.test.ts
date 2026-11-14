import { describe, expect, test } from "bun:test";
import {
  canRestoreCheckpoint,
  configuredImageRuntimesFromEnv,
  runtimeVersionsOf,
  sameCombination,
  selectWorkerImage,
  type WorkerImagesEnvironment,
  workerImageListFromEnv,
  workerImageRuntimesFromEnv,
} from "./worker-images.ts";

const current = {
  cliVersion: "2.1.280",
  engine: "claude",
  profileDigestScheme: 1,
  sdkVersion: "0.3.280",
};
const previous = { ...current, cliVersion: "2.1.270", sdkVersion: "0.3.270" };

describe("workerImageRuntimesFromEnv", () => {
  test("nothing configured is no images", () => {
    expect(workerImageRuntimesFromEnv({})).toBeNull();
    expect(workerImageRuntimesFromEnv({ WORKER_IMAGE_RUNTIME: "" })).toBeNull();
  });

  test("reads the current image and, when given, the previous one", () => {
    expect(
      workerImageRuntimesFromEnv({
        WORKER_IMAGE_RUNTIME: JSON.stringify(current),
      }),
    ).toEqual({ current, previous: null });
    expect(
      workerImageRuntimesFromEnv({
        WORKER_IMAGE_RUNTIME: JSON.stringify(current),
        // An image built before the catalog dropped profiles still
        // carries the field; it is read past.
        WORKER_IMAGE_PREVIOUS_RUNTIME: JSON.stringify({
          ...previous,
          profiles: {},
        }),
      }),
    ).toEqual({ current, previous });
  });

  test("refuses a previous image alone and names a setting it cannot read", () => {
    expect(() =>
      workerImageRuntimesFromEnv({
        WORKER_IMAGE_PREVIOUS_RUNTIME: JSON.stringify(previous),
      }),
    ).toThrow("needs WORKER_IMAGE_RUNTIME");
    expect(() =>
      workerImageRuntimesFromEnv({ WORKER_IMAGE_RUNTIME: "0.3.280" }),
    ).toThrow("WORKER_IMAGE_RUNTIME: image runtime");
    expect(() =>
      workerImageRuntimesFromEnv({
        WORKER_IMAGE_RUNTIME: JSON.stringify(current),
        WORKER_IMAGE_PREVIOUS_RUNTIME: "{}",
      }),
    ).toThrow("WORKER_IMAGE_PREVIOUS_RUNTIME: image runtime");
  });
});

describe("workerImageListFromEnv", () => {
  const NEW = `ghcr.io/x/worker@sha256:${"a".repeat(64)}`;
  const OLD = `ghcr.io/x/worker@sha256:${"b".repeat(64)}`;
  const entry = (
    image: string,
    runtime: object,
    released_at: string,
    extra: object = {},
  ) => ({ image, runtime, released_at, ...extra });
  const list = (...entries: unknown[]) => ({
    WORKER_IMAGES: JSON.stringify(entries),
  });

  test("unset leaves the single-image settings in charge", () => {
    expect(workerImageListFromEnv({})).toBeNull();
    expect(workerImageListFromEnv({ WORKER_IMAGES: "" })).toBeNull();
  });

  test("reads the images newest first, each with its runtime", () => {
    expect(
      workerImageListFromEnv(
        list(
          entry(NEW, current, "2026-11-10T00:00:00Z"),
          entry(
            OLD,
            { ...previous, profiles: {} },
            "2026-10-01T09:00:00+09:00",
          ),
        ),
      ),
    ).toEqual([
      { image: NEW, runtime: current, retracted: false },
      { image: OLD, runtime: previous, retracted: false },
    ]);
  });

  test("a retracted image stays listed and leaves room for its fix; every image retracted still reads", () => {
    const FIX = `ghcr.io/x/worker@sha256:${"c".repeat(64)}`;
    expect(
      workerImageListFromEnv(
        list(
          entry(FIX, previous, "2026-11-12T00:00:00Z"),
          entry(NEW, current, "2026-11-10T00:00:00Z"),
          entry(OLD, previous, "2026-10-01T00:00:00Z", { retracted: true }),
        ),
      )?.map(({ image, retracted }) => [image, retracted]),
    ).toEqual([
      [FIX, false],
      [NEW, false],
      [OLD, true],
    ]);
    expect(
      workerImageListFromEnv(
        list(entry(NEW, current, "2026-11-10T00:00:00Z", { retracted: true })),
      )?.[0].retracted,
    ).toBe(true);
    expect(
      configuredImageRuntimesFromEnv(
        list(
          entry(NEW, current, "2026-11-10T00:00:00Z", { retracted: true }),
          entry(OLD, previous, "2026-10-01T00:00:00Z"),
        ),
      ),
    ).toEqual([previous, current]);
  });

  test.each<[string, WorkerImagesEnvironment, string]>([
    ["not JSON", { WORKER_IMAGES: "[" }, "is not JSON"],
    ["empty", list(), "non-empty JSON array"],
    ["an object", { WORKER_IMAGES: "{}" }, "non-empty JSON array"],
    ["a string entry", list(NEW), "WORKER_IMAGES[0] must be a JSON object"],
    [
      "an unknown field",
      list(entry(NEW, current, "2026-11-10T00:00:00Z", { pinned: true })),
      "WORKER_IMAGES[0] has unknown field(s): pinned",
    ],
    [
      "retracted as text",
      list(entry(NEW, current, "2026-11-10T00:00:00Z", { retracted: "yes" })),
      "WORKER_IMAGES[0].retracted must be true or false",
    ],
    [
      "a tag",
      list(entry("ghcr.io/x/worker:1.2", current, "2026-11-10T00:00:00Z")),
      "WORKER_IMAGES[0].image must be pinned by digest",
    ],
    [
      "one image twice",
      list(
        entry(NEW, current, "2026-11-10T00:00:00Z"),
        entry(NEW, previous, "2026-10-01T00:00:00Z"),
      ),
      "WORKER_IMAGES[1].image sha256:aaaa",
    ],
    [
      "one digest under two names",
      list(
        entry(NEW, current, "2026-11-10T00:00:00Z"),
        entry(
          `mirror.local:5000/x/worker@sha256:${"a".repeat(64)}`,
          previous,
          "2026-10-01T00:00:00Z",
        ),
      ),
      "WORKER_IMAGES[1].image sha256:aaaa",
    ],
    ...[
      `https://ghcr.io/x/worker@sha256:${"a".repeat(64)}`,
      `ghcr.io/X/Worker@sha256:${"a".repeat(64)}`,
      `ghcr.io/x/worker:1.2@sha256:${"a".repeat(64)}`,
      `ghcr.io/x/worker@sha256:${"A".repeat(64)}`,
    ].map((image): [string, WorkerImagesEnvironment, string] => [
      `the reference ${image.slice(0, 28)}…`,
      list(entry(image, current, "2026-11-10T00:00:00Z")),
      "WORKER_IMAGES[0].image must be pinned by digest",
    ]),
    ...[
      "2026-02-30T00:00:00Z",
      "2026-11-10T24:00:00Z",
      "2026-11-10T00:60:00Z",
      "2026-11-10T00:00:00+24:00",
    ].map((at): [string, WorkerImagesEnvironment, string] => [
      `the time ${at}, which no calendar has`,
      list(entry(NEW, current, at)),
      "WORKER_IMAGES[0].released_at must be an ISO 8601 time",
    ]),
    [
      "a runtime as text",
      list(
        entry(NEW, JSON.stringify(current) as never, "2026-11-10T00:00:00Z"),
      ),
      "WORKER_IMAGES[0].runtime must be a JSON object",
    ],
    [
      "a runtime it cannot read",
      list(entry(NEW, { engine: "claude" }, "2026-11-10T00:00:00Z")),
      "WORKER_IMAGES[0].runtime: image runtime",
    ],
    [
      "a date without a time",
      list(entry(NEW, current, "2026-11-10")),
      "WORKER_IMAGES[0].released_at must be an ISO 8601 time",
    ],
    [
      "no release time",
      list({ image: NEW, runtime: current }),
      "WORKER_IMAGES[0].released_at must be an ISO 8601 time",
    ],
    [
      "the older image first",
      list(
        entry(OLD, previous, "2026-10-01T00:00:00Z"),
        entry(NEW, current, "2026-11-10T00:00:00Z"),
      ),
      "WORKER_IMAGES[1].released_at 2026-11-10T00:00:00Z is not before 2026-10-01T00:00:00Z",
    ],
    [
      "the same instant in two zones",
      list(
        entry(NEW, current, "2026-11-10T09:00:00+09:00"),
        entry(OLD, previous, "2026-11-10T00:00:00Z"),
      ),
      "WORKER_IMAGES[1].released_at",
    ],
    [
      "an engine's older image first, past another engine's",
      list(
        entry(OLD, { ...previous, engine: "codex" }, "2026-10-01T00:00:00Z"),
        entry(NEW, current, "2026-11-10T00:00:00Z"),
        entry(
          `ghcr.io/x/worker@sha256:${"c".repeat(64)}`,
          { ...current, engine: "codex" },
          "2026-11-12T00:00:00Z",
        ),
      ),
      "WORKER_IMAGES[2].released_at 2026-11-12T00:00:00Z is not before 2026-10-01T00:00:00Z of the codex image above it",
    ],
    [
      "three images of one engine beside another's",
      list(
        entry(NEW, current, "2026-11-10T00:00:00Z"),
        ...["c", "d", "e"].map((digit, index) =>
          entry(
            `ghcr.io/x/worker@sha256:${digit.repeat(64)}`,
            { ...current, engine: "codex" },
            `2026-11-0${3 - index}T00:00:00Z`,
          ),
        ),
      ),
      "lists 3 unretracted codex images: at most 2",
    ],
    [
      "three images of one engine",
      list(
        entry(NEW, current, "2026-11-10T00:00:00Z"),
        entry(OLD, previous, "2026-10-01T00:00:00Z"),
        entry(
          `ghcr.io/x/worker@sha256:${"c".repeat(64)}`,
          previous,
          "2026-09-01T00:00:00Z",
        ),
      ),
      "lists 3 unretracted claude images: at most 2",
    ],
  ])("refuses %s", (_, environment, message) => {
    expect(() => workerImageListFromEnv(environment)).toThrow(message);
  });

  test("two engines list two images each, ordered within each engine only", () => {
    const codexNew = { ...current, engine: "codex" };
    const codexOld = { ...previous, engine: "codex" };
    const image = (digit: string) =>
      `ghcr.io/x/worker@sha256:${digit.repeat(64)}`;
    expect(
      workerImageListFromEnv(
        list(
          entry(image("c"), codexNew, "2026-11-10T00:00:00Z"),
          // The same instant as the codex image above: another engine's.
          entry(NEW, current, "2026-11-10T00:00:00Z"),
          entry(image("d"), codexOld, "2026-10-20T00:00:00Z"),
          entry(OLD, previous, "2026-11-01T00:00:00Z"),
        ),
      ),
    ).toEqual([
      { image: image("c"), runtime: codexNew, retracted: false },
      { image: NEW, runtime: current, retracted: false },
      { image: image("d"), runtime: codexOld, retracted: false },
      { image: OLD, runtime: previous, retracted: false },
    ]);
  });

  test("refuses the single-image settings beside it", () => {
    for (const name of [
      "WORKER_IMAGE",
      "WORKER_IMAGE_RUNTIME",
      "WORKER_IMAGE_PREVIOUS",
      "WORKER_IMAGE_PREVIOUS_RUNTIME",
    ]) {
      expect(() =>
        workerImageListFromEnv({
          ...list(entry(NEW, current, "2026-11-10T00:00:00Z")),
          [name]: "x",
        }),
      ).toThrow(`WORKER_IMAGES replaces ${name}`);
    }
  });

  test("its runtimes, or the single-image ones, are the configured runtimes", () => {
    expect(
      configuredImageRuntimesFromEnv(
        list(
          entry(NEW, current, "2026-11-10T00:00:00Z"),
          entry(OLD, previous, "2026-10-01T00:00:00Z"),
        ),
      ),
    ).toEqual([current, previous]);
    expect(
      configuredImageRuntimesFromEnv({
        WORKER_IMAGE_RUNTIME: JSON.stringify(current),
        WORKER_IMAGE_PREVIOUS_RUNTIME: JSON.stringify(previous),
      }),
    ).toEqual([current, previous]);
    expect(
      configuredImageRuntimesFromEnv({
        WORKER_IMAGE_RUNTIME: JSON.stringify(current),
      }),
    ).toEqual([current]);
    expect(configuredImageRuntimesFromEnv({})).toBeNull();
  });
});

test("pins take any listed image's versions, under the kinds of its engine only", () => {
  const kinds = [
    { kind: "claude_agent_sdk", checkpointEngine: "claude" },
    { kind: "codex_app_server", checkpointEngine: "codex" },
  ];
  const claude = (version: string) => ({
    kind: "claude_agent_sdk",
    engine: "claude",
    version,
  });
  expect(runtimeVersionsOf([current, previous], kinds)).toEqual({
    accepted: [
      claude("0.3.280"),
      claude("2.1.280"),
      claude("0.3.270"),
      claude("2.1.270"),
    ],
  });
  const codex = { ...previous, engine: "codex" };
  expect(runtimeVersionsOf([current, codex], kinds)).toEqual({
    accepted: [
      claude("0.3.280"),
      claude("2.1.280"),
      { kind: "codex_app_server", engine: "codex", version: "0.3.270" },
      { kind: "codex_app_server", engine: "codex", version: "2.1.270" },
    ],
  });
  expect(
    runtimeVersionsOf(
      [current],
      [{ kind: "codex_app_server", checkpointEngine: "codex" }],
    ),
  ).toEqual({ accepted: [] });
});

describe("selectWorkerImage", () => {
  const images = [
    { image: "worker@sha256:new", runtime: current },
    { image: "worker@sha256:old", runtime: previous },
  ] as const;

  test("a session with no checkpoint, or one whose pointer predates the record, runs on the current image", () => {
    for (const pointer of [{ kind: "none" }, { kind: "unrecorded" }] as const) {
      expect(selectWorkerImage(pointer, images)).toEqual({
        kind: "selected",
        image: "worker@sha256:new",
        runtime: current,
      });
    }
  });

  test("a checkpoint sealed on the previous image resumes on it", () => {
    expect(
      selectWorkerImage({ kind: "recorded", runtime: previous }, images),
    ).toEqual({
      kind: "selected",
      image: "worker@sha256:old",
      runtime: previous,
    });
  });

  test("of two images with the same combination, the newest wins", () => {
    expect(
      selectWorkerImage({ kind: "recorded", runtime: current }, [
        { image: "worker@sha256:rebuilt", runtime: current },
        { image: "worker@sha256:new", runtime: { ...current } },
      ]),
    ).toMatchObject({ kind: "selected", image: "worker@sha256:rebuilt" });
  });

  test("a different digest scheme is not the same combination", () => {
    const outcome = selectWorkerImage(
      { kind: "recorded", runtime: { ...current, profileDigestScheme: 2 } },
      images,
    );
    expect(outcome).toMatchObject({
      kind: "none",
      reason: "incompatible_checkpoint",
    });
    expect(outcome.kind === "none" && outcome.detail).toContain(
      "digest scheme 2",
    );
  });

  describe("an image that resumes an earlier digest scheme", () => {
    const v2 = {
      ...current,
      profileDigestScheme: 2,
      restorableSchemes: [1, 2],
    };

    test("takes a checkpoint sealed under that scheme, so the old image can go", () => {
      expect(
        selectWorkerImage({ kind: "recorded", runtime: current }, [
          { image: "worker@sha256:v2", runtime: v2 },
        ]),
      ).toEqual({ kind: "selected", image: "worker@sha256:v2", runtime: v2 });
    });

    test("still refuses a scheme it does not list, and a different engine build", () => {
      expect(
        selectWorkerImage(
          { kind: "recorded", runtime: { ...current, profileDigestScheme: 3 } },
          [{ image: "worker@sha256:v2", runtime: v2 }],
        ).kind,
      ).toBe("none");
      expect(
        selectWorkerImage({ kind: "recorded", runtime: previous }, [
          { image: "worker@sha256:v2", runtime: v2 },
        ]).kind,
      ).toBe("none");
    });

    test("the strict combination, which a worker is held to, ignores the list", () => {
      expect(sameCombination(v2, current)).toBe(false);
      expect(sameCombination(v2, { ...v2, restorableSchemes: [2] })).toBe(true);
      expect(canRestoreCheckpoint(v2, current)).toBe(true);
      expect(canRestoreCheckpoint(current, v2)).toBe(false);
    });
  });

  describe("a retracted image", () => {
    const retracted = [
      { image: "worker@sha256:new", runtime: current },
      { image: "worker@sha256:old", runtime: previous, retracted: true },
    ] as const;

    test("is never selected; what only it restores is runtime_retired", () => {
      const outcome = selectWorkerImage(
        { kind: "recorded", runtime: previous },
        retracted,
      );
      expect(outcome).toMatchObject({
        kind: "none",
        reason: "runtime_retired",
      });
      expect(outcome.kind === "none" && outcome.detail).toContain(
        "only a retracted worker image restores it, and the others run claude sdk 0.3.280",
      );
    });

    test("gives its sessions to a rebuild of the same combination", () => {
      expect(
        selectWorkerImage({ kind: "recorded", runtime: previous }, [
          ...retracted,
          { image: "worker@sha256:fixed", runtime: { ...previous } },
        ]),
      ).toMatchObject({ kind: "selected", image: "worker@sha256:fixed" });
    });

    test("with every image retracted, nothing is selected, sealed or new", () => {
      const all = [
        { image: "worker@sha256:new", runtime: current, retracted: true },
      ] as const;
      for (const pointer of [
        { kind: "none" },
        { kind: "unrecorded" },
        { kind: "recorded", runtime: current },
      ] as const) {
        expect(selectWorkerImage(pointer, all)).toMatchObject({
          kind: "none",
          reason: "runtime_retired",
        });
      }
    });

    test("does not turn a checkpoint nothing restores into runtime_retired", () => {
      expect(
        selectWorkerImage(
          { kind: "recorded", runtime: { ...previous, sdkVersion: "0.3.260" } },
          retracted,
        ),
      ).toMatchObject({ kind: "none", reason: "incompatible_checkpoint" });
    });
  });

  describe("by the session's engine", () => {
    const codex = { ...current, engine: "codex", sdkVersion: "0.9.0" };
    const mixed = [
      { image: "worker@sha256:claude", runtime: current },
      { image: "worker@sha256:codex", runtime: codex },
    ] as const;

    test("a session with no checkpoint runs on its own engine's newest image, not the newest of all", () => {
      for (const pointer of [
        { kind: "none" },
        { kind: "unrecorded" },
      ] as const) {
        expect(selectWorkerImage(pointer, mixed, "codex")).toEqual({
          kind: "selected",
          image: "worker@sha256:codex",
          runtime: codex,
        });
        expect(selectWorkerImage(pointer, mixed, "claude")).toMatchObject({
          image: "worker@sha256:claude",
        });
      }
    });

    test("a checkpoint resumes on its engine's image", () => {
      expect(
        selectWorkerImage({ kind: "recorded", runtime: codex }, mixed, "codex"),
      ).toMatchObject({ kind: "selected", image: "worker@sha256:codex" });
    });

    test("no image of the engine leaves a session with no checkpoint waiting, and holds a checkpoint", () => {
      const claudeOnly = [mixed[0]] as const;
      for (const pointer of [
        { kind: "none" },
        { kind: "unrecorded" },
      ] as const) {
        expect(selectWorkerImage(pointer, claudeOnly, "codex")).toEqual({
          kind: "none",
          reason: "engine_unavailable",
          detail: "no configured worker image runs the codex engine",
        });
        expect(selectWorkerImage(pointer, claudeOnly, null)).toEqual({
          kind: "none",
          reason: "engine_unavailable",
          detail: "the session's runtime kind is not one this host runs",
        });
      }
      const held = selectWorkerImage(
        { kind: "recorded", runtime: codex },
        claudeOnly,
        "codex",
      );
      expect(held).toMatchObject({
        kind: "none",
        reason: "incompatible_checkpoint",
      });
      expect(held.kind === "none" && held.detail).toContain(
        "no configured worker image runs the codex engine",
      );
    });

    test("a checkpoint of another engine than the session's is not restored by the image that sealed it", () => {
      expect(
        selectWorkerImage(
          { kind: "recorded", runtime: current },
          mixed,
          "codex",
        ),
      ).toMatchObject({ kind: "none", reason: "incompatible_checkpoint" });
    });
  });

  test("no image matching engine, sdk and cli stops the launch", () => {
    for (const changed of [
      { engine: "other" },
      { sdkVersion: "0.3.260" },
      { cliVersion: "2.1.260" },
    ]) {
      expect(
        selectWorkerImage(
          { kind: "recorded", runtime: { ...previous, ...changed } },
          images,
        ).kind,
      ).toBe("none");
    }
  });
});
