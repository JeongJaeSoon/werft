import { describe, expect, test } from "bun:test";
import type { BootstrapClaimResponse } from "@werft-ai/contracts";
import { claimSecrets, SCRUBBED, SecretScrubber } from "./secret-scrubber.ts";

describe("claimSecrets", () => {
  test("holds the remote MCP route's token beside the others", () => {
    const claim = {
      session_credential: "wsc_1",
      runtime_config: {
        provider: { auth: { token: "wep_1" } },
        mcp_servers: [{ name: "fake", access: { token: "wem_1" } }],
      },
      workspace: { repository: {} },
      object_store: { access: { token: "weo_1" } },
      packages: { access: { token: "packages-token" } },
    } as unknown as BootstrapClaimResponse;
    expect(claimSecrets(claim, "nonce")).toContain("wem_1");
  });

  test("holds an attached repository's token when the session has no repository", () => {
    const claim = {
      session_credential: "wes_1",
      runtime_config: { provider: { auth: { token: "wep_1" } } },
      workspace: {
        repository: null,
        additional_repositories: [
          { id: "docs", access: { kind: "egress_token", token: "wer_1" } },
        ],
      },
      object_store: { access: { token: "weo_1" } },
      packages: { access: { token: "packages-token" } },
    } as unknown as BootstrapClaimResponse;
    expect(claimSecrets(claim, "nonce")).toContain("wer_1");
  });
});

describe("SecretScrubber", () => {
  test("replaces each known value wherever it sits, keys included", () => {
    const scrubber = new SecretScrubber([
      "token-abcdefgh",
      "token-abcdefgh-longer",
      null,
      undefined,
    ]);
    expect(
      scrubber.scrub<Record<string, unknown>>({
        text: "a token-abcdefgh-longer and token-abcdefgh",
        list: ["x token-abcdefgh y", 3, null, true],
        "token-abcdefgh": { nested: "token-abcdefgh" },
      }),
    ).toEqual({
      text: `a ${SCRUBBED} and ${SCRUBBED}`,
      list: [`x ${SCRUBBED} y`, 3, null, true],
      [SCRUBBED]: { nested: SCRUBBED },
    });
  });

  test("a short value goes wherever it stands alone, as in an environment dump", () => {
    // The local stack's keys are `test`: dropped for being short, such a
    // value would reach the event stream through /proc/1/environ.
    const scrubber = new SecretScrubber(["test", "a.b"]);
    expect(
      scrubber.scrub([
        "AWS_SECRET_ACCESS_KEY=test\0HOME=/home/worker",
        "key: test",
        "testing the tests, a.b and axb",
      ]),
    ).toEqual([
      `AWS_SECRET_ACCESS_KEY=${SCRUBBED}\0HOME=/home/worker`,
      `key: ${SCRUBBED}`,
      `testing the tests, ${SCRUBBED} and axb`,
    ]);
  });

  test("with nothing to hide it changes nothing", () => {
    const value = { a: ["b", { c: "d" }] };
    expect(new SecretScrubber([]).scrub(value)).toEqual(value);
  });
});
