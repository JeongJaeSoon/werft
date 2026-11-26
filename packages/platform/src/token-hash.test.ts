import { describe, expect, test } from "bun:test";
import { hashJudgmentToken } from "./sessions/achievements/judgment-token.ts";
import { hashTitleToken } from "./sessions/session-titler.ts";
import { hashToken } from "./token-hash.ts";
import { hashWorkerToken } from "./workers/worker-gateway.ts";

describe("hashToken", () => {
  // Stored token columns hold these bytes; a change here orphans every row.
  test.each([
    ["hashToken", hashToken],
    ["hashWorkerToken", hashWorkerToken],
    ["hashTitleToken", hashTitleToken],
    ["hashJudgmentToken", hashJudgmentToken],
  ] as const)("%s is the SHA-256 of the token's UTF-8 bytes", (_name, hash) => {
    expect(Buffer.from(hash("abc")).toString("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(Buffer.from(hash("é")).toString("hex")).toBe(
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
    );
  });
});
