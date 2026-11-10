import { describe, expect, test } from "bun:test";
import type { SlackOutboxKind } from "../ports/slack-outbox-store.ts";
import type {
  ClaimedOutboxRow,
  DeliveryInput,
  DeliveryOutcome,
} from "../surface/ports/delivery.ts";

/** How the channel answers a send, as far as a delivery can tell. */
export type ChannelAnswer =
  /** Takes the message and names it. */
  | "accepted"
  /** Says to wait, and for how long. */
  | "rate_limited"
  /** Refuses for a reason that may clear on its own. */
  | "transient_error"
  /** Refuses for good: nothing sent again can change it. */
  | "refused"
  /** Takes the message but names none, so it cannot be told apart later. */
  | "accepted_without_reference"
  /** The request went out and no answer came back. */
  | "no_answer";

/**
 * What a delivery contract runs against: the port's holder wired to a channel
 * the harness can script. A contract never says which channel that is.
 */
export type DeliverySubject = {
  /** A row of `kind` the channel can address, as the sender leases it. */
  row(kind: SlackOutboxKind): ClaimedOutboxRow;
  /** From now on every send is answered this way. */
  script(answer: ChannelAnswer): void;
  /** The channel's credential cannot be read: no request can be made. */
  withoutCredential(): void;
  /** Requests that reached the channel. */
  requestsSent(): number;
  /** The attempt at which a delivery stops asking for another. */
  maxAttempts: number;
};

type Deliver = (input: DeliveryInput) => Promise<DeliveryOutcome>;

function inputOf(
  row: ClaimedOutboxRow,
  attempts: number,
  begin: () => Promise<boolean> = async () => true,
): DeliveryInput {
  return { row, attempts, begin };
}

/**
 * The delivery promises both `Notifiable` and `Approvable` make, for the row
 * kinds each is given: the channel's answer is classified into one of five
 * outcomes and a send never throws. Re-sending and keeping the row are the
 * sender's and the store's (`outbox.test.ts`), not a delivery's.
 */
export function describeDeliveryContract(
  name: string,
  kinds: readonly SlackOutboxKind[],
  make: () => Promise<{ subject: DeliverySubject; deliver: Deliver }>,
) {
  describe(name, () => {
    test.each([...kinds])(
      "a %s row the channel takes is sent, naming the message",
      async (kind) => {
        const { subject, deliver } = await make();
        const outcome = await deliver(inputOf(subject.row(kind), 1));
        expect(outcome).toEqual({ kind: "sent", ref: expect.any(String) });
        expect((outcome as { ref: string }).ref).not.toBe("");
        expect(subject.requestsSent()).toBe(1);
      },
    );

    test("begins once, before the request leaves", async () => {
      const { subject, deliver } = await make();
      const [kind = "notice"] = kinds;
      const seen: number[] = [];
      await deliver(
        inputOf(subject.row(kind), 1, async () => {
          seen.push(subject.requestsSent());
          return true;
        }),
      );
      expect(seen).toEqual([0]);
      expect(subject.requestsSent()).toBe(1);
    });

    test("a begin that is refused sends nothing and is lease_lost", async () => {
      const { subject, deliver } = await make();
      const [kind = "notice"] = kinds;
      const outcome = await deliver(
        inputOf(subject.row(kind), 1, async () => false),
      );
      expect(outcome).toEqual({ kind: "lease_lost" });
      expect(subject.requestsSent()).toBe(0);
    });

    test("a rate limit is a retry that carries the wait the channel asked for", async () => {
      const { subject, deliver } = await make();
      const [kind = "notice"] = kinds;
      subject.script("rate_limited");
      expect(await deliver(inputOf(subject.row(kind), 1))).toEqual({
        kind: "retry",
        code: "ratelimited",
        retryAfterMs: expect.any(Number),
      });
    });

    test("a transient refusal is a retry with a wait, until the attempts run out", async () => {
      const { subject, deliver } = await make();
      const [kind = "notice"] = kinds;
      subject.script("transient_error");
      const first = await deliver(inputOf(subject.row(kind), 1));
      expect(first).toMatchObject({ kind: "retry" });
      expect((first as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(
        0,
      );
      expect(
        await deliver(inputOf(subject.row(kind), subject.maxAttempts)),
      ).toMatchObject({ kind: "failed" });
    });

    test("a refusal that cannot clear is failed, with the channel's own code", async () => {
      const { subject, deliver } = await make();
      const [kind = "notice"] = kinds;
      subject.script("refused");
      const outcome = await deliver(inputOf(subject.row(kind), 1));
      expect(outcome).toEqual({ kind: "failed", code: expect.any(String) });
      expect((outcome as { code: string }).code).not.toBe("");
    });

    test("an acceptance that names no message is failed, not retried", async () => {
      const { subject, deliver } = await make();
      const [kind = "notice"] = kinds;
      subject.script("accepted_without_reference");
      expect(await deliver(inputOf(subject.row(kind), 1))).toMatchObject({
        kind: "failed",
      });
    });

    test("a request that went out and was not answered is uncertain, and does not throw", async () => {
      const { subject, deliver } = await make();
      const [kind = "notice"] = kinds;
      subject.script("no_answer");
      expect(await deliver(inputOf(subject.row(kind), 1))).toEqual({
        kind: "uncertain",
        code: expect.any(String),
      });
    });

    test("without a credential nothing is requested, nor begun: a retry, then failed when the attempts run out", async () => {
      const { subject, deliver } = await make();
      const [kind = "notice"] = kinds;
      subject.withoutCredential();
      let begun = 0;
      const begin = async () => {
        begun += 1;
        return true;
      };
      const first = await deliver(inputOf(subject.row(kind), 1, begin));
      expect(first).toMatchObject({ kind: "retry", code: "no_bot_token" });
      expect((first as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(
        0,
      );
      expect(
        await deliver(inputOf(subject.row(kind), subject.maxAttempts, begin)),
      ).toEqual({ kind: "failed", code: "no_bot_token" });
      expect(begun).toBe(0);
      expect(subject.requestsSent()).toBe(0);
    });
  });
}
