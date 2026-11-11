import { describe, expect, test } from "bun:test";
import type { GitHubPackagesAllowEntry } from "@werft-ai/contracts";
import {
  allowedOwners,
  allowedRead,
  entriesFor,
  githubPackageReadOf,
  isGitHubNpmTarball,
} from "./github-packages.ts";

const entry = (
  fields: Partial<GitHubPackagesAllowEntry> &
    Pick<GitHubPackagesAllowEntry, "registry" | "owner" | "name">,
): GitHubPackagesAllowEntry => ({
  repository_id: null,
  agent_id: null,
  ...fields,
});

describe("githubPackageReadOf: npm", () => {
  test("reads metadata, GitHub's tarball and the public layout's tarball", () => {
    expect(githubPackageReadOf("npm", "/@acme%2fui")).toEqual({
      registry: "npm",
      owner: "acme",
      kind: "package",
      name: "ui",
      version: null,
    });
    expect(githubPackageReadOf("npm", "/@acme%2Fui")?.kind).toBe("package");
    expect(githubPackageReadOf("npm", "/@acme/ui")?.kind).toBe("package");
    expect(
      githubPackageReadOf("npm", "/download/@acme/ui/1.2.3/0a1b2c3d4e5f"),
    ).toMatchObject({ owner: "acme", name: "ui", version: "1.2.3" });
    expect(
      githubPackageReadOf("npm", "/@acme/ui/-/ui-2.0.0-rc.1.tgz"),
    ).toMatchObject({ name: "ui", version: "2.0.0-rc.1" });
  });

  test("anything else is not recognized", () => {
    for (const path of [
      "/left-pad",
      "/@acme%2fui?write=true",
      "/@acme/ui/-/other-1.0.0.tgz",
      "/-/whoami",
      "/-/npm/v1/security/advisories/bulk",
      "/@acme/ui/extra",
      "/download/@acme/ui/1.0.0/not-hex!",
      "/@-acme/ui",
    ]) {
      expect(githubPackageReadOf("npm", path)).toBeNull();
    }
  });

  test("only GitHub's tarball shape is taken from the public npm route", () => {
    expect(isGitHubNpmTarball("/download/@acme/ui/1.0.0/abcdef")).toBe(true);
    expect(isGitHubNpmTarball("/download/-/download-8.0.0.tgz")).toBe(false);
    expect(isGitHubNpmTarball("/download")).toBe(false);
  });
});

describe("githubPackageReadOf: rubygems", () => {
  test("reads the owner's indexes, one gem's info, gem files and the dependency API", () => {
    for (const path of [
      "/acme/versions",
      "/acme/specs.4.8.gz",
      "/acme/latest_specs.4.8.gz",
      "/acme/prerelease_specs.4.8.gz",
    ]) {
      expect(githubPackageReadOf("rubygems", path)).toEqual({
        registry: "rubygems",
        owner: "acme",
        kind: "index",
      });
    }
    expect(
      githubPackageReadOf("rubygems", "/acme/info/acme-auth"),
    ).toMatchObject({ kind: "package", name: "acme-auth", version: null });
    expect(
      githubPackageReadOf("rubygems", "/acme/gems/acme-auth-1.0.0.gem"),
    ).toEqual({
      registry: "rubygems",
      owner: "acme",
      kind: "gem_file",
      file: "acme-auth-1.0.0",
    });
    expect(
      githubPackageReadOf(
        "rubygems",
        "/acme/quick/Marshal.4.8/acme-auth-1.0.0.gemspec.rz",
      ),
    ).toMatchObject({ kind: "gem_file", file: "acme-auth-1.0.0" });
    expect(
      githubPackageReadOf(
        "rubygems",
        "/acme/api/v1/dependencies?gems=acme-auth,acme-db",
      ),
    ).toMatchObject({ kind: "gems", names: ["acme-auth", "acme-db"] });
  });

  test("anything else is not recognized", () => {
    for (const path of [
      "/acme",
      "/acme/versions?x=1",
      "/acme/api/v1/dependencies",
      "/acme/api/v1/dependencies?gems=a&other=b",
      // An upstream may answer for the last value, which nothing checked.
      "/acme/api/v1/dependencies?gems=a&gems=b",
      "/acme/api/v1/gems",
      "/acme/gems/../x.gem",
    ]) {
      expect(githubPackageReadOf("rubygems", path)).toBeNull();
    }
  });
});

describe("allowedRead", () => {
  const all = [entry({ registry: "npm", owner: "Acme", name: "*" })];
  const one = [
    entry({ registry: "rubygems", owner: "acme", name: "acme-auth" }),
  ];

  test("an owner's `*` allows its every package, owners compared case-insensitively", () => {
    const read = githubPackageReadOf("npm", "/@acme%2fui");
    expect(read && allowedRead(read, all)).toEqual({
      name: "ui",
      version: null,
    });
    const other = githubPackageReadOf("npm", "/@other%2fui");
    expect(other && allowedRead(other, all)).toBeNull();
    // The same owner on the other registry is another entry.
    const gem = githubPackageReadOf("rubygems", "/acme/info/ui");
    expect(gem && allowedRead(gem, all)).toBeNull();
  });

  test("a named gem allows its info and files, not another gem that shares its prefix", () => {
    const allowed = (path: string) => {
      const read = githubPackageReadOf("rubygems", path);
      return read && allowedRead(read, one);
    };
    expect(allowed("/acme/info/acme-auth")).toEqual({
      name: "acme-auth",
      version: null,
    });
    expect(allowed("/acme/gems/acme-auth-1.2.0.gem")).toEqual({
      name: "acme-auth",
      version: "1.2.0",
    });
    expect(allowed("/acme/gems/acme-auth-extra-1.0.0.gem")).toBeNull();
    // Gems `acme-auth-2fa` and `acme-auth-2`, not versions of `acme-auth`.
    expect(allowed("/acme/gems/acme-auth-2fa-1.0.0.gem")).toBeNull();
    expect(
      allowed("/acme/quick/Marshal.4.8/acme-auth-2fa-1.0.0.gemspec.rz"),
    ).toBeNull();
    expect(allowed("/acme/gems/acme-auth-2-1.0.0.gem")).toBeNull();
    expect(allowed("/acme/gems/acme-auth-1.2.0-x86_64-linux.gem")).toEqual({
      name: "acme-auth",
      version: "1.2.0-x86_64-linux",
    });
    expect(allowed("/acme/info/acme-db")).toBeNull();
    // The owner's index lists names only; any entry for the owner opens it.
    expect(allowed("/acme/specs.4.8.gz")).toEqual({
      name: null,
      version: null,
    });
    expect(allowed("/other/specs.4.8.gz")).toBeNull();
    expect(allowed("/acme/api/v1/dependencies?gems=acme-auth")).not.toBeNull();
    expect(
      allowed("/acme/api/v1/dependencies?gems=acme-auth,acme-db"),
    ).toBeNull();
  });
});

describe("entriesFor", () => {
  test("an entry narrowed to a repository or agent applies only to its sessions", () => {
    const list = [
      entry({ registry: "npm", owner: "acme", name: "a" }),
      entry({
        registry: "npm",
        owner: "acme",
        name: "b",
        repository_id: "web",
      }),
      entry({
        registry: "npm",
        owner: "acme",
        name: "c",
        agent_id: "00000000-0000-4000-8000-000000000001",
      }),
    ];
    const names = (repositoryId: string | null, agentId: string | null) =>
      entriesFor(list, { repositoryId, agentId }).map((e) => e.name);
    expect(names(null, null)).toEqual(["a"]);
    expect(names("web", null)).toEqual(["a", "b"]);
    expect(names("api", "00000000-0000-4000-8000-000000000001")).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("allowedOwners", () => {
  test("names each owner once per registry, lowercased", () => {
    expect(
      allowedOwners([
        entry({ registry: "npm", owner: "Acme", name: "a" }),
        entry({ registry: "npm", owner: "acme", name: "b" }),
        entry({ registry: "rubygems", owner: "acme-gems", name: "*" }),
      ]),
    ).toEqual({ npm: ["acme"], rubygems: ["acme-gems"] });
  });
});
