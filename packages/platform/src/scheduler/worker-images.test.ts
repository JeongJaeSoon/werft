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
      { image: NEW, runtime: current },
      { image: OLD, runtime: previous },
    ]);
  });

  test.each<[string, WorkerImagesEnvironment, string]>([
    ["not JSON", { WORKER_IMAGES: "[" }, "is not JSON"],
    ["empty", list(), "non-empty JSON array"],
    ["an object", { WORKER_IMAGES: "{}" }, "non-empty JSON array"],
    ["a string entry", list(NEW), "WORKER_IMAGES[0] must be a JSON object"],
    [
      "an unknown field",
      list(entry(NEW, current, "2026-11-10T00:00:00Z", { retracted: true })),
      "WORKER_IMAGES[0] has unknown field(s): retracted",
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
      "two engines",
      list(
        entry(NEW, current, "2026-11-10T00:00:00Z"),
        entry(OLD, { ...previous, engine: "codex" }, "2026-10-01T00:00:00Z"),
      ),
      "images of claude and codex",
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
      "lists 3 claude images: at most 2",
    ],
  ])("refuses %s", (_, environment, message) => {
    expect(() => workerImageListFromEnv(environment)).toThrow(message);
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
  const claude = (version: string) => ({ kind: "claude_agent_sdk", version });
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
      { kind: "codex_app_server", version: "0.3.270" },
      { kind: "codex_app_server", version: "2.1.270" },
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
