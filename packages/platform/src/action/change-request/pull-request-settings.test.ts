import { describe, expect, test } from "bun:test";
import {
  type AgentPullRequestSettings,
  DEFAULT_PULL_REQUEST_SETTINGS,
  type PullRequestSettings,
} from "@werft-ai/contracts";
import { claimGitOf } from "../../sessions/git-attribution.ts";
import { resolvePullRequestSettings } from "./pull-request-settings.ts";

const workspace = (
  over: Partial<PullRequestSettings> = {},
): PullRequestSettings => ({ ...DEFAULT_PULL_REQUEST_SETTINGS, ...over });
const agent = (
  over: Partial<AgentPullRequestSettings> = {},
): AgentPullRequestSettings => ({
  formatting: "inherit",
  template: null,
  template_name: null,
  ...over,
});

describe("which pull request settings apply", () => {
  test("nothing saved: the repository's template first, no template of our own, the console link", () => {
    expect(resolvePullRequestSettings(workspace(), null)).toEqual({
      sessionLink: "url",
      readRepository: true,
      templateName: null,
      text: null,
    });
  });

  test("the workspace's template supplies the text; the agent's wins over it", () => {
    const base = workspace({ default_template: "## W\n" });
    expect(resolvePullRequestSettings(base, null).text).toEqual({
      layer: "workspace",
      template: "## W\n",
    });
    expect(
      resolvePullRequestSettings(base, agent({ template: "## A\n" })).text,
    ).toEqual({ layer: "agent", template: "## A\n" });
    // An agent with no template of its own leaves the workspace's.
    expect(resolvePullRequestSettings(base, agent()).text).toEqual({
      layer: "workspace",
      template: "## W\n",
    });
  });

  test("`override` stops the repository's template from being read, for the agent's text too", () => {
    const resolved = resolvePullRequestSettings(
      workspace({ template_mode: "override" }),
      agent({ template: "## A\n", template_name: "bug.md" }),
    );
    expect(resolved.readRepository).toBe(false);
    expect(resolved.text?.layer).toBe("agent");
  });

  test("the agent's formatting wins unless it inherits", () => {
    const withTemplate = workspace({ default_template: "## W\n" });
    for (const [wsFormatting, agentFormatting, off] of [
      ["on", "inherit", false],
      ["off", "inherit", true],
      ["on", "off", true],
      ["off", "on", false],
      ["on", "on", false],
    ] as const) {
      const resolved = resolvePullRequestSettings(
        { ...withTemplate, formatting: wsFormatting },
        agent({ formatting: agentFormatting, template_name: "bug.md" }),
      );
      expect(resolved.readRepository).toBe(!off);
      expect(resolved.text === null).toBe(off);
      expect(resolved.templateName).toBe(off ? null : "bug.md");
    }
  });

  test("the session link is the workspace's whatever the agent says", () => {
    expect(
      resolvePullRequestSettings(
        workspace({ session_link: "id", formatting: "off" }),
        agent({ formatting: "on" }),
      ).sessionLink,
    ).toBe("id");
  });
});

describe("the session in the commit trailer", () => {
  test("`id` sends no address, so the trailer names the session id; the default sends the address", () => {
    expect(claimGitOf(null, "https://console.example.com", "s-1")).toEqual({
      co_author: null,
      session_url: "https://console.example.com/sessions/s-1",
    });
    expect(
      claimGitOf(null, "https://console.example.com", "s-1", "id"),
    ).toEqual({ co_author: null, session_url: null });
  });
});
