import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GitBundleFixture } from "./git-bundle.ts";

export type GitHttpRequest = {
  authorization: string | null;
  method: string;
  path: string;
};

export type GitHttpServer = {
  /** `http://127.0.0.1:<port>`; repositories are served under it by name. */
  readonly origin: string;
  readonly port: number;
  /** Every request, in arrival order, including refused ones. */
  readonly requests: GitHttpRequest[];
  /** The bare repositories' parent directory. */
  readonly root: string;
  stop(): Promise<void>;
};

export type GitHttpServerOptions = {
  /**
   * The one `Authorization` value the server accepts; anything else gets a
   * 401 with a Basic challenge. Absent, every request is served.
   */
  authorization?: string;
  /** Takes pushes too, as an authenticated http-backend user may. */
  push?: boolean;
};

/**
 * git's smart HTTP, served by `git http-backend` as a CGI behind Bun.serve,
 * for tests that clone over http the way a worker does. receive-pack is off,
 * as http-backend leaves it for unauthenticated users, unless `push` is set.
 */
export async function startGitHttpServer(
  options: GitHttpServerOptions = {},
): Promise<GitHttpServer> {
  const root = await mkdtemp(join(tmpdir(), "testkit-git-http-"));
  const requests: GitHttpRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization");
      requests.push({
        authorization,
        method: request.method,
        path: `${url.pathname}${url.search}`,
      });
      if (
        options.authorization !== undefined &&
        authorization !== options.authorization
      ) {
        return new Response("authentication required\n", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="git"' },
        });
      }
      return await serveGitHttp(
        root,
        request,
        url,
        options.push === true ? { remoteUser: "testkit" } : {},
      );
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    requests,
    root,
    async stop() {
      server.stop(true);
      await rm(root, { force: true, recursive: true });
    },
  };
}

/**
 * A bare repository `<name>.git` under the server's root with one commit on
 * `branch`. With `commitDate`, the commit's sha depends on `files` alone.
 */
export async function createServedRepository(
  server: Pick<GitHttpServer, "root">,
  name: string,
  files: Record<string, string>,
  branch = "main",
  commitDate?: string,
): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "testkit-git-work-"));
  try {
    await runTestGit(["init", "--quiet", "--initial-branch", branch], work);
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(work, path), contents);
    }
    await commitAll(
      work,
      "initial",
      commitDate === undefined
        ? {}
        : { GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate },
    );
    const bare = join(server.root, `${name}.git`);
    await runTestGit(["clone", "--quiet", "--bare", work, bare], server.root);
    return bare;
  } finally {
    await rm(work, { force: true, recursive: true });
  }
}

/**
 * Points `branch` of a served repository at a bundle's commit, so that a
 * checkpoint built on that bundle shares the repository's history.
 */
export async function seedServedBranch(
  server: Pick<GitHttpServer, "root">,
  name: string,
  branch: string,
  bundle: GitBundleFixture,
): Promise<void> {
  const bare = join(server.root, `${name}.git`);
  const file = join(await mkdtemp(join(tmpdir(), "testkit-seed-")), "b.bundle");
  try {
    await Bun.write(file, bundle.bytes);
    await runTestGit(
      ["fetch", "--quiet", file, `+${bundle.ref}:refs/heads/${branch}`],
      bare,
    );
  } finally {
    await rm(dirname(file), { force: true, recursive: true });
  }
}

/**
 * One smart-HTTP request answered by `git http-backend` over `root`. With
 * `remoteUser`, the request counts as authenticated, which is what lets
 * http-backend take a push.
 */
export async function serveGitHttp(
  root: string,
  request: Request,
  url: URL,
  options: { remoteUser?: string } = {},
): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  const child = Bun.spawn(["git", "http-backend"], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      REQUEST_METHOD: request.method,
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.replace(/^\?/, ""),
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
      CONTENT_LENGTH: String(body.byteLength),
      HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
      HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
      REMOTE_ADDR: "127.0.0.1",
      ...(options.remoteUser === undefined
        ? {}
        : { REMOTE_USER: options.remoteUser }),
    },
    stdin: body,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    return new Response(`http-backend exited ${code}: ${stderr}`, {
      status: 500,
    });
  }
  const bytes = new Uint8Array(output);
  const split = indexOfBlankLine(bytes);
  const head = new TextDecoder().decode(bytes.subarray(0, split.at));
  const headers = new Headers();
  let status = 200;
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers.append(name, value);
  }
  return new Response(bytes.subarray(split.at + split.length), {
    status,
    headers,
  });
}

function indexOfBlankLine(bytes: Uint8Array): { at: number; length: number } {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 10 && bytes[i + 1] === 10) return { at: i, length: 2 };
    if (
      bytes[i] === 13 &&
      bytes[i + 1] === 10 &&
      bytes[i + 2] === 13 &&
      bytes[i + 3] === 10
    ) {
      return { at: i, length: 4 };
    }
  }
  return { at: bytes.length, length: 0 };
}

export async function runTestGit(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`,
    );
  }
  return stdout;
}

/** Stages everything in `work` and commits it as testkit. */
export async function commitAll(
  work: string,
  message: string,
  env: Record<string, string> = {},
): Promise<void> {
  await runTestGit(["add", "--all"], work);
  await runTestGit(
    [
      "-c",
      "user.name=testkit",
      "-c",
      "user.email=testkit@example.test",
      "commit",
      "--quiet",
      "-m",
      message,
    ],
    work,
    env,
  );
}
