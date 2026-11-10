import { type Database, fillNeutralFields } from "@werft-ai/db";
import type { StructuredLogger } from "@werft-ai/observability";
import { createNeutralizer, type NeutralizeEvent } from "@werft-ai/platform";
import { installedEventCodecs } from "@werft-ai/runtime-codecs";

// As the tool call projection (reconciler/main.ts): a batch this size stays
// well under the API pool's statement timeout.
const FILL_BATCH_SIZE = 5_000;
const FILL_BUDGET_MS = 10_000;
const FILL_IDLE_MS = 15_000;
const FILL_RETRY_MS = 30_000;

/**
 * The installed codecs' neutralizer. A session whose runtime cannot be told
 * keeps its events as stored, with a warning once per runtime kind; an event
 * whose codec output the contract refuses is kept too, with a warning.
 */
export function eventNeutralizer(
  logger: Pick<StructuredLogger, "warn">,
): NeutralizeEvent {
  const warned = new Set<string | null>();
  return createNeutralizer(installedEventCodecs, {
    unknown: (runtimeKind) => {
      if (warned.has(runtimeKind)) return;
      warned.add(runtimeKind);
      logger.warn(
        "No event codec for the session's runtime; events keep their stored fields",
        { runtime_kind: runtimeKind },
      );
    },
    refused: (kind, event, reason) => {
      logger.warn(
        "Event codec output breaks the contract; the event keeps its stored fields",
        {
          runtime_kind: kind,
          event,
          reason,
        },
      );
    },
  });
}

/**
 * Fills the neutral fields of stored events in the background, for as long
 * as the process runs: history first, then whatever an older replica stores
 * meanwhile. Nothing waits on it; a replica that finds the fill held by
 * another tries again later. Each pass starts once `beforePass` resolves (the
 * catalog read afresh): the cursor passes a row whose runtime it could not
 * tell, so the catalog has to be current first.
 */
export function startNeutralFill(
  db: Database,
  neutralize: NeutralizeEvent,
  logger: Pick<StructuredLogger, "info" | "warn">,
  beforePass: () => Promise<void>,
): void {
  const pass = (): void => {
    beforePass()
      .then(() =>
        fillNeutralFields(db, {
          neutralize,
          batchSize: FILL_BATCH_SIZE,
          budgetMs: FILL_BUDGET_MS,
        }),
      )
      .then(
        (fill) => {
          if (fill.filled > 0) {
            logger.info("Event neutral fields filled", {
              events: fill.filled,
              filled_through: fill.filledThrough,
            });
          }
          setTimeout(
            pass,
            fill.caughtUp || fill.busy ? FILL_IDLE_MS : 0,
          ).unref();
        },
        (error: unknown) => {
          logger.warn("Event neutral fields could not be filled; retrying", {
            error_name: error instanceof Error ? error.name : typeof error,
          });
          setTimeout(pass, FILL_RETRY_MS).unref();
        },
      );
  };
  pass();
}
