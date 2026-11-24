import type * as schema from "@werft-ai/db";
import {
  announceLapsedInputWaits,
  createPostgresConversationCalls,
  deleteExpiredWebSessions,
  expireAuthzDecisions,
  expireOverdueInterrupts,
  expireOverdueTerminations,
  expireParkedGroups,
  expireToolCallAudits,
  projectToolCalls,
  purgeEndedAuthAttemptWindows,
  purgeExpiredEnvStart,
  purgeExpiredSlackChannelMembers,
  purgeFailedSlackInboundPayloads,
  purgeJudgmentBuffer,
  purgeUnknownSlackSourceMarks,
  reconcileAgentOwnership,
  reconcileExpiredLeases,
  reconcileOrphanedSessions,
  reconcileOverdueInterrupts,
  reconcileProviderExchanges,
  unknownBudgetByAccount,
} from "@werft-ai/db";
import { SEQUENTIAL_ROLE_POOL_MAX } from "@werft-ai/db/pool";
import { createLogger, logLevelFromEnv } from "@werft-ai/observability";
import {
  INTERRUPT_RECEIPT_DEADLINE_MS,
  INTERRUPT_SETTLE_DEADLINE_MS,
  TERMINATE_DEADLINE_MS,
} from "@werft-ai/platform";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { queueDatabaseUrl } from "../database-url.ts";
import { withJobDatabase } from "../job-database.ts";
import { runUnknownBudgetReport } from "./budget-unknown.ts";
import { runConversationCallReconciler } from "./conversation-calls.ts";
import { runProviderExchangeReconciler } from "./provider-exchanges.ts";
import {
  type ReconcilerLogger,
  type ReconcilerRun,
  runReconciler,
} from "./reconcile.ts";

// From packages/db/bench/tool-calls.ts on 18M events: a batch of results
// alone took 4s at 20,000 and up to 99s while backfill writes piled up. The
// pass (RECONCILER_PASS_TIMEOUT_SEC, 60) must also fit this budget plus the
// last batch's statements, each cut at the job pool's 10s.
const TOOL_CALL_BATCH_SIZE = 5_000;
const TOOL_CALL_BUDGET_MS = 10_000;
// Sign-in keys can be made faster than one batch a pass deletes.
const AUTH_ATTEMPT_PURGE_BUDGET_MS = 2_000;

export async function main(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const databaseUrl = queueDatabaseUrl(environment);
  const logger = createLogger({
    level: logLevelFromEnv(environment.LOG_LEVEL),
  });
  await withJobDatabase(
    "reconciler",
    databaseUrl,
    logger,
    async ({ db }) => {
      await reconcileOnce(db, environment, logger);
      await runProviderExchangeReconciler({
        environment: {
          ...(environment.RECONCILER_BATCH_SIZE === undefined
            ? {}
            : { RECONCILER_BATCH_SIZE: environment.RECONCILER_BATCH_SIZE }),
          ...(environment.RECONCILER_DRY_RUN === undefined
            ? {}
            : { RECONCILER_DRY_RUN: environment.RECONCILER_DRY_RUN }),
        },
        logger,
        reconcile: (options) => reconcileProviderExchanges(db, options),
      });
      const conversationCalls = createPostgresConversationCalls(db);
      await runConversationCallReconciler({
        environment: {
          ...(environment.RECONCILER_BATCH_SIZE === undefined
            ? {}
            : { RECONCILER_BATCH_SIZE: environment.RECONCILER_BATCH_SIZE }),
          ...(environment.RECONCILER_DRY_RUN === undefined
            ? {}
            : { RECONCILER_DRY_RUN: environment.RECONCILER_DRY_RUN }),
        },
        logger,
        releaseExpired: (options) => conversationCalls.releaseExpired(options),
        markUnknown: (options) => conversationCalls.markUnknown(options),
      });
      await runUnknownBudgetReport({
        environment: {
          ...(environment.RECONCILER_BATCH_SIZE === undefined
            ? {}
            : { RECONCILER_BATCH_SIZE: environment.RECONCILER_BATCH_SIZE }),
        },
        logger,
        unknownByAccount: (limit) => unknownBudgetByAccount(db, limit),
      });
    },
    { max: SEQUENTIAL_ROLE_POOL_MAX },
  );
}

/** One pass over `db`; every write in it is re-judged under row locks. */
export function reconcileOnce(
  db: NodePgDatabase<typeof schema>,
  environment: NodeJS.ProcessEnv,
  logger: ReconcilerLogger,
): Promise<ReconcilerRun> {
  return runReconciler({
    environment: {
      ...(environment.HEARTBEAT_TTL_SEC === undefined
        ? {}
        : { HEARTBEAT_TTL_SEC: environment.HEARTBEAT_TTL_SEC }),
      ...(environment.RECONCILER_BATCH_SIZE === undefined
        ? {}
        : { RECONCILER_BATCH_SIZE: environment.RECONCILER_BATCH_SIZE }),
      ...(environment.RECONCILER_DRY_RUN === undefined
        ? {}
        : { RECONCILER_DRY_RUN: environment.RECONCILER_DRY_RUN }),
    },
    logger,
    reconcile: (options) => reconcileOrphanedSessions(db, options),
    reconcileLeases: (options) => reconcileExpiredLeases(db, options),
    reconcileInterrupts: (options) =>
      reconcileOverdueInterrupts(db, {
        ...options,
        deadlineMs: INTERRUPT_SETTLE_DEADLINE_MS,
      }),
    expireInterrupts: (options) =>
      expireOverdueInterrupts(db, {
        ...options,
        deadlineMs: INTERRUPT_RECEIPT_DEADLINE_MS,
        logger,
      }),
    expireTerminations: (options) =>
      expireOverdueTerminations(db, {
        ...options,
        deadlineMs: TERMINATE_DEADLINE_MS,
        logger,
      }),
    expireParked: (options) => expireParkedGroups(db, options),
    announceInputReturns: (options) => announceLapsedInputWaits(db, options),
    expireDecisions: (options) => expireAuthzDecisions(db, options),
    expireToolAudits: (options) => expireToolCallAudits(db, options),
    deleteExpiredWebSessions: (options) =>
      deleteExpiredWebSessions(db, options),
    purgeExpiredEnvStart: (options) => purgeExpiredEnvStart(db, options),
    purgeFailedSlackInboundPayloads: (options) =>
      purgeFailedSlackInboundPayloads(db, options),
    purgeJudgmentBuffer: (options) => purgeJudgmentBuffer(db, options),
    purgeSlackSourceMarks: (options) =>
      purgeUnknownSlackSourceMarks(db, options),
    purgeSlackChannelMembers: (options) =>
      purgeExpiredSlackChannelMembers(db, options),
    purgeAuthAttemptWindows: (options) =>
      purgeEndedAuthAttemptWindows(db, {
        ...options,
        budgetMs: AUTH_ATTEMPT_PURGE_BUDGET_MS,
      }),
    reconcileOwnership: (options) => reconcileAgentOwnership(db, options),
    projectToolCalls: () =>
      projectToolCalls(db, {
        batchSize: TOOL_CALL_BATCH_SIZE,
        budgetMs: TOOL_CALL_BUDGET_MS,
        // Logged as it happens: a pass the watchdog kills never reaches
        // the summary line.
        onTimeout: (size, retrySize) =>
          logger.info("Tool call batch timed out", {
            batch_size: size,
            retry_size: retrySize,
          }),
      }),
  });
}
