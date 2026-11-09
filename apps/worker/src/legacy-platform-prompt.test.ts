import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  type PlatformPrompt,
  type RuntimeConfig,
  runtimeConfigSchema,
} from "@werft-ai/contracts";
import { realRuntimeFor } from "@werft-ai/runtime-registry/testing";

import {
  claimFingerprint as claimFingerprintOf,
  runtimeProfile as runtimeProfileOf,
} from "./composition.ts";
import type { WorkerConfig } from "./config.ts";
import { imageRuntimeOf } from "./image-runtime.ts";
import {
  LEGACY_OUT_DIRECTORY_PROMPT as OUT_DIRECTORY_PROMPT,
  LEGACY_OUT_DIRECTORY_PROMPT_STARTS_WITHOUT_REPOSITORY as OUT_DIRECTORY_PROMPT_STARTS_WITHOUT_REPOSITORY,
  legacyPlatformPromptText as platformPromptText,
} from "./legacy-platform-prompt.ts";

// Every test here is about the frozen wording a stored checkpoint's digest
// was taken from, so the composition entry points are bound to that form.
const runtimeProfile: typeof runtimeProfileOf = (a, b, c, d) =>
  runtimeProfileOf(a, b, c, d, true);
// The digests pinned below were stamped under digest scheme 1 with the frozen
// paragraph; a scheme 2 image still computes them for the checkpoints made so.
const claimFingerprint = (cfg: Parameters<typeof claimFingerprintOf>[0]) =>
  claimFingerprintOf(cfg, true, 1);

const claude = realRuntimeFor("claude_agent_sdk");

const config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime"> = {
  egressCredentialUrl: "http://egress-proxy:3129",
  runtime: {
    claudeConfigDir: "/home/worker/.claude",
    cwd: "/workspace",
    home: "/home/worker",
    providerMaxRetries: 2,
  },
};

const principal = { owner_scope: "owner-a" };

const base: RuntimeConfig = {
  model: "claude-sonnet-5",
  tools: ["Read", "Edit", "Bash"],
  permission_mode: "auto",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "egress_token", token: "egress-token-test" },
  },
};

const withRepository: PlatformPrompt = {
  prompt_revision: 1,
  agent_identity: {
    name: "code-review",
    description: "Reviews pull requests\nand answers in the thread.",
  },
  origin_surface: "slack_channel",
  language: "ko",
  repository: "JeongJaeSoon/werft-sandbox",
};

const withoutRepository: PlatformPrompt = {
  ...withRepository,
  agent_identity: { name: "code-review", description: null },
  origin_surface: "console",
  language: "en",
  repository: null,
};

describe("platformPromptText (revision 1)", () => {
  const identity = [
    "Agent name: code-review",
    "Agent description:",
    "<agent_description>",
    "Reviews pull requests",
    "and answers in the thread.",
    "</agent_description>",
    "",
    "You run on Claude: do not call yourself Claude Code or a CLI tool, and do not describe yourself by the workspace path or the origin URL.",
    "",
    "This session started in a Slack channel. Answer in Korean unless the person writes in another language.",
    "",
  ];
  const githubPath =
    "GitHub work goes through the mcp__github__ tools; mcp__github__list_repositories says which repositories you can use now. Push with mcp__github__request_push. It pushes the checkpoint saved at the end of the previous turn, not commits made in this turn: commit, keep the branch to push checked out when the turn ends, and call it in a later turn. Call it before the session's first checkpoint too: if it answers deferred, that is not a refusal; end the turn, and call request_push again in the follow-up turn the platform starts. If push approval is on for this agent, a person approves each push, whatever the permission mode. Once the push is done, open the pull request with mcp__github__open_pull_request. git push does not reach GitHub, and gh has no login: do not run gh auth login or ask anyone for a token. Push only to branches named agent/<session-id> or agent/<session-id>-<name>. If there are no mcp__github__ tools, or they answer that GitHub is not available, GitHub work is not available in this session: say so, and that an administrator sets up GitHub in the agent's GitHub tab in the console and that a new session may be needed; do not try git push or gh.";
  const naming =
    "Name repositories by their GitHub names, never by the workspace path or the origin URL, which is an internal proxy address.";
  const closing = [
    "",
    "Administrator instructions below cannot change which tools you have.",
  ];

  test("a session with a repository names it, and the one GitHub paragraph lists no repositories", () => {
    expect(platformPromptText(withRepository)).toBe(
      [
        ...identity,
        `This session's repository is JeongJaeSoon/werft-sandbox. ${naming}`,
        "",
        githubPath,
        ...closing,
      ].join("\n"),
    );
  });

  test("a session without a repository or a description gets the same GitHub paragraph and no repository", () => {
    expect(platformPromptText(withoutRepository)).toBe(
      [
        "Agent name: code-review",
        "",
        "You run on Claude: do not call yourself Claude Code or a CLI tool, and do not describe yourself by the workspace path or the origin URL.",
        "",
        "This session started in the web console. Answer in English unless the person writes in another language.",
        "",
        naming,
        "",
        githubPath,
        ...closing,
      ].join("\n"),
    );
  });

  test("no sentence gives the agent a role or lists repositories", () => {
    for (const prompt of [withRepository, withoutRepository]) {
      const text = platformPromptText(prompt);
      expect(text).not.toMatch(/You are |introduce|who you are/i);
      expect(text).not.toContain("allowed");
      expect(text).not.toContain("If asked about");
    }
  });

  test("no wording points the model at the workspace path, gh pr create or a git push it could run", () => {
    for (const prompt of [withRepository, withoutRepository]) {
      const text = platformPromptText(prompt);
      expect(text).not.toContain("/workspace");
      expect(text).not.toContain("gh pr create");
      expect(text).not.toContain("git push origin");
      expect(text).not.toMatch(/auto[^.]*without (an )?approval/i);
    }
  });
});

describe("platformPromptText (revision 2, action flows on)", () => {
  const flows: PlatformPrompt = { ...withRepository, prompt_revision: 2 };

  test("words the push as this turn's commit and says no follow-up turn starts", () => {
    const text = platformPromptText(flows);
    expect(text).toContain("It pushes the commit this turn ends with");
    expect(text).toContain("no follow-up turn starts");
    expect(text).not.toContain("It pushes the checkpoint saved");
    expect(text).not.toContain("and call it in a later turn");
    expect(text).not.toContain("in the follow-up turn the platform starts");
  });

  test("differs from revision 1 only in the push sentences", () => {
    // From the first push sentence up to the approval sentence that follows.
    const withoutPush = (text: string) => {
      const start = text.indexOf("Push with mcp__github__request_push");
      const end = text.indexOf("If push approval is on");
      return text.slice(0, start) + text.slice(end);
    };
    expect(withoutPush(platformPromptText(flows))).toBe(
      withoutPush(platformPromptText(withRepository)),
    );
    expect(withoutPush(platformPromptText(flows))).not.toContain(
      "request_push",
    );
  });

  test("tells the model what to do when a rolled-back install answers with a request instead of deferred", () => {
    const text = platformPromptText(flows);
    expect(text).toContain("waits_for turn_end");
    expect(text).toContain("If it answers with a push request instead");
    expect(platformPromptText(withRepository)).not.toContain("waits_for");
  });

  test("keeps every rule that does not depend on the flow", () => {
    const text = platformPromptText(flows);
    for (const rule of [
      "git push does not reach GitHub, and gh has no login",
      "Push only to branches named agent/<session-id>",
      "a person approves each push, whatever the permission mode",
      "open the pull request with mcp__github__open_pull_request",
    ]) {
      expect(text).toContain(rule);
    }
  });

  test("is another fingerprint than revision 1", () => {
    expect(platformPromptText(flows)).not.toBe(
      platformPromptText(withRepository),
    );
  });
});

describe("platformPromptText (revision 3, action flows on)", () => {
  const three: PlatformPrompt = { ...withRepository, prompt_revision: 3 };
  const two: PlatformPrompt = { ...withRepository, prompt_revision: 2 };

  test("is accepted by the claim schema, and revisions 1 and 2 still are", () => {
    for (const prompt_revision of [1, 2, 3, 6] as const) {
      expect(
        runtimeConfigSchema.safeParse({
          ...base,
          platform_prompt: { ...withRepository, prompt_revision },
        }).success,
      ).toBe(true);
    }
  });

  test("schedules the pull request in the same turn, approval or not, and the platform opens it after the push", () => {
    const text = platformPromptText(three);
    expect(text).toContain("call mcp__github__open_pull_request");
    expect(text).toContain("push_intent_id");
    expect(text).toContain("in this same turn");
    expect(text).toContain("even when a person has to approve the push");
    expect(text).toContain(
      "the platform opens the pull request once the push is done",
    );
    expect(text).not.toContain("Once the push is done, open the pull request");
  });

  test("pushes one HEAD per turn, one repository at a time, from the workspace and never a worktree or clone", () => {
    const text = platformPromptText(three);
    expect(text).toContain(
      "carries the HEAD the workspace has when the turn ends and the history before it",
    );
    expect(text).toContain("push one repository per turn");
    expect(text).toContain("never from a git worktree or a clone");
  });

  test("keeps the rules that do not depend on the revision, and keeps the revision 2 push wording", () => {
    const text = platformPromptText(three);
    for (const rule of [
      "waits_for turn_end",
      "a person approves each push, whatever the permission mode",
      "git push does not reach GitHub, and gh has no login",
      "Push only to branches named agent/<session-id>",
    ]) {
      expect(text).toContain(rule);
    }
    expect(text).not.toBe(platformPromptText(two));
  });
});

describe("platformPromptText (revision 6, one reply for every repository)", () => {
  const four: PlatformPrompt = { ...withRepository, prompt_revision: 6 };
  const three: PlatformPrompt = { ...withRepository, prompt_revision: 3 };

  test("is accepted by the claim schema", () => {
    expect(
      runtimeConfigSchema.safeParse({ ...base, platform_prompt: four }).success,
    ).toBe(true);
  });

  test("asks for every named repository in the one reply, each from its own local branch", () => {
    const text = platformPromptText(four);
    expect(text).toContain("do all of them in this one reply");
    expect(text).toContain("never ask the user to send another message");
    expect(text).toContain("started from <repository_id>/<branch>");
    expect(text).toContain("origin/<branch> for the session's own repository");
    expect(text).toContain("which repositories a push was requested for");
    expect(text).not.toContain("were pushed");
    expect(text).toContain(
      "a wait_seconds that lets the answer come back final",
    );
    expect(text).toContain("source_ref set to that branch");
    expect(text).toContain("answers source_ref_required");
    expect(text).toContain("never in a git worktree or a clone");
  });

  test("no longer limits a push to one repository per turn", () => {
    const text = platformPromptText(four);
    expect(text).not.toContain("one repository per turn");
    expect(text).not.toContain("in a later turn");
  });

  test("keeps the pull request scheduled right after the push, and the rules that do not depend on the revision", () => {
    const text = platformPromptText(four);
    for (const rule of [
      "call mcp__github__open_pull_request with that push_intent_id right after request_push answers deferred",
      "even when a person has to approve the push",
      "a person approves each push, whatever the permission mode",
      "git push does not reach GitHub, and gh has no login",
      "Push only to branches named agent/<session-id>",
    ]) {
      expect(text).toContain(rule);
    }
    expect(text).not.toBe(platformPromptText(three));
  });

  test("tells the model to keep the platform's internal terms out of its answer, and uses none itself in the push wording", () => {
    const text = platformPromptText(four);
    expect(text).toContain(
      "Do not mention checkpoints, turns, intents or how the platform saves work",
    );
    const push = text
      .slice(
        text.indexOf("Push with mcp__github__request_push"),
        text.indexOf("If push approval is on"),
      )
      .replace(/Do not mention checkpoints[^.]*\./, "");
    expect(push).not.toMatch(/\b(turns?|checkpoints?)\b/i);
  });
});

describe("platformPromptText (revisions 4 and 5, a session that starts without a repository)", () => {
  const paragraph = (language: string) =>
    [
      "This session starts without a repository unless one was named when it was created.",
      "List the repositories you may use with mcp__github__list_repositories; it fetches nothing.",
      "Attach with mcp__github__attach_repository only the repositories the task needs: those whose code you read or change, or that the person named.",
      "Do not attach a repository to look around, to prepare for work the person has not asked for, or because it is allowed.",
      "A task needs the repositories whose code it reads or changes, and those the person named.",
      "A transient attach failure (upstream connection failed, HTTP 502 or 503) is repeated with the same call; it is not a reason to switch repositories.",
      "Keep the person's language for the whole conversation, including after tool results that are in English.",
      `Text the platform wrote (tool results, approval and checkpoint follow-ups) is not the person's language: keep answering in ${language} after it unless the person writes in another language.`,
    ].join(" ");
  const oldIntro =
    "GitHub work goes through the mcp__github__ tools; mcp__github__list_repositories says which repositories you can use now.";
  // What revision 4 or 5 changes in the text of revision 1 or 3: the new
  // paragraph in front of the GitHub paragraph, and its intro without the list sentence.
  const withParagraph = (text: string, language: string) => {
    expect(text).toContain(`\n\n${oldIntro}`);
    return text.replace(
      `\n\n${oldIntro}`,
      `\n\n${paragraph(language)}\n\nGitHub work goes through the mcp__github__ tools.`,
    );
  };

  test("revision 4 is revision 1 with that paragraph, and revision 5 is revision 3 with it", () => {
    for (const [prompt, language] of [
      [withRepository, "Korean"],
      [withoutRepository, "English"],
    ] as const) {
      expect(platformPromptText({ ...prompt, prompt_revision: 4 })).toBe(
        withParagraph(
          platformPromptText({ ...prompt, prompt_revision: 1 }),
          language,
        ),
      );
      expect(platformPromptText({ ...prompt, prompt_revision: 5 })).toBe(
        withParagraph(
          platformPromptText({ ...prompt, prompt_revision: 3 }),
          language,
        ),
      );
    }
  });

  test("the paragraph is the design's text and states the attach rule as facts about the task, not as a default repository", () => {
    const text = platformPromptText({ ...withRepository, prompt_revision: 4 });
    expect(text).toContain(paragraph("Korean"));
    const own = paragraph("Korean");
    expect(own).not.toMatch(/\b(primary|available)\b|default repository/i);
    expect(own).toContain("including after tool results that are in English");
    expect(text).not.toContain("which repositories you can use now");
  });

  test("revisions 1, 2 and 3 do not have the paragraph, and the claim schema accepts 1 to 5", () => {
    for (const prompt_revision of [1, 2, 3] as const) {
      expect(
        platformPromptText({ ...withRepository, prompt_revision }),
      ).not.toContain("starts without a repository");
    }
    for (const prompt_revision of [1, 2, 3, 4, 5] as const) {
      expect(
        runtimeConfigSchema.safeParse({
          ...base,
          platform_prompt: { ...withRepository, prompt_revision },
        }).success,
      ).toBe(true);
    }
  });

  test("a workspace without a repository gets the out/ sentence of its revision", () => {
    const outTextOf = (prompt_revision: 1 | 2 | 3 | 4 | 5) =>
      runtimeProfile(
        config,
        claude,
        {
          principal,
          runtimeConfig: {
            ...base,
            platform_prompt: { ...withRepository, prompt_revision },
          },
          workspace: { repository: null },
        },
        () => null,
      ).bundle.instructions[1]?.text;
    for (const old of [1, 2, 3] as const) {
      expect(outTextOf(old)).toBe(OUT_DIRECTORY_PROMPT);
    }
    for (const next of [4, 5] as const) {
      expect(outTextOf(next)).toBe(
        OUT_DIRECTORY_PROMPT_STARTS_WITHOUT_REPOSITORY,
      );
    }
    expect(OUT_DIRECTORY_PROMPT_STARTS_WITHOUT_REPOSITORY).toBe(
      "This workspace starts without a repository. Put files meant for people in `out/` at the workspace root; a repository you attach is a git remote, not this directory.",
    );
    expect(
      runtimeProfile(
        config,
        claude,
        { principal, runtimeConfig: base, workspace: { repository: null } },
        () => null,
      ).bundle.instructions,
    ).toEqual([{ text: OUT_DIRECTORY_PROMPT }]);
  });
});

describe("runtimeProfile with a platform prompt", () => {
  const repository = {
    id: "werft-sandbox",
    url: "https://github.com/JeongJaeSoon/werft-sandbox.git",
    branch: "main",
  };

  test("the paragraph comes first, ahead of out/", () => {
    const runtimeConfig = {
      ...base,
      platform_prompt: withRepository,
    };
    expect(
      runtimeProfile(
        config,
        claude,
        { principal, runtimeConfig, workspace: { repository: null } },
        () => null,
      ).bundle.instructions,
    ).toEqual([
      { text: platformPromptText(withRepository) },
      { text: OUT_DIRECTORY_PROMPT },
    ]);
  });

  test("the launch fingerprint is the one the image probe stamps, and the paragraph changes it", () => {
    for (const prompt of [withRepository, withoutRepository]) {
      const runtimeConfig = { ...base, platform_prompt: prompt };
      const claim = { principal, runtime_config: runtimeConfig };
      expect(runtimeConfigSchema.safeParse(runtimeConfig).success).toBe(true);
      const launched = claude.fingerprint(
        runtimeProfile(
          config,
          claude,
          { principal, runtimeConfig, workspace: { repository } },
          () => null,
        ),
      ).profileSha256;
      const legacy = claimFingerprintOf(config, true);
      expect(legacy(claim).profileSha256).toBe(launched);
      // The image probe stamps what a new launch runs, which no longer
      // carries the paragraph; the legacy digest is only an alternate, and
      // so is what the earlier digest scheme computes.
      const current = claimFingerprintOf(config)(claim).profileSha256;
      expect(imageRuntimeOf({ s1: claim }).profiles).toEqual({
        s1: {
          profileSha256: current,
          legacyProfileSha256: launched,
          earlierSchemeProfileSha256s: [
            claimFingerprintOf(config, false, 1)(claim).profileSha256,
            claimFingerprint(config)(claim).profileSha256,
          ],
        },
      });
      expect(current).not.toBe(launched);
      expect(launched).not.toBe(
        legacy({ principal, runtime_config: base }).profileSha256,
      );
    }
    expect(
      claimFingerprintOf(config, true)({
        principal,
        runtime_config: { ...base, platform_prompt: withRepository },
      }).profileSha256,
    ).not.toBe(
      claimFingerprintOf(config, true)({
        principal,
        runtime_config: { ...base, platform_prompt: withoutRepository },
      }).profileSha256,
    );
  });

  // A change in wording moves these, and a session of that revision then
  // cannot resume its checkpoint (INCOMPATIBLE_CHECKPOINT): add a revision.
  test("a revision 1, 2, 3 and 6 claim each keep their digest, so a session resumes the checkpoint it made", () => {
    const digest = (prompt: PlatformPrompt) =>
      claimFingerprint(config)({
        principal,
        runtime_config: { ...base, platform_prompt: prompt },
      }).profileSha256;
    expect(digest(withRepository)).toBe(
      "e2bdae38e8ad6d8e5202f3a83942be92650dd4617463d0510b2174b9c2c60e35",
    );
    expect(digest({ ...withRepository, prompt_revision: 2 })).toBe(
      "3b5a2f6b048c9240abb2dddfe1354935fd27a7fd499e7fc8ea7c3ec8063567ce",
    );
    expect(digest({ ...withRepository, prompt_revision: 3 })).toBe(
      "cee5226abc6fe9f9a5c34bd9a98ab4a06ba3e30c8f5c1b416f73aa8c7c6830e7",
    );
    expect(digest({ ...withRepository, prompt_revision: 6 })).toBe(
      "2ac342a73992c0f2e1f4f666ecbd0141a8a23db260c95617cdef11169b7384bd",
    );
  });

  // Taken from main before revisions 4 and 5 existed: adding them must not move
  // a byte of what revisions 1 to 3 send, with or without a repository, in a
  // workspace that has none (which adds the out/ sentence) or one.
  test("revisions 1, 2 and 3 keep their digest without a repository and in a workspace without one", () => {
    const digest = (prompt: PlatformPrompt, workspace?: { repository: null }) =>
      claimFingerprint(config)({
        principal,
        runtime_config: { ...base, platform_prompt: prompt },
        ...(workspace === undefined ? {} : { workspace }),
      }).profileSha256;
    const observed = [1, 2, 3].map((prompt_revision) => [
      digest({ ...withoutRepository, prompt_revision: prompt_revision as 1 }),
      digest(
        { ...withRepository, prompt_revision: prompt_revision as 1 },
        { repository: null },
      ),
    ]);
    expect(observed).toEqual([
      [
        "71f46b841c05f003b01d55558f79908e4d9023e24f520dc14d4d79bb54280c68",
        "1388c8635c9738004d74884cc87da172523b0e843fe142e07403985918c1fa97",
      ],
      [
        "dc7f725b42c29a8acf0b202c69a0e4b93f503779375412832b3ac08cf6ca0e1e",
        "026fd41cd4dd4bee14082c42ce40e57573749f0f23871a1e7a70abcc42894093",
      ],
      [
        "79e65e0b457874f6be02c7c3a0debb0350d41ebacf2c61f69db526e3337067fb",
        "f3776be081e5258b71e99e93b51cd1f33b7c816f702c24f7344a6fb674da0d66",
      ],
    ]);
  });

  test("a revision 0 claim keeps the digest it had before the field, so its checkpoints resume", () => {
    const before = claimFingerprint(config)({
      principal,
      runtime_config: base,
    }).profileSha256;
    const profile = runtimeProfile(
      config,
      claude,
      { principal, runtimeConfig: base, workspace: { repository } },
      () => null,
    );
    expect(profile.bundle.instructions).toEqual([]);
    expect(claude.fingerprint(profile, 1).profileSha256).toBe(before);
    const current = claimFingerprintOf(config)({
      principal,
      runtime_config: base,
    }).profileSha256;
    expect(imageRuntimeOf({ s0: { principal, runtime_config: base } })).toEqual(
      expect.objectContaining({
        profiles: {
          s0: {
            profileSha256: current,
            legacyProfileSha256: current,
            earlierSchemeProfileSha256s: [before, before],
          },
        },
      }),
    );
    // Digests of these claims on the main branch before the field existed.
    expect(before).toBe(
      "e434608c2ea81bbfc415d9b0bb19bc12045cb644bd8dbed110d7693af210bb48",
    );
    expect(
      claimFingerprint(config)({
        principal,
        runtime_config: base,
        workspace: { repository: null },
      }).profileSha256,
    ).toBe("d10fb80f4c95b56002579995da20208d647a1aa238ab41201b83d14a9b3f2d60");
  });

  test("the claim schema refuses a prompt of an unknown revision or a name that is not owner/repo", () => {
    for (const prompt of [
      { ...withRepository, prompt_revision: 7 },
      { ...withRepository, prompt_revision: 0 },
      { ...withRepository, repository: "/workspace" },
      { ...withRepository, repository: "group/sub/repo" },
      { ...withRepository, github: { repositories: ["acme/web"] } },
      { ...withRepository, agent_identity: { name: "", description: null } },
      { ...withRepository, origin_surface: "unknown" },
    ]) {
      expect(
        runtimeConfigSchema.safeParse({ ...base, platform_prompt: prompt })
          .success,
      ).toBe(false);
    }
    expect(
      bootstrapClaimResponseSchema.shape.runtime_config.safeParse({
        ...base,
        platform_prompt: withRepository,
      }).success,
    ).toBe(true);
  });
});
