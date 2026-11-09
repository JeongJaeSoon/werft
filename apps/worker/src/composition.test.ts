import { describe, expect, test } from "bun:test";
import { runtimeConfigSchema } from "@werft-ai/contracts";
import { realRuntimeFor } from "@werft-ai/runtime-registry/testing";

import {
  claimFingerprint,
  createWorkerHost,
  instructionParts,
  OUT_DIRECTORY_PROMPT,
  runtimeProfile,
  workerRuntimeRegistry,
} from "./composition.ts";
import type { WorkerConfig } from "./config.ts";
import { EngineProcesses } from "./engine-processes.ts";
import { WorkerHost } from "./worker-host.ts";

const claude = realRuntimeFor("claude_agent_sdk");

const config: WorkerConfig = {
  bootstrapNonce: "wln_test",
  egressCredentialUrl: "http://egress-proxy:3129",
  executionGeneration: 1,
  executionId: "exec-1",
  gatewayUrl: "http://control-host:8080",
  objectStore: {
    bucket: "claude-sessions",
    endpoint: "http://egress-proxy:3129/object-store",
    region: "ap-northeast-1",
    scope: "sessions/00000000-0000-4000-8000-000000000001/",
  },
  runtime: {
    claudeConfigDir: "/home/worker/.claude",
    cwd: "/workspace",
    home: "/home/worker",
    providerMaxRetries: 2,
  },
  timeouts: {
    answerPollIntervalMs: 1_000,
    claimTimeoutMs: 1_000,
    drainTimeoutMs: 1_000,
    heartbeatIntervalMs: 1_000,
    idleTimeoutMs: 1_000,
    maxTurnMs: 60_000,
    nextInputRetryTimeoutMs: 60_000,
    nextInputWaitMs: 1_000,
    questionTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    startupTimeoutMs: 60_000,
  },
};

describe("createWorkerHost", () => {
  test("builds a host from the environment the launcher provides", () => {
    expect(createWorkerHost(config)).toBeInstanceOf(WorkerHost);
  });
});

describe("workerRuntimeRegistry", () => {
  test("serves a session created for the engine this image ships", () => {
    const launcher = workerRuntimeRegistry(
      config,
      new EngineProcesses(),
    ).launcherFor({
      kind: "claude_agent_sdk",
      version: claude.descriptor.runtimeVersion,
      profile_id: "default",
    });

    expect(typeof launcher.start).toBe("function");
  });

  test("refuses a session that asks for another engine", () => {
    expect(() =>
      workerRuntimeRegistry(config, new EngineProcesses()).launcherFor({
        kind: "codex_app_server",
        version: "1.0.0",
        profile_id: "default",
      }),
    ).toThrow("not codex_app_server");
  });

  test("refuses a build of the engine this image does not ship", () => {
    // A transcript is only replayable on the build that wrote it, so a
    // version this image cannot provide is refused rather than approximated.
    expect(() =>
      workerRuntimeRegistry(config, new EngineProcesses()).launcherFor({
        kind: "claude_agent_sdk",
        version: "0.0.1",
        profile_id: "default",
      }),
    ).toThrow("this worker ships Agent SDK");
  });

  test("a profile that wants CLAUDE.md gets no engine when the workspace cannot vouch for one", () => {
    const launcher = workerRuntimeRegistry(
      config,
      new EngineProcesses(),
    ).launcherFor({
      kind: "claude_agent_sdk",
      version: claude.descriptor.runtimeVersion,
      profile_id: "default",
    });

    expect(() =>
      launcher.start({
        committedInstructions: () => {
          throw new Error(
            "Repository instruction file refused: a restored workspace has no freshly fetched commit behind it",
          );
        },
        correlationId: "s:a",
        maxBudgetUsd: 25,
        mode: "new",
        principal: { owner_scope: "owner-a" },
        runtimeConfig: {
          model: "m",
          tools: [],
          permission_mode: "default",
          provider: {
            kind: "anthropic",
            endpoint: "http://127.0.0.1:9",
            auth: { kind: "egress_token", token: "placeholder" },
          },
          project_settings: { claude_md: true },
        },
      }),
    ).toThrow("no freshly fetched commit");
  });
});

describe("claimFingerprint", () => {
  const claimToken = { kind: "egress_token" as const, token: "claim-token" };
  // The runtime_config the API hands out for each fixture profile, as
  // runtimeConfigOf builds it.
  const shipped = {
    "claude-coding-real": {
      model: "claude-sonnet-5",
      tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      permission_mode: "default" as const,
      provider: {
        kind: "anthropic" as const,
        endpoint: "https://api.anthropic.com",
        auth: claimToken,
      },
      project_settings: { claude_md: true },
    },
    "claude-coding-local": {
      model: "claude-sonnet-5",
      tools: [
        "Read",
        "Edit",
        "Write",
        "Glob",
        "Grep",
        "Bash",
        "AskUserQuestion",
      ],
      permission_mode: "default" as const,
      provider: {
        kind: "anthropic" as const,
        endpoint: "http://fake-messages:4010",
        auth: claimToken,
      },
      project_settings: { claude_md: true },
    },
    "local-ollama": {
      model: "gemma4:26b-mlx",
      tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      permission_mode: "default" as const,
      provider: {
        kind: "anthropic" as const,
        endpoint: "http://ollama.internal:11434",
        auth: claimToken,
      },
      project_settings: { claude_md: true },
    },
    "local-litellm": {
      model: "gemma4-local",
      tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      permission_mode: "default" as const,
      provider: {
        kind: "litellm" as const,
        endpoint: "http://litellm:4000",
        auth: claimToken,
      },
      project_settings: { claude_md: true },
    },
  };
  // Computed on main at 535745c6, before repositoryless sessions: a
  // repository session's checkpoints must keep resuming.
  const onMain: Record<keyof typeof shipped, string> = {
    "claude-coding-real":
      "11264a133b88785aea552a70fe41191476cde610102801b3af6f0c421b9908a0",
    "claude-coding-local":
      "182ab96118dab50191a75f2e059db83385fbcf8c6c6508122448a894c8eefed8",
    "local-ollama":
      "70df2e8d6b479d84e79fb3df988fdb64be95660f588e0cd573d61a61da4e6c6a",
    "local-litellm":
      "308002b17585b7fc3ff77dc05e403bac013e476ccf5b3065c6722b9945cbcf24",
  };
  const principal = { owner_scope: "owner-a" };
  const fingerprint = claimFingerprint(config);

  test("a repository session's digest is the one main computed for every shipped profile", () => {
    const repository = {
      id: "sample-app",
      url: "https://example.invalid/team/app.git",
      branch: "main",
    };
    for (const workspace of [undefined, { repository }]) {
      const digests = Object.fromEntries(
        Object.entries(shipped).map(([id, runtime_config]) => [
          id,
          fingerprint({
            principal,
            runtime_config,
            ...(workspace === undefined ? {} : { workspace }),
          }).profileSha256,
        ]),
      );
      expect(digests).toEqual(onMain);
    }
    expect(
      runtimeProfile(
        config,
        claude,
        {
          principal,
          runtimeConfig: shipped["claude-coding-real"],
          workspace: { repository },
        },
        () => null,
      ).bundle.instructions,
    ).toEqual([]);
  });

  test("a session without a repository is told about out/, and its digest says so", () => {
    for (const [id, runtimeConfig] of Object.entries(shipped)) {
      const profile = runtimeProfile(
        config,
        claude,
        { principal, runtimeConfig, workspace: { repository: null } },
        () => null,
      );
      expect(profile.bundle.instructions).toEqual([
        { text: OUT_DIRECTORY_PROMPT },
      ]);
      const digest = fingerprint({
        principal,
        runtime_config: runtimeConfig,
        workspace: { repository: null },
      }).profileSha256;
      expect(digest).toBe(claude.fingerprint(profile).profileSha256);
      expect(digest).not.toBe(onMain[id as keyof typeof shipped]);
    }
    expect(OUT_DIRECTORY_PROMPT).toContain("`out/`");
  });

  test("which instruction file is read, and its name, stay out of the digest an older session was stamped with", () => {
    const launch = {
      principal,
      runtimeConfig: shipped["claude-coding-real"],
      workspace: {
        repository: {
          id: "sample-app",
          url: "https://example.invalid/team/app.git",
          branch: "main",
        },
      },
    };
    const only = (instructionFiles: string[]) =>
      runtimeProfile(
        config,
        { descriptor: { ...claude.descriptor, instructionFiles } },
        launch,
        () => "rules\n",
      );
    const before = only(["CLAUDE.md"]);
    const after = only(["AGENTS.md", "CLAUDE.md"]);

    expect(claude.descriptor.instructionFiles).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(after.bundle.repoInstructions).toEqual({
      files: ["AGENTS.md", "CLAUDE.md"],
      text: "rules\n",
    });
    expect(claude.fingerprint(after).profileSha256).toBe(
      claude.fingerprint(before).profileSha256,
    );
    expect(claude.fingerprint(after).profileSha256).toBe(
      onMain["claude-coding-real"],
    );
  });

  test("a claim's extensions reach the engine's profile as the paths the worker published, and move the digest", () => {
    const bundle = {
      name: "lint",
      digest: "ab".repeat(32),
      scope: "agent",
    } as const;
    const runtimeConfig = {
      ...shipped["claude-coding-real"],
      extensions: [bundle],
    };
    const launch = {
      principal,
      runtimeConfig,
      workspace: { repository: null },
    };
    const profile = runtimeProfile(config, claude, launch, () => null);
    expect(profile.bundle.extensions).toEqual([
      {
        name: "lint",
        digest: bundle.digest,
        path: `/home/worker/.ext/${bundle.digest}`,
      },
    ]);
    const without = runtimeProfile(
      config,
      claude,
      { ...launch, runtimeConfig: shipped["claude-coding-real"] },
      () => null,
    );
    expect(without.bundle).not.toHaveProperty("extensions");
    expect(claude.fingerprint(profile).profileSha256).not.toBe(
      claude.fingerprint(without).profileSha256,
    );
  });

  test("the engine's instructions and the workspace's AGENTS.md come from one list", () => {
    const runtimeConfig = shipped["claude-coding-real"];
    const parts = instructionParts(runtimeConfig, {
      repository: null,
    });

    expect(parts).toEqual([{ text: OUT_DIRECTORY_PROMPT }]);
    expect(
      runtimeProfile(
        config,
        claude,
        { principal, runtimeConfig, workspace: { repository: null } },
        () => null,
      ).bundle.instructions,
    ).toEqual(parts);
  });

  test("the claim carries no agent instructions, name, description or role", () => {
    const base = shipped["claude-coding-real"];
    for (const extra of [
      { agent_instructions: "x" },
      { name: "Reviewer" },
      { description: "Reviews pull requests" },
      { role: "reviewer" },
      { instructions: "card instructions" },
    ]) {
      expect(runtimeConfigSchema.safeParse({ ...base, ...extra }).success).toBe(
        false,
      );
    }
  });

  test("the built-in github server reaches the engine as a proxy route with the egress token, and no GitHub token", () => {
    const runtimeConfig = {
      ...shipped["claude-coding-local"],
      tools: ["Read", "mcp__github__request_push"],
      mcp_servers: [
        {
          name: "github",
          endpoint: "https://builtin.invalid/mcp/github",
          binding: `sha256:${"0".repeat(64)}`,
          access: claimToken,
        },
      ],
    };
    const profile = runtimeProfile(
      config,
      claude,
      {
        principal,
        runtimeConfig,
        workspace: {
          repository: {
            id: "sandbox",
            url: "https://github.com/acme/sandbox.git",
            branch: "main",
          },
        },
      },
      () => null,
    );
    expect(profile.bundle.mcpServers).toEqual([
      expect.objectContaining({
        name: "github",
        url: "http://egress-proxy:3129/mcp/github",
        token: claimToken.token,
        tools: ["Read", "mcp__github__request_push"],
      }),
    ]);
    expect(JSON.stringify(profile)).not.toMatch(
      /ghs_|ghp_|gho_|github_pat_|x-access-token/,
    );
  });

  test("platform and trusted reach the adapter's MCP server input, and move no checkpoint fingerprint", () => {
    const tools = [
      "Read",
      "mcp__github__request_push",
      "mcp__github__submit_review",
    ];
    const server = {
      name: "github",
      endpoint: "https://builtin.invalid/mcp/github",
      binding: `sha256:${"0".repeat(64)}`,
      access: claimToken,
    };
    const profileOf = (extra: object) =>
      runtimeProfile(
        config,
        claude,
        {
          principal,
          runtimeConfig: {
            ...shipped["claude-coding-local"],
            tools,
            mcp_servers: [{ ...server, ...extra }],
          },
        },
        () => null,
      );
    const marked = profileOf({
      platform: true,
      trusted: ["mcp__github__request_push"],
    });
    expect(marked.bundle.mcpServers).toEqual([
      expect.objectContaining({
        name: "github",
        platform: true,
        trusted: ["mcp__github__request_push"],
      }),
    ]);
    const plain = profileOf({});
    expect(Object.keys(plain.bundle.mcpServers[0] ?? {})).not.toContain(
      "trusted",
    );
    expect(claude.fingerprint(marked)).toEqual(claude.fingerprint(plain));
  });
});
