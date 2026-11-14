import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// deploy/helm/werft/files/next-workers.jq, the program the Kubernetes upgrade
// page runs to build images.workers. The package's own copy runs in
// deploy/helm/render-check.ts; these are its rules one by one.
const program = join(
  import.meta.dir,
  "../deploy/helm/werft/files/next-workers.jq",
);

type Entry = {
  repository: string;
  digest: string;
  runtime: Record<string, unknown>;
  releasedAt: string;
  retracted?: boolean;
};

// Images are named by a letter; the digest repeats a hex digit of its own.
const HEX: Record<string, string> = {
  n: "1",
  a: "2",
  c: "3",
  m: "4",
  d: "5",
  r: "6",
  o: "7",
  b: "8",
  x: "9",
  p: "a",
  e: "b",
};
const digest = (name: string) => `sha256:${(HEX[name] ?? "").repeat(64)}`;
const nameOf = (value: string) =>
  Object.keys(HEX).find((name) => digest(name) === value);
const claude = { engine: "claude", sdkVersion: "0.3.2", cliVersion: "2.1.2" };
const claudeOld = { ...claude, sdkVersion: "0.3.1", cliVersion: "2.1.1" };
const codex = { engine: "codex", sdkVersion: "0.167.0", cliVersion: "0.167.0" };
const image = (
  c: string,
  runtime: Record<string, unknown>,
  releasedAt: string,
  extra: Partial<Entry> = {},
): Entry => ({
  repository: `reg/werft-worker${runtime.engine === "codex" ? "-codex" : ""}`,
  digest: digest(c),
  runtime,
  releasedAt,
  ...extra,
});

const egressProxy = {
  repository: "reg/werft-egress-proxy",
  digest: digest("e"),
};
const single = (worker: Partial<Entry>, previous: Partial<Entry> = {}) => ({
  images: {
    worker: { repository: "reg/werft-worker", runtime: {}, ...worker },
    workerPrevious: {
      repository: "reg/werft-worker",
      digest: "",
      runtime: {},
      ...previous,
    },
    workers: [],
    egressProxy,
  },
});
const listed = (workers: Entry[]) => ({ images: { workers, egressProxy } });

function run(
  phase: string,
  deployed: unknown,
  release: unknown,
  known: Record<string, unknown> = {},
):
  | { ok: true; images: Record<string, unknown> }
  | { ok: false; error: string } {
  const result = spawnSync(
    "jq",
    [
      "-n",
      "-f",
      program,
      "--arg",
      "phase",
      phase,
      "--argjson",
      "deployed",
      JSON.stringify([deployed]),
      "--argjson",
      "release",
      JSON.stringify([release]),
      "--argjson",
      "known",
      JSON.stringify(known),
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return { ok: false, error: result.stderr };
  return {
    ok: true,
    images: (JSON.parse(result.stdout) as { images: Record<string, unknown> })
      .images,
  };
}
const workersOf = (...args: Parameters<typeof run>) => {
  const result = run(...args);
  if (!result.ok) throw new Error(result.error);
  return (result.images.workers as Entry[]).map(
    (e) =>
      `${e.runtime.engine} ${nameOf(e.digest)}${e.retracted ? " retracted" : ""}`,
  );
};
const refusal = (...args: Parameters<typeof run>) => {
  const result = run(...args);
  return result.ok ? "a list" : result.error;
};

const release = [
  image("n", claude, "2026-11-12T00:00:00Z"),
  image("c", codex, "2026-11-12T00:00:00Z"),
];

describe("next-workers.jq, single image to list", () => {
  const known = {
    [digest("a")]: { runtime: claudeOld, releasedAt: "2026-10-01T00:00:00Z" },
  };

  test("adds the release's two images to the deployed one, each engine newest first", () => {
    const result = run(
      "final",
      single({ digest: digest("a") }),
      release,
      known,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images.worker).toEqual({ digest: "", runtime: null });
    expect(result.images.workerPrevious).toEqual({ digest: "", runtime: null });
    expect(result.images.workers).toEqual([
      release[0],
      image("a", claudeOld, "2026-10-01T00:00:00Z"),
      release[1],
    ]);
  });

  test("takes releasedAt from $known only, never from the chart default in the values", () => {
    const withDefault = single({
      digest: digest("a"),
      runtime: claudeOld,
      releasedAt: "2026-11-12T00:00:00Z",
    });
    expect(refusal("final", withDefault, release)).toContain(
      `${digest("a")} has no releasedAt`,
    );
    expect(
      workersOf("final", withDefault, release, {
        [digest("a")]: { releasedAt: "2026-10-01T00:00:00Z" },
      }),
    ).toEqual(["claude n", "claude a", "codex c"]);
  });

  test("refuses a deployed image with no runtime anywhere", () => {
    expect(
      refusal("final", single({ digest: digest("a") }), release, {
        [digest("a")]: { releasedAt: "2026-10-01T00:00:00Z" },
      }),
    ).toContain(`${digest("a")} has no runtime`);
  });

  test("keeps images.workerPrevious when the release's image is the one deployed", () => {
    const deployed = single(
      { digest: digest("n"), runtime: claude },
      { digest: digest("a"), runtime: claudeOld },
    );
    expect(
      workersOf("final", deployed, release, {
        [digest("n")]: { releasedAt: "2026-11-12T00:00:00Z" },
        [digest("a")]: { releasedAt: "2026-10-01T00:00:00Z" },
      }),
    ).toEqual(["claude n", "claude a", "codex c"]);
  });

  test("a third image of the engine is dropped, for the upgrade check to judge", () => {
    const deployed = single(
      { digest: digest("a"), runtime: claudeOld },
      { digest: digest("p"), runtime: claudeOld },
    );
    expect(
      workersOf("final", deployed, release, {
        [digest("a")]: { releasedAt: "2026-10-01T00:00:00Z" },
        [digest("p")]: { releasedAt: "2026-09-01T00:00:00Z" },
      }),
    ).toEqual(["claude n", "claude a", "codex c"]);
  });
});

describe("next-workers.jq, list to next list", () => {
  const deployed = [
    image("n", claude, "2026-11-12T00:00:00Z"),
    image("a", claudeOld, "2026-10-01T00:00:00Z"),
    image("c", codex, "2026-11-12T00:00:00Z"),
  ];
  const next = [
    image("m", claude, "2026-11-20T00:00:00Z"),
    image("d", codex, "2026-11-20T00:00:00Z"),
  ];

  test("the new images go in front and each engine keeps two", () => {
    expect(workersOf("final", listed(deployed), next)).toEqual([
      "claude m",
      "claude n",
      "codex d",
      "codex c",
    ]);
  });

  test("an image already deployed with the same runtime and time is listed once", () => {
    expect(workersOf("final", listed(deployed), [next[0], release[1]])).toEqual(
      ["claude m", "claude n", "codex c"],
    );
  });

  test("a deployed retracted image stays retracted when the release names it", () => {
    const retracted = deployed.map((e) =>
      e.digest === digest("c") ? { ...e, retracted: true } : e,
    );
    expect(
      workersOf("final", listed(retracted), [next[0], release[1]]),
    ).toEqual(["claude m", "claude n", "codex c retracted"]);
  });

  test("refuses the release's image deployed with another runtime or time", () => {
    expect(
      refusal("final", listed(deployed), [
        next[0],
        { ...release[1], runtime: { ...codex, cliVersion: "0.168.0" } },
      ]),
    ).toContain("is deployed with another runtime");
    expect(
      refusal("final", listed(deployed), [
        next[0],
        { ...release[1], releasedAt: "2026-11-12T00:00:01Z" },
      ]),
    ).toContain("is deployed with releasedAt 2026-11-12T00:00:00Z");
  });

  test("refuses a new image that is not newer than every deployed image of its engine", () => {
    for (const at of ["2026-11-12T00:00:00Z", "2026-11-01T00:00:00Z"]) {
      expect(
        refusal("final", listed(deployed), [{ ...next[0], releasedAt: at }]),
      ).toContain("is not newer than every deployed claude image");
    }
    // Newer than a retracted image too: it would sort below it otherwise.
    const withRetracted = [
      image("r", claude, "2026-11-15T00:00:00Z", { retracted: true }),
      ...deployed,
    ];
    expect(
      refusal("final", listed(withRetracted), [
        { ...next[0], releasedAt: "2026-11-14T00:00:00Z" },
      ]),
    ).toContain("is not newer than every deployed claude image");
  });

  test("compares times across offsets and fractions as the chart does", () => {
    const offset = [
      image("n", claude, "2026-11-12T08:00:00+09:00"),
      image("c", codex, "2026-11-12T00:00:00Z"),
    ];
    expect(
      workersOf("final", listed(offset), [
        image("m", claude, "2026-11-11T23:00:00.001Z"),
      ]),
    ).toEqual(["claude m", "claude n", "codex c"]);
    expect(
      refusal("final", listed(offset), [
        image("m", claude, "2026-11-11T23:00:00Z"),
      ]),
    ).toContain("is not newer");
  });

  test("refuses two deployed images of one engine at the same time", () => {
    const tie = [
      image("n", claude, "2026-11-12T00:00:00Z"),
      image("a", claudeOld, "2026-11-12T00:00:00Z"),
    ];
    expect(refusal("final", listed(tie), [next[1]])).toContain(
      "has the releasedAt of the claude image above it",
    );
  });

  test("refuses times that are not RFC 3339 or not a day", () => {
    for (const at of [
      "2026-11-20",
      "2026-02-30T00:00:00Z",
      "2026-11-20T00:00:00",
    ]) {
      expect(
        refusal("final", listed(deployed), [{ ...next[0], releasedAt: at }]),
      ).toContain("next-workers: releasedAt");
    }
  });

  test("refuses a digest under two repositories and a digest listed twice", () => {
    expect(
      refusal("final", listed(deployed), [
        { ...next[0], digest: digest("a"), repository: "other/werft-worker" },
      ]),
    ).toContain("is listed under two repositories");
    expect(
      refusal("final", listed([...deployed, deployed[0] as Entry]), next),
    ).toContain(`the deployed images list ${digest("n")} twice`);
  });
});

describe("next-workers.jq, retracted images", () => {
  test("keeps a retracted image only above the oldest unretracted one kept", () => {
    const deployed = [
      image("r", claudeOld, "2026-11-01T00:00:00Z", { retracted: true }),
      image("a", claudeOld, "2026-10-01T00:00:00Z"),
      image("o", claudeOld, "2026-09-15T00:00:00Z", { retracted: true }),
      image("b", claudeOld, "2026-09-01T00:00:00Z"),
    ];
    expect(
      workersOf("final", listed(deployed), [
        image("n", claude, "2026-11-12T00:00:00Z"),
      ]),
    ).toEqual(["claude n", "claude r retracted", "claude a"]);
  });

  test("an engine left with retracted images only keeps them all", () => {
    const deployed = [
      image("n", claude, "2026-11-12T00:00:00Z"),
      image("c", codex, "2026-11-12T00:00:00Z", { retracted: true }),
      image("x", codex, "2026-10-12T00:00:00Z", { retracted: true }),
    ];
    expect(
      workersOf("final", listed(deployed), [
        image("m", claude, "2026-11-20T00:00:00Z"),
      ]),
    ).toEqual([
      "claude m",
      "claude n",
      "codex c retracted",
      "codex x retracted",
    ]);
  });
});

describe("next-workers.jq, control phase", () => {
  test("passes the deployed list and egress proxy through, and clears the single values", () => {
    const workers = [
      image("n", claude, "2026-11-12T00:00:00Z"),
      image("c", codex, "2026-11-12T00:00:00Z", { retracted: true }),
    ];
    const result = run("control", listed(workers), []);
    expect(result).toEqual({
      ok: true,
      images: {
        worker: { digest: "", runtime: null },
        workerPrevious: { digest: "", runtime: null },
        workers,
        egressProxy,
      },
    });
  });

  // A packaged chart lists its own images: the empty list keeps them out.
  test("keeps a single-image install's images as they are, with an empty list", () => {
    const deployed = single(
      {
        digest: digest("a"),
        runtime: claudeOld,
        releasedAt: "2026-10-01T00:00:00Z",
      },
      { digest: digest("o"), runtime: claude },
    );
    expect(run("control", deployed, [])).toEqual({
      ok: true,
      images: {
        workers: [],
        worker: {
          repository: "reg/werft-worker",
          digest: digest("a"),
          runtime: claudeOld,
        },
        workerPrevious: {
          repository: "reg/werft-worker",
          digest: digest("o"),
          runtime: claude,
        },
        egressProxy,
      },
    });
    // Deployed without a runtime, it stays without one.
    expect(run("control", single({ digest: digest("a") }), [])).toEqual({
      ok: true,
      images: {
        workers: [],
        worker: {
          repository: "reg/werft-worker",
          digest: digest("a"),
          runtime: {},
        },
        workerPrevious: {
          repository: "reg/werft-worker",
          digest: "",
          runtime: {},
        },
        egressProxy,
      },
    });
  });

  test("refuses an unknown phase", () => {
    expect(refusal("other", listed([]), [])).toContain(
      "phase must be control or final",
    );
  });
});
