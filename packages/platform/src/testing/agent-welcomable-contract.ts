import { describe, expect, test } from "bun:test";
import type { AgentWelcomable } from "../surface/ports/agent-welcomable.ts";

export type WelcomeScenario =
  /** A home channel the bot is in, and a live release. */
  | "home_joined"
  /** A home channel a person has yet to invite the bot into. */
  | "home_awaiting_invite"
  /** A home channel nobody has asked about yet; asking joins it. */
  | "home_unasked"
  | "no_home"
  | "no_release"
  /** The agent's Slack app is gone. */
  | "not_installed"
  /** The live release is older than one already activated. */
  | "rolled_back"
  /** What the welcome reads from fails. */
  | "reads_failing";

export type WelcomeSubject = {
  welcome: AgentWelcomable;
  workspaceId: string;
  agentId: string;
  releaseId: string;
  arrange(scenario: WelcomeScenario): void;
  /** Welcome messages queued for the home, however often asked. */
  welcomesQueued(): number;
};

/**
 * What every `AgentWelcomable` promises (`ports/agent-welcomable.ts`): the
 * home hears about the live release once; a welcome that has nothing to say
 * names why in its status instead of queueing a row that would fail for good;
 * `activated` never throws, and answers null when the welcome cannot go.
 */
export function describeAgentWelcomableContract(
  make: () => Promise<WelcomeSubject>,
) {
  describe("AgentWelcomable", () => {
    test("welcomes a home the bot is in once, and says it already did the second time", async () => {
      const subject = await make();
      subject.arrange("home_joined");
      const { welcome, workspaceId, agentId } = subject;
      const first = await welcome.welcome(workspaceId, agentId, { ask: false });
      expect(first).toEqual({
        status: "enqueued",
        channelId: expect.any(String),
      });
      expect(
        await welcome.welcome(workspaceId, agentId, { ask: false }),
      ).toEqual({
        status: "duplicate",
        channelId: (first as { channelId: string }).channelId,
      });
      expect(subject.welcomesQueued()).toBe(1);
    });

    test("a home the bot is not invited to yet is named, and nothing is queued", async () => {
      const subject = await make();
      subject.arrange("home_awaiting_invite");
      expect(
        await subject.welcome.welcome(subject.workspaceId, subject.agentId, {
          ask: false,
        }),
      ).toEqual({
        status: "awaiting_invite",
        channelId: expect.any(String),
        error: null,
      });
      expect(subject.welcomesQueued()).toBe(0);
    });

    test("without ask only what is stored counts; with ask the channel is asked, and joined, first", async () => {
      const subject = await make();
      subject.arrange("home_unasked");
      const { welcome, workspaceId, agentId } = subject;
      expect(
        await welcome.welcome(workspaceId, agentId, { ask: false }),
      ).toEqual({
        status: "unknown_membership",
        channelId: expect.any(String),
      });
      expect(subject.welcomesQueued()).toBe(0);
      expect(
        await welcome.welcome(workspaceId, agentId, { ask: true }),
      ).toEqual({
        status: "enqueued",
        channelId: expect.any(String),
      });
      expect(subject.welcomesQueued()).toBe(1);
    });

    test.each<
      [WelcomeScenario, "no_home" | "no_release" | "not_installed" | "rollback"]
    >([
      ["no_home", "no_home"],
      ["no_release", "no_release"],
      ["not_installed", "not_installed"],
      ["rolled_back", "rollback"],
    ])(
      "a %s agent is answered %s and queues nothing",
      async (scenario, status) => {
        const subject = await make();
        subject.arrange(scenario);
        expect(
          await subject.welcome.welcome(subject.workspaceId, subject.agentId, {
            ask: false,
          }),
        ).toEqual({ status });
        expect(subject.welcomesQueued()).toBe(0);
      },
    );

    test("an activation welcomes the live release as welcome does", async () => {
      const subject = await make();
      subject.arrange("home_joined");
      expect(
        await subject.welcome.activated(
          subject.workspaceId,
          subject.agentId,
          subject.releaseId,
        ),
      ).toEqual({ status: "enqueued", channelId: expect.any(String) });
      expect(subject.welcomesQueued()).toBe(1);
    });

    test("an activation never throws: when what it reads fails it answers null", async () => {
      const subject = await make();
      subject.arrange("reads_failing");
      expect(
        await subject.welcome.activated(
          subject.workspaceId,
          subject.agentId,
          subject.releaseId,
        ),
      ).toBeNull();
      expect(subject.welcomesQueued()).toBe(0);
    });
  });
}
