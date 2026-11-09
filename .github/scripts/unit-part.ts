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
// The web plan excludes surface-owned files; manual checks keep the full suite.
// usage: unit-part.ts <matrix|packages|packages-db|worker-web|control-slack|rest> [--exclude-surface]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assign, readJobs } from "./integration-jobs.ts";
import { suiteFiles } from "./test-files.ts";

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

export const LABELS: Record<Part, string> = {
  packages: "unit: packages",
  "packages-db": "unit: db",
  "worker-web": "unit: worker, web",
  "control-slack": "unit: control Slack",
  rest: "unit: other apps, tests",
};

export function withoutSurface(files: string[], workflow: string): string[] {
  const ownership = assign(files, readJobs(workflow));
  const surface = ownership.get("surface");
  if (!surface) throw new Error("integration matrix has no surface domain");
  const excluded = new Set(surface);
  return files.filter((path) => !excluded.has(path));
}

export function matrix(files: string[]) {
  return PARTS.filter((unit) =>
    files.some((path) => partOf(path) === unit),
  ).map((unit) => ({ part: LABELS[unit], unit }));
}

function main(argv: string[]): void {
  const [command, option] = argv;
  if (
    command === undefined ||
    (command !== "matrix" && !PARTS.includes(command as Part)) ||
    argv.length > 2 ||
    (option !== undefined && option !== "--exclude-surface")
  ) {
    console.error(
      `usage: unit-part.ts <matrix|${PARTS.join("|")}> [--exclude-surface]`,
    );
    process.exit(2);
  }

  const cwd = join(import.meta.dir, "..", "..");
  const all = suiteFiles(cwd);
  const files = option
    ? withoutSurface(
        all,
        readFileSync(join(cwd, ".github/workflows/ci.yml"), "utf8"),
      )
    : all;
  if (command === "matrix") {
    const entries = matrix(files);
    if (entries.length === 0) throw new Error("unit matrix has no files");
    console.log(JSON.stringify(entries));
    return;
  }
  const mine = pick(files, command as Part);
  console.error(`unit part ${command}: ${mine.length} of ${all.length} files`);
  for (const path of mine) console.log(`./${path}`);
}

if (import.meta.main) main(process.argv.slice(2));
