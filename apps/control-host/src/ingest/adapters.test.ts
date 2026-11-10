import { describe, expect, test } from "bun:test";
import { turnTraceId } from "@werft-ai/observability";
import { hashWorkerToken } from "@werft-ai/platform";
import {
  postgresAttemptAuthenticator,
  postgresTurnTraceDirectory,
} from "./adapters.ts";
import { attemptOf, SESSION } from "./test-support.ts";

const record = {
  sessionId: SESSION,
  attemptId: "att_1",
  executionId: "exe_1",
  executionGeneration: 2,
  workspaceId: null,
  held: true,
  lostForMs: 0,
};

describe("postgresAttemptAuthenticator", () => {
  test("hashes the token and maps a held row", async () => {
    let seen: Uint8Array | undefined;
    const auth = postgresAttemptAuthenticator({
      attemptOfCredential: async (hash) => {
        seen = hash;
        return record;
      },
    });
    const attempt = await auth.authenticate("secret-token");
    expect(seen).toEqual(hashWorkerToken("secret-token"));
    expect(attempt).toMatchObject({
      attemptId: "att_1",
      workspaceId: undefined,
      fence: { state: "held" },
    });
  });

  test("a lost row becomes a loss time relative to the listener's clock", async () => {
    const auth = postgresAttemptAuthenticator(
      {
        attemptOfCredential: async () => ({
          ...record,
          held: false,
          lostForMs: 90_000,
        }),
      },
      { now: () => 1_000_000 },
    );
    const attempt = await auth.authenticate("t");
    expect(attempt?.fence).toEqual({
      state: "lost",
      lostAt: new Date(910_000),
    });
  });

  test("an unknown token is null", async () => {
    const auth = postgresAttemptAuthenticator({
      attemptOfCredential: async () => null,
    });
    expect(await auth.authenticate("nope")).toBeNull();
  });
});

describe("postgresTurnTraceDirectory", () => {
  test("derives each turn's trace id from the session and its sequence", async () => {
    const turns = postgresTurnTraceDirectory({
      turnSequencesOf: async () => [1, 2],
    });
    const ids = await turns.traceIdsOf(attemptOf());
    expect(ids).toEqual(
      new Set([turnTraceId(SESSION, 1), turnTraceId(SESSION, 2)]),
    );
  });
});
