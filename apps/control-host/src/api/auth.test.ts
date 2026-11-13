import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiErrorResponseSchema,
  authMeResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  issuePasswordResetResponseSchema,
  loginResponseSchema,
  passwordResetResponseSchema,
  type UserLocale,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  BootstrapDoneError,
  type BootstrapInput,
  BootstrapTokenSpentError,
  type ConsumePasswordResetInput,
  type ExternalSignInResult,
  type IdentityStore,
  type IdentityUser,
  type IdentityWorkspace,
  type IssuePasswordResetInput,
  type IssuePasswordResetResult,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { Hono } from "hono";
import { BODY_IDLE_TIMEOUT_SECONDS } from "./app.ts";
import {
  apiKeyPrincipal,
  bootstrapGateFromEnv,
  createAuthenticator,
  createBootstrapGate,
  csrfViolation,
  hashPassword,
  hashWebSessionToken,
  LoginLockout,
  unauthenticatedPrincipal,
  WEB_SESSION_TTL_MS,
  WEB_SESSIONS_PER_USER,
  WorkGate,
} from "./auth.ts";
import { takeBootstrapTokenFile } from "./bootstrap-token-file.ts";
import {
  REQUEST_IDLE_TIMEOUT_SECONDS,
  RESPONSE_IDLE_TIMEOUT_SECONDS,
} from "./deadline.ts";
import { hashApiKey } from "./keys.ts";
import { recordRouteErrors } from "./route-error-coverage.ts";
import {
  permissionsOf,
  registerAuthRoutes,
  registerPublicAuthRoutes,
} from "./routes/auth.ts";

const createApiApp = recordRouteErrors("auth.test.ts");

// In-memory identity store with the same null/row semantics as the SQL
// helpers; the integration test covers the real queries.
class MemoryIdentityStore implements IdentityStore {
  users: IdentityUser[] = [];
  workspaces: IdentityWorkspace[] = [];
  memberships: Array<{
    workspaceId: string;
    userId: string;
    role: "owner" | "member";
    disabledAt: Date | null;
  }> = [];
  sessions: Array<{
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
    lastSeenAt: Date | null;
    renewals: number;
  }> = [];
  resets: Array<{
    workspaceId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    spent: boolean;
  }> = [];
  spentBootstrapTokens = new Set<string>();
  receipts: Array<{
    id: string;
    operation: string;
    targetRef: unknown;
    result?: unknown;
  }> = [];
  now = () => Date.now();

  async signInWithExternalIdentity(): Promise<ExternalSignInResult> {
    throw new Error("provider-login.test.ts covers external sign-in");
  }
  async countLiveOwners() {
    return this.memberships.filter(
      (m) =>
        m.role === "owner" &&
        m.disabledAt === null &&
        this.users.some((u) => u.id === m.userId && u.disabledAt === null),
    ).length;
  }
  async bootstrap(input: BootstrapInput) {
    if ((await this.countLiveOwners()) > 0) {
      throw new BootstrapDoneError();
    }
    const spent = Buffer.from(input.bootstrapTokenHash).toString("hex");
    if (this.spentBootstrapTokens.has(spent)) {
      throw new BootstrapTokenSpentError();
    }
    this.spentBootstrapTokens.add(spent);
    const recovered = this.users.length > 0;
    let workspace = this.workspaces[0];
    if (!workspace) {
      workspace = {
        id: input.workspaceId,
        slug: input.workspaceSlug,
        name: input.workspaceName,
        settings: {},
        createdAt: new Date(this.now()),
      };
      this.workspaces.push(workspace);
    }
    let user = this.users.find((u) => u.email === input.email);
    if (user) {
      user.passwordHash = input.passwordHash;
      user.disabledAt = null;
    } else {
      user = {
        id: input.userId,
        email: input.email,
        passwordHash: input.passwordHash,
        displayName: input.displayName,
        createdAt: new Date(this.now()),
        disabledAt: null,
      };
      this.users.push(user);
    }
    const userId = user.id;
    const membership = this.memberships.find(
      (m) => m.workspaceId === workspace.id && m.userId === userId,
    );
    if (membership) {
      membership.role = "owner";
      membership.disabledAt = null;
    } else {
      this.memberships.push({
        workspaceId: workspace.id,
        userId,
        role: "owner",
        disabledAt: null,
      });
    }
    if (recovered) {
      for (const session of this.sessions) {
        session.revokedAt ??= new Date(this.now());
      }
      for (const reset of this.resets) {
        if (reset.workspaceId === workspace.id) reset.spent = true;
      }
      this.receipts.push({
        id: input.receiptId,
        operation: "recover_owner",
        targetRef: {
          resource: { kind: "workspace", id: workspace.id },
          workspace_id: workspace.id,
        },
      });
    }
    return { user, workspace, recovered };
  }
  async retireBootstrapToken(tokenHash: Uint8Array) {
    this.spentBootstrapTokens.add(Buffer.from(tokenHash).toString("hex"));
  }
  async issuePasswordReset(
    input: IssuePasswordResetInput,
  ): Promise<IssuePasswordResetResult> {
    const liveRoles = (userId: string) =>
      this.users.some((u) => u.id === userId && u.disabledAt === null)
        ? this.memberships.filter(
            (m) => m.userId === userId && m.disabledAt === null,
          )
        : [];
    const issuer = this.users.find((u) => u.id === input.issuedBy);
    if (
      issuer?.passwordHash !== input.issuerPasswordHash ||
      !liveRoles(input.issuedBy).some(
        (m) => m.workspaceId === input.workspaceId && m.role === "owner",
      )
    ) {
      return { outcome: "issuer_changed" };
    }
    const roles = liveRoles(input.userId);
    const target = roles.find((m) => m.workspaceId === input.workspaceId);
    if (!target) return { outcome: "not_found" };
    if (
      roles.some(
        (m) => m.workspaceId !== input.workspaceId && m.role === "owner",
      )
    ) {
      return { outcome: "owner_elsewhere" };
    }
    for (const reset of this.resets) {
      if (reset.userId === input.userId) reset.spent = true;
    }
    const expiresAt = new Date(this.now() + input.ttlMs);
    this.resets.push({
      workspaceId: input.workspaceId,
      userId: input.userId,
      tokenHash: Buffer.from(input.tokenHash).toString("hex"),
      expiresAt,
      spent: false,
    });
    this.receipts.push({
      id: input.receiptId,
      operation: "issue_password_reset",
      targetRef: { user_id: input.userId, workspace_id: input.workspaceId },
      result: { target_role: target.role },
    });
    return { outcome: "issued", expiresAt };
  }
  async consumePasswordReset(input: ConsumePasswordResetInput) {
    const hex = Buffer.from(input.tokenHash).toString("hex");
    const reset = this.resets.find(
      (r) =>
        r.tokenHash === hex && !r.spent && r.expiresAt.getTime() > this.now(),
    );
    const user = this.users.find(
      (u) => u.id === reset?.userId && u.disabledAt === null,
    );
    const member = this.memberships.some(
      (m) =>
        m.workspaceId === reset?.workspaceId &&
        m.userId === user?.id &&
        m.disabledAt === null,
    );
    if (!reset || !user || !member) return null;
    reset.spent = true;
    user.passwordHash = input.passwordHash;
    for (const session of this.sessions) {
      if (session.userId === user.id) session.revokedAt ??= new Date();
    }
    this.receipts.push({
      id: input.receiptId,
      operation: "reset_password",
      targetRef: { user_id: user.id, workspace_id: reset.workspaceId },
    });
    return { userId: user.id, workspaceId: reset.workspaceId };
  }
  async findUserForLogin(email: string) {
    return (
      this.users.find((u) => u.email === email && u.disabledAt === null) ?? null
    );
  }
  async findLiveMembership(userId: string) {
    const row = this.memberships.find(
      (m) => m.userId === userId && m.disabledAt === null,
    );
    return row ? { workspaceId: row.workspaceId, role: row.role } : null;
  }
  async findWorkspace(workspaceId: string) {
    return this.workspaces.find((w) => w.id === workspaceId) ?? null;
  }
  async createWebSession(input: {
    id: string;
    userId: string;
    verifiedPasswordHash: string;
    tokenHash: Uint8Array;
    ttlMs: number;
    userAgent: string | null;
    maxLive: number;
  }) {
    const current = this.users.find(
      (u) => u.id === input.userId && u.disabledAt === null,
    );
    if (current?.passwordHash !== input.verifiedPasswordHash) return null;
    const expiresAt = new Date(this.now() + input.ttlMs);
    const mine = this.sessions.filter(
      (s) =>
        s.userId === input.userId &&
        s.revokedAt === null &&
        s.expiresAt.getTime() > this.now(),
    );
    const dropped = new Set(
      mine.slice(0, Math.max(0, mine.length - input.maxLive + 1)),
    );
    this.sessions = this.sessions.filter(
      (s) =>
        s.userId !== input.userId ||
        (!dropped.has(s) &&
          s.revokedAt === null &&
          s.expiresAt.getTime() > this.now()),
    );
    this.sessions.push({
      id: input.id,
      userId: input.userId,
      tokenHash: Buffer.from(input.tokenHash).toString("hex"),
      expiresAt,
      revokedAt: null,
      lastSeenAt: new Date(this.now()),
      renewals: 0,
    });
    return { expiresAt };
  }
  async resolveWebSession(
    tokenHash: Uint8Array,
  ): Promise<ResolvedWebSession | null> {
    const hex = Buffer.from(tokenHash).toString("hex");
    const session = this.sessions.find(
      (s) =>
        s.tokenHash === hex &&
        s.revokedAt === null &&
        s.expiresAt.getTime() > this.now(),
    );
    if (!session) return null;
    const user = this.users.find(
      (u) => u.id === session.userId && u.disabledAt === null,
    );
    const membership = user ? await this.findLiveMembership(user.id) : null;
    if (!user || !membership) return null;
    return {
      sessionId: session.id,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      locale: this.locales.get(user.id) ?? null,
      workspaceId: membership.workspaceId,
      role: membership.role,
      expiresAt: session.expiresAt,
    };
  }
  locales = new Map<string, UserLocale>();
  async setUserLocale(userId: string, locale: UserLocale) {
    this.locales.set(userId, locale);
  }
  async renewWebSession(
    sessionId: string,
    ttlMs: number,
    renewAfterMs: number,
  ): Promise<Date | null> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session || session.revokedAt !== null) return null;
    if (
      session.lastSeenAt === null ||
      session.lastSeenAt.getTime() < this.now() - renewAfterMs
    ) {
      session.expiresAt = new Date(this.now() + ttlMs);
      session.lastSeenAt = new Date(this.now());
      session.renewals += 1;
      return session.expiresAt;
    }
    return null;
  }
  async revokeWebSession(tokenHash: Uint8Array) {
    const hex = Buffer.from(tokenHash).toString("hex");
    for (const session of this.sessions) {
      if (session.tokenHash === hex && session.revokedAt === null) {
        session.revokedAt = new Date(this.now());
      }
    }
  }
}

const BOOTSTRAP_TOKEN = "t".repeat(40);
const PASSWORD = "correct horse battery staple";
const WRONG = "not the password at all";
const API_KEY = "csp_test-key";
const API_KEY_RECORD = {
  id: "key-id",
  ownerId: "key-owner",
  workspaceId: null,
  kind: "operator" as const,
  createdByUserId: null,
  creatorRole: null,
  scopes: ["sessions:read" as const],
};

function harness(
  options: {
    authMode?: string;
    lockout?: LoginLockout;
    passwordWork?: WorkGate;
    bootstrapToken?: string;
  } = {},
) {
  const identity = new MemoryIdentityStore();
  const sink = new MemoryLogSink();
  const logger = new StructuredLogger({ sinks: [sink] });
  const hooks: { beforeReauth?: () => void } = {};
  const auth = {
    identity,
    bootstrap: createBootstrapGate(options.bootstrapToken ?? BOOTSTRAP_TOKEN),
    logger,
    ...(options.lockout ? { lockout: options.lockout } : {}),
    ...(options.passwordWork ? { passwordWork: options.passwordWork } : {}),
  };
  const app = createApiApp({
    authMode: options.authMode ?? "api-key",
    logger,
    identity,
    keyStore: {
      async find(hash) {
        return Buffer.from(hash).equals(Buffer.from(hashApiKey(API_KEY)))
          ? API_KEY_RECORD
          : null;
      },
    },
    registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
    registerRoutes: (router) => {
      registerAuthRoutes(router, auth);
      router.get("/whoami", (context) =>
        context.json({
          owner_id: context.get("ownerId"),
          principal: context.get("principal"),
        }),
      );
      router.post("/mutate", (context) =>
        context.json({ owner_id: context.get("ownerId") }, 201),
      );
      // What SSE does on its clock: re-check the admitted credential.
      router.get("/reauth", async (context) => {
        hooks.beforeReauth?.();
        return context.json({ ok: await context.get("reauthenticate")() });
      });
    },
  });
  const json = (path: string, body: unknown, headers: HeadersInit = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const bootstrap = (overrides: Record<string, unknown> = {}) =>
    json("/v1/auth/bootstrap", {
      bootstrap_token: options.bootstrapToken ?? BOOTSTRAP_TOKEN,
      email: "Owner@Example.com",
      password: PASSWORD,
      display_name: "Owner",
      workspace_name: "Acme",
      workspace_slug: "acme",
      ...overrides,
    });
  const login = (email = "owner@example.com", password = PASSWORD) =>
    json("/v1/auth/login", { email, password }, BROWSER);
  return { app, identity, sink, json, bootstrap, login, hooks };
}

const BROWSER = { "X-Requested-With": "werft-web" };

function cookieOf(response: Response): string {
  const header = response.headers.get("Set-Cookie");
  if (!header) throw new Error("no Set-Cookie");
  return header.split(";")[0] ?? "";
}

async function errorCode(response: Response): Promise<string> {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

describe("bootstrap", () => {
  test("creates the first owner once, then answers 409 BOOTSTRAP_DONE", async () => {
    const h = harness();
    const first = await h.bootstrap();
    expect(first.status).toBe(201);
    const body = bootstrapResponseSchema.parse(await first.json());
    expect(body.role).toBe("owner");
    expect(body.workspace.slug).toBe("acme");
    expect(h.identity.users[0]?.email).toBe("owner@example.com");
    expect(h.identity.users[0]?.passwordHash).not.toContain(PASSWORD);

    const second = await h.bootstrap();
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe("BOOTSTRAP_DONE");
  });

  test("refuses a missing or wrong token with 401 and keeps the token spendable", async () => {
    const h = harness();
    expect((await h.bootstrap({ bootstrap_token: undefined })).status).toBe(
      401,
    );
    expect(
      (await h.bootstrap({ bootstrap_token: "x".repeat(40) })).status,
    ).toBe(401);
    expect(h.identity.users).toHaveLength(0);
    expect((await h.bootstrap()).status).toBe(201);
  });

  test("an oversized body is 413 and leaves the token unspent", async () => {
    const h = harness();
    const oversized = await h.bootstrap({
      display_name: "x".repeat(65 * 1024),
    });
    expect(oversized.status).toBe(413);
    expect(await errorCode(oversized)).toBe("PAYLOAD_TOO_LARGE");
    expect((await h.bootstrap()).status).toBe(201);
  });

  test("a failed insert releases the token for another try", async () => {
    const h = harness();
    const original = h.identity.bootstrap.bind(h.identity);
    let fail = true;
    h.identity.bootstrap = async (input) => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error("connection terminated"), {
          code: "ECONNRESET",
        });
      }
      return original(input);
    };
    expect((await h.bootstrap()).status).toBe(503);
    expect((await h.bootstrap()).status).toBe(201);
  });

  test("answers 401 before 400: the token is checked before the body", async () => {
    const h = harness();
    const invalidBody = { password: "x", workspace_slug: "Not A Slug" };
    // Wrong, missing or non-string token with an invalid body: 401, not 400.
    expect(
      (await h.bootstrap({ ...invalidBody, bootstrap_token: "y".repeat(40) }))
        .status,
    ).toBe(401);
    expect(
      (await h.bootstrap({ ...invalidBody, bootstrap_token: undefined }))
        .status,
    ).toBe(401);
    expect(
      (await h.bootstrap({ ...invalidBody, bootstrap_token: 42 })).status,
    ).toBe(401);
    // Right token, invalid body: 400, and the token is not spent.
    expect((await h.bootstrap(invalidBody)).status).toBe(400);
    expect((await h.bootstrap()).status).toBe(201);
    // Once done, a wrong token still learns nothing about the install.
    expect(
      (await h.bootstrap({ ...invalidBody, bootstrap_token: "y".repeat(40) }))
        .status,
    ).toBe(401);
    expect((await h.bootstrap(invalidBody)).status).toBe(409);
  });

  test("a matching token presented while an owner is live is spent", async () => {
    const h = harness();
    expect((await h.bootstrap()).status).toBe(201);
    h.identity.spentBootstrapTokens.clear();
    expect((await h.bootstrap()).status).toBe(409);
    expect(h.identity.spentBootstrapTokens).toContain(
      Buffer.from(hashWebSessionToken(BOOTSTRAP_TOKEN)).toString("hex"),
    );
  });

  test("failed attempts never lock out the right token", async () => {
    const h = harness({
      lockout: new LoginLockout({ now: () => 1_000_000 }),
    });
    for (let i = 0; i < 10; i += 1) {
      expect(
        (await h.bootstrap({ bootstrap_token: `${"y".repeat(39)}${i}` }))
          .status,
      ).toBe(401);
    }
    expect((await h.bootstrap()).status).toBe(201);
  });

  test("two concurrent bootstraps with the right token create one owner", async () => {
    const h = harness();
    const statuses = (await Promise.all([h.bootstrap(), h.bootstrap()]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([201, 409]);
    expect(h.identity.users).toHaveLength(1);
  });

  test("a generated token is printed once, only while no live owner exists", async () => {
    const identity = new MemoryIdentityStore();
    const sink = new MemoryLogSink();
    const logger = new StructuredLogger({ sinks: [sink] });
    const printed: string[] = [];
    const print = (line: string) => printed.push(line);
    const gate = await bootstrapGateFromEnv(undefined, identity, logger, print);
    expect(printed).toHaveLength(1);
    const token = printed[0]?.replace("BOOTSTRAP_TOKEN=", "") ?? "";
    expect(token).toHaveLength(43);
    expect(JSON.stringify(sink.records)).not.toContain(token);
    expect(gate.consume(token)).toBe(true);
    expect(gate.consume(token)).toBe(false);

    identity.users.push({ id: "u", disabledAt: null } as IdentityUser);
    identity.memberships.push({
      workspaceId: "w",
      userId: "u",
      role: "owner",
      disabledAt: null,
    });
    printed.length = 0;
    await bootstrapGateFromEnv(undefined, identity, logger, print);
    expect(printed).toHaveLength(0);

    const given = await bootstrapGateFromEnv(
      "g".repeat(32),
      identity,
      logger,
      print,
    );
    expect(printed).toHaveLength(0);
    expect(given.consume("g".repeat(32))).toBe(true);
    // Configured while an owner is live: spent, so it cannot recover later.
    expect(identity.spentBootstrapTokens).toContain(
      Buffer.from(hashWebSessionToken("g".repeat(32))).toString("hex"),
    );

    // A configured token the request schema would refuse can never be
    // presented, so it is a startup error rather than a silent dead install.
    await expect(
      bootstrapGateFromEnv("short", identity, logger, print),
    ).rejects.toThrow(/BOOTSTRAP_TOKEN/);
  });

  describe("with a BOOTSTRAP_TOKEN_FILE", () => {
    const setup = () => {
      const dir = mkdtempSync(join(tmpdir(), "bootstrap-token-"));
      const sink = new MemoryLogSink();
      return {
        dir,
        file: join(dir, "token"),
        sink,
        logger: new StructuredLogger({ sinks: [sink] }),
        printed: [] as string[],
      };
    };

    test("a minted token goes to the file once, never to the log or the output, and is gone after one take", async () => {
      const t = setup();
      try {
        const gate = await bootstrapGateFromEnv(
          undefined,
          new MemoryIdentityStore(),
          t.logger,
          (line) => t.printed.push(line),
          undefined,
          t.file,
        );
        const token = readFileSync(t.file, "utf8");
        expect(token).toHaveLength(43);
        expect(statSync(t.file).mode & 0o777).toBe(0o600);
        // Only the final name is left behind by the write-then-rename.
        expect(readdirSync(t.dir)).toEqual(["token"]);
        expect(gate.matches(token)).toBe(true);
        expect(t.printed.join("\n")).not.toContain(token);
        expect(JSON.stringify(t.sink.records)).not.toContain(token);

        expect(takeBootstrapTokenFile(t.file)).toBe(token);
        expect(existsSync(t.file)).toBe(false);
        expect(takeBootstrapTokenFile(t.file)).toBeNull();
        // Taking the value does not spend it: the gate still opens the install.
        expect(gate.consume(token)).toBe(true);
      } finally {
        rmSync(t.dir, { recursive: true, force: true });
      }
    });

    test("a second take finds nothing", async () => {
      const t = setup();
      try {
        writeFileSync(t.file, "x".repeat(43));
        const results = [
          takeBootstrapTokenFile(t.file),
          takeBootstrapTokenFile(t.file),
        ];
        expect(results.filter((r) => r !== null)).toEqual(["x".repeat(43)]);
      } finally {
        rmSync(t.dir, { recursive: true, force: true });
      }
    });

    test("a restart replaces the file's token, and a restart after the first owner removes it", async () => {
      const t = setup();
      try {
        const identity = new MemoryIdentityStore();
        const start = () =>
          bootstrapGateFromEnv(
            undefined,
            identity,
            t.logger,
            (line) => t.printed.push(line),
            undefined,
            t.file,
          );
        await start();
        const first = readFileSync(t.file, "utf8");
        await start();
        expect(readFileSync(t.file, "utf8")).not.toBe(first);

        identity.users.push({ id: "u", disabledAt: null } as IdentityUser);
        identity.memberships.push({
          workspaceId: "w",
          userId: "u",
          role: "owner",
          disabledAt: null,
        });
        await start();
        expect(existsSync(t.file)).toBe(false);
      } finally {
        rmSync(t.dir, { recursive: true, force: true });
      }
    });

    test("an operator's own BOOTSTRAP_TOKEN writes no file", async () => {
      const t = setup();
      try {
        await bootstrapGateFromEnv(
          "g".repeat(32),
          new MemoryIdentityStore(),
          t.logger,
          (line) => t.printed.push(line),
          undefined,
          t.file,
        );
        expect(existsSync(t.file)).toBe(false);
      } finally {
        rmSync(t.dir, { recursive: true, force: true });
      }
    });

    test("a file that cannot be written leaves the token out of the output too", async () => {
      const t = setup();
      try {
        const gate = await bootstrapGateFromEnv(
          undefined,
          new MemoryIdentityStore(),
          t.logger,
          (line) => t.printed.push(line),
          undefined,
          join(t.dir, "missing-dir", "token"),
        );
        expect(t.printed).toHaveLength(1);
        expect(t.printed[0]).not.toMatch(/[A-Za-z0-9_-]{43}/);
        expect(gate.matches("x".repeat(43))).toBe(false);
        expect(readdirSync(t.dir)).toEqual([]);
      } finally {
        rmSync(t.dir, { recursive: true, force: true });
      }
    });
  });

  test("an unreachable database does not stop startup; the value is printed since owners are unknown", async () => {
    const identity = new MemoryIdentityStore();
    identity.countLiveOwners = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
        code: "ECONNREFUSED",
      });
    };
    const sink = new MemoryLogSink();
    const logger = new StructuredLogger({ sinks: [sink] });
    const printed: string[] = [];
    const gate = await bootstrapGateFromEnv(
      undefined,
      identity,
      logger,
      (line) => printed.push(line),
    );
    expect(printed).toHaveLength(1);
    const value = printed[0]?.replace("BOOTSTRAP_TOKEN=", "") ?? "";
    expect(JSON.stringify(sink.records)).not.toContain(value);
    expect(gate.matches(value)).toBe(true);
  });

  test("a configured token is spent once the database answers, if startup could not check it", async () => {
    const identity = new MemoryIdentityStore();
    identity.users.push({ id: "u", disabledAt: null } as IdentityUser);
    identity.memberships.push({
      workspaceId: "w",
      userId: "u",
      role: "owner",
      disabledAt: null,
    });
    const counted = identity.countLiveOwners.bind(identity);
    let failures = 2;
    identity.countLiveOwners = async () => {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
      }
      return counted();
    };
    const logger = new StructuredLogger({ sinks: [new MemoryLogSink()] });
    await bootstrapGateFromEnv("g".repeat(32), identity, logger, () => {}, 5);
    expect(identity.spentBootstrapTokens.size).toBe(0);
    await Bun.sleep(100);
    expect(identity.spentBootstrapTokens).toContain(
      Buffer.from(hashWebSessionToken("g".repeat(32))).toString("hex"),
    );
  });

  test("an empty BOOTSTRAP_TOKEN refuses to start instead of generating one", async () => {
    const identity = new MemoryIdentityStore();
    let counted = 0;
    identity.countLiveOwners = async () => {
      counted += 1;
      return 0;
    };
    const logger = new StructuredLogger({ sinks: [new MemoryLogSink()] });
    const printed: string[] = [];
    await expect(
      bootstrapGateFromEnv("", identity, logger, (line) => printed.push(line)),
    ).rejects.toThrow(/BOOTSTRAP_TOKEN/);
    expect(counted).toBe(0);
    expect(printed).toHaveLength(0);
  });
});

describe("account recovery", () => {
  const OTHER_TOKEN = "n".repeat(40);
  const NEW_PASSWORD = "a brand new password here";

  async function withMember(h: ReturnType<typeof harness>) {
    await h.bootstrap();
    const owner = h.identity.users[0];
    const workspace = h.identity.workspaces[0];
    if (!owner || !workspace) throw new Error("bootstrap left no rows");
    const member: IdentityUser = {
      id: "00000000-0000-4000-8000-000000000002",
      email: "member@example.com",
      passwordHash: await hashPassword(PASSWORD),
      displayName: "Member",
      createdAt: new Date(),
      disabledAt: null,
    };
    h.identity.users.push(member);
    h.identity.memberships.push({
      workspaceId: workspace.id,
      userId: member.id,
      role: "member",
      disabledAt: null,
    });
    const ownerCookie = cookieOf(await h.login());
    const issue = (
      userId = member.id,
      cookie = ownerCookie,
      id = workspace.id,
      body: unknown = { current_password: PASSWORD },
    ) =>
      h.app.request(`/v1/workspaces/${id}/members/${userId}/password-reset`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          ...BROWSER,
        },
        body: JSON.stringify(body),
      });
    return { owner, member, workspace, ownerCookie, issue };
  }
  const redeem = (
    h: ReturnType<typeof harness>,
    token: string,
    password = NEW_PASSWORD,
  ) => h.json("/v1/auth/password-reset", { token, password });

  test("an owner's one-time link sets the password and ends the user's sessions", async () => {
    const h = harness();
    const { member, issue } = await withMember(h);
    const memberCookie = cookieOf(await h.login("member@example.com"));

    const issued = await issue();
    expect(issued.status).toBe(201);
    expect(issued.headers.get("Cache-Control")).toBe("no-store");
    const { token, expires_at } = issuePasswordResetResponseSchema.parse(
      await issued.json(),
    );
    expect(token).toStartWith("apr_");
    expect(Date.parse(expires_at) - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect(JSON.stringify(h.identity.resets)).not.toContain(token);
    expect(JSON.stringify(h.sink.records)).not.toContain(token);

    const redeemed = await redeem(h, token);
    expect(redeemed.status).toBe(200);
    const body = passwordResetResponseSchema.parse(await redeemed.json());
    expect(body.user_id).toBe(member.id);
    expect(h.identity.receipts).toContainEqual({
      id: body.receipt_id,
      operation: "reset_password",
      targetRef: { user_id: member.id, workspace_id: expect.any(String) },
    });
    expect(JSON.stringify(h.sink.records)).not.toContain(token);

    const stale = await h.app.request("/v1/auth/me", {
      headers: { Cookie: memberCookie },
    });
    expect(stale.status).toBe(401);
    expect((await h.login("member@example.com")).status).toBe(401);
    expect((await h.login("member@example.com", NEW_PASSWORD)).status).toBe(
      200,
    );

    const again = await redeem(h, token, "yet another new password");
    expect(again.status).toBe(401);
    expect(await errorCode(again)).toBe("UNAUTHORIZED");
  });

  test("issuing again revokes the open link, and an expired link is refused", async () => {
    const h = harness();
    const { issue } = await withMember(h);
    const first = issuePasswordResetResponseSchema.parse(
      await (await issue()).json(),
    );
    const second = issuePasswordResetResponseSchema.parse(
      await (await issue()).json(),
    );
    expect((await redeem(h, first.token)).status).toBe(401);
    const start = Date.now();
    h.identity.now = () => start + 61 * 60 * 1000;
    expect((await redeem(h, second.token)).status).toBe(401);
  });

  test("only an owner of that workspace can issue, and only for a live member", async () => {
    const h = harness();
    const { member, issue, workspace } = await withMember(h);
    const memberCookie = cookieOf(await h.login("member@example.com"));
    const byMember = await issue(member.id, memberCookie);
    expect(byMember.status).toBe(403);
    const byKey = await h.app.request(
      `/v1/workspaces/${workspace.id}/members/${member.id}/password-reset`,
      { method: "POST", headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(byKey.status).toBe(403);
    const otherWorkspace = await issue(
      member.id,
      undefined,
      "00000000-0000-4000-8000-0000000000ff",
    );
    expect(otherWorkspace.status).toBe(404);
    expect((await issue("not-a-uuid")).status).toBe(404);
    expect((await issue("00000000-0000-4000-8000-0000000000aa")).status).toBe(
      404,
    );
    const disabled = h.identity.users.find((u) => u.id === member.id);
    if (!disabled) throw new Error("member missing");
    disabled.disabledAt = new Date();
    expect((await issue()).status).toBe(404);
  });

  test("redeeming validates the body and maps a storage outage to 503", async () => {
    const h = harness();
    await withMember(h);
    const short = await redeem(h, "apr_x", "short");
    expect(short.status).toBe(400);
    const oversized = await redeem(h, "apr_x", "x".repeat(65 * 1024));
    expect(oversized.status).toBe(413);
    h.identity.consumePasswordReset = async () => {
      throw Object.assign(new Error("connection lost"), { code: "08006" });
    };
    expect((await redeem(h, "apr_x")).status).toBe(503);
  });

  test("failed redemptions never lock out a valid link", async () => {
    const h = harness({
      lockout: new LoginLockout({ now: () => 1_000_000 }),
    });
    const { issue } = await withMember(h);
    for (let i = 0; i < 10; i += 1) {
      expect((await redeem(h, `apr_guess-${i}`)).status).toBe(401);
    }
    const { token } = issuePasswordResetResponseSchema.parse(
      await (await issue()).json(),
    );
    expect((await redeem(h, token)).status).toBe(200);
  });

  test("redeeming and issuing answer 429 when the hashing gate is full", async () => {
    const passwordWork = new WorkGate(1, 0);
    const h = harness({ passwordWork });
    const { issue } = await withMember(h);
    const held = await passwordWork.tryAcquire();
    const busy = await redeem(h, "apr_x");
    expect(busy.status).toBe(429);
    expect(await errorCode(busy)).toBe("RATE_LIMITED");
    expect(busy.headers.get("Retry-After")).toBe("1");
    expect((await issue()).status).toBe(429);
    held?.();
    expect((await issue()).status).toBe(201);
  });

  test("an owner cannot issue a link for themselves", async () => {
    const h = harness();
    const { owner, issue } = await withMember(h);
    const self = await issue(owner.id);
    expect(self.status).toBe(403);
    expect(await errorCode(self)).toBe("FORBIDDEN");
    expect(h.identity.resets).toHaveLength(0);
  });

  test("issuing needs the issuer's current password, counted like a login", async () => {
    // Shared between the public and session routes, as server.ts wires it.
    const h = harness({ lockout: new LoginLockout() });
    const { issue, member, workspace, ownerCookie } = await withMember(h);
    expect((await issue(member.id, ownerCookie, workspace.id, {})).status).toBe(
      400,
    );
    const oversized = await issue(member.id, ownerCookie, workspace.id, {
      current_password: "x".repeat(65 * 1024),
    });
    expect(oversized.status).toBe(413);
    for (let i = 0; i < 5; i += 1) {
      const wrong = await issue(member.id, ownerCookie, workspace.id, {
        current_password: WRONG,
      });
      expect(wrong.status).toBe(403);
    }
    const locked = await issue();
    expect(locked.status).toBe(429);
    expect(await errorCode(locked)).toBe("RATE_LIMITED");
    expect(h.identity.resets).toHaveLength(0);
    // The same window as login: the owner's address is locked there too.
    expect((await h.login()).status).toBe(429);
  });

  test("a password changed after the check stops the issue", async () => {
    const h = harness();
    const { owner, issue } = await withMember(h);
    const original = h.identity.issuePasswordReset.bind(h.identity);
    h.identity.issuePasswordReset = async (input) => {
      owner.passwordHash = await hashPassword(WRONG);
      return original(input);
    };
    const stale = await issue();
    expect(stale.status).toBe(401);
    expect(h.identity.resets).toHaveLength(0);
  });

  test("while password sign-in is closed to the member, no link is issued", async () => {
    const h = harness();
    const { issue } = await withMember(h);
    // The store decides this under its lock (packages/db covers when); the
    // route only has to say it and hand out no token.
    h.identity.issuePasswordReset = async () => ({
      outcome: "password_closed",
    });
    const closed = await issue();
    expect(closed.status).toBe(409);
    const text = await closed.text();
    const { error } = apiErrorResponseSchema.parse(JSON.parse(text));
    expect(error.code).toBe("REVISION_CONFLICT");
    expect(error.details).toEqual({ reason_code: "password_login_closed" });
    // The token is made before the store is asked.
    expect(text).not.toContain("apr_");
  });

  test("a link for another owner is recorded as such; one for an owner elsewhere is refused", async () => {
    const h = harness();
    const { member, issue, workspace } = await withMember(h);
    const membership = h.identity.memberships.find(
      (m) => m.userId === member.id,
    );
    if (!membership) throw new Error("member membership missing");
    membership.role = "owner";
    expect((await issue()).status).toBe(201);
    expect(h.identity.receipts.at(-1)).toMatchObject({
      operation: "issue_password_reset",
      targetRef: { user_id: member.id, workspace_id: workspace.id },
      result: { target_role: "owner" },
    });

    membership.role = "member";
    h.identity.memberships.push({
      workspaceId: "00000000-0000-4000-8000-0000000000ee",
      userId: member.id,
      role: "owner",
      disabledAt: null,
    });
    const elsewhere = await issue();
    expect(elsewhere.status).toBe(403);
    expect(await errorCode(elsewhere)).toBe("FORBIDDEN");
  });

  test("a link dies with the user's membership", async () => {
    const h = harness();
    const { member, issue } = await withMember(h);
    const { token } = issuePasswordResetResponseSchema.parse(
      await (await issue()).json(),
    );
    const membership = h.identity.memberships.find(
      (m) => m.userId === member.id,
    );
    if (!membership) throw new Error("member membership missing");
    membership.disabledAt = new Date();
    expect((await redeem(h, token)).status).toBe(401);
  });

  test("with no live owner, a new token restores an owner in the same workspace and ends every session", async () => {
    const h = harness();
    const { owner, member, workspace } = await withMember(h);
    await h.login("member@example.com");
    const ownerMembership = h.identity.memberships.find(
      (m) => m.userId === owner.id,
    );
    if (!ownerMembership) throw new Error("owner membership missing");

    // A live owner still exists, but a token this process does not hold
    // learns nothing about that.
    expect((await h.bootstrap({ bootstrap_token: OTHER_TOKEN })).status).toBe(
      401,
    );

    ownerMembership.disabledAt = new Date();
    // A restart re-arms the process gate with the same value, but the
    // install token is spent in the store for good.
    const restart = (bootstrapToken: string) => {
      const next = harness({ bootstrapToken });
      next.identity = Object.assign(next.identity, {
        users: h.identity.users,
        workspaces: h.identity.workspaces,
        memberships: h.identity.memberships,
        sessions: h.identity.sessions,
        spentBootstrapTokens: h.identity.spentBootstrapTokens,
      });
      return next;
    };
    const reused = await restart(BOOTSTRAP_TOKEN).bootstrap();
    expect(reused.status).toBe(401);
    // The same answer as a wrong token; only the log says why.
    expect(await reused.json()).toMatchObject({
      error: { code: "UNAUTHORIZED", message: "Bootstrap token is invalid" },
    });

    const recovery = restart(OTHER_TOKEN);
    const restored = await recovery.bootstrap({
      workspace_slug: "ignored",
      workspace_name: "Ignored",
    });
    expect(restored.status).toBe(201);
    const body = bootstrapResponseSchema.parse(await restored.json());
    expect(body.user_id).toBe(owner.id);
    expect(body.workspace.id).toBe(workspace.id);
    expect(recovery.identity.workspaces).toHaveLength(1);
    expect(ownerMembership.disabledAt).toBeNull();
    expect(recovery.identity.sessions.every((s) => s.revokedAt !== null)).toBe(
      true,
    );
    expect(recovery.identity.receipts[0]?.operation).toBe("recover_owner");
    expect(
      h.identity.memberships.find((m) => m.userId === member.id)?.role,
    ).toBe("member");

    expect((await recovery.bootstrap()).status).toBe(409);
  });
});

describe("login, logout, me", () => {
  test("sets an HttpOnly Secure SameSite=Lax cookie and stores only the hash", async () => {
    const h = harness();
    await h.bootstrap();
    const response = await h.login("OWNER@example.com");
    expect(response.status).toBe(200);
    const body = loginResponseSchema.parse(await response.json());
    expect(body.role).toBe("owner");
    expect(body.scopes).toContain("sessions:recover");
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toStartWith(`${WEB_SESSION_COOKIE_NAME}=aps_`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    const token = cookieOf(response).split("=")[1] ?? "";
    expect(h.identity.sessions[0]?.tokenHash).toBe(
      Buffer.from(hashWebSessionToken(token)).toString("hex"),
    );
    expect(JSON.stringify(h.identity.sessions)).not.toContain(token);
    expect(
      (h.identity.sessions[0]?.expiresAt.getTime() ?? 0) - Date.now(),
    ).toBeGreaterThan(WEB_SESSION_TTL_MS - 5_000);
  });

  test("a wrong password and an unknown email answer the same 401", async () => {
    const h = harness();
    await h.bootstrap();
    const wrong = await h.login("owner@example.com", "not the password");
    const unknown = await h.login("nobody@example.com", PASSWORD);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const a = await wrong.json();
    const b = await unknown.json();
    expect(a.error.message).toBe(b.error.message);
    expect(wrong.headers.get("Set-Cookie")).toBeNull();
  });

  test("an account with no password fails password login like a wrong password", async () => {
    const h = harness();
    await h.bootstrap();
    const owner = h.identity.users[0];
    if (!owner) throw new Error("bootstrap left no rows");
    const wrong = await h.login("owner@example.com", "not the password");
    owner.passwordHash = null;
    const passwordless = await h.login("owner@example.com", PASSWORD);
    expect(passwordless.status).toBe(401);
    expect((await passwordless.json()).error.message).toBe(
      (await wrong.json()).error.message,
    );
    expect(passwordless.headers.get("Set-Cookie")).toBeNull();
  });

  test("a malformed body is 400 and an oversized one 413", async () => {
    const h = harness();
    const malformed = await h.json("/v1/auth/login", { email: 1 }, BROWSER);
    expect(malformed.status).toBe(400);
    expect(await errorCode(malformed)).toBe("BAD_REQUEST");
    const oversized = await h.login("x".repeat(65 * 1024));
    expect(oversized.status).toBe(413);
    expect(await errorCode(oversized)).toBe("PAYLOAD_TOO_LARGE");
  });

  test("a disabled account or membership cannot log in", async () => {
    const h = harness();
    await h.bootstrap();
    const membership = h.identity.memberships[0];
    const user = h.identity.users[0];
    if (!membership || !user) throw new Error("bootstrap left no rows");
    membership.disabledAt = new Date();
    expect((await h.login()).status).toBe(401);
    membership.disabledAt = null;
    user.disabledAt = new Date();
    expect((await h.login()).status).toBe(401);
  });

  test("me returns the user principal, user and workspace; logout revokes", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());

    const me = await h.app.request("/v1/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(me.status).toBe(200);
    const body = authMeResponseSchema.parse(await me.json());
    expect(body.principal.kind).toBe("user");
    expect(body.user?.email).toBe("owner@example.com");
    expect(body.workspace?.slug).toBe("acme");
    expect(body.workspace?.settings.kill_switch).toBe(false);
    expect(body.permissions).toContain("audit_retention.manage");
    expect(body.permissions).toContain("team.manage");

    const noHeader = await h.app.request("/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(noHeader.status).toBe(403);

    const logout = await h.app.request("/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(h.identity.sessions[0]?.revokedAt).not.toBeNull();

    const after = await h.app.request("/v1/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(after.status).toBe(401);
  });

  test("a session saves its user's language, which me then returns", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());
    const patch = (body: unknown, headers: Record<string, string> = {}) =>
      h.app.request("/v1/auth/me", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const me = async () =>
      authMeResponseSchema.parse(
        await (
          await h.app.request("/v1/auth/me", { headers: { Cookie: cookie } })
        ).json(),
      ).user?.locale;

    expect(await me()).toBeNull();
    expect((await patch({ locale: "ja" })).status).toBe(204);
    expect(await me()).toBe("ja");

    expect((await patch({ locale: "fr" })).status).toBe(400);
    expect((await patch({ locale: "en", extra: 1 })).status).toBe(400);
    expect((await patch({ locale: "x".repeat(65 * 1024) })).status).toBe(413);
    expect(await me()).toBe("ja");

    const withKey = await h.app.request("/v1/auth/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ locale: "en" }),
    });
    expect(withKey.status).toBe(403);
    const anonymous = await h.app.request("/v1/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "en" }),
    });
    expect(anonymous.status).toBe(401);

    h.identity.setUserLocale = async () => {
      throw Object.assign(new Error("connection lost"), { code: "08006" });
    };
    expect((await patch({ locale: "en" })).status).toBe(503);
  });

  test("me for an API key has no user and no workspace", async () => {
    const h = harness();
    const me = await h.app.request("/v1/auth/me", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(me.status).toBe(200);
    const body = authMeResponseSchema.parse(await me.json());
    expect(body.principal).toEqual(apiKeyPrincipal(API_KEY_RECORD));
    expect(body.user).toBeNull();
    expect(body.workspace).toBeNull();
    expect(body.permissions).toEqual([]);

    const logout = await h.app.request("/v1/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(logout.status).toBe(403);
  });

  test("permissions follow the policy's role table, an owner's beyond an admin's", () => {
    expect(permissionsOf("member").sort()).toEqual([
      "account.link",
      "agent.create",
      "api_key.manage_own",
    ]);
    expect(permissionsOf("admin")).toContain("team.manage");
    expect(permissionsOf("admin")).not.toContain("audit_retention.manage");
    expect(permissionsOf("admin")).not.toContain("usage.installation_read");
    expect(permissionsOf("owner")).toContain("usage.installation_read");
    expect(permissionsOf("admin")).toContain("usage.agent_read");
    expect(permissionsOf("owner")).toContain("audit_retention.manage");
  });

  test("an expired session is refused; an active one slides its expiry", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());
    const session = h.identity.sessions[0];
    if (!session) throw new Error("login left no session");
    const start = Date.now();
    h.identity.now = () => start + 2 * 60 * 60 * 1000;
    const later = await h.app.request("/v1/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(later.status).toBe(200);
    expect(session.renewals).toBe(1);
    expect(session.expiresAt.getTime()).toBe(
      start + 2 * 60 * 60 * 1000 + WEB_SESSION_TTL_MS,
    );
    // The browser's copy slides too: same token, the row's new Expires.
    const reissued = later.headers.get("Set-Cookie") ?? "";
    expect(reissued.split(";")[0]).toBe(cookie);
    expect(reissued).toContain(`Expires=${session.expiresAt.toUTCString()}`);
    expect(reissued).toContain("HttpOnly");
    // A second hit inside the renew window writes nothing and sets nothing.
    const quiet = await h.app.request("/v1/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(session.renewals).toBe(1);
    expect(quiet.headers.get("Set-Cookie")).toBeNull();

    h.identity.now = () => session.expiresAt.getTime() + 1;
    const expired = await h.app.request("/v1/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(expired.status).toBe(401);
  });
});

describe("login lockout", () => {
  test("holds at most maxKeys addresses, evicting the least recently failed", () => {
    let now = 0;
    const lockout = new LoginLockout({ maxKeys: 3, now: () => now });
    for (const key of ["a", "b", "c"]) {
      now += 1;
      lockout.recordFailure(key);
    }
    expect(lockout.size).toBe(3);
    now += 1;
    lockout.recordFailure("a"); // a becomes the most recent
    now += 1;
    lockout.recordFailure("d"); // evicts b, the least recently failed
    expect(lockout.size).toBe(3);
    for (let i = 0; i < 4; i += 1) lockout.recordFailure("b");
    expect(lockout.retryAfterMs("b")).toBe(0); // b restarted from zero
    for (let i = 0; i < 4; i += 1) lockout.recordFailure("a");
    expect(lockout.retryAfterMs("a")).toBeGreaterThan(0); // a kept its two
  });

  test("a concurrent burst cannot run more guesses than the limit", async () => {
    const lockout = new LoginLockout({ now: () => 1_000_000 });
    const h = harness({ lockout });
    await h.bootstrap();
    const statuses = (
      await Promise.all(
        Array.from({ length: 12 }, () => h.login("owner@example.com", WRONG)),
      )
    ).map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
  });

  test("a storage outage does not spend the budget, even in a concurrent burst", async () => {
    const lockout = new LoginLockout({ now: () => 1_000_000 });
    const h = harness({ lockout });
    await h.bootstrap();
    const findUserForLogin = h.identity.findUserForLogin;
    h.identity.findUserForLogin = async () => {
      throw Object.assign(new Error("connection lost"), { code: "08006" });
    };
    const outage = (
      await Promise.all(
        Array.from({ length: 12 }, () => h.login("owner@example.com", WRONG)),
      )
    ).map((r) => r.status);
    // Every attempt is 503 and gives its reservation back; the password
    // work gate keeps fewer than five in flight, so none sees the window
    // closed either.
    expect(outage).toEqual(Array.from({ length: 12 }, () => 503));
    expect(lockout.size).toBe(0);

    h.identity.findUserForLogin = findUserForLogin;
    for (let i = 0; i < 5; i += 1) {
      expect((await h.login("owner@example.com", WRONG)).status).toBe(401);
    }
    expect((await h.login()).status).toBe(429);
  });

  test("distinct unknown emails cannot run more password work than the gate admits", async () => {
    const lockout = new LoginLockout({ now: () => 1_000_000 });
    const h = harness({ lockout, passwordWork: new WorkGate(1, 2) });
    await h.bootstrap();
    let inFlight = 0;
    let peak = 0;
    let lookups = 0;
    const findUserForLogin = h.identity.findUserForLogin.bind(h.identity);
    h.identity.findUserForLogin = async (email: string) => {
      lookups += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      try {
        return await findUserForLogin(email);
      } finally {
        inFlight -= 1;
      }
    };
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        h.login(`nobody-${i}@example.com`, WRONG),
      ),
    );
    const statuses = responses.map((r) => r.status);
    // One running and two queued; the other seven are shed before any
    // lookup or hash, and do not count against their address.
    expect(statuses.filter((s) => s === 401)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    expect(peak).toBe(1);
    expect(lookups).toBe(3);
    expect(lockout.size).toBe(3);
    const shed = responses.find((r) => r.status === 429);
    expect(shed?.headers.get("Retry-After")).toBe("1");
    // Slots come back: the owner can log in afterwards.
    expect((await h.login()).status).toBe(200);
  });

  test("WorkGate admits up to its limit, queues up to maxQueued, refuses the rest", async () => {
    const gate = new WorkGate(2, 1);
    const first = await gate.tryAcquire();
    const second = await gate.tryAcquire();
    const third = gate.tryAcquire();
    expect(third).not.toBeNull();
    expect(gate.tryAcquire()).toBeNull();
    expect(gate.running).toBe(2);
    expect(gate.queued).toBe(1);
    first?.();
    first?.();
    const releaseThird = await third;
    expect(gate.running).toBe(2);
    expect(gate.queued).toBe(0);
    second?.();
    releaseThird?.();
    expect(gate.running).toBe(0);
  });

  test("release gives back only its own attempt and is a no-op after clear", () => {
    let now = 1_000_000;
    const lockout = new LoginLockout({ attempts: 2, now: () => now });
    const first = lockout.reserve("a");
    now += 1;
    const second = lockout.reserve("a");
    expect(lockout.reserve("a").retryAfterMs).toBeGreaterThan(0);
    first.release();
    first.release();
    const third = lockout.reserve("a");
    expect(third.retryAfterMs).toBe(0);
    lockout.clear("a");
    second.release();
    third.release();
    expect(lockout.size).toBe(0);
    expect(lockout.reserve("a").retryAfterMs).toBe(0);
  });

  test("the sixth failed attempt inside the window is 429, and success clears it", async () => {
    let now = 1_000_000;
    const lockout = new LoginLockout({ now: () => now });
    const h = harness({ lockout });
    await h.bootstrap();
    for (let i = 0; i < 5; i += 1) {
      expect((await h.login("owner@example.com", WRONG)).status).toBe(401);
    }
    const sixth = await h.login("owner@example.com", WRONG);
    expect(sixth.status).toBe(429);
    expect(await errorCode(sixth)).toBe("RATE_LIMITED");
    expect(Number(sixth.headers.get("Retry-After"))).toBeGreaterThan(0);
    // The right password is refused too while locked.
    expect((await h.login()).status).toBe(429);
    // Another address is not affected.
    expect((await h.login("other@example.com", WRONG)).status).toBe(401);

    now += 15 * 60 * 1000 + 1;
    expect((await h.login()).status).toBe(200);
    for (let i = 0; i < 5; i += 1) {
      await h.login("owner@example.com", WRONG);
    }
    expect((await h.login()).status).toBe(429);
  });
});

describe("principal middleware", () => {
  test("bearer wins over a cookie, and a bad bearer is not rescued by a valid cookie", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());
    const workspaceId = h.identity.workspaces[0]?.id;

    const cookieOnly = await h.app.request("/v1/whoami", {
      headers: { Cookie: cookie },
    });
    expect(await cookieOnly.json()).toMatchObject({
      owner_id: workspaceId,
      principal: { kind: "user", workspace_id: workspaceId, role: "owner" },
    });

    const bearerOnly = await h.app.request("/v1/whoami", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(await bearerOnly.json()).toMatchObject({
      owner_id: "key-owner",
      principal: { kind: "api_key", id: "key-id", owner_id: "key-owner" },
    });

    const both = await h.app.request("/v1/whoami", {
      headers: { Authorization: `Bearer ${API_KEY}`, Cookie: cookie },
    });
    expect(await both.json()).toMatchObject({ owner_id: "key-owner" });

    const badBearer = await h.app.request("/v1/whoami", {
      headers: { Authorization: "Bearer csp_wrong", Cookie: cookie },
    });
    expect(badBearer.status).toBe(401);

    // A present but empty, malformed or non-Bearer header is not a missing
    // one: the cookie must not stand in for it.
    for (const authorization of [
      "",
      "Basic dXNlcjpwYXNz",
      "Bearer",
      "Bearer ",
      `Bearer ${API_KEY} extra`,
    ]) {
      const response = await h.app.request("/v1/whoami", {
        headers: { Authorization: authorization, Cookie: cookie },
      });
      expect(response.status, JSON.stringify(authorization)).toBe(401);
    }

    expect((await h.app.request("/v1/whoami")).status).toBe(401);
    expect(
      (
        await h.app.request("/v1/whoami", {
          headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=aps_forged` },
        })
      ).status,
    ).toBe(401);

    // A sibling subdomain can set `werft_session` with Domain and a longer Path,
    // which browsers send first; it cannot set the `__Host-` name, so the
    // planted cookie is simply not ours.
    expect(WEB_SESSION_COOKIE_NAME).toStartWith("__Host-");
    const shadowed = await h.app.request("/v1/whoami", {
      headers: { Cookie: `werft_session=aps_planted; ${cookie}` },
    });
    expect(shadowed.status).toBe(200);
    expect(await shadowed.json()).toMatchObject({
      principal: { kind: "user", workspace_id: workspaceId },
    });
  });

  test("routes outside the public allowlist stay 401 without credentials", async () => {
    const h = harness();
    expect((await h.app.request("/v1/auth/me")).status).toBe(401);
    expect(
      (await h.app.request("/v1/auth/logout", { method: "POST" })).status,
    ).toBe(401);
    expect((await h.app.request("/v1/sessions")).status).toBe(401);
    // Public routes do not need credentials, and an unknown /v1/auth path is
    // not public just by prefix.
    expect((await h.login("x@example.com", "p".repeat(12))).status).toBe(401);
    expect((await h.app.request("/v1/auth/other")).status).toBe(401);
  });

  test("an unauthenticated POST to a protected route is refused before its body is read", async () => {
    const h = harness();
    const calls: number[] = [];
    const env = { setIdleTimeout: (seconds: number) => calls.push(seconds) };
    let pulled = 0;
    // A body that never finishes: reading it would hang the request.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled === 1) controller.enqueue(new TextEncoder().encode("{"));
      },
    });
    const response = await h.app.request(
      "/v1/mutate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit,
      env,
    );
    expect(response.status).toBe(401);
    // The deadline's clock for the auth lookup, never re-armed for a body.
    expect(calls).toEqual([
      REQUEST_IDLE_TIMEOUT_SECONDS,
      RESPONSE_IDLE_TIMEOUT_SECONDS,
    ]);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  test("public routes read their body under the idle clock, then return to the deadline's", async () => {
    const h = harness();
    const calls: number[] = [];
    const env = { setIdleTimeout: (seconds: number) => calls.push(seconds) };
    const response = await h.app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...BROWSER },
        body: JSON.stringify({ email: "a@example.com", password: WRONG }),
      },
      env,
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([
      REQUEST_IDLE_TIMEOUT_SECONDS,
      BODY_IDLE_TIMEOUT_SECONDS,
      REQUEST_IDLE_TIMEOUT_SECONDS,
      RESPONSE_IDLE_TIMEOUT_SECONDS,
    ]);
  });

  test("reauthenticate follows the cookie session: logout, disable and role change end it", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());
    const reauth = async () =>
      (
        (await (
          await h.app.request("/v1/reauth", { headers: { Cookie: cookie } })
        ).json()) as { ok: boolean }
      ).ok;
    expect(await reauth()).toBe(true);

    const membership = h.identity.memberships[0];
    const session = h.identity.sessions[0];
    if (!membership || !session) throw new Error("bootstrap left no rows");
    h.hooks.beforeReauth = () => {
      membership.role = "member";
    };
    expect(await reauth()).toBe(false);
    membership.role = "owner";
    h.hooks.beforeReauth = () => {
      membership.disabledAt = new Date();
    };
    expect(await reauth()).toBe(false);
    membership.disabledAt = null;
    h.hooks.beforeReauth = () => {
      session.revokedAt = new Date();
    };
    expect(await reauth()).toBe(false);
  });

  test("a cookie user's scopes follow the role: a member may not recover, an owner may", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());
    const membership = h.identity.memberships[0];
    if (!membership) throw new Error("bootstrap left no membership");
    const request = (path: string) =>
      h.app.request(path, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-Requested-With": "werft-web",
          "Idempotency-Key": "k",
        },
        body: "{}",
      });
    const recover = `/v1/sessions/${crypto.randomUUID()}/recovery-decisions`;
    const terminate = `/v1/sessions/${crypto.randomUUID()}/terminate`;

    membership.role = "member";
    const refused = await request(recover);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    // Control is still a member's; only the harness has no such route.
    expect((await request(terminate)).status).toBe(404);

    membership.role = "owner";
    // Past the policy: this harness registers no session routes, so the
    // owner reaches the router and finds none.
    expect((await request(recover)).status).toBe(404);
  });

  test("reauthenticate follows the API key", async () => {
    const h = harness();
    const response = await h.app.request("/v1/reauth", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(await response.json()).toEqual({ ok: true });
  });

  test("AUTH_MODE=none keeps trusting X-Owner-Id and ignores cookies", async () => {
    const h = harness({ authMode: "none" });
    await h.bootstrap();
    const cookie = cookieOf(await h.login());
    const header = await h.app.request("/v1/whoami", {
      headers: { "X-Owner-Id": "local-owner" },
    });
    expect(await header.json()).toMatchObject({
      owner_id: "local-owner",
      principal: { kind: "api_key", id: "local-owner" },
    });
    expect(
      (await h.app.request("/v1/whoami", { headers: { Cookie: cookie } }))
        .status,
    ).toBe(401);
  });
});

describe("login CSRF", () => {
  test("login needs the custom header, so a cross-site form cannot swap the victim's session", async () => {
    const h = harness();
    await h.bootstrap();
    const body = JSON.stringify({
      email: "owner@example.com",
      password: "correct horse battery staple",
    });
    // What a cross-site top-level form can send: text/plain, no custom
    // header, Sec-Fetch-Site cross-site. No cookie may come back.
    const form = await h.app.request("/v1/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Sec-Fetch-Site": "cross-site",
        Origin: "https://evil.example",
      },
      body,
    });
    expect(form.status).toBe(403);
    expect(form.headers.get("Set-Cookie")).toBeNull();
    const noHeader = await h.json("/v1/auth/login", JSON.parse(body));
    expect(noHeader.status).toBe(403);
    expect(noHeader.headers.get("Set-Cookie")).toBeNull();
    const withHeaderCrossSite = await h.json(
      "/v1/auth/login",
      JSON.parse(body),
      {
        ...BROWSER,
        "Sec-Fetch-Site": "cross-site",
      },
    );
    expect(withHeaderCrossSite.status).toBe(403);
    // Refused before the credentials are looked at: no session row.
    expect(h.identity.sessions).toHaveLength(0);
    expect((await h.login()).status).toBe(200);
  });

  test("a user keeps at most WEB_SESSIONS_PER_USER live sessions; the oldest goes first", async () => {
    const h = harness();
    await h.bootstrap();
    const cookies: string[] = [];
    for (let i = 0; i < WEB_SESSIONS_PER_USER + 2; i += 1) {
      cookies.push(cookieOf(await h.login()));
    }
    expect(h.identity.sessions).toHaveLength(WEB_SESSIONS_PER_USER);
    const status = async (cookie: string) =>
      (await h.app.request("/v1/whoami", { headers: { Cookie: cookie } }))
        .status;
    expect(await status(cookies[0] ?? "")).toBe(401);
    expect(await status(cookies[1] ?? "")).toBe(401);
    expect(await status(cookies[2] ?? "")).toBe(200);
    expect(await status(cookies.at(-1) ?? "")).toBe(200);
  });
});

describe("CSRF", () => {
  test("a cookie mutation needs the custom header; a bearer mutation does not", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());

    const noHeader = await h.json("/v1/mutate", {}, { Cookie: cookie });
    expect(noHeader.status).toBe(403);
    expect(await errorCode(noHeader)).toBe("FORBIDDEN");

    const withHeader = await h.json(
      "/v1/mutate",
      {},
      { Cookie: cookie, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    );
    expect(withHeader.status).toBe(201);

    const bearer = await h.json(
      "/v1/mutate",
      {},
      { Authorization: `Bearer ${API_KEY}` },
    );
    expect(bearer.status).toBe(201);

    // Reads never need it.
    const read = await h.app.request("/v1/whoami", {
      headers: { Cookie: cookie },
    });
    expect(read.status).toBe(200);
  });

  test("the header takes the current value and nothing else, the pre-rename value included", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());
    const send = (value: string, extra: Record<string, string> = {}) =>
      h.json(
        "/v1/mutate",
        {},
        { Cookie: cookie, [CSRF_HEADER_NAME]: value, ...extra },
      );

    expect((await send("werft-web")).status).toBe(201);
    expect(
      (await send("werft-web", { "Sec-Fetch-Site": "cross-site" })).status,
    ).toBe(403);
    expect(
      (
        await send("werft-web", {
          Host: "app.example",
          Origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);

    for (const value of [
      "",
      "werft",
      "WERFT-WEB",
      "agent-platform-web",
      "agent-platform",
      "XMLHttpRequest",
      "werft-web, agent-platform-web",
    ]) {
      expect((await send(value)).status).toBe(403);
    }
  });

  test("a cross-site or foreign-origin request is refused even with the header", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());
    const base = { Cookie: cookie, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    expect(
      (
        await h.json(
          "/v1/mutate",
          {},
          {
            ...base,
            Host: "app.example",
            Origin: "https://evil.example",
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.json(
          "/v1/mutate",
          {},
          {
            ...base,
            Host: "app.example",
            Origin: "https://app.example",
          },
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await h.json(
          "/v1/mutate",
          {},
          {
            ...base,
            "Sec-Fetch-Site": "cross-site",
          },
        )
      ).status,
    ).toBe(403);
  });

  test("csrfViolation is a no-op for non-user principals", () => {
    const principal = unauthenticatedPrincipal("o");
    const context = {
      req: { method: "POST", header: () => undefined },
    } as never;
    expect(csrfViolation(context, principal)).toBeNull();
  });
});

test("hashPassword produces argon2id", async () => {
  expect(await hashPassword("x".repeat(12))).toStartWith("$argon2id$");
});

describe("an API key's last use", () => {
  function harness(touchDue: boolean, touch: (keyId: string) => Promise<void>) {
    const sink = new MemoryLogSink();
    const authenticator = createAuthenticator({
      authMode: "api-key",
      logger: new StructuredLogger({ sinks: [sink] }),
      keyStore: {
        find: async () => ({
          id: "key-1",
          ownerId: "ws",
          workspaceId: "ws",
          scopes: ["sessions:read"],
          kind: "agent",
          agentId: "agent-1",
          createdByUserId: null,
          creatorRole: null,
          touchDue,
        }),
        touch,
      },
    });
    const app = new Hono();
    app.get("/", async (context) =>
      context.text((await authenticator.authenticate(context)) ? "in" : "out"),
    );
    const call = async () =>
      (
        await app.request("/", { headers: { Authorization: "Bearer csp_x" } })
      ).text();
    return { sink, call };
  }

  test("is recorded only when due", async () => {
    const touched: string[] = [];
    const due = harness(true, async (keyId) => {
      touched.push(keyId);
    });
    expect(await due.call()).toBe("in");
    const fresh = harness(false, async (keyId) => {
      touched.push(keyId);
    });
    expect(await fresh.call()).toBe("in");
    expect(touched).toEqual(["key-1"]);
  });

  test("a touch that fails or hangs does not hold up the request", async () => {
    const failing = harness(true, async () => {
      throw new Error("connection refused");
    });
    expect(await failing.call()).toBe("in");
    await Bun.sleep(0);
    expect(failing.sink.records).toContainEqual(
      expect.objectContaining({ message: "API key last use not recorded" }),
    );
    const hanging = harness(true, () => new Promise(() => {}));
    expect(await hanging.call()).toBe("in");
  });
});
