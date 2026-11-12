import type { WorkerLogger } from "./console-logger.ts";
import {
  type WorkspaceLimitEvidence,
  type WorkspaceLimitMode,
  workspaceLimitMode,
} from "./workspace-limit-mode.ts";
import {
  measureWorkspace,
  type WorkspaceMeasurement,
} from "./workspace-meter.ts";

export type WorkspaceObserverOptions = {
  root: string;
  evidence?: WorkspaceLimitEvidence;
};

export const measurementInterval = (durationMs: number): number =>
  Math.max(30_000, durationMs * 10);

export class WorkspaceObserver {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = false;
  private nextStart = 0;
  private intervalMs = 30_000;
  private lastComplete: number;
  private errors = 0;
  private classified = false;
  private classification: WorkspaceLimitMode | undefined;
  private readonly classificationListeners = new Set<
    (mode: WorkspaceLimitMode) => void
  >();
  private lastUsage: WorkspaceMeasurement | undefined;
  private flight: Promise<WorkspaceMeasurement | undefined> | undefined;
  private readonly listeners = new Set<
    (usage: WorkspaceMeasurement, mode: WorkspaceLimitMode) => void
  >();

  watch(
    listener: (usage: WorkspaceMeasurement, mode: WorkspaceLimitMode) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onClassified(listener: (mode: WorkspaceLimitMode) => void): void {
    if (this.classification !== undefined) listener(this.classification);
    else if (!this.stopped) this.classificationListeners.add(listener);
  }

  async measureNow(): Promise<WorkspaceMeasurement | undefined> {
    await this.flight;
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.sample();
  }

  constructor(
    private readonly options: WorkspaceObserverOptions,
    private readonly logger: WorkerLogger,
    private readonly measure = measureWorkspace,
    private readonly now = () => performance.now(),
    private readonly maximumAgeMs = 600_000,
  ) {
    this.lastComplete = now();
  }

  start(): void {
    if (!this.stopped && this.staleTimer === undefined) this.armStaleness();
    this.nudge();
  }

  nudge(): void {
    if (this.stopped || this.running) return;
    if (this.timer !== undefined) {
      if (this.now() < this.nextStart) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.sample();
      },
      Math.max(0, this.nextStart - this.now()),
    );
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.staleTimer);
    this.controller.abort();
    this.classificationListeners.clear();
  }

  private sample(): Promise<WorkspaceMeasurement | undefined> {
    if (this.flight !== undefined) return this.flight;
    this.flight = this.measureSample().finally(() => {
      this.flight = undefined;
    });
    return this.flight;
  }

  private async measureSample(): Promise<WorkspaceMeasurement | undefined> {
    if (this.stopped || this.running) return;
    this.running = true;
    const listeners = [...this.listeners];
    const started = this.now();
    try {
      const result = await this.measure(
        this.options.root,
        this.intervalMs,
        this.controller.signal,
      );
      if (this.stopped) return;
      const mode = workspaceLimitMode({
        ...this.options.evidence,
        ...(result.mount === undefined ? {} : { mount: result.mount }),
        ...(result.filesystem === undefined
          ? {}
          : { filesystem: result.filesystem }),
      });
      if (!this.classified) {
        const evidence = {
          ...this.options.evidence,
          ...(result.mount === undefined ? {} : { mount: result.mount }),
          ...(result.filesystem === undefined
            ? {}
            : { filesystem: result.filesystem }),
        };
        const mode = workspaceLimitMode(evidence);
        this.logger.info("workspace_limit_mode", {
          ...mode,
          evidence,
          dedicated_mount: evidence.mount?.mountPoint === this.options.root,
        });
        for (const axis of ["bytes", "inodes"] as const) {
          this.logger.info("workspace_metric", {
            metric: "workspace_limit_mode",
            axis,
            mode: mode[axis],
            value: 1,
          });
        }
        this.classified = true;
        this.classification = mode;
        for (const listener of this.classificationListeners) listener(mode);
        this.classificationListeners.clear();
      }
      this.intervalMs = measurementInterval(result.durationMs);
      if (result.complete) {
        this.lastComplete = this.now();
        this.lastUsage = result;
        this.armStaleness();
      }
      this.errors += result.complete
        ? result.errors
        : Math.max(1, result.errors);
      const usage = this.lastUsage;
      this.logger.info("workspace_measurement", {
        bytes: usage?.bytes,
        inodes: usage?.inodes,
        partial_bytes: result.complete ? undefined : result.bytes,
        partial_inodes: result.complete ? undefined : result.inodes,
        complete: result.complete,
        duration_ms: result.durationMs,
        interval_ms: this.intervalMs,
        filesystem: result.filesystem,
        statfs_scope: "filesystem",
      });
      if (usage !== undefined) {
        this.logger.info("workspace_metric", {
          metric: "workspace_usage_bytes",
          value: usage.bytes,
          complete: result.complete,
        });
        this.logger.info("workspace_metric", {
          metric: "workspace_usage_inodes",
          value: usage.inodes,
          complete: result.complete,
        });
      }
      this.logger.info("workspace_metric", {
        metric: "workspace_measure_duration_seconds",
        value: result.durationMs / 1000,
        complete: result.complete,
      });
      this.logger.info("workspace_metric", {
        metric: "workspace_measure_degraded",
        value: this.now() - this.lastComplete >= this.maximumAgeMs ? 1 : 0,
      });
      if (!result.complete || result.errors > 0) this.warning(result.errors);
      for (const listener of listeners) listener(result, mode);
      return result;
    } catch {
      if (!this.stopped) {
        this.errors++;
        this.warning(1);
      }
    } finally {
      this.running = false;
      this.nextStart = started + this.intervalMs;
      this.nudge();
    }
  }

  private warning(errors: number): void {
    const ageMs = this.now() - this.lastComplete;
    this.logger.warn("workspace_measurement_incomplete", {
      metric: "workspace_measure_errors_total",
      value: this.errors,
      errors,
      degraded: ageMs >= this.maximumAgeMs,
      last_complete_age_ms: ageMs,
    });
  }

  private armStaleness(): void {
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      if (this.stopped) return;
      this.logger.warn("workspace_measurement_degraded", {
        metric: "workspace_measure_degraded",
        value: 1,
        last_complete_age_ms: this.now() - this.lastComplete,
      });
    }, this.maximumAgeMs);
    this.staleTimer.unref();
  }
}
