import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  audit,
  planRetention,
  protectRelease,
  registryReader,
  retainDependencies,
  summarize,
  type Version,
} from "./package-retention.ts";

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const now = Date.parse("2026-11-09T00:00:00Z");
const version = (
  id: number,
  tags = [`main-${id.toString(16).padStart(12, "0")}`],
  date = "2026-09-01T00:00:00Z",
): Version => ({
  id,
  name: digest(id),
  created_at: date,
  updated_at: date,
  metadata: { container: { tags } },
});
const old = Array.from({ length: 25 }, (_, n) => version(n + 1));

describe("package retention dry run", () => {
  test("keeps the newest floor and only proposes old ephemeral versions", () => {
    const rows = planRetention("werft-worker", old, new Set(), new Set(), now);
    expect(rows.filter((r) => r.action === "would-delete")).toHaveLength(5);
    expect(rows.filter((r) => r.action === "keep")).toHaveLength(20);
    expect(summarize(rows)).toEqual({
      would_delete: 5,
      keep: 20,
      exceptions: 0,
    });
  });
  test("a recent update protects a reused old digest", () => {
    const updated = { ...version(100), updated_at: "2026-11-08T00:00:00Z" };
    expect(
      planRetention(
        "werft-worker",
        [...old, updated],
        new Set(),
        new Set(),
        now,
      ).find((r) => r.id === 100)?.reason,
    ).toBe("recent");
  });
  for (const tag of [
    "v1.2.3",
    "1.2.3",
    "v1.2.3-rc.1",
    "v1.2.3+build.7",
    "latest",
    "main",
    "sha-abcd",
    "main-invalid",
    "staging-invalid",
  ])
    test(`protects ${tag} even on an ephemeral digest`, () => {
      const rows = planRetention(
        "werft-worker",
        [...old, version(100, ["main-abcdefabcdef", tag])],
        new Set(),
        new Set(),
        now,
      );
      expect(rows.find((r) => r.id === 100)?.action).toBe("keep");
      expect(summarize(rows).exceptions).toBe(1);
    });
  test("untagged versions are exceptions, never deletion candidates", () => {
    expect(
      planRetention(
        "werft-worker",
        [...old, version(100, [])],
        new Set(),
        new Set(),
        now,
      ).find((r) => r.id === 100)?.reason,
    ).toBe("untagged");
  });
  for (const tag of [
    "staging-123",
    "staging-123-2",
    "staging-123-2-amd64",
    "staging-123-2-arm64",
  ])
    test(`recognizes ${tag}`, () => {
      const rows = planRetention(
        "werft-worker",
        [...old, version(100, [tag])],
        new Set(),
        new Set(),
        now,
      );
      expect(rows.find((r) => r.id === 100)?.reason).toBe("newest");
    });
  test("chart main versions are eligible but release versions are always protected", () => {
    const charts = old.map((v) =>
      version(v.id, [`0.1.0-main-${v.id.toString(16).padStart(12, "0")}`]),
    );
    const rows = planRetention(
      "werft",
      [...charts, version(100, ["0.1.0"])],
      new Set(),
      new Set(),
      now,
    );
    expect(summarize(rows)).toEqual({
      would_delete: 5,
      keep: 21,
      exceptions: 1,
    });
    expect(rows.find((r) => r.id === 100)?.action).toBe("keep");
  });
  test("release index, platform digests and chart version survive without release tags", () => {
    const manifest = {
      schema: 1,
      images: Object.fromEntries(
        ["control-host", "worker", "egress-proxy"].map((app) => [
          app,
          {
            image: `ghcr.io/example/werft-${app}`,
            digest: digest(1),
            platforms: { amd64: digest(2), arm64: digest(3) },
          },
        ]),
      ),
      chart: {
        ref: "oci://ghcr.io/example/werft",
        version: "0.1.0-main-abcdefabcdef",
        digest: digest(4),
      },
    };
    const protection = protectRelease(manifest, "example");
    for (const id of [1, 2, 3, 4])
      expect(protection.digests.has(digest(id))).toBe(true);
    expect(protection.chartTags.has("0.1.0-main-abcdefabcdef")).toBe(true);
    const rows = planRetention(
      "werft-worker",
      old,
      protection.digests,
      new Set(),
      now,
    );
    for (const id of [1, 2, 3])
      expect(rows.find((r) => r.id === id)?.reason).toBe("release-manifest");
    expect(
      planRetention(
        "werft",
        [version(100, [manifest.chart.version])],
        new Set(),
        protection.chartTags,
        now,
      )[0]?.reason,
    ).toBe("release-manifest");
    for (const bad of [
      {},
      { ...manifest, schema: 2 },
      { ...manifest, images: {} },
      { ...manifest, chart: {} },
    ])
      expect(() => protectRelease(bad, "example")).toThrow();
    const wrong = structuredClone(manifest);
    (wrong.images.worker as { image: string }).image =
      "ghcr.io/other/werft-worker";
    expect(() => protectRelease(wrong, "example")).toThrow();
    // The manifest above is of a release before the Codex image; a release
    // with one protects its digests too, and a malformed entry is refused.
    const withCodex = structuredClone(manifest) as unknown as {
      images: Record<string, unknown>;
    };
    withCodex.images["worker-codex"] = {
      image: "ghcr.io/example/werft-worker-codex",
      digest: digest(5),
      platforms: { amd64: digest(6), arm64: digest(7) },
    };
    const codexProtection = protectRelease(withCodex, "example");
    for (const id of [5, 6, 7])
      expect(codexProtection.digests.has(digest(id))).toBe(true);
    withCodex.images["worker-codex"] = { image: "ghcr.io/example/x" };
    expect(() => protectRelease(withCodex, "example")).toThrow();
  });
  test("kept index dependencies transitively protect old staging children", async () => {
    const rows = planRetention(
      "werft-worker",
      [...old, version(100, ["v1.2.3"])],
      new Set(),
      new Set(),
      now,
    );
    const read = async (d: string) =>
      d === digest(100) ? [digest(1)] : d === digest(1) ? [digest(2)] : [];
    await retainDependencies(rows, read);
    expect(rows.find((r) => r.id === 1)?.reason).toBe("kept-index");
    expect(rows.find((r) => r.id === 2)?.reason).toBe("kept-index");
    expect(summarize(rows).would_delete).toBe(3);
  });
  test("a missing or unreadable retained index stops the entire plan", async () => {
    const rows = planRetention("werft-worker", old, new Set(), new Set(), now);
    await expect(
      retainDependencies(rows, async () => {
        throw new Error("registry unavailable");
      }),
    ).rejects.toThrow("registry unavailable");
  });
  for (const bad of [
    { ...version(1), name: "not-a-digest" },
    { ...version(1), updated_at: "bad" },
    { ...version(1), id: 0 },
  ])
    test("malformed versions fail closed", () => {
      expect(() =>
        planRetention("werft-worker", [bad], new Set(), new Set(), now),
      ).toThrow();
    });
  test("duplicate API ids or digests fail closed", () => {
    expect(() =>
      planRetention(
        "werft-worker",
        [version(1), version(1)],
        new Set(),
        new Set(),
        now,
      ),
    ).toThrow();
    expect(() =>
      planRetention(
        "werft-worker",
        [version(1), { ...version(2), name: digest(1) }],
        new Set(),
        new Set(),
        now,
      ),
    ).toThrow();
  });
  test("audit limits versions to the four repository-linked product packages", async () => {
    const paths: string[] = [];
    const api = {
      json(path: string) {
        paths.push(path);
        return path === "repos/example/werft"
          ? { owner: { type: "User" } }
          : { repository: { full_name: "example/werft" } };
      },
      list(path: string) {
        paths.push(path);
        if (path.includes("/releases?")) return [];
        return path.includes("/werft/versions")
          ? old.map((v) =>
              version(v.id, [
                `0.1.0-main-${v.id.toString(16).padStart(12, "0")}`,
              ]),
            )
          : old;
      },
      asset() {
        throw new Error("unexpected asset");
      },
    };
    const rows = await audit("example/werft", api, async () => [], now);
    expect(summarize(rows)).toEqual({
      would_delete: 25,
      keep: 100,
      exceptions: 0,
    });
    expect(new Set(rows.map((r) => r.package))).toEqual(
      new Set([
        "werft-control-host",
        "werft-worker",
        "werft-worker-codex",
        "werft-egress-proxy",
        "werft",
      ]),
    );
    expect(
      paths.filter((p) => p.endsWith("/versions?per_page=100")),
    ).toHaveLength(5);
    // The Codex image's package does not exist before its first release; any
    // other package missing, or another failure, stays an error.
    const absent = (name: string, note = " (HTTP 404)") => ({
      ...api,
      json: (path: string) => {
        if (path.endsWith(`/${name}`))
          throw new Error(`GitHub read failed (1): ${path}${note}`);
        return api.json(path);
      },
    });
    const early = await audit(
      "example/werft",
      absent("werft-worker-codex"),
      async () => [],
      now,
    );
    expect(new Set(early.map((r) => r.package))).toEqual(
      new Set([
        "werft-control-host",
        "werft-worker",
        "werft-egress-proxy",
        "werft",
      ]),
    );
    await expect(
      audit("example/werft", absent("werft-worker"), async () => [], now),
    ).rejects.toThrow("GitHub read failed");
    await expect(
      audit(
        "example/werft",
        absent("werft-worker-codex", ""),
        async () => [],
        now,
      ),
    ).rejects.toThrow("GitHub read failed");
    const wrong = {
      ...api,
      json: () => ({
        owner: { type: "User" },
        repository: { full_name: "other/repository" },
      }),
    };
    await expect(
      audit("example/werft", wrong, async () => [], now),
    ).rejects.toThrow("not linked");
    const missing = {
      ...api,
      list: (path: string) =>
        path.includes("/releases?") ? [{ id: 1, tag_name: "v1.2.3" }] : [],
    };
    await expect(
      audit("example/werft", missing, async () => [], now),
    ).rejects.toThrow("missing or ambiguous");
    const wrongRelease = {
      ...api,
      list: (path: string) =>
        path.includes("/releases?")
          ? [{ id: 1, tag_name: "v1.2.3" }]
          : [{ id: 2, name: "release-manifest.json" }],
      asset: () => ({ tag: "v9.9.9" }),
    };
    await expect(
      audit("example/werft", wrongRelease, async () => [], now),
    ).rejects.toThrow("tag mismatch");
    const unreadable = {
      ...api,
      list: () => {
        throw new Error("GitHub read failed");
      },
    };
    await expect(
      audit("example/werft", unreadable, async () => [], now),
    ).rejects.toThrow("GitHub read failed");
  });
  test("registry reads verify digest bytes and validate every index descriptor", async () => {
    const body = JSON.stringify({
      schemaVersion: 2,
      manifests: [{ digest: digest(1) }],
    });
    const expected = `sha256:${new Bun.CryptoHasher("sha256").update(body).digest("hex")}`;
    const urls: string[] = [];
    const read = registryReader("Example", async (url, headers) => {
      urls.push(url);
      if (url.includes("/token?"))
        return Response.json({ token: "fixture-read-only" });
      expect(headers?.Authorization).toBe("Bearer fixture-read-only");
      return new Response(body);
    });
    expect(await read("werft-worker", expected)).toEqual([digest(1)]);
    expect(await read("werft-worker", expected)).toEqual([digest(1)]);
    expect(urls.filter((url) => url.includes("/token?"))).toHaveLength(1);
    expect(urls[1]).toBe(
      `https://ghcr.io/v2/example/werft-worker/manifests/${expected}`,
    );
    await expect(read("werft-worker", digest(2))).rejects.toThrow(
      "digest mismatch",
    );
    await expect(read("unrelated-package", expected)).rejects.toThrow(
      "invalid registry scope",
    );
    const malformedBody = JSON.stringify({
      schemaVersion: 2,
      manifests: [{ digest: "not-a-digest" }],
    });
    const malformedDigest = `sha256:${new Bun.CryptoHasher("sha256").update(malformedBody).digest("hex")}`;
    const malformed = registryReader("example", async (url) =>
      url.includes("/token?")
        ? Response.json({ token: "fixture-read-only" })
        : new Response(malformedBody),
    );
    await expect(malformed("werft-worker", malformedDigest)).rejects.toThrow(
      "invalid registry child",
    );
  });
  test("workflow grants no package write and cannot activate deletion", () => {
    const root = join(import.meta.dir, "../..");
    const text = readFileSync(
      join(root, ".github/workflows/package-retention.yml"),
      "utf8",
    );
    const w = Bun.YAML.parse(text) as {
      permissions: object;
      on: { workflow_dispatch: { inputs: { dry_run: { default: boolean } } } };
      jobs: Record<
        string,
        { permissions?: object; if?: string; steps: { run?: string }[] }
      >;
    };
    expect(w.permissions).toEqual({ contents: "read" });
    expect(w.on.workflow_dispatch.inputs.dry_run.default).toBe(true);
    expect(w.jobs["dry-run"]?.permissions).toEqual({
      contents: "read",
      packages: "read",
    });
    expect(w.jobs["dry-run"]?.if).toContain(
      "github.event_name != 'pull_request'",
    );
    expect(w.jobs.test?.permissions).toBeUndefined();
    expect(w.jobs.preview?.permissions).toEqual({
      contents: "read",
      packages: "read",
    });
    expect(w.jobs.preview?.if).toBe("github.event_name == 'pull_request'");
    const script = w.jobs["dry-run"]?.steps
      .map((s) => s.run ?? "")
      .join("\n") as string;
    expect(script).toContain('[ "$DRY_RUN" = true ]');
    expect(script).toContain("package-retention.ts --dry-run");
    const refused = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", script], {
      cwd: root,
      env: { ...process.env, DRY_RUN: "false" },
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout.toString()).toContain("dry_run must be true");
    const noMode = Bun.spawnSync([
      process.execPath,
      join(root, ".github/scripts/package-retention.ts"),
    ]);
    expect(noMode.exitCode).toBe(1);
    expect(noMode.stderr.toString()).toContain("only --dry-run is supported");
    expect(
      readFileSync(join(root, ".github/scripts/package-retention.ts"), "utf8"),
    ).not.toMatch(/--method|method:\s*["']DELETE|--delete|deletePackage/);
  });
});
