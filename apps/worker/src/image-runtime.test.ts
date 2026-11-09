import { describe, expect, test } from "bun:test";
import { realRuntimeFor } from "@werft-ai/runtime-registry/testing";

import { claimFingerprint } from "./composition.ts";
import { imageRuntimeOf } from "./image-runtime.ts";

const claim = {
  principal: { owner_scope: "owner-a" },
  runtime_config: {
    model: "claude-sonnet-5",
    tools: ["Read", "Edit"],
    permission_mode: "default" as const,
    provider: {
      kind: "anthropic" as const,
      endpoint: "http://fake-messages:4010",
      auth: { kind: "egress_token" as const, token: "[REDACTED]" },
    },
  },
};

// Scheme 2 (no permission mode in the digest) and the scheme 1 digest of the
// same claim, which a scheme 1 image stamped checkpoints with.
const NO_MCP_FINGERPRINT =
  "998a3b68fed08cf002b7f02d3f0a7ffdb6c513a01cf5a1cb57106daf667f02b3";
const NO_MCP_FINGERPRINT_SCHEME_1 =
  "d12b869e3f65a58193274b04ea1ab40d3cfd962a4d82e38b4f3f63190c2ef186";

describe("imageRuntimeOf", () => {
  test("stamps each claim with the digest a worker on any host computes for it", () => {
    const onAHost = claimFingerprint({
      egressCredentialUrl: "http://egress-proxy:3129",
      runtime: {
        claudeConfigDir: "/home/worker/.claude",
        cwd: "/srv/workspace",
        home: "/home/worker",
        providerMaxRetries: 2,
      },
    })(claim);

    const { profiles, ...build } = imageRuntimeOf({ s1: claim });
    expect(build).toEqual(
      JSON.parse(realRuntimeFor("claude_agent_sdk").imageFingerprint()),
    );
    // The legacy digest is what a worker sends as an alternate when it
    // restores a checkpoint made under the frozen pre-strip prompt; a claim
    // without the paragraph hashes the same either way.
    expect(profiles).toEqual({
      s1: {
        profileSha256: onAHost.profileSha256,
        legacyProfileSha256: onAHost.profileSha256,
        // What scheme 1 images stamped, with and without the frozen prompt.
        earlierSchemeProfileSha256s: [
          NO_MCP_FINGERPRINT_SCHEME_1,
          NO_MCP_FINGERPRINT_SCHEME_1,
        ],
      },
    });
    expect(onAHost.profileSha256).toBe(NO_MCP_FINGERPRINT);
  });

  test("a remote MCP server is fingerprinted by its binding, never its token", () => {
    const fingerprint = claimFingerprint({
      egressCredentialUrl: "http://egress-proxy:3129",
      runtime: {
        claudeConfigDir: "/home/worker/.claude",
        cwd: "/srv/workspace",
        home: "/home/worker",
        providerMaxRetries: 2,
      },
    });
    const withMcp = (binding: string, token: string) =>
      fingerprint({
        ...claim,
        runtime_config: {
          ...claim.runtime_config,
          tools: [...claim.runtime_config.tools, "mcp__fake__whoami"],
          mcp_servers: [
            {
              name: "fake",
              endpoint: "http://fake-mcp:4020/mcp",
              binding,
              access: { kind: "egress_token" as const, token },
            },
          ],
        },
      }).profileSha256;
    const one = `sha256:${"1".repeat(64)}`;
    const two = `sha256:${"2".repeat(64)}`;
    expect(withMcp(one, "wem_a")).toBe(withMcp(one, "wem_b"));
    expect(withMcp(one, "wem_a")).not.toBe(withMcp(two, "wem_a"));
    expect(withMcp(one, "wem_a")).not.toBe(fingerprint(claim).profileSha256);
    expect(fingerprint(claim).profileSha256).toBe(NO_MCP_FINGERPRINT);
  });

  test("a claim this image's protocol refuses gets an error, not a digest", () => {
    const { profiles } = imageRuntimeOf({
      bad: { ...claim, principal: {} },
      good: claim,
    });

    expect(profiles.bad).toEqual({
      error:
        "claim refused: principal.owner_scope Invalid input: expected string, received undefined",
    });
    expect(profiles.good).toHaveProperty("profileSha256");
    expect(() => imageRuntimeOf([])).toThrow("keyed by session id");
  });

  test("a claim that names no repository gets that session's digest, one that names one the same as without", () => {
    const repository = {
      id: "sample-app",
      url: "https://example.invalid/team/app.git",
      branch: "main",
    };
    const { profiles } = imageRuntimeOf({
      bare: claim,
      none: { ...claim, workspace: { repository: null } },
      repo: { ...claim, workspace: { repository } },
    });

    expect(profiles.repo).toEqual(profiles.bare);
    expect(profiles.none).toHaveProperty("profileSha256");
    expect(profiles.none).not.toEqual(profiles.bare);
  });
});
