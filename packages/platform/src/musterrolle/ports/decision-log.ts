import type {
  AuthorizationDecision,
  AuthorizationReason,
  AuthorizationRequest,
} from "@werft-ai/contracts";

export type DecisionEntry = {
  request: AuthorizationRequest;
  decision: AuthorizationDecision;
};

export interface DecisionLog {
  record(entry: DecisionEntry): Promise<void>;
}

/**
 * An allow the policy left unrecorded for the store that acts on it. The
 * store keeps it, in the transaction that makes the change, as the one row
 * of the request: the allow, or a deny with `refusalOf` its outcome when a
 * rule decided under its locks refuses.
 */
export type UnrecordedAllow = DecisionEntry;

/** The reason a store outcome refuses for, or null when the allow stands. */
export type RefusalOf<Outcome extends string> = (
  outcome: Outcome,
) => AuthorizationReason | null;

/**
 * A store's rules among its outcomes. The outcomes left out answer for the
 * state the allowed act met (gone, already so, disabled), so the allow stands.
 */
export function refusals<Outcome extends string>(
  table: Partial<Record<Outcome, AuthorizationReason>>,
): RefusalOf<Outcome> {
  return (outcome) => table[outcome] ?? null;
}

export interface AuditRetentionStore {
  /**
   * False when the workspace does not exist or `ownerUserId` is no longer an
   * active owner of it when the write commits.
   */
  setAuditRetentionDays(input: {
    workspaceId: string;
    ownerUserId: string;
    days: number;
  }): Promise<boolean>;
}
