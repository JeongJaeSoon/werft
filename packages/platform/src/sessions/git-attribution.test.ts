import { describe, expect, test } from "bun:test";
import type { SessionAttributionRecord } from "../action/ports/session-attribution.ts";
import {
  appBotAuthor,
  attributionView,
  claimGitOf,
  coAuthorOf,
  sessionUrlOf,
} from "./git-attribution.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";

function record(
  starter: SessionAttributionRecord["starter"],
  trigger: SessionAttributionRecord["trigger"] = "web",
): SessionAttributionRecord {
  return {
    ownerId: "owner-a",
    trigger,
    agentId: null,
    agentReleaseId: null,
    starter,
    authorApp: null,
    authorPinned: false,
  };
}

const OCTOCAT = { id: "583231", login: "octocat" };
const LINKED = record({ userId: "user-1", github: OCTOCAT });

describe("the co-author a commit names", () => {
  test("is the linked starter's login with GitHub's noreply address", () => {
    expect(coAuthorOf(LINKED)).toEqual({
      name: "octocat",
      email: "583231+octocat@users.noreply.github.com",
    });
  });

  test("is no one without a starter, a link, or with a value outside GitHub's rules", () => {
    for (const github of [
      null,
      { id: "0", login: "octocat" },
      { id: "12a", login: "octocat" },
      { id: "583231", login: "octo cat" },
      { id: "583231", login: "octocat>\nSigned-off-by: x" },
      { id: "583231", login: "a".repeat(40) },
    ]) {
      expect(coAuthorOf(record({ userId: "user-1", github }))).toBeNull();
    }
    expect(coAuthorOf(record(null))).toBeNull();
    expect(coAuthorOf(null)).toBeNull();
  });
});

test("the claim names the session's console page, or none without an origin", () => {
  expect(
    claimGitOf(record(null), "https://console.example.com", SESSION),
  ).toEqual({
    co_author: null,
    session_url: `https://console.example.com/sessions/${SESSION}`,
  });
  expect(sessionUrlOf(null, SESSION)).toBeNull();
});

test("the session detail says co_author, unlinked or app_only", () => {
  expect(attributionView(LINKED)).toEqual({
    trigger: "web",
    attribution: "co_author",
    login: "octocat",
  });
  expect(
    attributionView(record({ userId: "user-1", github: null }, "slack")),
  ).toEqual({ trigger: "slack", attribution: "unlinked", login: null });
  expect(attributionView(record(null, "agent_key"))).toEqual({
    trigger: "agent_key",
    attribution: "app_only",
    login: null,
  });
});

describe("the App bot a commit is written by", () => {
  test("is <slug>[bot] at its users-API id's noreply address", () => {
    expect(appBotAuthor("werft-dev", "41898282")).toEqual({
      name: "werft-dev[bot]",
      email: "41898282+werft-dev[bot]@users.noreply.github.com",
    });
  });

  test("is none for a slug or id outside GitHub's rules", () => {
    expect(appBotAuthor("Werft Dev", "1")).toBeNull();
    expect(appBotAuthor("werft-dev]", "1")).toBeNull();
    expect(appBotAuthor("werft-dev", "0")).toBeNull();
    expect(appBotAuthor("werft-dev", "12a")).toBeNull();
  });
});
