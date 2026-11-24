import type { AuthAttemptKind } from "@werft-ai/contracts";

declare const authAttemptKeyBrand: unique symbol;
/** An HMAC of an email or a client network: what a window is keyed on. */
export type AuthAttemptKey = string & { readonly [authAttemptKeyBrand]: true };

declare const authAttemptWindowBrand: unique symbol;
/** Which window an admitted attempt was counted in, for giving it back. */
export type AuthAttemptWindowRef = string & {
  readonly [authAttemptWindowBrand]: true;
};

export type AuthAttemptRule = { limit: number; windowMs: number };

export type AuthAttemptTake =
  | { admitted: true; window: AuthAttemptWindowRef }
  | {
      admitted: false;
      retryAfterMs: number;
      /** True for the first refusal of the window, and for no other. */
      closedNow: boolean;
      windowStartedAt: Date;
    };

/**
 * Fixed-window attempt counters, shared by every API replica. A window opens
 * at the first attempt and holds `limit` of them; the rest are refused until
 * it ends.
 */
export interface AuthAttemptStore {
  take(
    kind: AuthAttemptKind,
    key: AuthAttemptKey,
    rule: AuthAttemptRule,
  ): Promise<AuthAttemptTake>;
  /**
   * Uncounts an admitted attempt. Nothing once its window has ended or has
   * refused one, so a closed window stays closed until it ends.
   */
  giveBack(
    kind: AuthAttemptKind,
    key: AuthAttemptKey,
    window: AuthAttemptWindowRef,
    limit: number,
  ): Promise<void>;
  clear(kind: AuthAttemptKind, key: AuthAttemptKey): Promise<void>;
  /**
   * A `lock_login` receipt on each workspace the account with this email is
   * a live member of. Returns their ids; empty when there is no such account
   * or membership.
   */
  recordAccountLock(input: {
    email: string;
    windowStartedAt: Date;
    windowMs: number;
    failures: number;
  }): Promise<{ userId: string; workspaceIds: string[] } | null>;
}
