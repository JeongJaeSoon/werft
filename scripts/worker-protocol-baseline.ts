/**
 * The worker protocol baseline: the protocol of the oldest worker in the
 * support window, which the contract test holds the current tree to
 * (docs/contributing/decisions/worker-compat.md § 3).
 *
 *   bun scripts/worker-protocol-baseline.ts                 this checkout, release null
 *   bun scripts/worker-protocol-baseline.ts --ref v1.2.3    that tag, from a temporary worktree
 *   bun scripts/worker-protocol-baseline.ts --ref v1.2.3 --check
 *                                                           exit 1 unless the committed file is exactly that
 *
 * --ref installs the tag's own dependencies and reads its own zod, so the
 * schemas are the ones its worker image was built with.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type ContractsModule,
  describeProtocol,
  type Protocol,
  sameProtocol,
} from "./lib/worker-protocol-compat.ts";

export const BASELINE_FILE = join(
  import.meta.dir,
  "..",
  "tests/fixtures/worker-protocol-baseline.json",
);

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

async function describeTree(
  root: string,
  release: string | null,
): Promise<Protocol> {
  const contracts = (await import(
    join(root, "packages/contracts/src/index.ts")
  )) as Partial<ContractsModule>;
  if (!contracts.WORKER_PROTOCOL_ROUTES || !contracts.apiErrorResponseSchema) {
    throw new Error(
      `${release ?? root} has no WORKER_PROTOCOL_ROUTES table; a baseline needs a tree from after the table was introduced`,
    );
  }
  const z = await import(
    Bun.resolveSync("zod", join(root, "packages/contracts"))
  );
  const commit = run("git", ["rev-parse", "HEAD"], root);
  return describeProtocol(contracts as ContractsModule, z, {
    release,
    commit,
  });
}

export function serialize(protocol: Protocol): string {
  return `${JSON.stringify(protocol, null, 2)}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: { ref: { type: "string" }, check: { type: "boolean" } },
  });
  const repo = join(import.meta.dir, "..");
  let protocol: Protocol;
  if (values.ref === undefined) {
    protocol = await describeTree(repo, null);
  } else {
    const ref = values.ref;
    if (!/^v\d+\.\d+\.\d+$/.test(ref)) {
      throw new Error(`--ref takes a release tag like v1.2.3, not ${ref}`);
    }
    const tree = mkdtempSync(join(tmpdir(), "worker-protocol-baseline-"));
    try {
      run(
        "git",
        ["worktree", "add", "--detach", tree, `${ref}^{commit}`],
        repo,
      );
      run("bun", ["install", "--frozen-lockfile"], tree);
      protocol = await describeTree(tree, ref);
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: repo });
      rmSync(tree, { recursive: true, force: true });
    }
  }
  if (values.check) {
    const committed = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
    if (!sameProtocol(committed, protocol)) {
      console.error(
        `${BASELINE_FILE} is not the worker protocol of ${values.ref ?? "this checkout"}. Refresh it in a pull request:\n  bun scripts/worker-protocol-baseline.ts${values.ref ? ` --ref ${values.ref}` : ""}`,
      );
      process.exit(1);
    }
    console.log(`baseline matches ${values.ref ?? "this checkout"}`);
    return;
  }
  writeFileSync(BASELINE_FILE, serialize(protocol));
  console.log(
    `wrote ${BASELINE_FILE} (${protocol.release ?? "unreleased"} ${protocol.commit})`,
  );
}

if (import.meta.main) {
  await main();
}
