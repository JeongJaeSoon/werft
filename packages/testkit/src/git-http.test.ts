import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServedRepository,
  type GitHttpServer,
  runTestGit,
  startGitHttpServer,
} from "./git-http.ts";

const started: GitHttpServer[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const server of started.splice(0)) await server.stop();
  for (const dir of scratch.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

describe("serveGitHttp", () => {
  test("refuses a push without a remote user and keeps the served head", async () => {
    const server = await startGitHttpServer();
    started.push(server);
    const bare = await createServedRepository(server, "app", {
      "README.md": "# app\n",
    });
    const head = (
      await runTestGit(["rev-parse", "refs/heads/main"], bare)
    ).trim();
    const dir = await mkdtemp(join(tmpdir(), "testkit-git-http-test-"));
    scratch.push(dir);
    const url = `${server.origin}/app.git`;
    await runTestGit(["clone", "--quiet", url, "work"], dir);
    const work = join(dir, "work");
    await Bun.write(join(work, "change.txt"), "change\n");
    await runTestGit(["add", "change.txt"], work);
    await runTestGit(
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        "commit",
        "-qm",
        "c",
      ],
      work,
    );

    await expect(
      runTestGit(["push", "origin", "main"], work),
    ).rejects.toThrow();
    const direct = await fetch(`${url}/git-receive-pack`, {
      method: "POST",
      headers: { "content-type": "application/x-git-receive-pack-request" },
      body: "0000",
    });
    expect(direct.status).toBe(403);

    expect(
      server.requests.some((r) => r.path.includes("git-receive-pack")),
    ).toBe(true);
    expect(
      (await runTestGit(["ls-remote", url, "refs/heads/main"], dir)).split(
        "\t",
      )[0],
    ).toBe(head);
  });
});
