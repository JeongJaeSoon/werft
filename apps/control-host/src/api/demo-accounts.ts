import { randomBytes, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  PASSWORD_MIN_LENGTH,
  passwordSchema,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  bootstrapOwner,
  countUsers,
  createPostgresInviteStore,
  type Database,
  memberships,
  users,
} from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import { callerFor, INVITE_TTL_MS, messageOf } from "@werft-ai/platform";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { withJobDatabase } from "../job-database.ts";
import {
  generateWebSessionToken,
  hashPassword,
  hashWebSessionToken,
  WEB_SESSION_TTL_MS,
  WEB_SESSIONS_PER_USER,
} from "./auth.ts";
import { generateInviteToken } from "./routes/musterrolle/invites.ts";

// The web console's demo sign-ins for a local development stack, the same
// on every machine (docs/quickstart.md "웹 콘솔 데모 계정"). Public on
// purpose: never reuse them anywhere real.
export const DEMO_PASSWORD = "demo-local-only";
export const DEMO_ACCOUNTS = [
  {
    email: "demo-owner@example.test",
    displayName: "Demo Owner",
    role: "owner",
  },
  {
    email: "demo-member@example.test",
    displayName: "Demo Member",
    role: "member",
  },
] as const satisfies readonly {
  email: string;
  displayName: string;
  role: WorkspaceRole;
}[];

/**
 * The demo accounts' password: DEMO_ACCOUNTS_PASSWORD when it is set (a
 * preview open to the internet makes one per run, .github/workflows/preview.yml),
 * else the public DEMO_PASSWORD. A value that is set but no valid password
 * throws rather than falling back to the public one.
 */
export function demoPassword(env: Record<string, string | undefined>): string {
  const chosen = env.DEMO_ACCOUNTS_PASSWORD;
  if (chosen === undefined) return DEMO_PASSWORD;
  if (!passwordSchema.safeParse(chosen).success) {
    throw new Error(
      `DEMO_ACCOUNTS_PASSWORD must be a password of at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
  return chosen;
}

// The compose postgres service, or a database on this machine.
const LOCAL_DATABASE_HOSTS = new Set([
  "postgres",
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

// The names a pod's resolver maps to the postgres Service of its own
// namespace.
function previewDatabaseHosts(namespace: string) {
  return new Set(
    [
      "",
      `.${namespace}`,
      `.${namespace}.svc`,
      `.${namespace}.svc.cluster.local`,
    ].map((suffix) => `postgres${suffix}`),
  );
}

/**
 * Why this process must not create the demo accounts, or null. Only
 * scripts/local.sh sets DEMO_ACCOUNTS=local, and only on its own compose
 * stack; a database elsewhere is a real installation. So is a Kubernetes
 * pod, unless the chart's preview.enabled gave it PREVIEW_NAMESPACE and its
 * database is that namespace's postgres Service: the flag alone must not
 * open fixed passwords on a real database.
 */
export function demoAccountsRefusal(
  env: Record<string, string | undefined>,
): string | null {
  if (env.DEMO_ACCOUNTS !== "local") {
    return "DEMO_ACCOUNTS=local is not set; only scripts/local.sh or a preview install creates demo accounts";
  }
  const preview = env.KUBERNETES_SERVICE_HOST ? env.PREVIEW_NAMESPACE : null;
  if (preview === undefined || preview === "") {
    return "this is a Kubernetes installation without preview.enabled";
  }
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? "");
  } catch {
    return "DATABASE_URL is missing or not a URL";
  }
  // pg lets the query (host, hostaddr, connectionString) override the
  // URL's own host; the compose DSN has no query at all.
  if (url.search !== "") {
    return "DATABASE_URL carries query options";
  }
  const host = url.hostname;
  const [allowed, expected] =
    preview === null
      ? [LOCAL_DATABASE_HOSTS, "the local compose postgres"]
      : [
          previewDatabaseHosts(preview),
          `the postgres Service of namespace ${preview}`,
        ];
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !allowed.has(host)
  ) {
    return `DATABASE_URL points at ${host}, not ${expected}`;
  }
  return null;
}

type Lookup = (host: string) => Promise<{ address: string }[]>;

// The trailing dot keeps the search domains out of every lookup of it.
function previewService(env: Record<string, string | undefined>) {
  return `postgres.${env.PREVIEW_NAMESPACE}.svc.cluster.local.`;
}

/**
 * The URL the CLI connects with. A preview pod uses the absolute Service
 * name previewDatabaseRefusal checked: pg resolves the host again on every
 * connection, and a short name could by then fall through elsewhere.
 */
export function demoDatabaseUrl(
  env: Record<string, string | undefined>,
): string {
  const raw = env.DATABASE_URL ?? "";
  if (!env.KUBERNETES_SERVICE_HOST) return raw;
  const url = new URL(raw);
  url.hostname = previewService(env);
  return url.toString();
}

/**
 * The DNS half of the preview exception, once demoAccountsRefusal passed:
 * the DATABASE_URL host must resolve to this namespace's postgres Service.
 * With no such Service a bare `postgres` falls through the pod's search
 * domains to whatever other host answers.
 */
export async function previewDatabaseRefusal(
  env: Record<string, string | undefined>,
  lookup: Lookup = (host) => dnsLookup(host, { all: true }),
): Promise<string | null> {
  if (!env.KUBERNETES_SERVICE_HOST) return null;
  const service = previewService(env);
  const host = new URL(env.DATABASE_URL ?? "").hostname;
  const addresses = async (name: string) =>
    (await lookup(name))
      .map(({ address }) => address)
      .sort()
      .join(",");
  let want: string;
  try {
    want = await addresses(service);
  } catch (error) {
    return `cannot resolve ${service}: ${messageOf(error)}`;
  }
  let got: string;
  try {
    got = await addresses(host);
  } catch (error) {
    return `cannot resolve ${host}: ${messageOf(error)}`;
  }
  if (got !== want) {
    return `DATABASE_URL host ${host} does not resolve to ${service}`;
  }
  return null;
}

export type DemoAccountOutcome = {
  email: string;
  outcome: "created" | "exists";
};

async function findUserId(db: Database, email: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  return row?.id ?? null;
}

// The demo owner when it is live, else the longest-standing live owner.
async function liveOwner(db: Database, preferEmail: string) {
  const rows = await db
    .select({
      userId: memberships.userId,
      workspaceId: memberships.workspaceId,
      email: users.email,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.role, "owner"),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      ),
    )
    .orderBy(asc(memberships.createdAt), asc(memberships.userId));
  return rows.find((row) => row.email === preferEmail) ?? rows[0] ?? null;
}

/**
 * Adds whichever demo account is missing and leaves every existing row
 * alone, so running it again changes nothing. An empty installation gets
 * the owner the way a bootstrap would; anything else is invited and
 * accepted, as an owner inviting from the web console would.
 */
export async function seedDemoAccounts(
  db: Database,
  password: string = DEMO_PASSWORD,
): Promise<DemoAccountOutcome[]> {
  const passwordHash = await hashPassword(password);
  const outcomes: DemoAccountOutcome[] = [];
  for (const account of DEMO_ACCOUNTS) {
    if ((await findUserId(db, account.email)) !== null) {
      outcomes.push({ email: account.email, outcome: "exists" });
      continue;
    }
    if (account.role === "owner") {
      // Emptiness is re-read under bootstrap's own lock: a user arriving in
      // between would turn bootstrapOwner into recovery.
      const bootstrapped = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('auth.bootstrap'))`,
        );
        if ((await countUsers(tx)) > 0) return false;
        await bootstrapOwner(tx, {
          userId: randomUUID(),
          email: account.email,
          passwordHash,
          displayName: account.displayName,
          workspaceId: randomUUID(),
          workspaceSlug: "demo",
          workspaceName: "Demo",
          // No BOOTSTRAP_TOKEN was presented; a fresh value spends nothing.
          bootstrapTokenHash: hashWebSessionToken(
            randomBytes(32).toString("base64url"),
          ),
          receiptId: randomUUID(),
          loginMethodId: randomUUID(),
        });
        return true;
      });
      if (bootstrapped) {
        outcomes.push({ email: account.email, outcome: "created" });
        continue;
      }
    }
    const owner = await liveOwner(db, DEMO_ACCOUNTS[0].email);
    if (!owner) {
      // Bootstrapping here would be recovery, which ends every session.
      throw new Error(
        "the installation has users but no live owner to invite the demo accounts",
      );
    }
    const store = createPostgresInviteStore(db);
    const inviteToken = generateInviteToken();
    const invited = await store.createInvite({
      id: randomUUID(),
      actor: {
        principal: callerFor(
          {
            kind: "user",
            id: owner.userId,
            workspace_id: owner.workspaceId,
            role: "owner",
            scopes: [...scopesForRole("owner")],
          },
          { kind: "web" },
          randomUUID(),
        ),
        workspaceId: owner.workspaceId,
        userId: owner.userId,
      },
      email: account.email,
      role: account.role,
      tokenHash: hashWebSessionToken(inviteToken),
      ttlMs: INVITE_TTL_MS,
      receiptId: randomUUID(),
    });
    if (invited.outcome !== "created") {
      throw new Error(`inviting ${account.email}: ${invited.outcome}`);
    }
    const accepted = await store.acceptInvite({
      tokenHash: hashWebSessionToken(inviteToken),
      account: {
        kind: "new",
        userId: randomUUID(),
        passwordHash,
        displayName: account.displayName,
        loginMethodId: randomUUID(),
      },
      session: {
        id: randomUUID(),
        tokenHash: hashWebSessionToken(generateWebSessionToken()),
        ttlMs: WEB_SESSION_TTL_MS,
        userAgent: "scripts/local.sh demo-accounts",
        maxLive: WEB_SESSIONS_PER_USER,
      },
      receiptId: randomUUID(),
    });
    if (accepted.outcome !== "accepted") {
      throw new Error(`accepting ${account.email}: ${accepted.outcome}`);
    }
    outcomes.push({ email: account.email, outcome: "created" });
  }
  return outcomes;
}

async function main(): Promise<void> {
  const refusal =
    demoAccountsRefusal(process.env) ??
    (await previewDatabaseRefusal(process.env));
  if (refusal) {
    console.error(`demo accounts refused: ${refusal}`);
    process.exitCode = 2;
    return;
  }
  const password = demoPassword(process.env);
  await withJobDatabase(
    "demo-accounts",
    demoDatabaseUrl(process.env),
    createLogger(),
    async ({ db }) => {
      for (const { email, outcome } of await seedDemoAccounts(db, password)) {
        console.log(`${outcome} ${email}`);
      }
    },
  );
}

if (import.meta.main) {
  await main();
}
