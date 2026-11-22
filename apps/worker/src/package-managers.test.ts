import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PACKAGE_MANAGER_FILES,
  packageManagerFiles,
  writePackageManagerConfig,
} from "./package-managers.ts";

const ROUTE = "http://egress-proxy:3129";
const TOKEN = "wek_attempt-token";

describe("packageManagerFiles", () => {
  const files = packageManagerFiles(ROUTE, TOKEN);

  test("npm reads the route as its registry with the token as a bearer", () => {
    expect(files.npm).toBe(
      [
        "registry=http://egress-proxy:3129/packages/npm/",
        "//egress-proxy:3129/packages/npm/:_authToken=wek_attempt-token",
        "",
      ].join("\n"),
    );
  });

  test("Bundler mirrors rubygems.org to the route", () => {
    expect(files.bundler).toContain(
      'BUNDLE_MIRROR__HTTPS://RUBYGEMS__ORG/: "http://werft:wek_attempt-token@egress-proxy:3129/packages/rubygems"',
    );
  });

  test("Go has one proxy and no direct, and its checksum database goes through the route", () => {
    const env = Object.fromEntries(
      files.go
        .trim()
        .split("\n")
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    expect(env).toEqual({
      // Go refuses userinfo on an http URL; the route reads this segment.
      GOPROXY: "http://egress-proxy:3129/packages/go/_token/wek_attempt-token",
      GOSUMDB:
        "sum.golang.org http://egress-proxy:3129/packages/gosum/_token/wek_attempt-token",
      GOFLAGS: "-mod=readonly",
    });
    expect(env.GOPROXY).not.toContain(",");
    expect(env.GOPROXY).not.toContain("|");
    expect(Object.keys(env)).not.toContain("GONOSUMDB");
    expect(Object.keys(env)).not.toContain("GOPRIVATE");
    expect(Object.keys(env)).not.toContain("GONOSUMCHECK");
  });

  test("the session's own modules skip the proxy and the checksum database", () => {
    const go = packageManagerFiles(ROUTE, "t", undefined, [
      "github.com/o/a",
      "github.com/o/b",
    ]).go.split("\n");
    expect(go).toContain("GOPRIVATE=github.com/o/a,github.com/o/b");
    expect(go).toContain(
      "GOPROXY=http://egress-proxy:3129/packages/go/_token/t",
    );
  });

  test("a token that would break a URL is escaped", () => {
    const files = packageManagerFiles(ROUTE, "a@b/c");
    expect(files.bundler).toContain(
      "http://werft:a%40b%2Fc@egress-proxy:3129/packages/rubygems",
    );
    expect(files.go).toContain("/packages/go/_token/a%40b%2Fc\n");
  });

  test("GitHub owners send their scopes and Gemfile sources to the GitHub routes", () => {
    const github = packageManagerFiles(ROUTE, "tok", {
      npm: ["acme", "acme-labs"],
      rubygems: ["acme"],
    });
    expect(github.npm).toBe(
      [
        "registry=http://egress-proxy:3129/packages/npm/",
        "//egress-proxy:3129/packages/npm/:_authToken=tok",
        "replace-registry-host=always",
        "@acme:registry=http://egress-proxy:3129/packages/github-npm/",
        "@acme-labs:registry=http://egress-proxy:3129/packages/github-npm/",
        "//egress-proxy:3129/packages/github-npm/:_authToken=tok",
        "",
      ].join("\n"),
    );
    expect(github.bundler).toContain(
      'BUNDLE_MIRROR__HTTPS://RUBYGEMS__PKG__GITHUB__COM/ACME/: "http://werft:tok@egress-proxy:3129/packages/github-rubygems/acme"',
    );
  });

  test("without GitHub owners npm keeps the default tarball hosts", () => {
    expect(packageManagerFiles(ROUTE, "tok").npm).not.toContain(
      "replace-registry-host",
    );
  });
});

describe("writePackageManagerConfig", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "package-managers-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("writes each file under HOME, readable by the worker alone", async () => {
    await writePackageManagerConfig(home, ROUTE, TOKEN);
    for (const relative of Object.values(PACKAGE_MANAGER_FILES)) {
      const path = join(home, relative);
      expect(await readFile(path, "utf8")).toContain(TOKEN);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });
});
