import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as schema from "@werft-ai/db";
import {
  findSlackInstallation,
  revokeSlackInstallation,
  slackInstallations,
  workspaces,
} from "@werft-ai/db";
import {
  type MockSlackOidc,
  startMockSlackOidc,
} from "@werft-ai/testkit/mock-slack-oidc";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  runSlackInstall,
  SLACK_INSTALL_EXIT,
  type SlackInstallIo,
} from "./slack-install.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const TOKEN = [
  "xoxb",
  "1234567890",
  "1234567890123",
  "notarealtoken0000bbbb",
].join("-");

integration("slack-install on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let slack: MockSlackOidc;
  let teamId: string;

  const newWorkspace = async () => {
    const id = randomUUID();
    await db.insert(workspaces).values({ id, slug: `ws-${id}`, name: "ws" });
    return id;
  };

  const run = async (
    workspaceId: string,
    database: (db: NodePgDatabase<typeof schema>) => schema.Database = (d) => d,
  ) => {
    const lines: string[] = [];
    const io: SlackInstallIo = {
      env: {
        SLACK_BOT_TOKEN: TOKEN,
        MOCK_SLACK_API_URL: `${slack.listenUrl}/api`,
        DATABASE_URL: "postgres://handled-by-openDatabase",
      },
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      openDatabase: async () => ({ db: database(db), close: async () => {} }),
    };
    const code = await runSlackInstall(
      ["register", "--workspace", workspaceId, "--app-id", "A0MOCK"],
      io,
    );
    const text = lines.join("\n");
    expect(text).not.toContain(TOKEN);
    return { code, text };
  };

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_install_cli" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    teamId = `T${randomUUID().slice(0, 8).toUpperCase()}`;
    slack = await startMockSlackOidc({
      account: { teamId, userId: "U0PERSON" },
      bot: { token: TOKEN, appId: "A0MOCK", botUserId: "U0BOT" },
    });
  }, 60_000);

  afterAll(async () => {
    await slack.stop();
    await pool.end();
    await database.drop();
  });

  test("one run leaves a verified row; a second run finds it", async () => {
    const workspaceId = await newWorkspace();

    const first = await run(workspaceId);
    expect(first.code).toBe(SLACK_INSTALL_EXIT.verified);
    const printed = JSON.parse(first.text);
    expect(printed).toMatchObject({
      outcome: "verified",
      registration: "registered",
      workspace_id: workspaceId,
      app_id: "A0MOCK",
      team_id: teamId,
      bot_user_id: "U0BOT",
    });
    const row = await findSlackInstallation(db, { appId: "A0MOCK", teamId });
    expect(row).toMatchObject({
      id: printed.installation_id,
      workspaceId,
      status: "verified",
      botUserId: "U0BOT",
    });

    const again = await run(workspaceId);
    expect(again.code).toBe(SLACK_INSTALL_EXIT.verified);
    expect(JSON.parse(again.text)).toMatchObject({
      registration: "existing",
      installation_id: printed.installation_id,
    });

    // Another workspace cannot take the same app and team.
    const other = await run(await newWorkspace());
    expect(other.code).toBe(SLACK_INSTALL_EXIT.workspace_conflict);
    expect(other.text).toContain(
      `workspace_conflict: app A0MOCK in team ${teamId} is installed for workspace ${workspaceId}`,
    );

    // A revoke landing between register and verify. Only verify opens a
    // transaction, so revoking on entry to it lands in that gap.
    const raced = await run(
      workspaceId,
      (d) =>
        new Proxy(d, {
          get(target, property, receiver) {
            if (property !== "transaction") {
              return Reflect.get(target, property, receiver);
            }
            return async (...args: Parameters<typeof target.transaction>) => {
              await revokeSlackInstallation(target, {
                appId: "A0MOCK",
                teamId,
              });
              return target.transaction(...args);
            };
          },
        }),
    );
    expect(raced.code).toBe(SLACK_INSTALL_EXIT.revoked);
    expect(raced.text).toContain(
      `revoked: installation ${printed.installation_id}`,
    );

    // Running it again reopens the revoked row.
    const reopened = await run(workspaceId);
    expect(reopened.code).toBe(SLACK_INSTALL_EXIT.verified);
    expect(JSON.parse(reopened.text)).toMatchObject({
      registration: "registered",
      installation_id: printed.installation_id,
    });

    // A revoked row still belongs to its workspace; the message says so.
    await revokeSlackInstallation(db, { appId: "A0MOCK", teamId });
    const takeover = await run(await newWorkspace());
    expect(takeover.code).toBe(SLACK_INSTALL_EXIT.workspace_conflict);
    expect(takeover.text).toContain(
      `belongs to workspace ${workspaceId} (revoked there); only that workspace can register it again`,
    );
  });

  test("an unknown workspace has its own exit code and writes nothing", async () => {
    const before = await db.$count(slackInstallations);
    const result = await run(randomUUID());
    expect(result.code).toBe(SLACK_INSTALL_EXIT.workspace_not_found);
    expect(result.text).toContain("workspace_not_found");
    expect(await db.$count(slackInstallations)).toBe(before);
  });

  test("the real process prints the row and never the token", async () => {
    const workspaceId = await newWorkspace();
    const otherTeam = `T${randomUUID().slice(0, 8).toUpperCase()}`;
    const otherSlack = await startMockSlackOidc({
      account: { teamId: otherTeam, userId: "U0PERSON" },
      bot: { token: TOKEN, appId: "A0PROC", botUserId: "U0BOTPROC" },
    });
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          new URL("./slack-install.ts", import.meta.url).pathname,
          "register",
          "--workspace",
          workspaceId,
          "--app-id",
          "A0PROC",
        ],
        {
          env: {
            PATH: process.env.PATH ?? "",
            SLACK_BOT_TOKEN: TOKEN,
            MOCK_SLACK_API_URL: `${otherSlack.listenUrl}/api`,
            DATABASE_URL: database.url,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(SLACK_INSTALL_EXIT.verified);
      expect(stdout).not.toContain(TOKEN);
      expect(stderr).not.toContain(TOKEN);
      expect(stdout).not.toContain("notarealtoken");
      expect(stderr).not.toContain("notarealtoken");
      const verified = stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith('{"outcome"'));
      expect(JSON.parse(verified ?? "null")).toMatchObject({
        outcome: "verified",
        team_id: otherTeam,
        bot_user_id: "U0BOTPROC",
      });
    } finally {
      await otherSlack.stop();
    }
  }, 30_000);
});
