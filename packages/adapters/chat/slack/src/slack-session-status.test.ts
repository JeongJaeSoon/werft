import { describe, expect, test } from "bun:test";
import type { SlackThreadStatusFacts } from "@werft-ai/platform";
import {
  type SlackSessionStatusMaterial,
  type SlackThreadStatus,
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
      "an unapprovable push alone is active",
      { approvablePush: false },
      "active",
    ],
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
  const facts: SlackThreadStatusFacts = {
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
