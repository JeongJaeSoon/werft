import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  createAuthorizationPolicy,
  createSessionService,
  type SessionCatalog,
  SessionServiceError,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import { sessions } from "./schema.ts";
import {
  fixtureRelease,
  TEST_MODEL,
  testSessionCatalog,
} from "./testing/spec-pins.ts";

const OWNER = testCaller("00000000-0000-4000-8000-00000000000a");
const OTHER = testCaller("00000000-0000-4000-8000-00000000000b");

const CATALOG: SessionCatalog = testSessionCatalog({
  repositories: {
    app: {
      url: "https://github.com/acme/app.git",
      branch: "release/1.2",
      auth: { kind: "github_app", registered: true },
    },
  },
});

// Markers planted where a stored URL may hold a credential; none of them
// may reach a response.
const USERINFO_MARK = "planted-userinfo-mark";
const QUERY_MARK = "planted-query-mark";
const CATALOG_MARK = "planted-catalog-mark";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
});

afterEach(async () => {
  await client.close();
});

const service = (catalog: SessionCatalog = CATALOG) =>
  createSessionService({
    authorization: createAuthorizationPolicy(),
    inputs: createPostgresSessionUnitOfWork(db),
    controls: createPostgresSessionControl(db),
    reader: createPostgresSessionReader(db),
    catalog,
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
  });

// As the service's create stores it: the reading is what is under test.
async function create(body: { repository_id?: string }) {
  const entry =
    body.repository_id === undefined
      ? undefined
      : CATALOG.repositories[body.repository_id];
  const created = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    principal: OWNER,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    repository:
      entry === undefined || body.repository_id === undefined
        ? "none"
        : { id: body.repository_id, url: entry.url, branch: entry.branch },
    agentReleaseId: await fixtureRelease(db),
    model: TEST_MODEL,
    message: "hello",
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
  });
  if (created.outcome !== "accepted") throw new Error(created.outcome);
  return created.response.session_id;
}

async function read(id: string, catalog?: SessionCatalog) {
  const list = await service(catalog).listSessions(OWNER, { limit: 50 });
  const detail = await service(catalog).getSession(OWNER, id);
  return {
    listed: list.items.find((item) => item.id === id),
    detail,
    text: JSON.stringify({ list, detail }),
  };
}

describe("session repository (94S-822, 94S-820)", () => {
  test("list and detail carry the repository the session was created against", async () => {
    const id = await create({ repository_id: "app" });
    const { listed, detail } = await read(id);
    const repository = {
      id: "app",
      full_name: "acme/app",
      branch: "release/1.2",
    };
    expect(listed?.repository).toEqual(repository);
    expect(detail.repository).toEqual(repository);
    expect(detail.repository_id).toBe("app");
  });

  test("a changed or removed catalog entry does not change it", async () => {
    const id = await create({ repository_id: "app" });
    const moved: SessionCatalog = {
      ...CATALOG,
      repositories: {
        app: {
          url: "https://github.com/other/renamed.git",
          branch: "main",
          auth: { kind: "github_app", registered: true },
        },
      },
    };
    const removed: SessionCatalog = { ...CATALOG, repositories: {} };
    for (const catalog of [moved, removed]) {
      const { listed, detail } = await read(id, catalog);
      for (const repository of [listed?.repository, detail.repository]) {
        expect(repository).toEqual({
          id: "app",
          full_name: "acme/app",
          branch: "release/1.2",
        });
      }
      // The catalog check still sees the change; only the display stays.
      expect(detail.attention?.code).toBe("CATALOG_MISMATCH");
    }
  });

  test("a session created without a repository has none", async () => {
    const id = await create({});
    const { listed, detail } = await read(id);
    expect(listed?.repository).toBeNull();
    expect(detail.repository).toBeNull();
    expect(detail.repository_id).toBeNull();
  });

  test("a pre-catalog row has no key and is named from its URL", async () => {
    const id = await create({ repository_id: "app" });
    await db
      .update(sessions)
      .set({
        repositoryId: null,
        repoUrl: "https://github.com/legacy-org/legacy-repo",
        branch: "trunk",
      })
      .where(eq(sessions.id, id));
    const { listed, detail } = await read(id);
    const repository = {
      id: null,
      full_name: "legacy-org/legacy-repo",
      branch: "trunk",
    };
    expect(listed?.repository).toEqual(repository);
    expect(detail.repository).toEqual(repository);
  });

  test("no credential in a stored or catalog URL reaches any response", async () => {
    const legacy = await create({ repository_id: "app" });
    const keyed = await create({ repository_id: "app" });
    await db
      .update(sessions)
      .set({
        repositoryId: null,
        repoUrl: `https://agent:${USERINFO_MARK}@github.com/acme/app.git?access_token=${QUERY_MARK}`,
      })
      .where(eq(sessions.id, legacy));
    await db
      .update(sessions)
      .set({
        repoUrl: `https://agent:${USERINFO_MARK}@git.internal/acme/app%20copy.git?access_token=${QUERY_MARK}`,
      })
      .where(eq(sessions.id, keyed));
    // The catalog loader refuses such a URL; a catalog built around it
    // stands for an entry that predates that check.
    const leaky: SessionCatalog = {
      ...CATALOG,
      repositories: {
        app: {
          branch: "release/1.2",
          auth: { kind: "github_app", registered: true },
          url: `https://agent:${CATALOG_MARK}@github.com/acme/app.git?token=${CATALOG_MARK}`,
        },
      },
    };
    for (const catalog of [CATALOG, leaky]) {
      for (const id of [legacy, keyed]) {
        const { text } = await read(id, catalog);
        for (const mark of [USERINFO_MARK, QUERY_MARK, CATALOG_MARK]) {
          expect(text).not.toContain(mark);
        }
        expect(text).not.toContain("git.internal");
        expect(text).not.toContain("repo_url");
      }
      const { detail: legacyDetail } = await read(legacy, catalog);
      expect(legacyDetail.repository).toEqual({
        id: null,
        full_name: "acme/app",
        branch: "release/1.2",
      });
      // Not a plain path: the key stands in for the name.
      const { detail: keyedDetail } = await read(keyed, catalog);
      expect(keyedDetail.repository?.full_name).toBe("app");
    }
  });

  test("another owner neither lists nor reads it", async () => {
    const id = await create({ repository_id: "app" });
    const list = await service().listSessions(OTHER, { limit: 50 });
    expect(list.items).toEqual([]);
    const refused = await service()
      .getSession(OTHER, id)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SessionServiceError);
    expect((refused as SessionServiceError).code).toBe("NOT_FOUND");
  });
});
