import type { SavedCost } from "@werft-ai/runtime-core";
import type { NativeSdkMessage } from "./driver.ts";

/** The provider failure a turn ended on, as the engine classified it. */
export type ProviderFailure = {
  /** The engine's class for it: `server_error`, `rate_limit`, … */
  error: string;
  /** The last HTTP status a retry saw; null for a connection failure. */
  status: number | null;
};

/**
 * Turns the engine's running totals into what each turn cost, and remembers
 * why the provider last refused a request.
 *
 * `total_cost_usd` on a result is the running total of the whole query, not
 * of the turn, so a turn's cost is the difference from the previous result.
 * The engine starts counting again when it starts a new session (`/clear`
 * inside the query) or when a query is resumed. A result under a session id
 * other than the previous one's, or a total that went down, is such a
 * restart, and its total is counted in full. That can count a little twice,
 * never too little, which is the side a budget has to err on.
 * A total of zero after spending is not a restart — it is a result that
 * reports nothing (a request that never reached the provider) — so it
 * neither charges nor moves the baseline.
 *
 * A turn whose own result carried no usable total settles with no cost at
 * all, not zero, so the API can tell an unknown cost from a zero one
 * . Zero is a figure only while nothing has been spent, when it
 * agrees with the baseline. What was carried from other results then waits
 * for the next turn that does report, rather than lending this one a figure.
 */
export class TurnAccounting {
  private lastTotalUsd = 0;
  private lastSessionId: string | undefined;
  private unsettledUsd = 0;
  // Whether the latest result gave a usable total. Settlement follows the
  // settling turn's own result, so this is that turn's report.
  private lastResultReported = false;
  private providerFailure: ProviderFailure | undefined;
  private countRestarted = false;

  /**
   * Whether the engine has started its count over since the run began. The
   * run's spending budget is measured against that count, so from then on
   * it no longer bounds what the session spends.
   */
  get restarted(): boolean {
    return this.countRestarted;
  }

  /**
   * A resumed query's first total continues from the cost its transcript
   * saved (since SDK 0.3.277), so that cost is the baseline, not part of the first
   * turn. Without a saved figure the total is counted in full, as before.
   * A total below the baseline is an engine that counts from zero again, and
   * counts in full too.
   */
  continueFrom(saved: SavedCost | undefined): void {
    // Without the session, a `/clear` before the first result would look like
    // the same session and be charged only what it spent past the saved cost;
    // such a figure is not a baseline.
    if (saved?.sessionId === undefined || this.lastSessionId !== undefined) {
      return;
    }
    this.lastTotalUsd = saved.usd;
    this.lastSessionId = saved.sessionId;
  }

  observe(native: NativeSdkMessage): void {
    if (native.type === "result") {
      const total = native.total_cost_usd;
      this.lastResultReported = false;
      if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
        return;
      }
      const sessionId =
        typeof native.session_id === "string" ? native.session_id : undefined;
      if (total === 0) {
        // A new engine session that has spent nothing yet is a real zero,
        // and it is the baseline from here on.
        if (
          sessionId !== undefined &&
          this.lastSessionId !== undefined &&
          sessionId !== this.lastSessionId
        ) {
          this.lastTotalUsd = 0;
          this.lastSessionId = sessionId;
          this.countRestarted = true;
        }
        this.lastResultReported = this.lastTotalUsd === 0;
        return;
      }
      this.lastResultReported = true;
      const restarted =
        total < this.lastTotalUsd ||
        (this.lastSessionId !== undefined && sessionId !== this.lastSessionId);
      if (restarted) this.countRestarted = true;
      this.unsettledUsd += restarted ? total : total - this.lastTotalUsd;
      this.lastTotalUsd = total;
      this.lastSessionId = sessionId;
      return;
    }
    if (native.type === "assistant") {
      // Every request ends in one: a clean one means the retries before it
      // succeeded, and whatever they saw is no longer why anything failed.
      this.providerFailure =
        typeof native.error === "string"
          ? {
              error: native.error,
              status: this.providerFailure?.status ?? null,
            }
          : undefined;
      return;
    }
    if (native.type === "system" && native.subtype === "api_retry") {
      this.providerFailure = {
        error:
          typeof native.error === "string"
            ? native.error
            : (this.providerFailure?.error ?? "unknown"),
        status:
          typeof native.error_status === "number" ? native.error_status : null,
      };
    }
  }

  /**
   * Why the provider last refused a request: cleared by the next request that
   * succeeds, not by a result.
   */
  get lastProviderFailure(): ProviderFailure | undefined {
    return this.providerFailure;
  }

  /**
   * What the turn now settling owes, and the provider failure seen since the
   * previous one. A cost with no turn to carry it — a result nobody was
   * waiting for — rides on the next one instead of being dropped.
   */
  settle(): {
    costUsd: number | undefined;
    providerFailure: ProviderFailure | undefined;
  } {
    const providerFailure = this.providerFailure;
    this.providerFailure = undefined;
    return { costUsd: this.settleCost(), providerFailure };
  }

  /** `settle` without touching the provider failure. */
  settleCost(): number | undefined {
    const costUsd = this.lastResultReported ? this.unsettledUsd : undefined;
    if (this.lastResultReported) this.unsettledUsd = 0;
    this.lastResultReported = false;
    return costUsd;
  }
}
