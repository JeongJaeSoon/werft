import { describe, expect, test } from "bun:test";
import type { AuthorizationSurface } from "@werft-ai/contracts";
import {
  platformPromptOf,
  platformPromptRevisionFromEnv,
} from "./platform-prompt.ts";

const promptFrom = (surface: AuthorizationSurface) =>
  platformPromptOf({
    identity: { name: "a", description: null, language: "ko" },
    surface,
    repositoryUrl: null,
  }).origin_surface;

describe("platformPromptOf", () => {
  test("names where the session started by the kind of surface, a Slack DM apart from a channel", () => {
    expect(promptFrom({ kind: "web" })).toBe("console");
    expect(promptFrom({ kind: "api" })).toBe("api");
    expect(promptFrom({ kind: "slack", channel_kind: "dm" })).toBe("slack_dm");
    for (const channel_kind of ["public_channel", "private_channel"] as const) {
      expect(promptFrom({ kind: "slack", channel_kind })).toBe("slack_channel");
    }
  });
});

describe("platformPromptOf revision", () => {
  const revisionWhen = (actionFlows: boolean | undefined) =>
    platformPromptOf({
      identity: { name: "a", description: null, language: "ko" },
      surface: { kind: "web" },
      repositoryUrl: null,
      ...(actionFlows === undefined ? {} : { actionFlows }),
    }).prompt_revision;

  test("is 4 only for a session created while the action flows are on", () => {
    expect(revisionWhen(true)).toBe(4);
    expect(revisionWhen(false)).toBe(1);
    expect(revisionWhen(undefined)).toBe(1);
  });
});

describe("platformPromptOf repository", () => {
  test("names the repository by its owner/repo path, and nothing for a path that is not one", () => {
    const repositoryOf = (repositoryUrl: string | null) =>
      platformPromptOf({
        identity: { name: "a", description: " ", language: "ko" },
        surface: { kind: "web" },
        repositoryUrl,
      });
    expect(repositoryOf("https://github.com/acme/web.git")).toMatchObject({
      repository: "acme/web",
      agent_identity: { name: "a", description: null },
    });
    expect(
      repositoryOf("https://gitlab.example/group/sub/repo.git").repository,
    ).toBeNull();
    expect(repositoryOf(null).repository).toBeNull();
  });
});

describe("platformPromptRevisionFromEnv", () => {
  test("unset or empty is 0; 0 and 1 are read; anything else refuses to start", () => {
    expect(platformPromptRevisionFromEnv({})).toBe(0);
    expect(platformPromptRevisionFromEnv({ SESSION_PROMPT_REVISION: "" })).toBe(
      0,
    );
    expect(
      platformPromptRevisionFromEnv({ SESSION_PROMPT_REVISION: "1" }),
    ).toBe(1);
    expect(
      platformPromptRevisionFromEnv({ SESSION_PROMPT_REVISION: "0" }),
    ).toBe(0);
    for (const bad of ["2", "true", " 1", "01"]) {
      expect(() =>
        platformPromptRevisionFromEnv({ SESSION_PROMPT_REVISION: bad }),
      ).toThrow("SESSION_PROMPT_REVISION must be one of 0, 1");
    }
  });
});
