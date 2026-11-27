// The test files `bun run test` runs, found the way Bun finds them, for CI
// scripts that split the suite across jobs and must not drop a file.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Bun's own discovery rule: a `.test`/`_test`/`.spec`/`_spec` suffix on any
// loadable script extension, outside hidden directories and node_modules.
export const TEST_FILE = /(\.test|_test|\.spec|_spec)\.[cm]?[jt]sx?$/;

/**
 * The filters `bun run test` hands to `bun test`, read from package.json.
 * They look like directories, but Bun matches them as substrings of each
 * file's path relative to the repo, so `apps` also takes `xapps-e2e/a.test.ts`.
 */
export function testFilters(script: string): string[] {
  const match = /^bun test((?: [\w.][\w./-]*)+)$/.exec(script.trim());
  if (!match?.[1]) {
    throw new Error(
      `package.json "test" is no longer \`bun test <dirs>\`, so CI cannot tell which files it runs: ${script}`,
    );
  }
  return match[1].trim().split(" ");
}

export function discover(cwd: string, filters: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const item of readdirSync(join(cwd, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (!item.name.startsWith(".") && item.name !== "node_modules") {
          walk(path);
        }
      } else if (
        item.isFile() &&
        TEST_FILE.test(item.name) &&
        filters.some((filter) => path.includes(filter))
      ) {
        files.push(path);
      }
    }
  };
  walk("");
  return files.sort();
}

/** Every file `bun run test` runs in the repository at `cwd`. */
export function suiteFiles(cwd: string): string[] {
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  return discover(cwd, testFilters(pkg.scripts.test));
}
