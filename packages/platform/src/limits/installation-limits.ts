import {
  MAX_TURN_SECONDS_MAX,
  PROVIDER_MAX_RETRIES_MAX,
  STORAGE_ACCOUNTED_CONTENT_VALUES,
} from "@werft-ai/contracts";
import { integerSetting, settingProblems } from "@werft-ai/contracts/settings";

/**
 * The limits an installation still takes from env. Every control process
 * reads them with this one parser, so the scheduler that launches workers
 * and the API that reports them cannot disagree about them. There are no
 * defaults here on purpose: a missing value stops the process, and the
 * documented defaults live in `infra/compose.core.yml`.
 */
export type InstallationLimits = {
  /** Worker containers that may hold a slot at once. */
  executionSlotLimit: number;
};

/**
 * The limits the owner keeps in the console. Each decision reads them once
 * (a `Setting`) and holds that one read: another process's save reaches the
 * next decision, not one under way.
 */
export type SessionLimits = {
  /** `queued` turns one session may hold; the next input answers 429. */
  queuedInputLimitPerSession: number;
  /**
   * Retained content the installation may hold, in bytes. What counts is
   * listed at `STORAGE_ACCOUNTED_CONTENT`; the next input past it answers 413.
   */
  storageLimitBytes: number;
  /** A session that has spent this much is dispatched nothing further. */
  sessionCostLimitUsd: number;
  /**
   * Provider tokens a session may use over its lifetime, whatever they cost;
   * null when the installation sets none. Past it the session is stopped
   * exactly where the cost limit stops it.
   */
  sessionTokenLimit: number | null;
};

/**
 * A fixed value, or a read asked at each decision so a save applies to the
 * next one. A read that fails refuses that decision.
 */
export type Setting<T> = T | (() => Promise<T>);

export function readSetting<T>(setting: Setting<T>): Promise<T> {
  return typeof setting === "function"
    ? (setting as () => Promise<T>)()
    : Promise.resolve(setting);
}

/**
 * What an installation setting sets is refused: nothing it accepts is saved,
 * or the settings have not been read for longer than a stale value may be
 * used. Never answered with a default nobody chose.
 */
export class InstallationConfigUnavailableError extends Error {
  constructor(readonly key: string | null) {
    super(
      key === null
        ? "the installation settings could not be read"
        : `${key} has no value this release accepts; save it in Settings > Workspace > Execution limits`,
    );
  }
}

export type InstallationLimitsEnvironment = {
  EXECUTION_SLOT_LIMIT?: string | undefined;
  [name: string]: string | undefined;
};

/**
 * What the storage limit counts today: the UTF-8 bytes of every input
 * message a session was given. Events, checkpoint objects and worker disks
 * are not in it — refusing an event batch would strand the turn that wrote
 * it, and a worker's disk has its own quota.
 */
export const STORAGE_ACCOUNTED_CONTENT = STORAGE_ACCOUNTED_CONTENT_VALUES;

/** The widest worker limits the console takes. */
export const MAX_PROVIDER_RETRIES = PROVIDER_MAX_RETRIES_MAX;
export const MAX_TURN_SECONDS_CEILING = MAX_TURN_SECONDS_MAX;

export class InstallationConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid installation limits: ${problems.join("; ")}`);
  }
}

/** Every problem at once, so an operator fixes the file in one pass. */
export function installationLimitProblems(
  environment: InstallationLimitsEnvironment,
): string[] {
  return parseAll(environment).problems;
}

export function installationLimitsFromEnv(
  environment: InstallationLimitsEnvironment,
): InstallationLimits {
  const { limits, problems } = parseAll(environment);
  if (problems.length > 0) throw new InstallationConfigError(problems);
  return limits as InstallationLimits;
}

function parseAll(environment: InstallationLimitsEnvironment): {
  limits: Record<keyof InstallationLimits, number | undefined>;
  problems: string[];
} {
  const { problems, read } = settingProblems();
  const limits = {
    // Zero is a real setting: admit and queue everything, launch nothing.
    executionSlotLimit: read(() =>
      integerSetting(environment, "EXECUTION_SLOT_LIMIT", {
        min: 0,
        max: 10_000,
      }),
    ),
  };
  return { limits, problems };
}

/** What a session has used, as `sessions` keeps it. */
export type SessionSpend = { costUsd: number; providerTokens: number };

/** The limits a session's spend is held to. */
export type SessionBudget = { costUsd: number; tokens: number | null };

export function sessionBudgetOf(
  limits: Pick<SessionLimits, "sessionCostLimitUsd" | "sessionTokenLimit">,
): SessionBudget {
  return {
    costUsd: limits.sessionCostLimitUsd,
    tokens: limits.sessionTokenLimit,
  };
}

/**
 * The one budget predicate every gate uses: a limit is reached once spend
 * gets to it. db's `withinBudget` is its SQL form, held to it by a test.
 */
export function limitsReached(
  spend: SessionSpend,
  budget: SessionBudget,
): { cost: boolean; tokens: boolean } {
  return {
    cost: spend.costUsd >= budget.costUsd,
    tokens: budget.tokens !== null && spend.providerTokens >= budget.tokens,
  };
}

export function budgetExceeded(
  spend: SessionSpend,
  budget: SessionBudget,
): boolean {
  const reached = limitsReached(spend, budget);
  return reached.cost || reached.tokens;
}
