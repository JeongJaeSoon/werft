import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { imageRuntime } from "../../apps/worker/src/composition.ts";

const root = join(import.meta.dir, "../..");
const json = (path: string) =>
  JSON.parse(readFileSync(join(root, path), "utf8"));

const SDK = "@anthropic-ai/claude-agent-sdk";
const ADAPTER = "packages/adapters/runtimes/claude";

// The conversation runtime starts the same engine a session worker does: the
// one runtime the image installs. What the compat harness says of that engine
// holds for this runtime only while it stays the exact, unpatched version the
// adapter pins.
test("the conversation runtime's engine is the SDK the adapter pins exactly, installed as published", () => {
  const pinned = json(`${ADAPTER}/package.json`).dependencies[SDK];
  expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);

  const installed = JSON.parse(
    readFileSync(
      Bun.resolveSync(`${SDK}/package.json`, join(root, ADAPTER)),
      "utf8",
    ),
  );
  expect(installed.version).toBe(pinned);
  expect(JSON.parse(imageRuntime().imageFingerprint()).sdkVersion).toBe(pinned);

  // The worker adds no SDK of its own beside the adapter's, and none is patched.
  const worker = json("apps/worker/package.json");
  expect(Object.keys(worker.dependencies ?? {})).not.toContain(SDK);
  const patched = Object.keys(json("package.json").patchedDependencies ?? {});
  expect(patched.filter((name) => name.startsWith("@anthropic-ai/"))).toEqual(
    [],
  );
});
