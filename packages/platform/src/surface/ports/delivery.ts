/** The rows a `Notifiable` is handed. */
export type NoticeRowKind =
  | "notice"
  | "failure_notice"
  | "action_notice"
  | "model_notice";

/** The row an `Approvable` is handed. */
export type DecisionRequestRowKind = "input_notice";

/**
 * A row the sender has leased from the outbox, as far as the ports read it:
 * its kind picks the port. The address and the body, drawn when the row is
 * written, are the channel's own, so a channel's row type extends this one
 * and its implementation names that type (`Notifiable<TheChannelsRow>`).
 */
export type ClaimedOutboxRow = { kind: NoticeRowKind | DecisionRequestRowKind };

/**
 * What the sender hands a channel for one row. `begin` is called once, right
 * before the request leaves, and marks the row as being sent; what a channel
 * needs before that (a credential, a profile image) is read first so a slow
 * read spends no send lease. False means the lease is gone: nothing went out.
 */
export type DeliveryInput<Row = ClaimedOutboxRow> = {
  row: Row;
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
