#!/usr/bin/env bun
// Prints the test files one unit part of `check` runs, one `./path` per line.
//
// `check` runs the suite without services in parts named after the repo
// layout: `packages-db` is packages/db/, `packages` is the rest of packages/, `worker-web`
// every one under apps/worker/ and apps/web/, `control-slack` the slow Slack fixtures,
// and `rest` every other one. `rest` is the complement by construction,
// so a file cannot fall between the parts, and a new directory the `test`
// filters pick up lands in `rest` rather than nowhere.
//
// usage: unit-part.ts <packages|packages-db|worker-web|control-slack|rest>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discover, testFilters } from "./test-files.ts";

export const PARTS = [
  "packages",
  "packages-db",
  "worker-web",
  "control-slack",
  "rest",
] as const;
export type Part = (typeof PARTS)[number];

export function partOf(path: string): Part {
  if (path.startsWith("packages/db/")) return "packages-db";
  if (path.startsWith("packages/")) return "packages";
  if (path.startsWith("apps/worker/") || path.startsWith("apps/web/")) {
    return "worker-web";
  }
  if (path.startsWith("apps/control-host/src/slack/")) return "control-slack";
  return "rest";
}

export function pick(files: string[], part: Part): string[] {
  const mine = files.filter((path) => partOf(path) === part);
  // `bun test` with no path runs the whole suite, so an empty part would
  // quietly repeat the other parts' work instead of doing nothing.
  if (mine.length === 0) throw new Error(`unit part ${part} has no files`);
  return mine;
}

function main(argv: string[]): void {
  const part = argv[0] as Part;
  if (argv.length !== 1 || !PARTS.includes(part)) {
    console.error(`usage: unit-part.ts <${PARTS.join("|")}>`);
    process.exit(2);
  }

  const cwd = join(import.meta.dir, "..", "..");
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const files = discover(cwd, testFilters(pkg.scripts.test));
  const mine = pick(files, part);

  console.error(`unit part ${part}: ${mine.length} of ${files.length} files`);
  for (const path of mine) console.log(`./${path}`);
}

if (import.meta.main) main(process.argv.slice(2));
