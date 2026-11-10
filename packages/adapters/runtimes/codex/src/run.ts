import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import {
  CODEX_CLI_VERSION,
  CODEX_DESCRIPTOR,
} from "@werft-ai/runtime-codex-codec";
import {
  type AgentInput,
  type AgentRun,
  type AnswerResult,
  type ApprovalAnswer,
  ApprovalChannel,
  type ApprovalRequested,
  approvalInputHash,
  type CheckpointLeaseGrant,
  type CheckpointPoint,
  type CheckpointPreparation,
  type NegotiatedCapabilities,
  type RejectedCheckpoint,
  type RuntimeEvent,
  type ToolPrecheck,
} from "@werft-ai/runtime-core";

import type { CodexLaunch } from "./config.ts";
import {
  addUsage,
  COMMAND_TOOL,
  EMPTY_USAGE,
  FILE_CHANGE_TOOL,
  itemCompleted,
  itemOf,
  itemStarted,
  outcomeOf,
  startedEvent,
  turnEvents,
  warningEvent,
} from "./mapper.ts";
import { type AppServerTransport, RpcError, type RpcId } from "./transport.ts";

const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
const FILE_CHANGE_APPROVAL = "item/fileChange/requestApproval";

export type CodexRunOptions = {
  transport: AppServerTransport;
  launch: Pick<
    CodexLaunch,
    "answers" | "approvalPolicy" | "developerInstructions" | "threadConfig"
  >;
  cwd: string;
  model: string;
  /** The thread to resume; absent for a new one. */
  resume?: string;
  precheckTool?: ToolPrecheck | undefined;
  /** The inputs the thread already holds, read when a resumed run asks. */
  heldInputs: (threadId: string) => Promise<ReadonlySet<string>>;
  /** Descendants of the engine process, to judge the run quiet. */
  descendants: () => readonly number[];
  /** Ends the engine process and everything it started. */
  kill: () => void;
  /** Why the engine started badly (settings it ignored), if it did. */
  startupProblem: () => string | undefined;
};

type Turn = {
  id: string | undefined;
  inputs: string[];
  usage: typeof EMPTY_USAGE;
};

type Queued = { input: AgentInput };

/** The approvals a person is asked, and what they stand for in the engine. */
type OpenRequest = { rpcId: RpcId; localId: string; answeredByUs: boolean };

class EventQueue {
  private readonly items: RuntimeEvent[] = [];
  private waiting: (() => void) | undefined;
  private done = false;
  private consumed = false;

  push(...events: RuntimeEvent[]): void {
    if (this.done) return;
    this.items.push(...events);
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *drain(): AsyncGenerator<RuntimeEvent> {
    if (this.consumed) throw new Error("This run's events are already read");
    this.consumed = true;
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = undefined;
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rejected(
  reason: RejectedCheckpoint["reason"],
  detail: string,
): RejectedCheckpoint {
  return { status: "rejected", reason, detail };
}

/**
 * The run contract over one `codex app-server` conversation. Inputs queue in
 * the adapter and go to the engine one turn at a time, so an interrupt can say
 * what stayed queued; approvals the engine asks for commands and file changes
 * go through the shared channel; nothing else the engine may ask is answered
 * with anything but a refusal.
 */
export class CodexRun implements AgentRun {
  private readonly events$ = new EventQueue();
  private readonly channel = new ApprovalChannel();
  private readonly stop = new AbortController();
  private readonly queue: Queued[] = [];
  private readonly sent = new Set<string>();
  private readonly open = new Map<string, OpenRequest>();
  private readonly announced = new Set<string>();
  private readonly running = new Set<string>();
  private readyPromise: Promise<NegotiatedCapabilities> | undefined;
  private threadId: string | undefined;
  private turn: Turn | undefined;
  private starting: Promise<void> | undefined;
  private inputClosed = false;
  private leased = false;
  private closing = false;
  private idle = true;

  constructor(private readonly options: CodexRunOptions) {
    options.transport.listen({
      notification: (method, params) => this.onNotification(method, params),
      request: (id, method, params) => this.onRequest(id, method, params),
    });
    void options.transport.closed.then((info) => {
      if (this.closing) return;
      this.endTurnWith(
        `The Codex app-server ended (${info.signal ?? `code ${String(info.code)}`})`,
      );
      this.channel.cancelAll("shutdown");
      this.events$.end();
    });
  }

  ready(): Promise<NegotiatedCapabilities> {
    this.readyPromise ??= this.initialize();
    return this.readyPromise;
  }

  events(): AsyncIterable<RuntimeEvent> {
    return this.events$.drain();
  }

  send(input: AgentInput): void {
    if (this.closing || this.sent.has(input.uuid)) return;
    this.sent.add(input.uuid);
    this.queue.push({ input });
    void this.pump();
  }

  finishInput(): void {
    this.inputClosed = true;
    this.maybeFinish();
  }

  async holdsInput(uuid: string): Promise<boolean> {
    if (this.sent.has(uuid)) return true;
    const threadId = await this.threadAfterReady();
    return (await this.options.heldInputs(threadId)).has(uuid);
  }

  answer(answer: ApprovalAnswer): Promise<AnswerResult> {
    const result = this.channel.answer(answer);
    const open = this.open.get(answer.localId);
    if (result === "applied" && open !== undefined) open.answeredByUs = true;
    return Promise.resolve(result);
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    const stillQueued = this.queue.splice(0).map((queued) => queued.input.uuid);
    await this.starting;
    const turn = this.turn;
    this.channel.cancelAll("interrupt");
    if (turn?.id !== undefined && this.threadId !== undefined) {
      await this.options.transport.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: turn.id,
      });
    }
    return { stillQueued };
  }

  async prepareCheckpoint(
    point: CheckpointPoint,
  ): Promise<CheckpointPreparation> {
    if (point !== "turn_end") {
      return rejected(
        "turn_in_flight",
        `${point} checkpoints are not supported`,
      );
    }
    const threadId = this.threadId;
    if (threadId === undefined) {
      return rejected("no_engine_session", "The engine has no thread yet");
    }
    if (this.leased) {
      return rejected("checkpoint_lease_held", "A checkpoint is being taken");
    }
    if (this.turn !== undefined || this.queue.length > 0 || !this.idle) {
      return rejected("turn_in_flight", "A turn is running or queued");
    }
    if (this.running.size > 0 || this.channel.open > 0) {
      return rejected("tool_in_flight", "A tool call has not finished");
    }
    if (this.options.descendants().length > 0) {
      return rejected(
        "background_writer",
        "A process the engine started is still running",
      );
    }
    // The engine writes its record from its own task; a request that comes
    // back through it is the one barrier the protocol offers.
    await this.options.transport.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    return {
      status: "ready",
      checkpoint: {
        engine: CODEX_DESCRIPTOR.checkpointEngine,
        resume: threadId,
        sdkVersion: CODEX_CLI_VERSION,
      },
    };
  }

  async leaseCheckpoint(point: CheckpointPoint): Promise<CheckpointLeaseGrant> {
    const preparation = await this.prepareCheckpoint(point);
    if (preparation.status === "rejected") return { lease: null, preparation };
    this.leased = true;
    return {
      preparation,
      lease: {
        release: () => {
          if (!this.leased) return;
          this.leased = false;
          void this.pump();
        },
      },
    };
  }

  abort(): void {
    this.closing = true;
    this.stop.abort();
    this.channel.cancelAll("shutdown");
    this.options.kill();
    this.events$.end();
  }

  async close(): Promise<void> {
    this.abort();
    await this.options.transport.close();
  }

  // --- startup ---------------------------------------------------------

  private async initialize(): Promise<NegotiatedCapabilities> {
    const { transport, launch } = this.options;
    await transport.request("initialize", {
      clientInfo: { name: "werft", title: null, version: CODEX_CLI_VERSION },
      capabilities: null,
    });
    transport.notify("initialized");
    // The claim's policy, on a resumed thread too: what was stored with the
    // thread never decides how this run is approved or instructed.
    const overrides = {
      cwd: this.options.cwd,
      model: this.options.model,
      approvalPolicy: launch.approvalPolicy,
      sandbox: "danger-full-access",
      config: launch.threadConfig,
      ...(launch.developerInstructions === undefined
        ? {}
        : { developerInstructions: launch.developerInstructions }),
    };
    const response = record(
      this.options.resume === undefined
        ? await transport.request("thread/start", {
            ...overrides,
            ephemeral: false,
          })
        : await transport.request("thread/resume", {
            ...overrides,
            threadId: this.options.resume,
            excludeTurns: true,
          }),
    );
    const id = record(response.thread).id;
    if (typeof id !== "string") {
      throw new Error("The Codex app-server started no thread");
    }
    const problem = this.options.startupProblem();
    if (problem !== undefined) throw new Error(problem);
    this.threadId = id;
    this.events$.push(startedEvent(id, this.options.model));
    void this.pump();
    return {
      effective: CODEX_DESCRIPTOR.capabilities,
      effectiveExtraFeatures: CODEX_DESCRIPTOR.extraFeatures,
    };
  }

  private async threadAfterReady(): Promise<string> {
    await this.ready();
    if (this.threadId === undefined) throw new Error("The run has no thread");
    return this.threadId;
  }

  // --- turns -----------------------------------------------------------

  private async pump(): Promise<void> {
    if (
      this.threadId === undefined ||
      this.turn !== undefined ||
      this.leased ||
      this.closing
    ) {
      this.maybeFinish();
      return;
    }
    const queued = this.queue.shift();
    if (queued === undefined) {
      this.maybeFinish();
      return;
    }
    const turn: Turn = {
      id: undefined,
      inputs: [queued.input.uuid],
      usage: EMPTY_USAGE,
    };
    this.turn = turn;
    this.idle = false;
    const threadId = this.threadId;
    this.starting = (async () => {
      try {
        if ((await this.options.heldInputs(threadId)).has(queued.input.uuid)) {
          // The thread already answered this input: the engine would too.
          this.turn = undefined;
          this.idle = true;
          return;
        }
        const response = record(
          await this.options.transport.request("turn/start", {
            threadId,
            clientUserMessageId: queued.input.uuid,
            input: [
              { type: "text", text: queued.input.message, text_elements: [] },
            ],
          }),
        );
        const id = record(response.turn).id;
        if (typeof id === "string") turn.id = id;
      } catch (error) {
        this.endTurnWith(
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
    await this.starting;
    if (this.turn === undefined) void this.pump();
  }

  private endTurnWith(reason: string): void {
    const turn = this.turn;
    if (turn === undefined || this.threadId === undefined) return;
    this.turn = undefined;
    this.idle = true;
    this.events$.push(
      ...turnEvents(
        this.threadId,
        { status: "failed", error: { message: reason } },
        turn.usage,
        turn.inputs,
      ),
    );
    void this.pump();
  }

  private maybeFinish(): void {
    if (
      this.inputClosed &&
      this.queue.length === 0 &&
      this.turn === undefined &&
      !this.leased
    ) {
      this.events$.end();
    }
  }

  private get inputs(): readonly string[] {
    return this.turn?.inputs ?? [];
  }

  // --- what the engine says ---------------------------------------------

  private onNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (params.threadId !== undefined && params.threadId !== this.threadId) {
      return;
    }
    switch (method) {
      case "item/started": {
        const item = itemOf(params);
        if (item === undefined) return;
        if (item.type === "commandExecution" || item.type === "fileChange") {
          this.running.add(item.id);
          this.announce(item.id, () => itemStarted(item, this.inputs));
        }
        return;
      }
      case "item/completed": {
        const item = itemOf(params);
        if (item === undefined) return;
        this.running.delete(item.id);
        if (item.type === "commandExecution" || item.type === "fileChange") {
          // A call that finished without ever being announced still gets its
          // tool event before its result.
          this.announce(item.id, () => itemStarted(item, this.inputs));
        }
        this.events$.push(...itemCompleted(item, this.inputs));
        return;
      }
      case "thread/tokenUsage/updated": {
        if (this.turn !== undefined) {
          this.turn.usage = addUsage(
            this.turn.usage,
            record(params.tokenUsage).last,
          );
        }
        return;
      }
      case "thread/status/changed": {
        this.idle = record(params.status).type === "idle";
        return;
      }
      case "turn/completed": {
        const turn = this.turn;
        if (turn === undefined || this.threadId === undefined) return;
        this.turn = undefined;
        this.idle = true;
        this.running.clear();
        this.events$.push(
          ...turnEvents(
            this.threadId,
            outcomeOf(record(params.turn)),
            turn.usage,
            turn.inputs,
          ),
        );
        void this.pump();
        return;
      }
      case "serverRequest/resolved":
        this.withdrawn(params.requestId);
        return;
      case "warning":
        if (typeof params.message === "string") {
          this.events$.push(warningEvent(params.message, this.inputs));
        }
        return;
      case "error":
        if (params.willRetry === true) {
          this.events$.push({
            type: "runtime.warning",
            kind: "api_retry",
            detail: { error: record(params.error).message ?? null },
          });
        }
        return;
      default:
        return;
    }
  }

  /** The call's public events, once, before anything asks about it. */
  private announce(id: string, events: () => RuntimeEvent[]): void {
    if (this.announced.has(id)) return;
    this.announced.add(id);
    this.events$.push(...events());
  }

  private withdrawn(requestId: unknown): void {
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    for (const [localId, request] of this.open) {
      if (request.rpcId !== requestId || request.answeredByUs) continue;
      this.open.delete(localId);
      this.channel.cancelAll("interrupt");
      this.events$.push({
        type: "approval.resolved",
        localId,
        outcome: "withdrawn",
      });
    }
  }

  private async onRequest(
    id: RpcId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const tool =
      method === COMMAND_APPROVAL
        ? COMMAND_TOOL
        : method === FILE_CHANGE_APPROVAL
          ? FILE_CHANGE_TOOL
          : undefined;
    if (tool === undefined || params.threadId !== this.threadId) {
      // Questions, MCP elicitations, permission grants, dynamic tools, token
      // refreshes: the profile offers none of them, so none is answered.
      throw new RpcError(`The platform does not answer ${method}`, -32601);
    }
    return { decision: await this.decide(id, tool, params) };
  }

  private async decide(
    rpcId: RpcId,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<"accept" | "decline" | "cancel"> {
    const itemId =
      typeof params.itemId === "string" ? params.itemId : undefined;
    if (itemId === undefined) return "decline";
    const isCommand = tool === COMMAND_TOOL;
    const input: Record<string, unknown> = isCommand
      ? { command: params.command ?? null, cwd: params.cwd ?? null }
      : { grant_root: params.grantRoot ?? null };
    this.announce(itemId, () =>
      itemStarted(
        isCommand
          ? { type: "commandExecution", id: itemId, ...input }
          : { type: "fileChange", id: itemId, changes: [] },
        this.inputs,
      ),
    );
    const { answers } = this.options.launch;
    if (answers === "edits" && !isCommand) return "accept";
    if (answers !== "ask") return "decline";
    if (isCommand && this.options.precheckTool !== undefined) {
      const refusal = await this.options.precheckTool(tool, input);
      if (refusal !== null) return "decline";
    }
    let inputHash: string;
    try {
      inputHash = approvalInputHash(tool, input);
    } catch {
      return "decline";
    }
    const request: ApprovalRequested = {
      localId: randomUUID(),
      toolCallId: itemId,
      tool: { name: tool, input },
      inputHash,
      askedAt: performance.now(),
      kind: "permission",
      display: {
        ...(isCommand
          ? { command: params.command ?? null, cwd: params.cwd ?? null }
          : { grant_root: params.grantRoot ?? null }),
        reason: params.reason ?? null,
      },
    };
    this.open.set(request.localId, {
      rpcId,
      localId: request.localId,
      answeredByUs: false,
    });
    const answered = this.channel.request(request, this.stop.signal);
    this.events$.push({ type: "approval.requested", request });
    const answer = await answered;
    this.open.delete(request.localId);
    switch (answer.kind) {
      case "selected":
        return answer.optionKind === "allow_once" ? "accept" : "decline";
      case "cancelled":
        return answer.reason === "interrupt" || answer.reason === "shutdown"
          ? "cancel"
          : "decline";
      case "answered":
        return "decline";
    }
  }
}

/** The inputs a rollout already holds, by the client ids the engine recorded on its user messages. */
export function clientIdsIn(rollout: string): Set<string> {
  const ids = new Set<string>();
  for (const line of rollout.split("\n")) {
    if (!line.includes('"client_id"')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const item = record(record(record(parsed).payload).item);
      if (typeof item.client_id === "string") ids.add(item.client_id);
    } catch {
      // A torn last line holds no complete input.
    }
  }
  return ids;
}

/** `rollout-<time>-<thread id>.jsonl` under `<home>/sessions/<yyyy>/<mm>/<dd>/`. */
export async function findRollout(
  home: string,
  threadId: string,
): Promise<string | undefined> {
  const walk = async (dir: string): Promise<string | undefined> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        const found = await walk(path);
        if (found !== undefined) return found;
      } else if (entry.name.endsWith(`-${threadId}.jsonl`)) {
        return path;
      }
    }
    return undefined;
  };
  return walk(`${home}/sessions`);
}

/** What a resumed run asks `heldInputs`: unreadable is an error, absent is empty. */
export function heldInputsFrom(
  home: string,
): (threadId: string) => Promise<ReadonlySet<string>> {
  return async (threadId) => {
    const path = await findRollout(home, threadId);
    if (path === undefined) return new Set();
    return clientIdsIn(await readFile(path, "utf8"));
  };
}
