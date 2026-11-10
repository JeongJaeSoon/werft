import { describe, expect, test } from "bun:test";
import type { SurfaceMembership } from "@werft-ai/contracts";
import type { SurfaceBindingRecord } from "../ports/surface-binding-store.ts";
import type { ChannelJoinable } from "../surface/ports/channel-joinable.ts";

export type ChannelJoinSubject = {
  join: ChannelJoinable;
  /** A live binding to a channel in this condition, as the provider has it. */
  binding(
    channel:
      | "public_bot_in"
      | "public_bot_out"
      | "private_bot_out"
      | "archived",
  ): SurfaceBindingRecord;
  /** The install's DM binding: no channel id. */
  dmBinding(): SurfaceBindingRecord;
  /** A binding turned off. */
  offBinding(): SurfaceBindingRecord;
  /** The app's credential cannot be read. */
  withoutToken(): void;
  /** The provider does not answer. */
  goSilent(): void;
  /** Join requests the provider took. */
  joinsMade(): number;
  /** The memberships the joiner recorded on bindings, in order. */
  recorded(): { bindingId: string; membership: SurfaceMembership }[];
};

/**
 * What every `ChannelJoinable` promises (`ports/channel-joinable.ts`): it
 * joins a public channel the bot is not in and answers what the provider said
 * (`joined`; `awaiting_invite` for a private one; `join_failed` with the
 * provider's code), records a changed answer on the binding, and answers null
 * with nothing recorded when there was nothing to ask: the DM row, a binding
 * that is off, no credential, or a provider that did not answer.
 */
export function describeChannelJoinableContract(
  make: () => Promise<ChannelJoinSubject>,
) {
  describe("ChannelJoinable", () => {
    test("joins a public channel the bot is not in", async () => {
      const subject = await make();
      const binding = subject.binding("public_bot_out");
      expect(await subject.join(binding)).toEqual({
        state: "joined",
        error: null,
      });
      expect(subject.joinsMade()).toBe(1);
      expect(subject.recorded()).toEqual([
        { bindingId: binding.id, membership: { state: "joined", error: null } },
      ]);
    });

    test("a channel the bot is already in is joined without a join, and nothing new is recorded", async () => {
      const subject = await make();
      const binding = {
        ...subject.binding("public_bot_in"),
        membership: { state: "joined", error: null } as const,
      };
      expect(await subject.join(binding)).toEqual({
        state: "joined",
        error: null,
      });
      expect(subject.joinsMade()).toBe(0);
      expect(subject.recorded()).toEqual([]);
    });

    test("a private channel the bot is not in waits for the invite, and is not joined", async () => {
      const subject = await make();
      // `error` is not part of the promise: a provider that hides a private
      // channel from the bot says so with a code, one that shows it says none.
      expect(
        await subject.join(subject.binding("private_bot_out")),
      ).toMatchObject({
        state: "awaiting_invite",
      });
      expect(subject.joinsMade()).toBe(0);
    });

    test("an archived channel is join_failed with the provider's code", async () => {
      const subject = await make();
      expect(await subject.join(subject.binding("archived"))).toEqual({
        state: "join_failed",
        error: "is_archived",
      });
    });

    test("the DM row and a binding that are off are null, with nothing recorded", async () => {
      const subject = await make();
      expect(await subject.join(subject.dmBinding())).toBeNull();
      expect(await subject.join(subject.offBinding())).toBeNull();
      expect(subject.recorded()).toEqual([]);
    });

    test("no credential is null, with nothing recorded and no join asked", async () => {
      const subject = await make();
      subject.withoutToken();
      expect(await subject.join(subject.binding("public_bot_out"))).toBeNull();
      expect(subject.joinsMade()).toBe(0);
      expect(subject.recorded()).toEqual([]);
    });

    test("a silent provider is null, with nothing recorded", async () => {
      const subject = await make();
      subject.goSilent();
      expect(await subject.join(subject.binding("public_bot_out"))).toBeNull();
      expect(subject.recorded()).toEqual([]);
    });
  });
}
