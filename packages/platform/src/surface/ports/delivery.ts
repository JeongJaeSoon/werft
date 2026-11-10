import type { SlackOutboxClaim } from "../../ports/slack-outbox-store.ts";

/**
 * A row the sender has leased from the outbox. Its address and rendered body
 * are in it: the card is drawn when the row is written, so a channel sends
 * what the row holds.
 */
export type ClaimedOutboxRow = SlackOutboxClaim;

/**
 * What the sender hands a channel for one row. `begin` is called once, right
 * before the request leaves, and marks the row as being sent; what a channel
 * needs before that (a credential, a profile image) is read first so a slow
 * read spends no send lease. False means the lease is gone: nothing went out.
 */
export type DeliveryInput = {
  row: ClaimedOutboxRow;
  /** Attempts so far, this one included. */
  attempts: number;
  begin: () => Promise<boolean>;
};

/**
 * How one delivery ended. The sender settles the row from it and nothing else.
 * `code` names why in the channel's own words and is stored as the row's error.
 * `uncertain`: the request may have reached the channel; it is never sent again.
 * `lease_lost`: `begin` refused, so nothing went out and the row is not settled.
 */
export type DeliveryOutcome =
  | { kind: "sent"; ref: string }
  | { kind: "retry"; code: string; retryAfterMs: number }
  | { kind: "failed"; code: string }
  | { kind: "uncertain"; code: string }
  | { kind: "lease_lost" };
