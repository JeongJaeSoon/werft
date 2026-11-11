import { createHash, randomUUID } from "node:crypto";
import {
  type AgentPullRequestSettings,
  agentPullRequestSettingsSchema,
  DEFAULT_AGENT_PULL_REQUEST_SETTINGS,
  DEFAULT_PULL_REQUEST_SETTINGS,
  GITHUB_CEILING_NONE,
  type PullRequestSettings,
  pullRequestSettingsSchema,
} from "@werft-ai/contracts";
import type { PullRequestSettingsStore } from "@werft-ai/platform";
import { and, eq, sql } from "drizzle-orm";
import { lockAgentToChange } from "../agents.ts";
import { receiptActorOf } from "../control-shared.ts";
import { lockedRole } from "../musterrolle/api-keys.ts";
import type { Database } from "../queries.ts";
import {
  agentPullRequestSettings,
  agentReleases,
  githubWorkspaceSettings,
  receipts,
  sessions,
} from "../schema.ts";

export function pullRequestSettingsOf(stored: unknown): PullRequestSettings {
  const parsed = pullRequestSettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_PULL_REQUEST_SETTINGS;
}

function templateRecord(text: string | null) {
  return text === null
    ? null
    : {
        bytes: new TextEncoder().encode(text).length,
        sha256: createHash("sha256").update(text).digest("hex"),
      };
}

function receiptView(settings: PullRequestSettings | null) {
  return settings === null
    ? null
    : {
        formatting: settings.formatting,
        template_mode: settings.template_mode,
        session_link: settings.session_link,
        default_template: templateRecord(settings.default_template),
      };
}

function agentSettingsOf(row: {
  formatting: string;
  template: string | null;
  templateName: string | null;
}): AgentPullRequestSettings | null {
  const parsed = agentPullRequestSettingsSchema.safeParse({
    formatting: row.formatting,
    template: row.template,
    template_name: row.templateName,
  });
  return parsed.success ? parsed.data : null;
}

function agentReceiptView(settings: AgentPullRequestSettings | null) {
  return settings === null
    ? null
    : {
        formatting: settings.formatting,
        template_name: settings.template_name,
        template: templateRecord(settings.template),
      };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPostgresPullRequestSettingsStore(
  db: Database,
): PullRequestSettingsStore {
  return {
    async agent(agentId) {
      const [row] = await db
        .select()
        .from(agentPullRequestSettings)
        .where(eq(agentPullRequestSettings.agentId, agentId.toLowerCase()))
        .limit(1);
      const settings = row === undefined ? null : agentSettingsOf(row);
      return {
        settings: settings ?? DEFAULT_AGENT_PULL_REQUEST_SETTINGS,
        revision: row?.revision ?? 0,
      };
    },

    async agentOfSession(workspaceId, sessionId) {
      const [row] = await db
        .select({
          formatting: agentPullRequestSettings.formatting,
          template: agentPullRequestSettings.template,
          templateName: agentPullRequestSettings.templateName,
        })
        .from(sessions)
        .innerJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .innerJoin(
          agentPullRequestSettings,
          eq(agentPullRequestSettings.agentId, agentReleases.agentId),
        )
        .where(
          and(
            eq(sessions.id, sessionId.toLowerCase()),
            eq(sessions.ownerId, workspaceId),
            eq(agentPullRequestSettings.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      return row === undefined ? null : agentSettingsOf(row);
    },

    putAgent(input) {
      return db.transaction(async (tx) => {
        const agentId = input.agentId.toLowerCase();
        const locked = await lockAgentToChange(tx, input, agentId);
        if ("outcome" in locked) return locked;
        const [held] = await tx
          .select()
          .from(agentPullRequestSettings)
          .where(eq(agentPullRequestSettings.agentId, agentId))
          .limit(1)
          .for("update");
        if ((held?.revision ?? 0) !== input.revision) {
          return { outcome: "revision_conflict" as const };
        }
        const before = held === undefined ? null : agentSettingsOf(held);
        if (
          held !== undefined &&
          before !== null &&
          before.formatting === input.settings.formatting &&
          before.template === input.settings.template &&
          before.template_name === input.settings.template_name
        ) {
          return {
            outcome: "stored" as const,
            settings: input.settings,
            revision: held.revision,
            receiptId: null,
          };
        }
        const revision = input.revision + 1;
        const values = {
          formatting: input.settings.formatting,
          template: input.settings.template,
          templateName: input.settings.template_name,
          revision,
          updatedBy: input.userId,
        };
        if (held === undefined) {
          const [inserted] = await tx
            .insert(agentPullRequestSettings)
            .values({ agentId, workspaceId: input.workspaceId, ...values })
            .onConflictDoNothing({ target: agentPullRequestSettings.agentId })
            .returning({ revision: agentPullRequestSettings.revision });
          if (inserted === undefined) {
            return { outcome: "revision_conflict" as const };
          }
        } else {
          await tx
            .update(agentPullRequestSettings)
            .set({ ...values, updatedAt: sql`now()` })
            .where(eq(agentPullRequestSettings.agentId, agentId));
        }
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.principal.ownerId,
          actor: receiptActorOf(input.principal),
          operation: "set_agent_pull_request_settings",
          targetRef: {
            resource: { kind: "agent", id: agentId },
            workspace_id: input.workspaceId,
          },
          status: "succeeded",
          result: {
            agent_id: agentId,
            before: agentReceiptView(before),
            after: agentReceiptView(input.settings),
            revision,
          },
        });
        return {
          outcome: "stored" as const,
          settings: input.settings,
          revision,
          receiptId,
        };
      });
    },

    async get(workspaceId) {
      // An owner scope that is not a workspace id has no settings; the uuid
      // column would reject it rather than match nothing.
      if (!UUID.test(workspaceId)) {
        return { settings: DEFAULT_PULL_REQUEST_SETTINGS, revision: 0 };
      }
      const [row] = await db
        .select({
          pullRequest: githubWorkspaceSettings.pullRequest,
          revision: githubWorkspaceSettings.pullRequestRevision,
        })
        .from(githubWorkspaceSettings)
        .where(eq(githubWorkspaceSettings.workspaceId, workspaceId))
        .limit(1);
      return row === undefined
        ? { settings: DEFAULT_PULL_REQUEST_SETTINGS, revision: 0 }
        : {
            settings: pullRequestSettingsOf(row.pullRequest),
            revision: row.revision,
          };
    },

    put(input) {
      return db.transaction(async (tx) => {
        // A demotion or disable committed after the policy's check wins.
        const role = await lockedRole(tx, input.workspaceId, input.updatedBy);
        if (role !== "owner" && role !== "admin") {
          return { outcome: "actor_inactive" as const };
        }
        const [held] = await tx
          .select({
            pullRequest: githubWorkspaceSettings.pullRequest,
            revision: githubWorkspaceSettings.pullRequestRevision,
          })
          .from(githubWorkspaceSettings)
          .where(eq(githubWorkspaceSettings.workspaceId, input.workspaceId))
          .limit(1)
          .for("update");
        if ((held?.revision ?? 0) !== input.revision) {
          return { outcome: "revision_conflict" as const };
        }
        const before =
          held === undefined ? null : pullRequestSettingsOf(held.pullRequest);
        // Revision 0 is "never saved": the defaults sent back still count as
        // the first save, which the response contract numbers 1.
        if (
          held !== undefined &&
          held.revision > 0 &&
          JSON.stringify(before) === JSON.stringify(input.settings)
        ) {
          return {
            outcome: "stored" as const,
            settings: input.settings,
            revision: held.revision,
            receiptId: null,
          };
        }
        const revision = input.revision + 1;
        if (held === undefined) {
          // The ceiling stays unsaved: its revision 0 is what a client that
          // never saved one still holds. Two first writes both read no row;
          // the second finds the key.
          const [inserted] = await tx
            .insert(githubWorkspaceSettings)
            .values({
              workspaceId: input.workspaceId,
              ceiling: GITHUB_CEILING_NONE,
              revision: 0,
              pullRequest: input.settings,
              pullRequestRevision: revision,
              updatedBy: input.updatedBy,
            })
            .onConflictDoNothing()
            .returning({
              revision: githubWorkspaceSettings.pullRequestRevision,
            });
          if (inserted === undefined) {
            return { outcome: "revision_conflict" as const };
          }
        } else {
          await tx
            .update(githubWorkspaceSettings)
            .set({
              pullRequest: input.settings,
              pullRequestRevision: revision,
              updatedBy: input.updatedBy,
              updatedAt: sql`now()`,
            })
            .where(eq(githubWorkspaceSettings.workspaceId, input.workspaceId));
        }
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.workspaceId,
          actor: input.actor,
          operation: "set_github_pull_request_settings",
          targetRef: {
            resource: { kind: "workspace", id: input.workspaceId },
            workspace_id: input.workspaceId,
          },
          status: "succeeded",
          result: {
            before: receiptView(before),
            after: receiptView(input.settings),
            revision,
          },
        });
        return {
          outcome: "stored" as const,
          settings: input.settings,
          revision,
          receiptId,
        };
      });
    },
  };
}
