/**
 * Run at image build, through the registry's `image:verify`: resolves the
 * Codex executable exactly the way the runtime does at run time, so the build
 * fails if the package stops shipping it for this arch, and prints the version
 * of that very file. The build also fails when it is not the pinned one.
 */
import { accessSync, constants } from "node:fs";
import { CODEX_CLI_VERSION } from "@werft-ai/runtime-codex-codec";

import { codexExecutable } from "./binary.ts";

const target = codexExecutable();
accessSync(target, constants.X_OK);

const run = Bun.spawnSync([target, "--version"], {
  stdout: "pipe",
  stderr: "inherit",
});
const text = run.stdout.toString().trim();
console.log(`${target}: ${text}`);
if (run.exitCode !== 0 || !text.endsWith(CODEX_CLI_VERSION)) {
  throw new Error(
    `Expected Codex ${CODEX_CLI_VERSION}, the executable says "${text}"`,
  );
}
