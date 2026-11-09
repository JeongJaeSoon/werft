import { describe, expect, test } from "bun:test";
import {
  canRestoreCheckpoint,
  runtimeVersionsOf,
  sameCombination,
  selectWorkerImage,
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

test("new sessions take the current image's versions; pins take either image's", () => {
  expect(runtimeVersionsOf({ current, previous })).toEqual({
    current: ["0.3.280", "2.1.280"],
    accepted: ["0.3.280", "2.1.280", "0.3.270", "2.1.270"],
  });
  expect(runtimeVersionsOf({ current, previous: null })).toEqual({
    current: ["0.3.280", "2.1.280"],
    accepted: ["0.3.280", "2.1.280"],
  });
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
