import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// The platform packages `@openai/codex` lists as exact optional dependencies,
// by the target triple their binary is built for (bin/codex.js in the package
// holds the same table; the Linux builds are static musl).
const TARGETS: Record<string, { triple: string; pkg: string }> = {
  "linux-x64": {
    triple: "x86_64-unknown-linux-musl",
    pkg: "@openai/codex-linux-x64",
  },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-musl",
    pkg: "@openai/codex-linux-arm64",
  },
  "darwin-x64": {
    triple: "x86_64-apple-darwin",
    pkg: "@openai/codex-darwin-x64",
  },
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    pkg: "@openai/codex-darwin-arm64",
  },
};

/**
 * The native `codex` executable of the installed `@openai/codex`, resolved
 * from the dependency itself and never from `PATH`: the version the image
 * pins is the version the adapter runs. The package's `bin/codex.js` only
 * spawns this file, so skipping it keeps Node out of the worker's process
 * tree.
 */
export function codexExecutable(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const target = TARGETS[`${platform}-${arch}`];
  if (target === undefined) {
    throw new Error(`Codex has no build for ${platform} on ${arch}`);
  }
  const here = createRequire(import.meta.url);
  const codexPackage = here.resolve("@openai/codex/package.json");
  const platformPackage = createRequire(codexPackage).resolve(
    `${target.pkg}/package.json`,
  );
  const executable = join(
    dirname(platformPackage),
    "vendor",
    target.triple,
    "bin",
    "codex",
  );
  if (!existsSync(executable)) {
    throw new Error(`The Codex executable is missing at ${executable}`);
  }
  return executable;
}
