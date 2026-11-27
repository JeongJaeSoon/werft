#!/usr/bin/env bun
// The D2 gate's result per test, by name. bun's exit status alone
// passes a test that skipped or never ran. The tests are the ones
// .github/integration-domains.yml declares skipped because only
// scripts/d2-gate/run.sh can run them; each must have passed in the given
// junit reports, or the gate fails.
//
// usage: d2-gate-verdict.ts <junit.xml>...

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJobs, readJunit } from "./integration-jobs.ts";

type Result = "PASS" | "FAIL" | "SKIP" | "MISSING";
export type Verdict = { file: string; test: string; result: Result };

/** Every d2-gate test the declaration skips, with its result in the reports. */
export function verdicts(declaration: string, reports: string[]): Verdict[] {
  const results = new Map<string, Result>();
  for (const xml of reports) {
    for (const [testcase] of xml.matchAll(
      /<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g,
    )) {
      for (const { file, test, skipped } of readJunit(testcase)) {
        const failed = /<(failure|error)\b/.test(testcase);
        results.set(
          `${file} > ${test}`,
          failed ? "FAIL" : skipped ? "SKIP" : "PASS",
        );
      }
    }
  }
  return readJobs(declaration)
    .flatMap((job) => job.skips)
    .filter(
      ({ file, test }) =>
        file.startsWith("tests/d2-gate/") && test !== "(unnamed)",
    )
    .map(({ file, test }) => ({
      file,
      test,
      result: results.get(`${file} > ${test}`) ?? "MISSING",
    }));
}

function main(reports: string[]): void {
  if (reports.length === 0) {
    console.error("usage: d2-gate-verdict.ts <junit.xml>...");
    process.exit(2);
  }
  const declaration = readFileSync(
    join(import.meta.dir, "..", "integration-domains.yml"),
    "utf8",
  );
  const all = verdicts(
    declaration,
    // A run that died before writing its report leaves its tests MISSING.
    reports.map((path) => (existsSync(path) ? readFileSync(path, "utf8") : "")),
  );
  if (all.length === 0) {
    console.error(".github/integration-domains.yml declares no d2-gate test");
    process.exit(1);
  }
  console.log("D2 gate verdict:");
  for (const { file, test, result } of all)
    console.log(`${result.padEnd(7)} ${file} > ${test}`);
  const passed = all.filter(({ result }) => result === "PASS").length;
  console.log(`${passed} of ${all.length} passed`);
  if (passed !== all.length) process.exit(1);
}

if (import.meta.main) main(process.argv.slice(2));
