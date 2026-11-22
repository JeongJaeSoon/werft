import { expect, test } from "bun:test";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

// Minified and gzipped, as a browser downloads each entry on its own. The
// schemas and forms entries each carry zod and every contracts module: the
// contracts are not marked side-effect free, so a bundler keeps all of them.
const BUDGET_BYTES: Record<string, number> = {
  ".": 4 * 1024,
  // 141 KiB: the agent engine settings storage schemas and their validator
  // (4c) put ./schemas 141 bytes over 139, then raised it to 140. The tool call
  // audit report schemas put it 38 bytes over that, and ./forms 243 bytes over
  // its 139, so ./forms moves to 140. The session event archive settings
  // put ./schemas 2 bytes over 141, so it moves to 142. The agent list's
  // engine and channels and the session's turn time put it 26 bytes over 142,
  // so it moves to 143. The input-only validation schemas (trimmed names,
  // non-blank messages and answers, the allow-list rules) put ./forms 416
  // bytes over 140, so it moves to 141. The takeover list's agent and its
  // filter put ./schemas 58 bytes over 143, so it moves to 144. The agent's
  // published flag and the preview session fields put ./forms 416 bytes over
  // 141, so it moves to 142. The skill API's schemas put ./schemas 499 bytes
  // over 144 and ./forms 298 bytes over 142, so they move to 145 and 143.
  // The Git skill source and sync schemas put ./schemas 487 bytes over 145
  // and ./forms 257 bytes over 143, so they move to 146 and 144. The access
  // decision ask and result schemas put ./schemas 653 bytes over 146 and
  // ./forms 317 bytes over 144, so they move to 147 and 145. The Slack bot
  // allow list schemas put ./schemas 80 bytes over 147, so it moves to 148.
  // The turn requester schemas put ./forms 155 bytes over 145, so it moves
  // to 146.
  "./schemas": 148 * 1024,
  "./forms": 146 * 1024,
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
