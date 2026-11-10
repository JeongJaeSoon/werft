import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest,
  MANIFEST_ASSET,
  type ReleaseManifest,
} from "../.github/scripts/release-manifest.ts";

// The manifest a tag's GitHub Release carries, and the script that attaches it.

const root = join(import.meta.dir, "..");
const sha = "0123456789abcdef0123456789abcdef01234567";
const tag = "v0.1.0";
const ref = `refs/tags/${tag}`;
const hex = (c: string) => `sha256:${c.repeat(64)}`;
const runtime = {
  engine: "claude",
  sdkVersion: "0.3.280",
  cliVersion: "2.1.280",
  profileDigestScheme: 1,
};
const codexRuntime = {
  engine: "codex",
  sdkVersion: "0.167.0",
  cliVersion: "0.167.0",
  profileDigestScheme: 1,
};
const APPS = [
  "control-host",
  "worker",
  "worker-codex",
  "egress-proxy",
] as const;
const DIGEST_CHAR = {
  "control-host": "a",
  worker: "b",
  "worker-codex": "e",
  "egress-proxy": "c",
};
const RUNTIME = { worker: runtime, "worker-codex": codexRuntime } as Record<
  string,
  object
>;

const records = (): Record<string, unknown>[] =>
  APPS.map((app) => ({
    app,
    image: `ghcr.io/octo/werft-${app}`,
    digest: hex(DIGEST_CHAR[app]),
    promoted: true,
    commit: sha,
    ref,
    runtime: RUNTIME[app] ?? null,
    platforms: {
      amd64: { digest: hex("1"), imageId: hex("2") },
      arm64: { digest: hex("3"), imageId: hex("4") },
    },
  }));

const chart = (version = "0.1.0") => ({
  tgzName: `werft-${version}.tgz`,
  chartYaml: `apiVersion: v2\nname: werft\nversion: ${version}\nappVersion: ${tag}\n`,
  valuesYaml: APPS.map((app) => `  digest: ${hex(DIGEST_CHAR[app])}\n`).join(
    "",
  ),
});

const build = (
  over: Partial<Parameters<typeof buildManifest>[0]> = {},
): ReleaseManifest =>
  buildManifest({
    ref,
    sha,
    owner: "Octo",
    records: records(),
    chart: chart(),
    ...over,
  });

describe("buildManifest", () => {
  test("holds the four digests, both worker runtimes and the chart version", () => {
    expect(build()).toEqual({
      schema: 1,
      tag,
      commit: sha,
      images: {
        "control-host": {
          image: "ghcr.io/octo/werft-control-host",
          digest: hex("a"),
          platforms: { amd64: hex("1"), arm64: hex("3") },
        },
        worker: {
          image: "ghcr.io/octo/werft-worker",
          digest: hex("b"),
          platforms: { amd64: hex("1"), arm64: hex("3") },
        },
        "worker-codex": {
          image: "ghcr.io/octo/werft-worker-codex",
          digest: hex("e"),
          platforms: { amd64: hex("1"), arm64: hex("3") },
        },
        "egress-proxy": {
          image: "ghcr.io/octo/werft-egress-proxy",
          digest: hex("c"),
          platforms: { amd64: hex("1"), arm64: hex("3") },
        },
      },
      workerRuntime: runtime,
      workerCodexRuntime: codexRuntime,
      chart: {
        name: "werft",
        version: "0.1.0",
        appVersion: tag,
        ref: "oci://ghcr.io/octo/werft",
      },
    });
  });

  test("a prerelease tag keeps its prerelease in the chart version", () => {
    const pre = "v0.2.0-rc.1";
    const manifest = buildManifest({
      ref: `refs/tags/${pre}`,
      sha,
      owner: "octo",
      records: records().map((r) => ({ ...r, ref: `refs/tags/${pre}` })),
      chart: {
        ...chart("0.2.0-rc.1"),
        chartYaml: `name: werft\nversion: 0.2.0-rc.1\nappVersion: ${pre}\n`,
      },
    });
    expect(manifest.chart.version).toBe("0.2.0-rc.1");
  });

  test.each([
    ["a main ref", { ref: "refs/heads/main" }, /from a tag/],
    [
      "another tag's chart",
      { chart: chart("0.1.1") },
      /expected werft-0\.1\.0/,
    ],
    [
      "a Chart.yaml of another version",
      {
        chart: {
          ...chart(),
          chartYaml: `version: 0.1.1\nappVersion: ${tag}\n`,
        },
      },
      /Chart.yaml version/,
    ],
    [
      "a values.yaml without a digest",
      { chart: { ...chart(), valuesYaml: "images: {}\n" } },
      /values\.yaml does not hold/,
    ],
    [
      "a record of another ref",
      { records: records().map((r) => ({ ...r, ref: "refs/tags/v0.0.9" })) },
      /was published from/,
    ],
    [
      "one platform only",
      {
        records: records().map((r) => ({
          ...r,
          platforms: { amd64: { digest: hex("1") } },
        })),
      },
      /platforms are not exactly/,
    ],
    [
      "a short platform digest",
      {
        records: records().map((r) => ({
          ...r,
          platforms: {
            amd64: { digest: "sha256:1" },
            arm64: { digest: hex("3") },
          },
        })),
      },
      /has digest/,
    ],
    [
      "an unpromoted image",
      { records: records().map((r) => ({ ...r, promoted: false })) },
      /was not promoted/,
    ],
  ] as const)("refuses %s", (_name, over, message) => {
    expect(() => build(over as never)).toThrow(message);
  });
});

describe("release-manifest.ts", () => {
  test("reads the published records and the chart package, and writes the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-manifest-"));
    try {
      mkdirSync(join(dir, "published"));
      mkdirSync(join(dir, "chart-out"));
      mkdirSync(join(dir, "pack/werft"), { recursive: true });
      for (const record of records()) {
        writeFileSync(
          join(dir, "published", `${record.app}.json`),
          JSON.stringify(record),
        );
      }
      const c = chart();
      writeFileSync(join(dir, "pack/werft/Chart.yaml"), c.chartYaml);
      writeFileSync(join(dir, "pack/werft/values.yaml"), c.valuesYaml);
      const tar = Bun.spawnSync([
        "tar",
        "-czf",
        join(dir, "chart-out", c.tgzName),
        "-C",
        join(dir, "pack"),
        "werft",
      ]);
      expect(tar.exitCode).toBe(0);
      const out = join(dir, MANIFEST_ASSET);
      const run = Bun.spawnSync(
        [
          "bun",
          join(root, ".github/scripts/release-manifest.ts"),
          join(dir, "published"),
          join(dir, "chart-out"),
          out,
        ],
        {
          env: {
            ...Bun.env,
            GITHUB_REF: ref,
            GITHUB_SHA: sha,
            GITHUB_REPOSITORY_OWNER: "Octo",
          },
        },
      );
      expect(run.stderr.toString()).toBe("");
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(build());
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

// A fake `gh` over a JSON file holding the releases of one repository, so the
// script's states (nothing, a draft, a published release, a stub asset) can be
// set up and read back. jq answers the --jq expressions as the real gh does.
const FAKE_GH = `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const file = process.env.FAKE_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const save = () => writeFileSync(file, JSON.stringify(state));
const jq = (value, expr) => {
  const out = Bun.spawnSync(["jq", "-r", expr], { stdin: new TextEncoder().encode(JSON.stringify(value)) });
  process.stdout.write(out.stdout.toString());
};
const path = args.find((a) => a.startsWith("repos/")) ?? "";
const expr = args[args.indexOf("--jq") + 1];
const release = (id) => state.releases.find((r) => String(r.id) === id);
const find = (re) => path.match(re);
if (args[0] === "api") {
  let m;
  if (args.includes("-X") && args[args.indexOf("-X") + 1] === "DELETE" && (m = find(/assets\\/(\\d+)/))) {
    for (const r of state.releases) r.assets = r.assets.filter((a) => String(a.id) !== m[1]);
    save();
  } else if (args.includes("-X") && (m = find(/releases\\/(\\d+)$/))) {
    release(m[1]).draft = false;
    save();
  } else if ((m = find(/releases\\/assets\\/(\\d+)/))) {
    const a = state.releases.flatMap((r) => r.assets).find((a) => String(a.id) === m[1]);
    process.stdout.write(a.content);
  } else if ((m = find(/releases\\/(\\d+)\\/assets/))) {
    jq(release(m[1]).assets, expr.startsWith(".[]") ? expr.replace(/^\\.\\[\\]/, ".[]") : expr);
  } else if ((m = find(/releases\\/(\\d+)$/))) {
    jq(release(m[1]), expr);
  } else if (path.includes("/releases?")) {
    if (state.listFails) { console.error("HTTP 502"); process.exit(1); }
    jq(state.releases, expr);
  } else { console.error("unexpected api call " + args.join(" ")); process.exit(9); }
} else if (args[0] === "release" && args[1] === "create") {
  state.createArgs = args;
  state.releases.push({ id: 100 + state.releases.length, tag_name: args[2], draft: args.includes("--draft"), prerelease: args.includes("--prerelease"), assets: [] });
  save();
} else if (args[0] === "release" && args[1] === "upload") {
  const r = state.releases.find((r) => r.tag_name === args[2]);
  const asset = { id: 500 + r.assets.length, name: args[3].split("/").pop(), state: "uploaded", content: readFileSync(args[3], "utf8") };
  if (state.uploadFails && (state.uploadFails === true || state.uploadFails === asset.name)) { asset.state = "starter"; r.assets.push(asset); save(); process.exit(1); }
  r.assets.push(asset);
  save();
} else { console.error("unexpected gh call " + args.join(" ")); process.exit(9); }
`;

type Fake = {
  releases: {
    id: number;
    tag_name: string;
    draft: boolean;
    prerelease?: boolean;
    assets: { id: number; name: string; state: string; content: string }[];
  }[];
  listFails?: boolean;
  uploadFails?: boolean | string;
  createArgs?: string[];
};

function publish(
  initial: Fake,
  manifest: object,
  name = tag,
  extra: Record<string, string> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "release-publish-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), FAKE_GH);
    chmodSync(join(bin, "gh"), 0o755);
    const stateFile = join(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify(initial));
    const file = join(dir, MANIFEST_ASSET);
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    const extraFiles = Object.entries(extra).map(([asset, content]) => {
      const path = join(dir, asset);
      writeFileSync(path, content);
      return path;
    });
    const run = Bun.spawnSync(
      [
        join(root, ".github/scripts/release-publish.sh"),
        name,
        file,
        ...extraFiles,
      ],
      {
        env: {
          ...Bun.env,
          GH_REPO: "octo/repo",
          FAKE_STATE: stateFile,
          PATH: `${bin}:${Bun.env.PATH}`,
        },
      },
    );
    return {
      exitCode: run.exitCode,
      stderr: run.stderr.toString(),
      state: JSON.parse(readFileSync(stateFile, "utf8")) as Fake,
    };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

describe("release-publish.sh", () => {
  const manifest = build();
  const asset = (content: object, state = "uploaded") => ({
    id: 7,
    name: MANIFEST_ASSET,
    state,
    // Another key order and indentation: only the content counts.
    content: JSON.stringify(content),
  });
  const release = (
    draft: boolean,
    assets: Fake["releases"][number]["assets"],
  ) => ({
    id: 1,
    tag_name: tag,
    draft,
    assets,
  });

  test("creates the release as a draft, uploads, reads back and publishes", () => {
    const { exitCode, state } = publish({ releases: [] }, manifest);
    expect(exitCode).toBe(0);
    expect(state.releases).toHaveLength(1);
    expect(state.releases[0]?.draft).toBe(false);
    expect(state.releases[0]?.prerelease).toBe(false);
    expect(JSON.parse(state.releases[0]?.assets[0]?.content ?? "")).toEqual(
      manifest,
    );
  });

  test("the body is the generated notes plus the manifest line", () => {
    const { state } = publish({ releases: [] }, manifest);
    const args = state.createArgs ?? [];
    expect(args).toContain("--generate-notes");
    const notes = args[args.indexOf("--notes") + 1] ?? "";
    expect(notes).toContain(MANIFEST_ASSET);
    expect(notes).toContain("image digests");
  });

  test("a prerelease tag makes a prerelease", () => {
    const { state } = publish({ releases: [] }, manifest, "v0.2.0-rc.1");
    expect(state.releases[0]?.prerelease).toBe(true);
  });

  test("a rerun with the same content passes and changes nothing", () => {
    const initial = { releases: [release(false, [asset(manifest)])] };
    const { exitCode, state } = publish(initial, manifest);
    expect(exitCode).toBe(0);
    expect(state).toEqual(initial);
  });

  test("a rerun with other digests fails and leaves the manifest as it was", () => {
    const other = build({
      records: records().map((r) => ({ ...r, digest: hex("d") })),
      chart: {
        ...chart(),
        valuesYaml: `  digest: ${hex("d")}\n`,
      },
    });
    const initial = { releases: [release(false, [asset(manifest)])] };
    const { exitCode, stderr, state } = publish(initial, other);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("different");
    expect(state).toEqual(initial);
  });

  test("a remote manifest with trailing garbage is not the same manifest", () => {
    const damaged = {
      releases: [
        release(true, [
          { ...asset(manifest), content: `${JSON.stringify(manifest)}BROKEN` },
        ]),
      ],
    };
    const { exitCode, state } = publish(damaged, manifest);
    expect(exitCode).toBe(1);
    expect(state.releases[0]?.draft).toBe(true);
  });

  test("completes a draft that has no manifest yet", () => {
    const { exitCode, state } = publish(
      { releases: [release(true, [])] },
      manifest,
    );
    expect(exitCode).toBe(0);
    expect(state.releases).toHaveLength(1);
    expect(state.releases[0]?.draft).toBe(false);
    expect(state.releases[0]?.assets).toHaveLength(1);
  });

  test("publishes a draft whose manifest is already there", () => {
    const { exitCode, state } = publish(
      { releases: [release(true, [asset(manifest)])] },
      manifest,
    );
    expect(exitCode).toBe(0);
    expect(state.releases[0]?.draft).toBe(false);
  });

  test("replaces an unfinished upload, which holds no manifest", () => {
    const { exitCode, state } = publish(
      { releases: [release(true, [asset({}, "starter")])] },
      manifest,
    );
    expect(exitCode).toBe(0);
    expect(state.releases[0]?.assets).toHaveLength(1);
    expect(state.releases[0]?.assets[0]?.state).toBe("uploaded");
  });

  test("a failed upload keeps the release a draft", () => {
    const { exitCode, state } = publish(
      { releases: [], uploadFails: true },
      manifest,
    );
    expect(exitCode).toBe(1);
    expect(state.releases[0]?.draft).toBe(true);
  });

  describe("with more files than the manifest", () => {
    const bundle = {
      "bundle.tar.gz": "bytes-1",
      "bundle.tar.gz.sha256": "sum-1\n",
    };
    const names = (s: Fake) => s.releases[0]?.assets.map((a) => a.name).sort();

    test("uploads every file and publishes only afterwards", () => {
      const { exitCode, state } = publish(
        { releases: [] },
        manifest,
        tag,
        bundle,
      );
      expect(exitCode).toBe(0);
      expect(state.releases[0]?.draft).toBe(false);
      expect(names(state)).toEqual(
        [MANIFEST_ASSET, "bundle.tar.gz", "bundle.tar.gz.sha256"].sort(),
      );
    });

    test("a file that fails to upload keeps the release a draft", () => {
      const { exitCode, state } = publish(
        { releases: [], uploadFails: "bundle.tar.gz" },
        manifest,
        tag,
        bundle,
      );
      expect(exitCode).toBe(1);
      expect(state.releases[0]?.draft).toBe(true);
    });

    test("a rerun with the same bytes passes and other bytes fail unchanged", () => {
      const first = publish({ releases: [] }, manifest, tag, bundle);
      const same = publish(first.state, manifest, tag, bundle);
      expect(same.exitCode).toBe(0);
      expect(same.state).toEqual(first.state);
      const other = publish(first.state, manifest, tag, {
        ...bundle,
        "bundle.tar.gz": "bytes-2",
      });
      expect(other.exitCode).toBe(1);
      expect(other.stderr).toContain("different bundle.tar.gz");
      expect(other.state).toEqual(first.state);
    });
  });

  test("a lookup that fails is not an absent release", () => {
    const { exitCode, state } = publish(
      { releases: [], listFails: true },
      manifest,
    );
    expect(exitCode).not.toBe(0);
    expect(state.releases).toHaveLength(0);
  });
});

describe("images.yml release job", () => {
  type Job = {
    if?: string;
    needs?: string | string[];
    environment?: string;
    permissions?: Record<string, string>;
    steps: { run?: string; env?: Record<string, string> }[];
  };
  const { jobs, permissions } = Bun.YAML.parse(
    readFileSync(join(root, ".github/workflows/images.yml"), "utf8"),
  ) as { jobs: Record<string, Job>; permissions: Record<string, string> };

  test("only the release job may write contents, and only after the chart is published", () => {
    expect(permissions).toEqual({ contents: "read" });
    const writers = Object.entries(jobs)
      .filter(([, job]) => job.permissions?.contents === "write")
      .map(([name]) => name);
    // `release-tag` and `release-publish` are the release by merge's: the same
    // gate comes from release-approve, which they reach through the chart.
    expect(writers).toEqual(["release", "release-tag", "release-publish"]);
    expect(jobs.release?.needs).toBe("chart-publish");
    expect(jobs.release?.if).toBe(jobs.publish?.if);
    expect(jobs.release?.permissions).toEqual({ contents: "write" });
  });

  test("builds the manifest from the published records and the chart, then attaches it", () => {
    const runs = (jobs.release?.steps ?? []).map((step) => step.run ?? "");
    expect(runs.join("\n")).toContain(
      "release-manifest.ts published chart-out release-manifest.json",
    );
    // The tag is the ref's, or RELEASE_REF's when a main run releases.
    expect(runs.join("\n")).toContain(
      'ref="${RELEASE_REF:-$GITHUB_REF}"\ntag="${ref#refs/tags/}"\n.github/scripts/release-publish.sh "$tag" release-manifest.json',
    );
    // The auto release job shares these steps, so the bundle is built and
    // attached there too, after the approval chain (release-tag).
    expect(jobs["release-publish"]?.steps).toEqual(jobs.release?.steps);
  });

  test("the bundle is built before it is attached, and only the release job attaches it", () => {
    const runs = (jobs.release?.steps ?? []).map((step) => step.run ?? "");
    const text = runs.join("\n");
    expect(text.indexOf("test-ops-bundle.sh")).toBeGreaterThan(-1);
    expect(text.indexOf("test-ops-bundle.sh")).toBeLessThan(
      text.indexOf("release-publish.sh"),
    );
    expect(text).toContain("werft-test-ops-$" + "{tag}.tar.gz.sha256");
    expect(text).toContain(
      '"$' + '{ref#refs/tags/}" release-manifest.json bundle-out',
    );
    // Product plans build and check it without attaching a release.
    const other = jobs["test-ops-bundle"];
    expect(other?.needs).toBe("plan");
    expect(other?.if).toBe("needs.plan.outputs.images == 'build'");
    expect(other?.permissions).toBeUndefined();
    const otherRuns = (other?.steps ?? [])
      .map((step) => step.run ?? "")
      .join("\n");
    expect(otherRuns).toContain("test-ops-bundle.sh");
    expect(otherRuns).not.toContain("release-publish");
    expect(otherRuns).not.toContain("gh ");
  });
});
