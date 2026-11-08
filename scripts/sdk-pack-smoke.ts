/**
 * Installs the packed @werft-ai/sdk into an empty npm project, the way an
 * outside consumer would, and fails unless the tarball carries exactly the
 * files it should, the README example and every sample under examples/
 * type-check with skipLibCheck off, and examples/sdk-approver runs under
 * Node against a fake API.
 *
 *   bun run --cwd packages/sdk build:package
 *   bun scripts/sdk-pack-smoke.ts [--keep]
 *
 * Needs node and npm (the consumer's toolchain, from the npm registry). The
 * project lives under the system temp directory and is removed afterwards
 * unless --keep is given.
 */

import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..");
const PACKAGE_DIR = join(ROOT, "packages/sdk/dist");
const EXAMPLES = join(ROOT, "examples");
// Each sample's runnable files, as a consumer copies them: tests stay behind.
const SAMPLES = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("sdk-"))
  .flatMap((entry) =>
    readdirSync(join(EXAMPLES, entry.name, "src"))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => join(entry.name, file)),
  );
const README = join(ROOT, "packages/sdk/README.md");

const PACKED_FILES = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "index.d.ts",
  "index.js",
  "package.json",
];
const CONSUMER_DEV_DEPENDENCIES = {
  "@types/node": "24.19.2",
  typescript: "5.9.2",
};

const { values: args } = parseArgs({
  options: { keep: { type: "boolean", default: false } },
});

function step(message: string): void {
  console.log(`\n== ${message}`);
}

// Thrown, not process.exit, so the work directory is still removed.
function fail(message: string): never {
  throw new Error(message);
}

async function run(
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  console.log(`$ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, {
    cwd,
    env: env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function mustRun(
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<string> {
  const { code, stdout, stderr } = await run(cmd, cwd, env);
  if (code !== 0) fail(`${cmd[0]} exited ${code}\n${stdout}${stderr}`);
  return stdout;
}

/** The README's first ```ts block, so the example a reader copies is the one checked. */
async function readmeExample(): Promise<string> {
  const text = await Bun.file(README).text();
  const block = text.match(/```ts\n([\s\S]*?)```/);
  if (!block?.[1]) fail(`${README} has no ts example`);
  return block[1];
}

/** Just enough of /v1 for the sample's success path: create, two turns, an approval, close. */
function fakeApi() {
  let answered = false;
  let closed = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const json = (body: unknown, status = 200) =>
        Response.json(body, { status });
      if (path === "/v1/sessions" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.agent_release_id !== "sha256:smoke-release") {
          return json({ error: { code: "BAD_REQUEST", message: "" } }, 400);
        }
        return json(
          { session_id: "smoke-session", turn_id: "1", status: "queued" },
          201,
        );
      }
      if (path.endsWith("/events")) {
        return new Response("", {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (path.includes("/turns/")) {
        const turn_id = path.split("/").at(-1);
        const ended = turn_id === "1" || answered;
        return json({
          turn_id,
          status: ended ? "completed" : "running",
          ended_at: ended ? "2026-10-28T00:00:00Z" : null,
        });
      }
      if (path.endsWith("/pending-requests")) {
        return json({
          items: answered
            ? []
            : [
                {
                  request_id: "smoke-request",
                  kind: "permission",
                  tool: "Bash",
                  input: { command: "echo alpha | tee hello.txt" },
                  created_at: "2026-10-28T00:00:00Z",
                },
              ],
        });
      }
      if (path.endsWith("/answers")) {
        // A deny would also end the turn, so the smoke has to see the action.
        const answer = (await request.json()) as { action?: string };
        if (answer.action !== "allow") {
          return json({ error: { code: "BAD_REQUEST", message: "" } }, 400);
        }
        answered = true;
        return json(
          { receipt_id: "answer-receipt", receipt_status: "accepted" },
          202,
        );
      }
      if (path.endsWith("/messages")) {
        if (closed) {
          return json(
            {
              error: {
                code: "SESSION_CLOSED",
                message: "closed",
                retryable: false,
              },
            },
            409,
          );
        }
        return json({ turn_id: "2", status: "queued" }, 202);
      }
      if (path.endsWith("/close")) {
        closed = true;
        return json(
          { receipt_id: "close-receipt", receipt_status: "accepted" },
          202,
        );
      }
      if (path === "/v1/receipts/close-receipt") {
        return json({
          status: "succeeded",
          operation: "close",
          result: {
            checkpoint_revision: 1,
            cancelled_turn_count: 0,
            resulting_admission_state: "closed",
          },
        });
      }
      return json({
        revision: 1,
        admission_state: closed ? "closed" : "active",
        status: closed ? "stopped" : "running",
      });
    },
  });
  return { server, answered: () => answered };
}

const work = mkdtempSync(join(tmpdir(), "sdk-pack-smoke-"));
const app = join(work, "app");
try {
  step("files the tarball carries");
  const dry = JSON.parse(
    await mustRun(["npm", "pack", "--dry-run", "--json", PACKAGE_DIR], ROOT),
  ) as { files: { path: string }[] }[];
  const packed = (dry[0]?.files ?? []).map((file) => file.path).sort();
  console.log(packed.join("\n"));
  if (packed.join(" ") !== PACKED_FILES.join(" ")) {
    fail(`tarball carries ${packed.join(", ")}; expected ${PACKED_FILES}`);
  }
  for (const file of ["index.js", "index.d.ts"]) {
    const text = await Bun.file(join(PACKAGE_DIR, file)).text();
    if (text.includes("sourceMappingURL"))
      fail(`${file} points at a sourcemap`);
    if (text.includes(ROOT)) fail(`${file} carries the build machine's path`);
  }

  step("pack");
  await mustRun(["npm", "pack", PACKAGE_DIR, "--pack-destination", work], ROOT);
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  if (!tarball) fail("npm pack wrote no tarball");

  step("install into an empty project");
  await Bun.write(
    join(app, "package.json"),
    `${JSON.stringify({ name: "sdk-pack-smoke", private: true, type: "module" }, null, 2)}\n`,
  );
  await Bun.write(
    join(app, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          erasableSyntaxOnly: true,
          verbatimModuleSyntax: true,
          types: ["node"],
        },
        include: ["*.ts", "sdk-*/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  for (const sample of SAMPLES)
    cpSync(
      join(EXAMPLES, dirname(sample), "src", basename(sample)),
      join(app, sample),
    );
  await Bun.write(
    join(app, "readme-example.ts"),
    `${await readmeExample()}export {};\n`,
  );
  await mustRun(
    [
      "npm",
      "install",
      "--no-audit",
      "--no-fund",
      join(work, tarball),
      ...Object.entries(CONSUMER_DEV_DEPENDENCIES).map(
        ([name, version]) => `${name}@${version}`,
      ),
    ],
    app,
  );
  const installed = await Bun.file(
    join(app, "node_modules/@werft-ai/sdk/package.json"),
  ).json();
  const workspaceDeps = Object.keys(installed.dependencies ?? {}).filter(
    (name) => name.startsWith("@werft-ai/"),
  );
  if (workspaceDeps.length > 0) {
    fail(`installed package still depends on ${workspaceDeps}`);
  }
  console.log(
    `installed ${installed.name}@${installed.version} (${installed.license})`,
  );

  step(
    `type-check the README example and ${SAMPLES.length} sample files, skipLibCheck off`,
  );
  await mustRun(["npx", "--no-install", "tsc", "-p", "."], app);

  step("run the sample under Node against a fake API");
  const fake = fakeApi();
  try {
    const { code, stdout, stderr } = await run(
      ["node", "sdk-approver/session-close.ts"],
      app,
      {
        PATH: process.env.PATH ?? "",
        WERFT_BASE_URL: fake.server.url.href,
        WERFT_API_KEY: "smoke-agent-key",
        WERFT_APPROVER_API_KEY: "smoke-approver-key",
        WERFT_AGENT_RELEASE_ID: "sha256:smoke-release",
      },
    );
    console.log(stdout);
    if (code !== 0) fail(`sample exited ${code}\n${stderr}`);
    for (const line of ["turn 2: completed", "409 SESSION_CLOSED"]) {
      if (!stdout.includes(line)) fail(`sample output lacks "${line}"`);
    }
    if (!fake.answered()) fail("sample never answered the permission request");
  } finally {
    await fake.server.stop(true);
  }
  console.log("\nsdk-pack-smoke: ok");
} finally {
  if (args.keep) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
