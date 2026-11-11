import type { ImageRuntime } from "@werft-ai/runtime-core";
import type {
  ExecutionBackend,
  ExecutionRef,
  ExecutionResources,
} from "./ports/execution-backend.ts";
import type { SchedulerStore } from "./ports/scheduler-store.ts";

/** api.md: a kill not observed within this is reported unknown. */
export const TERMINATE_DEADLINE_MS = 30_000;

/**
 * How many times one launch may be rebuilt before the scheduler gives up on
 * it. Three covers a teardown that needed a retry and a create that failed
 * once; a launch that needs more is being judged replaceable by something
 * that will judge its replacement the same way.
 */
export const DEFAULT_REPLACEMENT_LIMIT = 3;

/**
 * How long a `stopped` session keeps its workspace before GC may take it.
 * Long enough that a session stopped for the night comes back to its volume;
 * past it, a resume restores from the checkpoint instead, and a session that
 * has none had nothing a resume could have used.
 */
export const DEFAULT_STOPPED_WORKSPACE_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * How long a claimed resource on an older isolation contract is left to
 * finish its turn before it is replaced anyway. The control host
 * derives it from the installation's turn limit; this covers callers that
 * do not.
 */
export const DEFAULT_DRAIN_DEADLINE_MS = 30 * 60_000;

/**
 * How long a kill may stay `stopping` after its first stop went out: the
 * backend's stop grace plus one request. A stop the daemon took has ended in
 * a SIGKILL by then, so one still standing was never delivered. The control
 * host derives it from the backend's own timeouts; this is their default.
 */
export const DEFAULT_STOP_DEADLINE_MS = 120_000 + 30_000;

/**
 * Failed attempts before a launch is given up on. With the backoff
 * below, four retries wait 30s, 1m, 2m and 4m: a daemon restart or a slow
 * image pull gets through, while an image that does not exist hands its slot
 * back in under ten minutes instead of holding it for good.
 */
export const DEFAULT_LAUNCH_FAILURE_LIMIT = 5;
export const DEFAULT_LAUNCH_RETRY_BASE_MS = 30_000;
export const DEFAULT_LAUNCH_RETRY_CAP_MS = 10 * 60_000;

/** The wait after the `failures`-th failure: doubling from `baseMs`, capped. */
export function launchRetryDelayMs(
  failures: number,
  baseMs: number = DEFAULT_LAUNCH_RETRY_BASE_MS,
  capMs: number = DEFAULT_LAUNCH_RETRY_CAP_MS,
): number {
  const exponent = Math.max(0, failures - 1);
  // 2^31 already dwarfs any cap; bounding the exponent keeps it finite.
  return Math.min(capMs, baseMs * 2 ** Math.min(exponent, 31));
}

export type SchedulerLogger = {
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

export type SchedulerOptions = {
  backend: ExecutionBackend;
  /** See `DEFAULT_DRAIN_DEADLINE_MS`. */
  drainDeadlineMs?: number;
  /** The configured reference; each new launch is pinned to what it names. */
  image: string;
  /**
   * What `image` runs, from its build. Without it every launch takes `image`
   * as before; with it each launch takes the image its checkpoint matches
   * (`selectWorkerImage`), and one no image matches is stopped.
   */
  imageRuntime?: ImageRuntime;
  /** The release before `image`, for sessions sealed on it. */
  previousImage?: { image: string; runtime: ImageRuntime };
  /** Failed attempts per launch before it is given up on; see the default. */
  launchFailureLimit?: number;
  /** First backoff after a failed attempt; doubles per failure up to the cap. */
  launchRetryBaseMs?: number;
  launchRetryCapMs?: number;
  logger: SchedulerLogger;
  now?: () => Date;
  /** Replacements per launch before it is closed instead; see the default. */
  replacementLimit?: number;
  resources: ExecutionResources;
  slotLimit: number;
  /** See `DEFAULT_STOPPED_WORKSPACE_TTL_MS`. */
  stoppedWorkspaceTtlMs?: number;
  /**
   * Shutdown: the pass stops where it would stop on losing its lock, so
   * nothing is reserved or launched after it and the next pass re-observes
   * whatever was in flight.
   */
  stop?: AbortSignal;
  /** See `DEFAULT_STOP_DEADLINE_MS`. */
  stopDeadlineMs?: number;
  store: SchedulerStore;
};

export type ReclaimOptions = Pick<
  SchedulerOptions,
  "backend" | "logger" | "stoppedWorkspaceTtlMs" | "store"
>;

export type SchedulerRunSummary = {
  /** true when another pass held the lock and this one did nothing. */
  skipped: boolean;
  activeAfter: number;
  activeBefore: number;
  /** Executions whose row lists them as live but the provider had lost. */
  failedLaunches: ExecutionRef[];
  /**
   * Claimed resources on an older isolation contract left running this pass
   * because their turn has not ended. Their worker is handed no
   * new turn; each is replaced once its turn ends or the deadline passes.
   */
  draining: ExecutionRef[];
  /**
   * Claimed resources replaced this pass with their turn still open: the
   * drain deadline passed first. Each is also in `replaced`.
   */
  drainsOverdue: ExecutionRef[];
  /**
   * true when the configured image could not be pinned, so no session was
   * admitted this pass. A fault: sessions wait on it until someone looks.
   */
  imageUnresolved: boolean;
  /**
   * Pinned images left out this pass because a worker on them claimed under
   * another combination than configured. A fault, like `imageUnresolved`.
   */
  imagesRefused: string[];
  /** Sessions stopped before launch: no configured image matches their checkpoint. */
  heldIncompatible: string[];
  launched: ExecutionRef[];
  /**
   * Launches left alone this pass because their last failed attempt still
   * holds the next one back. Each keeps its slot while it waits; the exit
   * code carries them, since a launch that is failing is work undone.
   */
  launchesBackingOff: ExecutionRef[];
  /**
   * Launches given up on this pass after failing as many times as the limit
   * allows: their queued input failed with `LAUNCH_FAILED` and their kill
   * was written. The slot comes back once the kill is confirmed.
   */
  launchesQuarantined: ExecutionRef[];
  orphansTerminated: ExecutionRef[];
  /** Orphans the provider would not terminate; each still holds a slot. */
  orphansUnresolved: ExecutionRef[];
  /**
   * Orphans asked to stop and still winding down. Not a failure, but each
   * still holds a slot until a later pass finds it gone.
   */
  orphansStopping: ExecutionRef[];
  /** Exited resources whose reclaim failed; each row stays `terminating`. */
  reclaimFailed: ExecutionRef[];
  /** Rows whose reconcile threw; they stay live and are retried next pass. */
  reconcileFailed: ExecutionRef[];
  /** Intents re-ensured after the resource was missing or not yet observed. */
  reensured: ExecutionRef[];
  /** Resources torn down and built again; see `ReplaceReason` for why. */
  replaced: ExecutionRef[];
  /**
   * Launches that have been rebuilt as many times as the limit allows and
   * would need it again. Each is left exactly as it is — its slot, its
   * resource — and reported every pass until someone looks: something keeps
   * rejecting what the scheduler builds, and building it once more is not
   * the answer.
   */
  replacementsExhausted: ExecutionRef[];
  slotLimit: number;
  terminatedObserved: ExecutionRef[];
  /** Kill intents carried out this pass; each is also in terminatedObserved. */
  killed: ExecutionRef[];
  /** Kill intents the provider did not carry out; each row keeps its slot. */
  killFailed: ExecutionRef[];
  /**
   * Kill intents whose resource was asked to stop and is still draining its
   * turn. Not a failure: each keeps its slot, and a later pass confirms it
   * gone without having waited on it.
   */
  killsStopping: ExecutionRef[];
  /**
   * Isolation resources (worker networks) the backend could neither remove
   * nor repair. A fault: each one is either a leaked address pool or a
   * worker cut off from its egress, so the exit code carries it.
   */
  networksFailed: string[];
  /** Worker networks whose execution was gone, removed by this pass. */
  networksReclaimed: string[];
  /** Worker networks that had lost their egress proxy and were given it back. */
  networksRepaired: string[];
  /** true when the backend could not even list its worker networks. */
  networkScanFailed: boolean;
  /** Terminate receipts flipped to unknown because the kill took too long. */
  terminationsOverdue: number;
  /**
   * true when GC could not even draw up its candidate list — listing the
   * workspaces or asking the store which sessions are retained threw. Nothing
   * was removed, and unlike the outcomes below this is a fault, not a
   * judgement, so the exit code carries it.
   */
  workspaceScanFailed: boolean;
  /** Workspaces whose removal threw; neither reclaimed nor deliberately kept. */
  workspacesFailed: string[];
  /** Workspaces of finished sessions, reclaimed by this pass. */
  workspacesReclaimed: string[];
  /**
   * Workspaces GC decided to reclaim and deliberately left alone: still
   * mounted, or no longer this installation's. Not part of the exit code — a
   * volume mounted by a container that is still shutting down is the normal
   * state during a teardown, and the next pass takes it.
   */
  workspacesUnresolved: string[];
};
