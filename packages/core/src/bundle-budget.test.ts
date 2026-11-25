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
  // The turn requester and skill check finding schemas together put ./forms
  // 469 bytes over 145, so it moves to 146. The Slack channel lifecycle
  // events, the binding status gone and the conversation's channel state and
  // name put ./schemas 65 bytes over 148, so it moves to 149. The GitHub
  // tool descriptions that name git switch -c put ./forms 223 bytes over 146,
  // so it moves to 147. The sign-in attempt kinds and the lock_login receipt
  // with the Slack allowed bots receipt put ./schemas 1 byte over 149, so it
  // moves to 150. The conversation runtime's turn protocol put ./forms 86
  // bytes over 147, so it moves to 148. The agent list's activation and the
  // counts' inactive put ./schemas 87 bytes over 150, so it moves to 151.
  // The session's capacity wait fields and the no-capacity turn and notice
  // keys put ./forms 64 bytes over 148, so it moves to 149. The Slack
  // channel's hourly M1 cap and the agent's M1 judgment records put
  // ./schemas 271 bytes over 151, so it moves to 152. The Slack tab's
  // instruction branch head read put ./forms 52 bytes over 149, so it moves
  // to 150.
  "./schemas": 152 * 1024,
  "./forms": 150 * 1024,
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
