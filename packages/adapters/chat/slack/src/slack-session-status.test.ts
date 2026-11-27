import { describe, expect, test } from "bun:test";
import { SLACK_NOTICE_MESSAGES, type UserLocale } from "@werft-ai/contracts";
import type { SurfaceThreadStatusFacts } from "@werft-ai/platform";
import { SLACK_OUTBOX_MESSAGES } from "./slack-outbox-render.ts";
import {
  type SlackSessionStatusMaterial,
  type SlackThreadStatus,
  slackProgressMessage,
  slackSessionStatus,
  slackStatusMaterial,
} from "./slack-session-status.ts";

const idle: SlackSessionStatusMaterial = {
  lifecycle: "open",
  approvablePush: false,
  answerableRequest: false,
  runningTurn: false,
  queuedTurn: false,
  actionStages: [],
};

describe("slackSessionStatus", () => {
  const rows: [
    string,
    Partial<SlackSessionStatusMaterial>,
    SlackThreadStatus,
  ][] = [
    [
      "closed beats everything",
      {
        lifecycle: "closed",
        approvablePush: true,
        answerableRequest: true,
        runningTurn: true,
      },
      "closed",
    ],
    [
      "an approvable push waits on a person",
      { approvablePush: true, runningTurn: true },
      "suspended",
    ],
    [
      "an approvable push in recovery still waits on a person",
      { lifecycle: "recovery", approvablePush: true },
      "suspended",
    ],
    [
      "an approvable push while paused waits on a person",
      { lifecycle: "paused", approvablePush: true },
      "suspended",
    ],
    [
      "recovery with only a pending request is active",
      { lifecycle: "recovery", answerableRequest: true, runningTurn: true },
      "active",
    ],
    [
      "a pending request on a running turn waits on a person",
      { answerableRequest: true, runningTurn: true },
      "suspended",
    ],
    [
      "a request parked on a paused session waits on a person",
      { lifecycle: "paused", answerableRequest: true },
      "suspended",
    ],
    [
      "paused with a follow-up turn held is active",
      { lifecycle: "paused", queuedTurn: true },
      "active",
    ],
    ["a running turn is processing", { runningTurn: true }, "processing"],
    [
      "a queued continuation or follow-up turn is processing",
      { queuedTurn: true },
      "processing",
    ],
    ["nothing is active", {}, "active"],
    [
      "action stages alone do not change the status",
      { actionStages: [{ kind: "push_intent", id: "i", state: "pinned" }] },
      "active",
    ],
  ];
  for (const [name, change, expected] of rows) {
    test(name, () => {
      expect(slackSessionStatus({ ...idle, ...change })).toBe(expected);
    });
  }
});

describe("slackStatusMaterial", () => {
  const facts: SurfaceThreadStatusFacts = {
    admissionState: "active",
    executionRevoked: false,
    unknownTurn: false,
    checkpointRevision: 3,
    answerableRequest: false,
    runningTurn: false,
    queuedTurn: false,
    requestedPushes: [],
    actionStages: [
      { kind: "push_intent", id: "i", state: "pinned" },
      { kind: "pull_request", id: "p", state: "opening" },
    ],
  };

  test("carries the open intents and pull request stages, and they leave the thread active", async () => {
    const material = await slackStatusMaterial("s", facts);
    expect(material.actionStages).toEqual(facts.actionStages);
    expect(slackSessionStatus(material)).toBe("active");
  });
});

describe("slackProgressMessage", () => {
  // 2026-11-27 05:31:12 UTC
  const STARTED = 1_795_757_472.5;

  test.each([
    ["capacity_wait:exec-1:0", "capacityWait"],
    ["needs_input:2", "progressNeedsInput"],
    ["running:2", "progressRunning"],
    ["queued:1", "progressQueued"],
    ["idle:3", "progressIdle"],
  ] as const)("%s says %s", (state, message) => {
    for (const locale of ["ko", "ja", "en"] as UserLocale[]) {
      const shown = slackProgressMessage({ locale, state, startedAt: null });
      expect(shown.text).toBe(SLACK_NOTICE_MESSAGES[locale][message]);
      expect(shown.blocks).toEqual([
        { type: "section", text: { type: "mrkdwn", text: shown.text } },
      ]);
    }
  });

  test("labels the start, drawn relative by Slack, absolute in its fallback", () => {
    for (const locale of ["ko", "ja", "en"] as UserLocale[]) {
      const shown = slackProgressMessage({
        locale,
        state: "running:1",
        startedAt: STARTED,
        linkUrl: "https://console.example/sessions/s1",
      });
      expect(shown.blocks[1]).toEqual({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${SLACK_NOTICE_MESSAGES[locale].progressStarted} <!date^1795757472^{ago}|2026-11-27 05:31 UTC> · <https://console.example/sessions/s1|${SLACK_OUTBOX_MESSAGES[locale].link}>`,
          },
        ],
      });
    }
  });

  test("refuses a state it does not know", () => {
    expect(() =>
      slackProgressMessage({ locale: "en", state: "done:1", startedAt: null }),
    ).toThrow("Unknown progress state");
  });
});
