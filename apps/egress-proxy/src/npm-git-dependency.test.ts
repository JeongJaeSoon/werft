import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyLogger } from "./logger.ts";
import { type EgressProxyServer, startEgressProxy } from "./proxy.ts";

/**
 * Real npm behind the proxy, for a GitHub git dependency. npm asks
 * codeload.github.com for a tarball first and falls back to `git clone`
 * only when that fails with an HTTP error: the 403 the proxy answers a
 * refused CONNECT with is replayed to npm as the response. A refusal that
 * dropped the connection instead would fail the whole install. The clone
 * then reaches an attached repository through the engine's `insteadOf`,
 * here a local bare repository standing in for the repository route.
 */
const npm = Bun.which("npm");

async function run(
  command: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: stdout + stderr };
}

// CI has npm on the runner; a machine without it skips rather than fails.
describe.skipIf(npm === null && process.env.CI === undefined)(
  "npm's GitHub git dependency behind the egress proxy",
  () => {
    const warnings: string[] = [];
    let dir: string;
    let sha: string;
    let proxy: EgressProxyServer;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "npm-git-dep-"));
      const source = join(dir, "source");
      const git = ["git", "-c", "init.defaultBranch=main"];
      expect(
        (await run([...git, "init", "-q", source], { cwd: dir })).code,
      ).toBe(0);
      await writeFile(
        join(source, "package.json"),
        '{"name":"dep","version":"1.0.0"}\n',
      );
      const author = [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
      ];
      await run(["git", "add", "package.json"], { cwd: source });
      await run(["git", ...author, "commit", "-qm", "dep"], { cwd: source });
      sha = (
        await run(["git", "rev-parse", "HEAD"], { cwd: source })
      ).output.trim();
      await run(
        ["git", "clone", "-q", "--bare", source, join(dir, "dep.git")],
        {
          cwd: dir,
        },
      );
      proxy = await startEgressProxy({
        logger: createProxyLogger("warn", (line) => warnings.push(line)),
        policy: { allow: [], allowPrivate: [] },
        port: 0,
        resolve: async (host) => {
          throw new Error(`no lookup expected for ${host}`);
        },
      });
    });

    afterAll(async () => {
      proxy?.stop();
      await rm(dir, { recursive: true, force: true });
    });

    async function install(name: string, repository: string) {
      const app = join(dir, name);
      const home = join(dir, `${name}-home`);
      await run(["mkdir", "-p", app, home], { cwd: dir });
      await writeFile(
        join(app, "package.json"),
        JSON.stringify({
          name,
          version: "1.0.0",
          dependencies: {
            dep: `git+https://github.com/${repository}.git#${sha}`,
          },
        }),
      );
      // The worker writes one insteadOf per attached repository; only
      // acme/dep is attached here.
      const gitconfig = join(home, "gitconfig");
      await writeFile(
        gitconfig,
        `[url "file://${join(dir, "dep.git")}"]\n\tinsteadOf = https://github.com/acme/dep.git\n`,
      );
      const via = `http://127.0.0.1:${proxy.port}`;
      warnings.length = 0;
      const result = await run(
        [
          npm ?? "npm",
          "install",
          "--no-audit",
          "--no-fund",
          "--cache",
          join(home, "cache"),
          "--registry",
          "http://127.0.0.1:9/",
        ],
        {
          cwd: app,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            GIT_CONFIG_GLOBAL: gitconfig,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
            // npm tries SSH after HTTPS; a worker network has no route for
            // it, and a test must not reach github.com either.
            GIT_SSH_COMMAND: "false",
            HTTPS_PROXY: via,
            https_proxy: via,
            npm_config_update_notifier: "false",
          },
        },
      );
      return { app, ...result };
    }

    // Exact host: a substring match would let codeload.github.com stand in
    // for github.com.
    const denied = (host: string) =>
      warnings.some((line) => {
        const record = JSON.parse(line) as {
          message?: string;
          fields?: { host?: unknown };
        };
        return (
          record.message === "Egress denied" && record.fields?.host === host
        );
      });

    test("an attached repository's dependency installs through git once codeload is refused", async () => {
      const { app, code, output } = await install("attached", "acme/dep");
      expect({ code, output }).toMatchObject({ code: 0 });
      expect(
        JSON.parse(
          await readFile(join(app, "node_modules/dep/package.json"), "utf8"),
        ),
      ).toEqual({ name: "dep", version: "1.0.0" });
      expect(denied("codeload.github.com")).toBe(true);
    }, 60_000);

    test("an unattached repository's dependency fails, codeload and github.com both refused", async () => {
      const { code } = await install("unattached", "acme/other");
      expect(code).not.toBe(0);
      expect(denied("codeload.github.com")).toBe(true);
      expect(denied("github.com")).toBe(true);
    }, 60_000);
  },
);
