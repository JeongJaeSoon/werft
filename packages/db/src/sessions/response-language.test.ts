import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "../schema.ts";
import { agentReleases, sessions } from "../schema.ts";
import { newPartitionedSession } from "../testing/sessions.ts";
import { sessionResponseLanguage } from "./response-language.ts";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
});

afterEach(async () => {
  await client.close();
});

describe("sessionResponseLanguage", () => {
  test("the language the session's release fixes; none for follow-user, an unknown value or no field", async () => {
    const { sessionId } = await newPartitionedSession(db, "language");
    const [session] = await db
      .select({ release: sessions.agentReleaseId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const [release] = await db
      .select()
      .from(agentReleases)
      .where(eq(agentReleases.id, session?.release as string));
    // A release row never changes, so each case is a release of its own.
    const snapshot = async (value: Record<string, unknown>) => {
      const id = `sha256:${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
      await db.insert(agentReleases).values({
        ...(release as typeof agentReleases.$inferInsert),
        id,
        runtimeConfigSnapshot: {
          ...(release?.runtimeConfigSnapshot as Record<string, unknown>),
          ...value,
        },
      });
      await db
        .update(sessions)
        .set({ agentReleaseId: id })
        .where(eq(sessions.id, sessionId));
    };
    await snapshot({ language: "en" });
    expect(await sessionResponseLanguage(db, sessionId)).toBe("en");
    await snapshot({ language: "ja" });
    expect(await sessionResponseLanguage(db, sessionId)).toBe("ja");
    for (const value of [
      { language: "follow-user" },
      { language: "de" },
      { language: undefined },
    ]) {
      await snapshot(value);
      expect(await sessionResponseLanguage(db, sessionId)).toBeNull();
    }
    expect(await sessionResponseLanguage(db, randomUUID())).toBeNull();
  });
});
