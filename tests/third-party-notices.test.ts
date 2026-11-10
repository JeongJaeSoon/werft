import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUN_BUILDS,
  baseImageOf,
  CLAUDE_CODE_BUN,
  embeddedBunVersions,
  holderOf,
  imageClosure,
  isLicenseFile,
  isPermissive,
  type Lockfile,
  licenseOf,
  mentionsGpl,
  parseDebianSources,
  parseDpkgStatus,
  parseHeld,
  parseLockfile,
  parseRows,
  problemsOf,
  type Row,
  removedFrom,
  render,
  renderDebianSources,
  snapshotAnswers,
  snapshotAnswersWithPrior,
  snapshotHolds,
  snapshotResponses,
  snapshotUrl,
} from "../scripts/third-party-notices.ts";

const root = join(import.meta.dir, "..");
const base = { bun: "1.3.14", digest: `sha256:${"0".repeat(64)}` };

// Shaped like bun.lock: workspaces by path, packages by hoisting key.
const lock: Lockfile = {
  workspaces: {
    "": { name: "root" },
    "apps/control-host": {
      name: "@werft-ai/control-host",
      dependencies: { "@werft-ai/storage": "workspace:*", hono: "4" },
    },
    "apps/worker": {
      name: "@werft-ai/worker",
      dependencies: { sdk: "1" },
    },
    "packages/storage": {
      name: "@werft-ai/storage",
      dependencies: { "@scope/a": "1" },
    },
    "packages/ui": { name: "@werft-ai/ui" },
    "packages/client": { name: "@werft-ai/client" },
  },
  packages: {
    "@werft-ai/control-host": [
      "@werft-ai/control-host@workspace:apps/control-host",
    ],
    "@werft-ai/storage": ["@werft-ai/storage@workspace:packages/storage"],
    "@werft-ai/worker": ["@werft-ai/worker@workspace:apps/worker"],
    hono: ["hono@4.0.0", "", {}, "sha"],
    "@scope/a": ["@scope/a@1.0.0", "", { dependencies: { b: "2" } }, "sha"],
    // A second b that only @scope/a sees: the nested key wins over the hoisted.
    b: ["b@1.0.0", "", {}, "sha"],
    "@scope/a/b": ["b@2.0.0", "", { dependencies: { c: "1" } }, "sha"],
    c: ["c@1.0.0", "", {}, "sha"],
    sdk: [
      "sdk@1.0.0",
      "",
      {
        optionalDependencies: {
          "sdk-linux-x64": "1",
          "sdk-darwin-arm64": "1",
          "sdk-linux-riscv": "1",
        },
        peerDependencies: { zod: "4", "left-out": "1" },
        optionalPeers: ["left-out"],
      },
      "sha",
    ],
    "sdk-linux-x64": [
      "sdk-linux-x64@1.0.0",
      "",
      { os: "linux", cpu: "x64" },
      "sha",
    ],
    "sdk-darwin-arm64": [
      "sdk-darwin-arm64@1.0.0",
      "",
      { os: "darwin", cpu: "arm64" },
      "sha",
    ],
    "sdk-linux-riscv": [
      "sdk-linux-riscv@1.0.0",
      "",
      { os: "linux", cpu: "riscv64" },
      "sha",
    ],
    zod: ["zod@4.0.0", "", {}, "sha"],
    "not-windows": [
      "not-windows@1.0.0",
      "",
      { os: ["!win32"], cpu: "*" },
      "sha",
    ],
  },
};

const ids = (image: "control-host" | "worker" | "egress-proxy") =>
  [...imageClosure(lock, image).values()]
    .map((pkg) => `${pkg.name}@${pkg.version}`)
    .sort();

describe("image closure from bun.lock", () => {
  test("follows workspace dependencies and resolves nested keys before hoisted ones", () => {
    expect(ids("control-host")).toEqual([
      "@scope/a@1.0.0",
      "b@2.0.0",
      "c@1.0.0",
      "hono@4.0.0",
    ]);
  });

  test("the worker installs its own closure; linux x64/arm64 builds and required peers only", () => {
    expect(ids("worker")).toEqual([
      "sdk-linux-x64@1.0.0",
      "sdk@1.0.0",
      "zod@4.0.0",
    ]);
  });

  test("the egress proxy installs nothing", () => {
    expect(ids("egress-proxy")).toEqual([]);
  });

  test("a required dependency missing from the lockfile is an error, not a gap", () => {
    const broken: Lockfile = {
      ...lock,
      packages: { ...lock.packages, c: undefined as never },
    };
    delete (broken.packages as Record<string, unknown>).c;
    expect(() => imageClosure(broken, "control-host")).toThrow(
      /c \(needed by @scope\/a\/b\) is not in bun.lock/,
    );
  });

  test("the real lockfile resolves for every image", () => {
    const real = parseLockfile(readFileSync(join(root, "bun.lock"), "utf8"));
    const controlHost = imageClosure(real, "control-host");
    const worker = imageClosure(real, "worker");
    // The Dockerfiles' own promises: the SDK only in the worker, the database
    // driver and ORM only in control-host, nothing in the proxy. The web
    // console bundle that control-host serves keeps its components listed.
    const names = (closure: typeof worker) =>
      new Set([...closure.values()].map((pkg) => pkg.name));
    expect(names(worker).has("@anthropic-ai/claude-agent-sdk")).toBe(true);
    expect(names(controlHost).has("@anthropic-ai/claude-agent-sdk")).toBe(
      false,
    );
    for (const name of ["pg", "drizzle-orm"]) {
      expect(names(controlHost).has(name)).toBe(true);
      expect(names(worker).has(name)).toBe(false);
    }
    for (const name of ["react", "@radix-ui/react-dialog", "openapi-fetch"]) {
      expect(names(controlHost).has(name)).toBe(true);
    }
    expect(imageClosure(real, "egress-proxy").size).toBe(0);
  });

  test("each worker image holds its own engine and not the other's", () => {
    const real = parseLockfile(readFileSync(join(root, "bun.lock"), "utf8"));
    const names = (image: "worker" | "worker-codex") =>
      new Set([...imageClosure(real, image).values()].map((pkg) => pkg.name));
    expect(names("worker").has("@anthropic-ai/claude-agent-sdk")).toBe(true);
    expect(names("worker").has("@openai/codex")).toBe(false);
    expect(names("worker-codex").has("@openai/codex")).toBe(true);
    expect(names("worker-codex").has("@anthropic-ai/claude-agent-sdk")).toBe(
      false,
    );
  });
});

describe("license policy", () => {
  test("SPDX expressions", () => {
    expect(isPermissive("MIT")).toBe(true);
    expect(isPermissive("(MIT OR GPL-3.0)")).toBe(true);
    expect(isPermissive("MIT AND Apache-2.0")).toBe(true);
    expect(isPermissive("MIT AND GPL-2.0")).toBe(false);
    expect(isPermissive("LGPL-2.1")).toBe(false);
    expect(isPermissive("SEE LICENSE IN LICENSE.md")).toBe(false);
    expect(isPermissive("UNKNOWN")).toBe(false);
    // AND binds tighter than OR, and parentheses group: GPL-2.0 is required.
    expect(isPermissive("(MIT OR GPL-3.0) AND GPL-2.0")).toBe(false);
    expect(isPermissive("MIT OR GPL-3.0 AND GPL-2.0")).toBe(true);
    expect(isPermissive("GPL-2.0 AND (MIT OR ISC)")).toBe(false);
    expect(isPermissive("((MIT))")).toBe(true);
    expect(isPermissive("GPL-2.0 WITH Classpath-exception-2.0")).toBe(false);
    expect(isPermissive("MIT OR")).toBe(false);
    expect(isPermissive("(MIT")).toBe(false);
  });

  test("reads the legacy license shapes", () => {
    expect(licenseOf({ license: "ISC" })).toBe("ISC");
    expect(licenseOf({ license: { type: "MIT" } })).toBe("MIT");
    expect(
      licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
    ).toBe("MIT OR Apache-2.0");
    expect(licenseOf({})).toBe("UNKNOWN");
  });

  const row = (name: string, license: string, version = "1.0.0"): Row => ({
    name,
    version,
    license,
    images: ["worker"],
    notices: [],
  });

  test("a copyleft or unknown license fails until it is reviewed", () => {
    expect(problemsOf([row("hono", "MIT")], base)).toEqual([]);
    expect(problemsOf([row("gpl-thing", "GPL-3.0")], base)).toEqual([
      "gpl-thing@1.0.0 is GPL-3.0: not in PERMISSIVE and not REVIEWED in scripts/third-party-notices.ts",
    ]);
    // Reviewed by name, and a platform family by prefix.
    expect(
      problemsOf(
        [
          row(
            "@anthropic-ai/claude-agent-sdk",
            "SEE LICENSE IN README.md",
            "0.3.319",
          ),
          row(
            "@anthropic-ai/claude-agent-sdk-linux-x64",
            "SEE LICENSE IN LICENSE.md",
          ),
        ],
        base,
      ),
    ).toEqual([]);
    // A review covers the license it read; new terms need a new one.
    expect(
      problemsOf(
        [row("@anthropic-ai/claude-agent-sdk", "GPL-3.0", "0.3.319")],
        base,
      ),
    ).toHaveLength(1);
  });

  // what the notices say about Bun and the bundled Claude Code is
  // tied to a version, so a bump waits for someone to read the new one.
  test("a Bun or Agent SDK version without its pinned build fails", () => {
    expect(problemsOf([], { ...base, bun: "9.9.9" })).toEqual([
      "Bun 9.9.9 (the Dockerfiles' BUN_IMAGE) has no BUN_BUILDS entry in scripts/third-party-notices.ts",
    ]);
    expect(
      problemsOf(
        [
          row(
            "@anthropic-ai/claude-agent-sdk",
            "SEE LICENSE IN README.md",
            "9.9.9",
          ),
        ],
        base,
      ),
    ).toEqual([
      "@anthropic-ai/claude-agent-sdk@9.9.9 has no CLAUDE_CODE_BUN entry in scripts/third-party-notices.ts",
    ]);
  });

  test("the notices name the Bun build and the source of its LGPL parts", () => {
    const text = render(
      [
        row(
          "@anthropic-ai/claude-agent-sdk",
          "SEE LICENSE IN README.md",
          "0.3.319",
        ),
      ],
      base,
    );
    const build = BUN_BUILDS["1.3.14"];
    expect(text).toContain(`oven/bun:1.3.14@${base.digest}`);
    expect(text).toContain(`commit \`${build?.revision}\``);
    expect(text).toContain(`oven-sh/WebKit/tree/${build?.webkit}`);
    expect(text).toContain(`oven-sh/tinycc/tree/${build?.tinycc}`);
    expect(text).toContain("oven-sh/bun/tree/bun-v1.3.14");
    expect(text).toContain(
      `Bun ${CLAUDE_CODE_BUN["0.3.319"]} 런타임을 내장한다`,
    );
    // Only an image list with the SDK gets the Claude Code section.
    expect(render([row("hono", "MIT")], base)).not.toContain("Claude Code");
  });

  test("the file round-trips: every row render writes, parseRows reads back", () => {
    const rows: Row[] = [
      { ...row("a", "MIT"), images: ["control-host", "worker"] },
      {
        ...row("b", "Apache-2.0"),
        notices: ["Copyright b\nNOTICE body"],
      },
    ];
    const text = render(rows, base);
    expect(text).toContain(
      "### b@1.0.0\n\n```text\nCopyright b\nNOTICE body\n```",
    );
    const parsed = parseRows(text);
    expect([...parsed.keys()]).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(parsed.get("a@1.0.0")?.images).toEqual(["control-host", "worker"]);
    expect(parsed.get("b@1.0.0")?.license).toBe("Apache-2.0");
    expect(text).toContain("## 라이선스 파일이 없는 npm 패키지\n\n없음.");
  });

  // A package without its own license file gets its text from the notices,
  // and --check reads the holder back for a build this machine lacks.
  test("a package without a license file: holder listed, text carried", () => {
    const rows: Row[] = [
      { ...row("pgpass", "MIT"), holder: "Hannes Hörl, https://x/pgpass" },
      { ...row("drizzle-orm", "Apache-2.0"), holder: "Drizzle Team" },
      row("hono", "MIT"),
    ];
    const text = render(rows, base);
    expect(text).toContain(
      "- `pgpass@1.0.0` (MIT): Hannes Hörl, https://x/pgpass",
    );
    expect(text).toContain(
      "Copyright (c) <저작권자>\n\nPermission is hereby granted",
    );
    expect(text).toContain("/usr/share/common-licenses/Apache-2.0");
    const parsed = parseRows(text);
    expect(parsed.get("pgpass@1.0.0")?.holder).toBe(
      "Hannes Hörl, https://x/pgpass",
    );
    expect(parsed.get("hono@1.0.0")?.holder).toBeUndefined();
    expect(problemsOf(rows, base)).toEqual([]);
    expect(
      problemsOf([{ ...row("isc-thing", "ISC"), holder: "someone" }], base),
    ).toEqual([
      "isc-thing@1.0.0 ships no license file and the notices carry no ISC text; add it to CARRIED_TEXTS and render in scripts/third-party-notices.ts",
    ]);
  });

  test("license files and holders", () => {
    for (const file of [
      "LICENSE",
      "LICENSE.md",
      "license.txt",
      "LICENSE-MIT",
      "LICENCE",
      "COPYING",
    ]) {
      expect(isLicenseFile(file)).toBe(true);
    }
    for (const file of ["README.md", "licenses.json", "NOTICE"]) {
      expect(isLicenseFile(file)).toBe(false);
    }
    // No maintainer address is republished.
    expect(
      holderOf({
        author: "Hannes Hörl <hannes@example.com> (https://h.example)",
        repository: { url: "git+https://github.com/hoegaarden/pgpass.git" },
      }),
    ).toBe("Hannes Hörl, https://github.com/hoegaarden/pgpass.git");
    expect(holderOf({ author: { name: "Drizzle Team" } })).toBe("Drizzle Team");
    expect(holderOf({ repository: "https://github.com/oven-sh/bun" })).toBe(
      "저작자 표기 없음, https://github.com/oven-sh/bun",
    );
  });
});

describe("base image pins", () => {
  test("the Dockerfiles' BUN_IMAGE", () => {
    const pinned = baseImageOf(
      readFileSync(join(root, "apps/worker/Dockerfile"), "utf8"),
    );
    expect(pinned.bun).toBe("1.3.14");
    expect(pinned.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => baseImageOf("FROM oven/bun:1.3.14")).toThrow();
  });

  test("the Bun running this test is a pinned build", () => {
    // CI and the images run the same Bun; its revision is the one named.
    expect(BUN_BUILDS[Bun.version]?.revision).toBe(Bun.revision);
  });
});

describe("Debian corresponding source", () => {
  const status = [
    "Package: libc6",
    "Status: install ok installed",
    "Architecture: amd64",
    "Source: glibc",
    "Version: 2.41-12",
    "Description: GNU C Library",
    " Continuation: not a field",
    "",
    "Package: libgcc-s1",
    "Status: install ok installed",
    "Source: gcc-14 (14.2.0-19)",
    "Version: 14.2.0-19+b1",
    "",
    "Package: libc-bin",
    "Status: install ok installed",
    "Source: glibc",
    "Version: 2.41-12",
    "",
    "Package: tini",
    "Status: install ok installed",
    "Version: 0.19.0-1+b3",
    "Built-Using: musl (= 1.2.5-3), glibc (= 2.41-12)",
    "",
    "Package: removed",
    "Status: deinstall ok config-files",
    "Version: 1.0",
    "",
    "Package: broken",
    "Status: install reinstreq half-installed",
    "Version: 1.0",
    "",
  ].join("\n");

  test("installed packages with the source they were built from", () => {
    expect(parseDpkgStatus(status)).toEqual([
      {
        name: "libc6",
        version: "2.41-12",
        source: "glibc",
        sourceVersion: "2.41-12",
        builtUsing: [],
      },
      // A binNMU: the source version is the one in parentheses.
      {
        name: "libgcc-s1",
        version: "14.2.0-19+b1",
        source: "gcc-14",
        sourceVersion: "14.2.0-19",
        builtUsing: [],
      },
      {
        name: "libc-bin",
        version: "2.41-12",
        source: "glibc",
        sourceVersion: "2.41-12",
        builtUsing: [],
      },
      // No Source field: the package is its own source, version included.
      {
        name: "tini",
        version: "0.19.0-1+b3",
        source: "tini",
        sourceVersion: "0.19.0-1+b3",
        // Statically incorporated sources are corresponding source too.
        builtUsing: [
          { source: "musl", version: "1.2.5-3" },
          { source: "glibc", version: "2.41-12" },
        ],
      },
    ]);
  });

  test("one row per source package, with its snapshot.debian.org address", () => {
    const text = renderDebianSources(
      parseDpkgStatus(status),
      (pkg) => pkg.source === "glibc",
    );
    expect(text).toContain("source package 4개, 바이너리 패키지 4개.");
    const rows = text
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| source"));
    expect(rows).toEqual([
      "| gcc-14 | 14.2.0-19 | libgcc-s1 |  | https://snapshot.debian.org/package/gcc-14/14.2.0-19/ |",
      "| glibc | 2.41-12 | libc-bin, libc6, tini (Built-Using) | 예 | https://snapshot.debian.org/package/glibc/2.41-12/ |",
      "| musl | 1.2.5-3 | tini (Built-Using) |  | https://snapshot.debian.org/package/musl/1.2.5-3/ |",
      "| tini | 0.19.0-1+b3 | tini |  | https://snapshot.debian.org/package/tini/0.19.0-1%2Bb3/ |",
    ]);
    // What --snapshot-check reads back.
    expect(parseDebianSources(text)).toEqual([
      { source: "gcc-14", version: "14.2.0-19" },
      { source: "glibc", version: "2.41-12" },
      { source: "musl", version: "1.2.5-3" },
      { source: "tini", version: "0.19.0-1+b3" },
    ]);
  });

  test("epochs and plus signs are escaped the way snapshot.debian.org takes them", () => {
    expect(snapshotUrl("openssl", "3.5.1-1+deb13u1")).toBe(
      "https://snapshot.debian.org/package/openssl/3.5.1-1%2Bdeb13u1/",
    );
    expect(snapshotUrl("shadow", "1:4.17.4-2")).toBe(
      "https://snapshot.debian.org/package/shadow/1%3A4.17.4-2/",
    );
  });

  test("the snapshot budget ends the asking, and what is left has no answer", async () => {
    const wanted = Array.from({ length: 6 }, (_, index) => ({
      source: `source-${index}`,
      version: "1",
    }));
    const asked: string[] = [];
    const answers = await snapshotAnswers(wanted, 20, async (source) => {
      asked.push(source);
      await Bun.sleep(40);
      return "held";
    });
    expect(asked).toEqual(["source-0", "source-1", "source-2", "source-3"]);
    expect(answers).toEqual([
      "held",
      "held",
      "held",
      "held",
      "unreachable",
      "unreachable",
    ]);
  });

  const sources = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      source: `source-${index}`,
      version: "1",
    }));
  const noPause = async () => {};

  test("what stays unanswered is asked again until it answers", async () => {
    const asked: string[] = [];
    let pauses = 0;
    const answers = await snapshotAnswers(
      sources(3),
      60_000,
      async (source) => {
        asked.push(source);
        return source === "source-1" && asked.length < 6
          ? "unreachable"
          : "held";
      },
      async () => {
        pauses += 1;
      },
    );
    expect(answers).toEqual(["held", "held", "held"]);
    expect(asked).toEqual([
      "source-0",
      "source-1",
      "source-2",
      "source-1",
      "source-1",
      "source-1",
    ]);
    expect(pauses).toBe(3);
  });

  test("a held source is not asked again, and one no is not believed", async () => {
    const counts = new Map<string, number>();
    const answers = await snapshotAnswers(
      sources(2),
      60_000,
      async (source) => {
        const count = (counts.get(source) ?? 0) + 1;
        counts.set(source, count);
        if (source === "source-0") return "held";
        return count === 1 ? "missing" : "held";
      },
      noPause,
    );
    expect(answers).toEqual(["held", "held"]);
    expect(counts.get("source-0")).toBe(1);
    expect(counts.get("source-1")).toBe(2);
  });

  test("a second no ends the asking, and silence does not erase a no", async () => {
    const denied = new Map<string, number>();
    const answers = await snapshotAnswers(
      sources(2),
      30,
      async (source) => {
        await Bun.sleep(1);
        const count = (denied.get(source) ?? 0) + 1;
        denied.set(source, count);
        if (source === "source-0") return "missing";
        return count === 1 ? "missing" : "unreachable";
      },
      noPause,
    );
    expect(answers).toEqual(["missing", "missing"]);
    expect(denied.get("source-0")).toBe(2);
    expect(denied.get("source-1")).toBeGreaterThan(2);
  });

  test("an earlier attempt's held sources are not asked again, and the rest still decide", async () => {
    const asked: string[] = [];
    const { answers, held } = await snapshotAnswersWithPrior(
      sources(3),
      parseHeld("source-0 1\nsource-2 1\nnot-in-this-run 9\n"),
      5,
      async (source) => {
        asked.push(source);
        return "unreachable";
      },
      noPause,
    );
    // Silence repeats until the budget ends; the carried-over ones never appear.
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(["source-1"]));
    expect(answers).toEqual(["held", "unreachable", "held"]);
    // The next attempt inherits the whole earlier set plus this attempt's finds.
    expect([...held].sort()).toEqual([
      "not-in-this-run 9",
      "source-0 1",
      "source-2 1",
    ]);
  });

  test("what this attempt finds is added to the set handed on", async () => {
    const { answers, held } = await snapshotAnswersWithPrior(
      sources(2),
      parseHeld("source-0 1"),
      60_000,
      async () => "held",
      noPause,
    );
    expect(answers).toEqual(["held", "held"]);
    expect([...held].sort()).toEqual(["source-0 1", "source-1 1"]);
  });

  test("a denial is not hidden by the carried-over set", async () => {
    const { answers } = await snapshotAnswersWithPrior(
      sources(2),
      parseHeld("source-0 1"),
      5,
      async () => "missing",
      noPause,
    );
    expect(answers).toEqual(["held", "missing"]);
  });

  test("with no earlier attempt every source is asked", async () => {
    const asked: string[] = [];
    const { answers, held } = await snapshotAnswersWithPrior(
      sources(2),
      parseHeld(""),
      60_000,
      async (source) => {
        asked.push(source);
        return "held";
      },
      noPause,
    );
    expect(asked).toEqual(["source-0", "source-1"]);
    expect(answers).toEqual(["held", "held"]);
    expect(held.size).toBe(2);
  });

  test("the response tally tells a bad body from a failure while reading it", async () => {
    const realFetch = globalThis.fetch;
    const reply = (json: () => Promise<unknown>) => {
      globalThis.fetch = (async () => ({
        status: 200,
        ok: true,
        json,
      })) as unknown as typeof fetch;
    };
    try {
      snapshotResponses.clear();
      reply(async () => {
        throw new SyntaxError("Unexpected token");
      });
      expect(await snapshotHolds("a", "1", 1000)).toBe("unreachable");
      reply(async () => {
        throw new TypeError("connection reset");
      });
      expect(await snapshotHolds("a", "1", 1000)).toBe("unreachable");
      reply(async () => ({ result: [{ hash: "x" }] }));
      expect(await snapshotHolds("a", "1", 1000)).toBe("held");
      expect(Object.fromEntries(snapshotResponses)).toEqual({
        "200": 3,
        "not-json": 1,
        error: 1,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("parseHeld keeps only well-formed lines", () => {
    expect([...parseHeld("a 1\n\n  b 2 \nbroken\nc 3 extra\n")]).toEqual([
      "a 1",
      "b 2",
    ]);
  });

  test("a budget that runs out with a no reports the no", async () => {
    const answers = await snapshotAnswers(
      sources(2),
      5,
      async (source) => {
        await Bun.sleep(10);
        return source === "source-0" ? "missing" : "unreachable";
      },
      noPause,
    );
    expect(answers).toEqual(["missing", "unreachable"]);
  });

  test("a request never outlives the budget", async () => {
    const timeouts: number[] = [];
    await snapshotAnswers(
      sources(1),
      1000,
      async (_, __, timeoutMs) => {
        timeouts.push(timeoutMs);
        return "held";
      },
      noPause,
    );
    expect(timeouts[0]).toBeLessThanOrEqual(1000);
  });

  test("the first pass asks about every source, four at a time", async () => {
    let running = 0;
    let most = 0;
    const answers = await snapshotAnswers(sources(9), 60_000, async () => {
      running += 1;
      most = Math.max(most, running);
      await Bun.sleep(1);
      running -= 1;
      return "held";
    });
    expect(answers).toEqual(Array(9).fill("held"));
    expect(most).toBe(4);
  });

  test("--snapshot-check refuses an empty list and a bad budget", () => {
    const check = (...args: string[]) =>
      Bun.spawnSync(
        ["bun", join(root, "scripts/third-party-notices.ts"), ...args],
        { env: { PATH: process.env.PATH ?? "" } },
      ).exitCode;
    const listed = join(root, "README.md");
    expect(check("--snapshot-check", "240")).toBe(2);
    expect(check("--snapshot-check", "240", listed)).toBe(2);
    expect(check("--snapshot-check", "nonsense", listed)).toBe(2);
    expect(check("--snapshot-check", "0", listed)).toBe(2);
  });

  test("GPL-family mentions in a copyright file", () => {
    expect(mentionsGpl("License: GPL-2+")).toBe(true);
    expect(mentionsGpl("License: LGPL-2.1+")).toBe(true);
    expect(mentionsGpl("GNU Lesser General Public License")).toBe(true);
    expect(mentionsGpl("License: MIT")).toBe(false);
  });
});

describe("the Bun inside the Claude Code executable", () => {
  test("reads every Bun v<x.y.z> the binary names", () => {
    const binary = Buffer.from(
      "\0\0Bun v1.4.3 (linux x64)\0Bun v1.4.30\0Bun v1.4.3\0Bun vnext\0",
      "latin1",
    );
    expect(embeddedBunVersions(binary)).toEqual(["1.4.3", "1.4.30"]);
    expect(embeddedBunVersions(Buffer.from("no runtime here"))).toEqual([]);
  });
});

describe("packages a Dockerfile deletes", () => {
  test("the worker's musl builds are in the closure but not the image", () => {
    expect(
      removedFrom("worker", "@anthropic-ai/claude-agent-sdk-linux-x64-musl"),
    ).toBe(true);
    expect(
      removedFrom("worker", "@anthropic-ai/claude-agent-sdk-linux-x64"),
    ).toBe(false);
    expect(
      removedFrom(
        "control-host",
        "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
      ),
    ).toBe(false);
    const listed = parseRows(
      readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
    );
    expect([...listed.keys()].filter((id) => id.includes("-musl@"))).toEqual(
      [],
    );
  });
});
