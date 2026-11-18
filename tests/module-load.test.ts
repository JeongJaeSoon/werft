import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

// Modules in platform and db import each other in cycles, so which module a
// process loads first decides evaluation order. A top-level read of a binding
// from a module still evaluating throws only for some entry points, and the
// test suite's own load order can hide it. Each file is an entry point here.
const packages = ["packages/platform/src", "packages/db/src"];

async function sourceFiles(): Promise<string[]> {
  const listed = await new Response(
    Bun.spawn(["git", "ls-files", ...packages], { cwd: root }).stdout,
  ).text();
  return listed
    .split("\n")
    .filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !/\.test\.tsx?$|\.d\.ts$/.test(file) &&
        !file.includes("/testing/"),
    );
}

async function loadFailure(file: string): Promise<string | null> {
  const child = Bun.spawn(
    [process.execPath, "-e", `await import("./${file}")`],
    {
      cwd: root,
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code === 0) return null;
  const reason = stderr.split("\n").find((line) => /error/i.test(line));
  return `${file}: ${reason ?? `exit ${code}`}`;
}

test("every platform and db source file loads as the first module of a process", async () => {
  const pending = await sourceFiles();
  expect(pending.length).toBeGreaterThan(0);
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let file = pending.pop(); file; file = pending.pop()) {
        const failure = await loadFailure(file);
        if (failure) failures.push(failure);
      }
    }),
  );
  expect(failures.sort()).toEqual([]);
}, 120_000);
