import { expect, test } from "bun:test";
import { join } from "node:path";
import { CLAUDE_RUNTIME_FINGERPRINT } from "@werft-ai/runtime-claude-codec";

import {
  CLAUDE_PROFILE_DIGEST_SCHEME,
  claudeProfileFingerprint,
} from "./profile-fingerprint.ts";

// The digests checkpoints are stamped with, pinned to the bytes main produced
// before the runtime contract refactor (94S-827): a restore compares them, so
// a refactor that moves this code must keep every one of them.
// Regenerate only for an intended change: UPDATE_GOLDEN=1 bun test <file>.

const GOLDEN = join(
  import.meta.dir,
  "../../../../../tests/fixtures/golden/claude/profile-fingerprint.json",
);

type FingerprintInput = Parameters<typeof claudeProfileFingerprint>[0];

const base: FingerprintInput = {
  model: "claude-sonnet-5",
  permissionMode: "default",
  profile: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: {
      kind: "egress_token",
      token: "golden-token",
      transport: "http://egress-proxy:3129/provider",
    },
    principal: { ownerScope: "owner-a" },
  },
  settingSources: [],
  tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
};

const profiles: Record<string, FingerprintInput> = {
  default: base,
  "default-unset-fields": {
    model: base.model,
    profile: base.profile,
    tools: base.tools,
  },
  "claude-md": { ...base, repositoryClaudeMd: { contents: "rules" } },
  "remote-mcp": {
    ...base,
    identities: { mcpServers: { notion: "sha256:".padEnd(71, "a") } },
    mcpServers: {
      notion: {
        type: "http",
        url: "http://egress-proxy:3129/mcp/notion",
        headers: { Authorization: "Bearer golden" },
      },
    },
    tools: [...base.tools, "mcp__notion__search"],
  },
  "stdio-mcp-and-plugin": {
    ...base,
    identities: {
      mcpServers: { review: "review-server@2" },
      plugins: { "/plugins/review": "review@1.0.0" },
    },
    mcpServers: {
      review: { command: "review-server", args: ["--safe"], env: { K: "v" } },
    },
    plugins: [{ path: "/plugins/review", type: "local" }],
  },
  "repositoryless-accept-edits": {
    ...base,
    appendSystemPrompt: "Put files to hand back under out/.",
    permissionMode: "acceptEdits",
  },
  litellm: {
    ...base,
    model: "gemma4-local",
    profile: {
      ...base.profile,
      kind: "litellm",
      endpoint: "http://litellm:4000",
    },
  },
};

// The digest of `profiles.default` under each scheme there has been. An entry
// is never edited: a change that moves the digest adds the next scheme here
// and bumps CLAUDE_PROFILE_DIGEST_SCHEME, which UPDATE_GOLDEN does not do.
const DEFAULT_DIGEST_BY_SCHEME: Readonly<Record<number, string>> = {
  1: "574cab6e9d2c3df9ede2ef6ca103503eaf4fa2f391e444b742110816bcf771ce",
  2: "08bd96ec34d7819ec909c3c90a727d711d3c51ad6720eb0bd20b36bc4623efa5",
};

test("a digest moves only with the scheme", () => {
  expect(DEFAULT_DIGEST_BY_SCHEME[CLAUDE_PROFILE_DIGEST_SCHEME]).toBe(
    claudeProfileFingerprint(base),
  );
});

test("checkpoint fingerprints match main (golden)", async () => {
  const digests = (scheme: number) =>
    Object.fromEntries(
      Object.entries(profiles).map(([name, input]) => [
        name,
        claudeProfileFingerprint(input, scheme),
      ]),
    );
  const actual = {
    runtime: CLAUDE_RUNTIME_FINGERPRINT,
    profileDigestScheme: CLAUDE_PROFILE_DIGEST_SCHEME,
    profileSha256: digests(CLAUDE_PROFILE_DIGEST_SCHEME),
    // What scheme 1 images stamped checkpoints with: a restore on this image
    // computes them as alternates, so they never move.
    profileSha256Scheme1: digests(1),
  };
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") {
    await Bun.write(GOLDEN, text);
    return;
  }
  expect(text).toBe(await Bun.file(GOLDEN).text());
});
