import { createHmac, randomBytes } from "node:crypto";
import {
  type AuthAttemptKind,
  LOGIN_LOCKOUT_ATTEMPTS,
  LOGIN_LOCKOUT_WINDOW_MINUTES,
} from "@werft-ai/contracts";
import type {
  AuthAttemptKey,
  AuthAttemptRule,
  AuthAttemptStore,
  AuthAttemptTake,
  AuthAttemptWindowRef,
} from "@werft-ai/platform";

export type AuthAttemptRules = {
  /** Failed password guesses at one account. */
  accountFailures: AuthAttemptRule;
  /** Failed password guesses from one client network, at any account. */
  networkFailures: AuthAttemptRule;
  /** Requests from one client network to the token routes, whatever their answer. */
  networkRequests: AuthAttemptRule;
};

const MINUTE_MS = 60 * 1000;

/** What an installation gets until its settings say otherwise. */
export const DEFAULT_AUTH_ATTEMPT_RULES: AuthAttemptRules = {
  accountFailures: {
    limit: LOGIN_LOCKOUT_ATTEMPTS,
    windowMs: LOGIN_LOCKOUT_WINDOW_MINUTES * MINUTE_MS,
  },
  networkFailures: { limit: 20, windowMs: 15 * MINUTE_MS },
  networkRequests: { limit: 30, windowMs: MINUTE_MS },
};

/**
 * What the attempt windows are keyed on: an HMAC of the email or the client
 * network under a key derived from the platform secret, the same on every
 * replica, so the table never holds either.
 */
export class AuthAttemptKeys {
  constructor(private readonly secret: Buffer = randomBytes(32)) {}

  account(email: string): AuthAttemptKey {
    return this.mac(`account:${email}`);
  }

  network(network: string): AuthAttemptKey {
    return this.mac(`network:${network}`);
  }

  private mac(value: string): AuthAttemptKey {
    return createHmac("sha256", this.secret)
      .update(value)
      .digest("base64url") as AuthAttemptKey;
  }
}

const MEMORY_MAX_KEYS = 10_000;

/**
 * The store's rules in process memory, for tests and for an API run without
 * a database. Past `maxKeys` the window touched longest ago is dropped.
 */
export class MemoryAuthAttemptStore implements AuthAttemptStore {
  // Map iteration is insertion order; a key is re-inserted on every take so
  // the first key is the one touched longest ago.
  private readonly windows = new Map<
    string,
    { startedAt: number; count: number }
  >();
  readonly locks: Array<{
    email: string;
    windowStartedAt: Date;
    windowMs: number;
    failures: number;
  }> = [];

  constructor(
    private readonly options: {
      now?: () => number;
      maxKeys?: number;
      /** Who recordAccountLock finds for an email; nobody by default. */
      members?: (email: string) => { userId: string; workspaceIds: string[] };
    } = {},
  ) {}

  get size(): number {
    return this.windows.size;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async take(
    kind: AuthAttemptKind,
    key: AuthAttemptKey,
    rule: AuthAttemptRule,
  ): Promise<AuthAttemptTake> {
    const id = `${kind}:${key}`;
    const now = this.now();
    let window = this.windows.get(id);
    this.windows.delete(id);
    if (window === undefined || window.startedAt <= now - rule.windowMs) {
      window = { startedAt: now, count: 0 };
    }
    if (this.windows.size >= (this.options.maxKeys ?? MEMORY_MAX_KEYS)) {
      const eldest = this.windows.keys().next().value;
      if (eldest !== undefined) this.windows.delete(eldest);
    }
    window.count += 1;
    this.windows.set(id, window);
    if (window.count <= rule.limit) {
      return {
        admitted: true,
        window: String(window.startedAt) as AuthAttemptWindowRef,
      };
    }
    return {
      admitted: false,
      retryAfterMs: Math.max(1, window.startedAt + rule.windowMs - now),
      closedNow: window.count === rule.limit + 1,
      windowStartedAt: new Date(window.startedAt),
    };
  }

  async giveBack(
    kind: AuthAttemptKind,
    key: AuthAttemptKey,
    ref: AuthAttemptWindowRef,
    upTo: number | null,
  ): Promise<void> {
    const window = this.windows.get(`${kind}:${key}`);
    if (
      window &&
      String(window.startedAt) === ref &&
      window.count >= 1 &&
      (upTo === null || window.count <= upTo)
    ) {
      window.count -= 1;
      if (window.count === 0) this.windows.delete(`${kind}:${key}`);
    }
  }

  async clear(kind: AuthAttemptKind, key: AuthAttemptKey): Promise<void> {
    this.windows.delete(`${kind}:${key}`);
  }

  async recordAccountLock(input: {
    email: string;
    windowStartedAt: Date;
    windowMs: number;
    failures: number;
  }): Promise<{ userId: string; workspaceIds: string[] } | null> {
    const found = this.options.members?.(input.email);
    if (!found || found.workspaceIds.length === 0) return null;
    this.locks.push(input);
    return found;
  }
}
