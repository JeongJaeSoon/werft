import { expect, test } from "bun:test";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

// Minified and gzipped, as a browser downloads each entry on its own. The
// schemas and forms entries each carry zod and every contracts module: the
// contracts are not marked side-effect free, so a bundler keeps all of them.
const BUDGET_BYTES: Record<string, number> = {
  ".": 4 * 1024,
  "./schemas": 138 * 1024,
  "./forms": 138 * 1024,
};

test("every entry has a budget", () => {
  expect(Object.keys(packageJson.exports).sort()).toEqual(
    Object.keys(BUDGET_BYTES).sort(),
  );
});

for (const [entry, file] of Object.entries(packageJson.exports)) {
  test(`${entry} stays within its bundle budget`, async () => {
    // In its own process: after another suite's Bun.build in the same run
    // (openapi.test.ts), Bun 1.3.14 fails this one with EISDIR.
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        join(import.meta.dir, "..", file),
        "--target=browser",
        "--minify",
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const code = await new Response(build.stdout).text();
    expect(await build.exited).toBe(0);
    const gzip = Bun.gzipSync(code).length;
    const budget = BUDGET_BYTES[entry] ?? 0;
    console.log(
      `bundle budget ${entry}: ${gzip} / ${budget} bytes gzip (${code.length} minified)`,
    );
    expect(gzip).toBeLessThanOrEqual(budget);
  });
}
