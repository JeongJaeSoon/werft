import { describe, expect, test } from "bun:test";
import type { SurfaceChannelKind } from "@werft-ai/contracts";
import { SessionServiceError } from "../musterrolle/service-errors.ts";
import type { ChannelKindReadable } from "../surface/ports/channel-kind-readable.ts";

export type ChannelKindSubject = {
  channels: ChannelKindReadable;
  workspaceId: string;
  agentId: string;
  /** A channel of this kind, as the provider knows it. */
  channelOf(kind: SurfaceChannelKind): string;
  /**
   * From now on the provider hides the channel from the agent's own app
   * (`hidden`), refuses the question (`refused`), or does not answer.
   */
  script(answer: "hidden" | "refused" | "no_answer"): void;
  /** The agent has no installed app, or none whose credential can be read. */
  withoutInstall(): void;
};

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionServiceError) return error.code;
    throw error;
  }
  return "ok";
}

/**
 * What every `ChannelKindReadable` promises (`ports/channel-kind-readable.ts`):
 * it answers what the provider says a channel is, asked with the agent's own
 * app; a question it cannot answer throws a `SessionServiceError` whose code
 * the route answers with.
 */
export function describeChannelKindReadableContract(
  make: () => Promise<ChannelKindSubject>,
) {
  describe("ChannelKindReadable", () => {
    test.each<SurfaceChannelKind>(["public_channel", "private_channel", "dm"])(
      "answers a %s as the provider says it is",
      async (kind) => {
        const { channels, workspaceId, agentId, channelOf } = await make();
        expect(
          await channels.kindOf(workspaceId, agentId, channelOf(kind)),
        ).toBe(kind);
      },
    );

    test("an agent with no installed app, or no credential, is SLACK_NOT_INSTALLED", async () => {
      const subject = await make();
      subject.withoutInstall();
      expect(
        await codeOf(
          subject.channels.kindOf(
            subject.workspaceId,
            subject.agentId,
            subject.channelOf("public_channel"),
          ),
        ),
      ).toBe("SLACK_NOT_INSTALLED");
    });

    test("a channel hidden from the app is a private one waiting for the invite, and a hidden DM is refused", async () => {
      const subject = await make();
      const { channels, workspaceId, agentId, channelOf } = subject;
      const hiddenPrivate = channelOf("private_channel");
      const hiddenDm = channelOf("dm");
      subject.script("hidden");
      expect(await channels.kindOf(workspaceId, agentId, hiddenPrivate)).toBe(
        "private_channel",
      );
      expect(
        await codeOf(channels.kindOf(workspaceId, agentId, hiddenDm)),
      ).toBe("BAD_REQUEST");
    });

    test("a refusal the provider names is BAD_REQUEST, carrying its code", async () => {
      const subject = await make();
      const channel = subject.channelOf("public_channel");
      subject.script("refused");
      const error = await subject.channels
        .kindOf(subject.workspaceId, subject.agentId, channel)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionServiceError);
      expect((error as SessionServiceError).code).toBe("BAD_REQUEST");
    });

    test("a provider that does not answer is BACKEND_UNAVAILABLE", async () => {
      const subject = await make();
      const channel = subject.channelOf("public_channel");
      subject.script("no_answer");
      expect(
        await codeOf(
          subject.channels.kindOf(
            subject.workspaceId,
            subject.agentId,
            channel,
          ),
        ),
      ).toBe("BACKEND_UNAVAILABLE");
    });
  });
}
