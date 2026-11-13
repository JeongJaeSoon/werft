import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs next to the verify skill's scripts
import { pkceVerdict } from "../.claude/skills/verify-werft/scripts/pkce-verdict.mjs";
// @ts-expect-error plain .mjs next to the verify skill's scripts
import { parseRunState } from "../.claude/skills/verify-werft/scripts/run-state.mjs";

/**
 * The helpers of the verify-werft skill's Keycloak run: what counts as
 * Keycloak refusing a wrong PKCE verifier, and how the run's state is read.
 */

const script = join(
  import.meta.dir,
  "..",
  ".claude/skills/verify-werft/scripts/pkce-verdict.mjs",
);
const refusal = {
  error: "invalid_grant",
  error_description: "PKCE verification failed: Code mismatch",
};

describe("pkce-verdict.mjs", () => {
  test("Keycloak's own PKCE refusal is the only answer that counts", () => {
    expect(pkceVerdict(400, JSON.stringify(refusal))).toEqual({
      refused: true,
      line: "400 invalid_grant | PKCE verification failed: Code mismatch | tokens: none",
    });
  });

  test("a 400 for another reason is not the refusal", () => {
    for (const body of [
      // A code that was spent or has expired.
      { error: "invalid_grant", error_description: "Code not valid" },
      { error: "invalid_grant", error_description: "Incorrect redirect_uri" },
      { error: "invalid_grant" },
      {
        error: "unauthorized_client",
        error_description: "Invalid client or Invalid client credentials",
      },
      {
        error: "invalid_request",
        error_description: refusal.error_description,
      },
    ]) {
      expect(pkceVerdict(400, JSON.stringify(body)).refused).toBe(false);
    }
  });

  test("the refusal's words under another status, or beside a token, are not it", () => {
    expect(pkceVerdict(401, JSON.stringify(refusal)).refused).toBe(false);
    expect(pkceVerdict(200, JSON.stringify(refusal)).refused).toBe(false);
    for (const token of ["id_token", "access_token", "refresh_token"]) {
      const verdict = pkceVerdict(
        400,
        JSON.stringify({ ...refusal, [token]: "value-not-to-print" }),
      );
      expect(verdict.refused).toBe(false);
      expect(verdict.line).toContain(`tokens: ${token}`);
      expect(verdict.line).not.toContain("value-not-to-print");
    }
  });

  test("a body that is not a JSON object is not the refusal", () => {
    for (const text of ["", "<html>Bad Request</html>", "null", "[]", '"x"']) {
      expect(pkceVerdict(400, text)).toEqual({
        refused: false,
        line: "400 (the body is not a JSON object)",
      });
    }
  });

  test("run as a command it exits 0 for the refusal alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pkce-verdict-"));
    try {
      const exit = async (status: string, body: unknown) => {
        const file = join(dir, "body");
        await writeFile(file, JSON.stringify(body));
        const run = Bun.spawnSync(["node", script, status, file]);
        return [run.exitCode, run.stdout.toString().trim()];
      };

      expect(await exit("400", refusal)).toEqual([
        0,
        "400 invalid_grant | PKCE verification failed: Code mismatch | tokens: none",
      ]);
      expect(
        await exit("400", {
          error: "invalid_grant",
          error_description: "Code not valid",
        }),
      ).toEqual([1, "400 invalid_grant | Code not valid | tokens: none"]);
      expect((await exit("200", { id_token: "value-not-to-print" }))[0]).toBe(
        1,
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("run-state.mjs", () => {
  test("reads plain and exported lines, names with digits, and nothing else", () => {
    expect(
      parseRunState(
        [
          "VERIFY_RUN=/tmp/verify-werft/20261113-000000-1",
          "export COMPOSE_PROJECT_NAME=verify-ap-20261113-000000-1",
          "export OAUTH2_PORT=41234",
          'QUOTED="a b"',
          "URL=http://127.0.0.1:41234/x?y=z",
          "# a comment",
          "lower=ignored",
          "2FA=ignored",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      VERIFY_RUN: "/tmp/verify-werft/20261113-000000-1",
      COMPOSE_PROJECT_NAME: "verify-ap-20261113-000000-1",
      OAUTH2_PORT: "41234",
      QUOTED: "a b",
      URL: "http://127.0.0.1:41234/x?y=z",
    });
  });
});
