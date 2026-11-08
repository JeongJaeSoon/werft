import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  bootstrapTokenSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  LOGIN_LOCKOUT_ATTEMPTS,
  LOGIN_LOCKOUT_WINDOW_MINUTES,
  type Principal,
  SESSION_SCOPE_VALUES,
  scopesForRole,
  type UserLocale,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  type ApiKeyRecord,
  bootstrapOwner,
  consumePasswordReset,
  countLiveOwners,
  createWebSession,
  type Database,
  findLiveMembership,
  findUserForLogin,
  findWorkspace,
  issuePasswordReset,
  renewWebSession,
  resolveWebSession,
  retireBootstrapToken,
  revokeWebSession,
  setUserLocale,
  signInWithExternalIdentity,
} from "@werft-ai/db";
import type { StructuredLogger } from "@werft-ai/observability";
import type {
  BootstrapInput,
  ConsumePasswordResetInput,
  ExternalSignInInput,
  IdentityStore,
  IssuePasswordResetInput,
  ResolvedWebSession,
} from "@werft-ai/platform";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  removeBootstrapTokenFile,
  writeBootstrapTokenFile,
} from "./bootstrap-token-file";
import { type ApiKeyStore, hashApiKey } from "./keys.ts";

// Principal resolution for /v1 (03 §3.2). A bearer key is evaluated alone —
// a wrong key is never rescued by a cookie — and the cookie path
// exists only when the app was given a session store. AUTH_MODE=none keeps
// trusting X-Owner-Id and nothing else, exactly as before this file existed.

export const WEB_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// A session's expiry slides forward at most this often, so an active tab
// does not turn every request into an UPDATE.
const WEB_SESSION_RENEW_AFTER_MS = 60 * 60 * 1000;
// Live sessions one user may hold; the next login drops the oldest.
export const WEB_SESSIONS_PER_USER = 10;
const LOGIN_LOCKOUT_WINDOW_MS = LOGIN_LOCKOUT_WINDOW_MINUTES * 60 * 1000;

export class DatabaseIdentityStore implements IdentityStore {
  constructor(private readonly db: Database) {}
  countLiveOwners() {
    return countLiveOwners(this.db);
  }
  bootstrap(input: BootstrapInput) {
    return bootstrapOwner(this.db, input);
  }
  retireBootstrapToken(tokenHash: Uint8Array) {
    return retireBootstrapToken(this.db, tokenHash);
  }
  issuePasswordReset(input: IssuePasswordResetInput) {
    return issuePasswordReset(this.db, input);
  }
  consumePasswordReset(input: ConsumePasswordResetInput) {
    return consumePasswordReset(this.db, input);
  }
  findUserForLogin(email: string) {
    return findUserForLogin(this.db, email);
  }
  findLiveMembership(userId: string) {
    return findLiveMembership(this.db, userId);
  }
  findWorkspace(workspaceId: string) {
    return findWorkspace(this.db, workspaceId);
  }
  createWebSession(input: {
    id: string;
    userId: string;
    verifiedPasswordHash: string;
    tokenHash: Uint8Array;
    ttlMs: number;
    userAgent: string | null;
    maxLive: number;
  }) {
    return createWebSession(this.db, input);
  }
  signInWithExternalIdentity(input: ExternalSignInInput) {
    return signInWithExternalIdentity(this.db, input);
  }
  resolveWebSession(tokenHash: Uint8Array) {
    return resolveWebSession(this.db, tokenHash);
  }
  renewWebSession(sessionId: string, ttlMs: number, renewAfterMs: number) {
    return renewWebSession(this.db, sessionId, ttlMs, renewAfterMs);
  }
  revokeWebSession(tokenHash: Uint8Array) {
    return revokeWebSession(this.db, tokenHash);
  }
  setUserLocale(userId: string, locale: UserLocale) {
    return setUserLocale(this.db, userId, locale);
  }
}

// ---------------------------------------------------------------------------
// Tokens and passwords
// ---------------------------------------------------------------------------

// Same shape as API keys: a prefixed random token whose sha256 is stored.
export function generateWebSessionToken(): string {
  return `aps_${randomBytes(32).toString("base64url")}`;
}

export const hashWebSessionToken = hashApiKey;

export function generatePasswordResetToken(): string {
  return `apr_${randomBytes(32).toString("base64url")}`;
}

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

let unknownUserHash: Promise<string> | undefined;
/**
 * Verify against a real hash even when there is no user, so a login for an
 * unknown email takes as long as one with a wrong password and the response
 * does not say which it was.
 */
export async function verifyPassword(
  password: string,
  storedHash: string | null,
): Promise<boolean> {
  if (storedHash === null) {
    unknownUserHash ??= hashPassword(randomBytes(16).toString("base64url"));
    await Bun.password.verify(password, await unknownUserHash);
    return false;
  }
  return Bun.password.verify(password, storedHash);
}

// ---------------------------------------------------------------------------
// Bootstrap token
// ---------------------------------------------------------------------------

export interface BootstrapGate {
  /**
   * Whether the candidate is the token, spent or not; does not spend it. A
   * right token that a concurrent request already spent is a 409, not a 401.
   */
  matches(candidate: string): boolean;
  /** True once, for the matching token; false afterwards and for any other. */
  consume(candidate: string): boolean;
  /** Undo a consume whose bootstrap did not complete. */
  release(): void;
}

export function createBootstrapGate(token: string): BootstrapGate {
  let pending: string | null = token;
  const expected = Buffer.from(token, "utf8");
  const matches = (candidate: string) => {
    const given = Buffer.from(candidate, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  return {
    matches,
    consume(candidate) {
      if (pending === null || !matches(candidate)) return false;
      pending = null;
      return true;
    },
    release() {
      pending = token;
    },
  };
}

const BOOTSTRAP_RETIRE_RETRY_MS = 30_000;

/** Retries until `work` resolves once; the timer never holds the process. */
function retryInBackground(work: () => Promise<void>, delayMs: number) {
  const attempt = () => {
    work().catch(() => {
      setTimeout(attempt, delayMs).unref();
    });
  };
  setTimeout(attempt, delayMs).unref();
}

function generateBootstrapToken(): string {
  return randomBytes(32).toString("base64url");
}

/** False when the file cannot be written, so the caller prints the token instead. */
function writeTokenFile(
  path: string,
  token: string,
  logger: StructuredLogger,
): boolean {
  try {
    writeBootstrapTokenFile(path, token);
    return true;
  } catch (error) {
    logger.warn("BOOTSTRAP_TOKEN_FILE could not be written", {
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}

/**
 * Take the operator's token or mint one. A minted token is printed once, and
 * only while the install needs it — no live owner, first install or
 * recovery — so an established deployment that forgot the variable does
 * not print a secret nobody can use. It goes
 * through `print`, not the structured logger: that logger redacts any
 * `*token*` field on purpose, and this is the one value that must reach the
 * operator's terminal in the clear.
 */
export async function bootstrapGateFromEnv(
  value: string | undefined,
  store: Pick<IdentityStore, "countLiveOwners" | "retireBootstrapToken">,
  logger: StructuredLogger,
  print: (line: string) => void = (line) => console.error(line),
  retryMs = BOOTSTRAP_RETIRE_RETRY_MS,
  tokenFile?: string,
): Promise<BootstrapGate> {
  if (value !== undefined) {
    // The request schema bounds the token; a configured value outside it
    // could never be presented, which would leave the install impossible to
    // bootstrap with no error anywhere. Refuse to start instead. An empty
    // value is a secret injection that failed, not a request to generate
    // one and print it to a log the operator meant to keep it out of.
    const parsed = bootstrapTokenSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        "BOOTSTRAP_TOKEN must be 32 to 256 characters (or unset to generate one)",
      );
    }
    // A value configured while an owner is live cannot be the new token a
    // recovery needs, and an install that predates bootstrap_token_uses
    // never recorded the one it used. Spend it now, or as soon as the
    // database answers: left unchecked, it would still open recovery if the
    // owners were lost later.
    const tokenHash = hashWebSessionToken(parsed.data);
    const retire = async () => {
      if ((await store.countLiveOwners()) > 0) {
        await store.retireBootstrapToken(tokenHash);
      }
    };
    try {
      await retire();
    } catch (error) {
      logger.warn("BOOTSTRAP_TOKEN could not be checked against live owners", {
        error_name: error instanceof Error ? error.name : typeof error,
      });
      retryInBackground(retire, retryMs);
    }
    return createBootstrapGate(parsed.data);
  }
  const token = generateBootstrapToken();
  let owners: number | null;
  try {
    owners = await store.countLiveOwners();
  } catch (error) {
    // The API starts without its database and answers readiness 503
    // so an unreachable database cannot stop startup here. The
    // count is unknown; print anyway, since the value only ever works while
    // no live owner exists.
    owners = null;
    logger.warn("BOOTSTRAP_TOKEN not set and owners could not be counted", {
      error_name: error instanceof Error ? error.name : typeof error,
    });
  }
  if (owners === null || owners === 0) {
    if (tokenFile !== undefined && writeTokenFile(tokenFile, token, logger)) {
      print(
        `BOOTSTRAP_TOKEN not set; the value for this process waits in ${tokenFile}. Take it once with the bootstrap-token command`,
      );
    } else {
      logger.warn(
        "BOOTSTRAP_TOKEN not set; a value for this process was printed to stderr",
      );
      print(`BOOTSTRAP_TOKEN=${token}`);
    }
  } else if (tokenFile !== undefined) {
    // A restart after the first owner exists: the file left by the earlier
    // process holds a value this process no longer accepts.
    removeBootstrapTokenFile(tokenFile);
  }
  return createBootstrapGate(token);
}

// ---------------------------------------------------------------------------
// Login lockout
// ---------------------------------------------------------------------------

const LOGIN_LOCKOUT_MAX_KEYS = 10_000;

// Each argon2id verify holds ~64 MiB and a core for tens of milliseconds,
// and an unknown email still runs one against the dummy hash, so rotating
// addresses walks straight past the per-email lockout. This bounds the
// work one process admits no matter how many addresses are tried.
// Per-client (IP) and cross-replica limits need the ingress's view of the
// client and are left to the deployment.
const PASSWORD_WORK_CONCURRENCY = 4;
const PASSWORD_WORK_QUEUE = 64;

/**
 * At most `limit` holders at once and `maxQueued` waiting; anything beyond
 * that is refused immediately instead of piling up.
 */
export class WorkGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly limit = PASSWORD_WORK_CONCURRENCY,
    private readonly maxQueued = PASSWORD_WORK_QUEUE,
  ) {}

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  /** A promise of the release function, or null when the queue is full. */
  tryAcquire(): Promise<() => void> | null {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    if (this.waiters.length >= this.maxQueued) {
      return null;
    }
    return new Promise((resolve) => {
      this.waiters.push(() => resolve(this.releaser()));
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      // The slot passes straight to the next waiter, so `active` only drops
      // when nobody is queued.
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    };
  }
}

/**
 * Per-email failure window, in process memory. Two replicas keep two
 * windows, so the effective limit is attempts × replicas; a shared store is
 * the trigger for moving this to the database. The map holds at most
 * `maxKeys` addresses: past that, the address whose failure was recorded
 * longest ago is dropped, so a spray of distinct emails costs the attacker
 * their own lockouts, not the process its memory.
 */
export interface LoginReservation {
  retryAfterMs: number;
  /** Give the attempt back; a no-op once cleared, evicted or released. */
  release(): void;
}

export class LoginLockout {
  // Map iteration is insertion order; a key is re-inserted on every failure
  // so the first key is always the least recently failed one.
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly options: {
      attempts?: number;
      windowMs?: number;
      maxKeys?: number;
      now?: () => number;
    } = {},
  ) {}

  private get attempts() {
    return this.options.attempts ?? LOGIN_LOCKOUT_ATTEMPTS;
  }
  private get windowMs() {
    return this.options.windowMs ?? LOGIN_LOCKOUT_WINDOW_MS;
  }
  private get maxKeys() {
    return this.options.maxKeys ?? LOGIN_LOCKOUT_MAX_KEYS;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }

  get size(): number {
    return this.failures.size;
  }

  private live(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) {
      this.failures.delete(key);
    }
    return kept;
  }

  /** Milliseconds until the caller may try again, or 0 when not locked. */
  retryAfterMs(key: string): number {
    const live = this.live(key);
    if (live.length < this.attempts) return 0;
    const oldest = live[live.length - this.attempts] ?? this.now();
    return Math.max(1, oldest + this.windowMs - this.now());
  }

  recordFailure(key: string): void {
    const live = this.live(key);
    live.push(this.now());
    // Only the last `attempts` stamps can ever matter to retryAfterMs.
    const kept = live.slice(-this.attempts);
    this.failures.delete(key);
    if (this.failures.size >= this.maxKeys) {
      const eldest = this.failures.keys().next().value;
      if (eldest !== undefined) {
        this.failures.delete(eldest);
      }
    }
    this.failures.set(key, kept);
  }

  /**
   * Check and count one attempt in a single synchronous step. A zero
   * `retryAfterMs` means the attempt was admitted and already counted as a
   * failure: clear() on success, release() when it failed for a reason that
   * is not a guess (storage down). Otherwise nothing was counted.
   */
  reserve(key: string): LoginReservation {
    const wait = this.retryAfterMs(key);
    if (wait > 0) return { retryAfterMs: wait, release: () => {} };
    this.recordFailure(key);
    const stamp = this.failures.get(key)?.at(-1);
    return {
      retryAfterMs: 0,
      release: () => {
        const stamps = this.failures.get(key);
        const index = stamp === undefined ? -1 : (stamps?.indexOf(stamp) ?? -1);
        if (!stamps || index < 0) return;
        stamps.splice(index, 1);
        if (stamps.length === 0) this.failures.delete(key);
      },
    };
  }

  clear(key: string): void {
    this.failures.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Principal resolution
// ---------------------------------------------------------------------------

export interface AuthenticatorOptions {
  authMode: string | undefined;
  keyStore: ApiKeyStore;
  // Absent: no cookie path, the app is API-key only as in alpha.
  identity?: IdentityStore;
  logger?: StructuredLogger;
}

type Authenticated = {
  principal: Principal;
  verified: boolean;
  /** Set on the cookie path; GET /v1/auth/me and logout read it. */
  webSession?: ResolvedWebSession;
  /** Re-runs the credential check; SSE calls it so revocation ends a stream. */
  reauthenticate: () => Promise<boolean>;
  /**
   * Set when a key row authenticated; a personal key names its creator, an
   * agent key its agent.
   */
  storedKey?: {
    creatorId: string | null;
    agentId: string | null;
    issuerId: string | null;
    kind: ApiKeyRecord["kind"];
  };
};

function bearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? null;
}

// AUTH_MODE=none trusts X-Owner-Id and holds every scope, as before scopes.
export function unauthenticatedPrincipal(ownerId: string): Principal {
  return {
    kind: "api_key",
    id: ownerId,
    owner_id: ownerId,
    workspace_id: null,
    scopes: [...SESSION_SCOPE_VALUES],
  };
}

// A key carries exactly what `keys create --scopes` gave it. One issued
// before scopes existed (NULL) holds none and has to be reissued: guessing
// "everything" would hand it recovery too.
export function apiKeyPrincipal(key: ApiKeyRecord): Principal {
  const scopes = key.scopes === null ? [] : [...key.scopes];
  const ceiling =
    key.kind === "personal" && key.creatorRole !== null
      ? new Set(scopesForRole(key.creatorRole))
      : null;
  return {
    kind: "api_key",
    id: key.id,
    owner_id: key.ownerId,
    workspace_id: key.workspaceId,
    scopes: ceiling === null ? scopes : scopes.filter((s) => ceiling.has(s)),
  };
}

function samePrincipal(left: Principal, right: Principal): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface Authenticator {
  authenticate(context: Context): Promise<Authenticated | null>;
}

export function createAuthenticator(
  options: AuthenticatorOptions,
): Authenticator {
  const { authMode, keyStore, identity, logger } = options;
  return {
    async authenticate(context: Context) {
      if (authMode === "none") {
        const ownerId = context.req.header("X-Owner-Id")?.trim() || null;
        return ownerId
          ? {
              principal: unauthenticatedPrincipal(ownerId),
              verified: false,
              reauthenticate: async () => true,
            }
          : null;
      }
      const authorization = context.req.header("Authorization");
      if (authorization !== undefined) {
        // Any Authorization header commits the request to the API key path:
        // an empty, malformed or non-Bearer one fails here rather than
        // falling back to whatever cookie session this browser holds.
        const token = bearerToken(authorization);
        if (!token) {
          return null;
        }
        const keyHash = hashApiKey(token);
        const key = await keyStore.find(keyHash);
        if (!key) {
          return null;
        }
        if (key.touchDue && keyStore.touch) {
          // Not awaited: a last-use time is not worth a request's latency.
          keyStore.touch(key.id).catch((error: unknown) => {
            logger?.warn("API key last use not recorded", {
              key_id: key.id,
              error_name: error instanceof Error ? error.name : "UnknownError",
            });
          });
        }
        const principal = apiKeyPrincipal(key);
        return {
          principal,
          storedKey: {
            creatorId: key.kind === "personal" ? key.createdByUserId : null,
            agentId: key.kind === "agent" ? (key.agentId ?? null) : null,
            issuerId: key.createdByUserId,
            kind: key.kind,
          },
          verified: true,
          // Nothing edits a key's scopes today, but a stream that outlives
          // a narrowed key must not keep what the key no longer holds.
          reauthenticate: async () => {
            const current = await keyStore.find(keyHash);
            return (
              current !== null &&
              samePrincipal(apiKeyPrincipal(current), principal)
            );
          },
        };
      }
      if (!identity) {
        return null;
      }
      const cookie = getCookie(context, WEB_SESSION_COOKIE_NAME);
      if (!cookie) {
        return null;
      }
      const tokenHash = hashWebSessionToken(cookie);
      const session = await identity.resolveWebSession(tokenHash);
      if (!session) {
        return null;
      }
      // A long-lived response re-checks the same session: logout, expiry, a
      // disabled account or membership, or a role change all end it.
      const reauthenticate = async () => {
        const current = await identity.resolveWebSession(tokenHash);
        return (
          current !== null &&
          current.sessionId === session.sessionId &&
          current.workspaceId === session.workspaceId &&
          current.role === session.role
        );
      };
      const renewed = await identity.renewWebSession(
        session.sessionId,
        WEB_SESSION_TTL_MS,
        WEB_SESSION_RENEW_AFTER_MS,
      );
      if (renewed) {
        // The browser drops the cookie at its own Expires, so it has to
        // slide with the row or an active user is logged out at day 14.
        setWebSessionCookie(context, cookie, renewed);
      }
      return {
        principal: {
          kind: "user",
          id: session.userId,
          workspace_id: session.workspaceId,
          role: session.role,
          scopes: [...scopesForRole(session.role)],
        },
        verified: true,
        webSession: session,
        reauthenticate,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// CSRF (03 §3.2)
// ---------------------------------------------------------------------------

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Why a cookie-authenticated mutation is refused, or null. The custom header
 * cannot be sent cross-site without a CORS preflight the API never answers,
 * and the Origin check catches a same-site sibling that could. Bearer calls
 * are not subject to this: a key is not sent by the browser on its own.
 */
export function csrfViolation(
  context: Context,
  principal: Principal,
): string | null {
  if (principal.kind !== "user" || SAFE_METHODS.has(context.req.method)) {
    return null;
  }
  return browserRequestViolation(context);
}

/**
 * The CSRF checks on their own, for a route that must hold them whoever the
 * caller is: login sets the session cookie, so a cross-site form posting
 * the attacker's credentials would swap the victim into the attacker's
 * account. A custom header cannot be sent cross-site without a preflight.
 */
export function browserRequestViolation(context: Context): string | null {
  if (context.req.header(CSRF_HEADER_NAME) !== CSRF_HEADER_VALUE) {
    return `${CSRF_HEADER_NAME} header is required`;
  }
  if (context.req.header("Sec-Fetch-Site") === "cross-site") {
    return "cross-site request";
  }
  const origin = context.req.header("Origin");
  if (origin && origin !== "null") {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return "malformed Origin";
    }
    if (originHost !== context.req.header("Host")) {
      return "Origin does not match Host";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

export function setWebSessionCookie(
  context: Context,
  token: string,
  expiresAt: Date,
): void {
  setCookie(context, WEB_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearWebSessionCookie(context: Context): void {
  deleteCookie(context, WEB_SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
  });
}

export function webSessionCookie(context: Context): string | undefined {
  return getCookie(context, WEB_SESSION_COOKIE_NAME);
}
