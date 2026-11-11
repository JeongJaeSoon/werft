import { createHash, randomUUID } from "node:crypto";
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
  changePaths,
  EMPTY_USAGE,
  FILE_CHANGE_TOOL,
  type Item,
  itemCompleted,
  itemOf,
  itemStarted,
  mcpToolName,
  outcomeOf,
  startedEvent,
  turnEvents,
  warningEvent,
} from "./mapper.ts";
import type { RelayCall } from "./mcp-relay.ts";
import { type AppServerTransport, RpcError, type RpcId } from "./transport.ts";

const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
const FILE_CHANGE_APPROVAL = "item/fileChange/requestApproval";
const MCP_ELICITATION = "mcpServer/elicitation/request";
const MCP_STARTUP = "mcpServer/startupStatus/updated";
const MCP_STARTUP_TIMEOUT_MS = 30_000;

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
  descendants: () => readonly number[] | undefined;
  /** Ends the engine process and everything it started. */
  kill: () => void;
  /** Why the engine started badly (settings it ignored), if it did. */
  startupProblem: () => string | undefined;
  /**
   * The platform tools the MCP relay serves that the server judges itself
   * (`mcp__<server>__<tool>`), and the end of the relay with the run.
   */
  mcp?: {
    servers: ReadonlySet<string>;
    trusted: ReadonlySet<string>;
    release: () => void;
  };
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
  private checkpointing = false;
  /** File changes the engine announced, by item id: what an approval is bound to. */
  private readonly fileChanges = new Map<string, Item>();
  private closing = false;
  private idle = true;
  /** MCP calls the engine announced and the relay has not yet claimed or finished. */
  private mcpItems: Item[] = [];
  private readonly mcpStartup = new Map<
    string,
    { status: string; error?: string }
  >();
  private mcpStartupChanged: (() => void) | undefined;
  private readonly mcpClaimed = new Set<string>();
  /** Relay calls between their judgment and the end of the upstream call; `running` is cleared per turn, these are not. */
  private readonly relayCalls = new Set<string>();

  constructor(private readonly options: CodexRunOptions) {
    options.transport.listen({
      notification: (method, params) => this.onNotification(method, params),
      request: (id, method, params) => this.onRequest(id, method, params),
    });
    void options.transport.closed.then((info) => {
      if (this.closing) return;
      this.closing = true;
      this.stop.abort();
      this.options.mcp?.release();
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

  prepareCheckpoint(point: CheckpointPoint): Promise<CheckpointPreparation> {
    return this.prepare(point, false);
  }

  /**
   * Why the run is not quiet now, if it is not. A process whose children
   * cannot be listed is not called quiet: an unreadable `/proc` says nothing
   * about a writer the engine left behind.
   */
  private notQuiet(withQueue: boolean): RejectedCheckpoint | undefined {
    if (this.turn !== undefined || !this.idle) {
      return rejected("turn_in_flight", "A turn is running");
    }
    if (withQueue && this.queue.length > 0) {
      return rejected("turn_in_flight", "An input is queued");
    }
    if (
      this.running.size > 0 ||
      this.relayCalls.size > 0 ||
      this.channel.open > 0
    ) {
      return rejected("tool_in_flight", "A tool call has not finished");
    }
    const below = this.options.descendants();
    if (below === undefined) {
      return rejected(
        "background_writer",
        "The processes the engine started cannot be listed on this system",
      );
    }
    if (below.length > 0) {
      return rejected(
        "background_writer",
        "A process the engine started is still running",
      );
    }
    return undefined;
  }

  private async prepare(
    point: CheckpointPoint,
    lease: boolean,
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
    if (this.leased || this.checkpointing) {
      return rejected("checkpoint_lease_held", "A checkpoint is being taken");
    }
    const busy = this.notQuiet(true);
    if (busy !== undefined) return busy;
    // Held from here with no await in between, so no second checkpoint and no
    // turn can begin while the engine's record is being flushed.
    this.checkpointing = true;
    try {
      // The engine writes its record from its own task; a request that comes
      // back through it is the one barrier the protocol offers.
      await this.options.transport.request("thread/read", {
        threadId,
        includeTurns: false,
      });
      // Something the engine did while we waited (a tool it started on its own).
      const late = this.notQuiet(false);
      if (late !== undefined) return late;
      if (lease) this.leased = true;
      return {
        status: "ready",
        checkpoint: {
          engine: CODEX_DESCRIPTOR.checkpointEngine,
          resume: threadId,
          sdkVersion: CODEX_CLI_VERSION,
        },
      };
    } finally {
      this.checkpointing = false;
      if (!this.leased) void this.pump();
    }
  }

  async leaseCheckpoint(point: CheckpointPoint): Promise<CheckpointLeaseGrant> {
    const preparation = await this.prepare(point, true);
    if (preparation.status === "rejected") return { lease: null, preparation };
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
    this.options.mcp?.release();
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
    await this.mcpStarted();
    this.threadId = id;
    this.events$.push(startedEvent(id, this.options.model));
    void this.pump();
    return {
      effective: CODEX_DESCRIPTOR.capabilities,
      effectiveExtraFeatures: CODEX_DESCRIPTOR.extraFeatures,
    };
  }

  /**
   * The engine fixes the tools a turn offers the model when the turn starts, so
   * a relay server still connecting then is missing from that turn. Waiting
   * here keeps the first turn from running without the platform's tools.
   */
  private async mcpStarted(): Promise<void> {
    const names = this.options.mcp?.servers;
    if (names === undefined || names.size === 0) return;
    const deadline = Date.now() + MCP_STARTUP_TIMEOUT_MS;
    for (const name of names) {
      for (;;) {
        if (this.closing)
          throw new Error("The run ended before its MCP servers started");
        const state = this.mcpStartup.get(name);
        if (state?.status === "ready") break;
        if (state?.status === "failed" || state?.status === "cancelled") {
          throw new Error(
            `The Codex app-server could not start the ${name} MCP server (${state.status}${state.error === undefined ? "" : `: ${state.error}`})`,
          );
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(
            `The Codex app-server did not start the ${name} MCP server in ${String(MCP_STARTUP_TIMEOUT_MS / 1000)}s`,
          );
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, left);
          const signal = this.stop.signal;
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          }
          this.mcpStartupChanged = done;
          signal.addEventListener("abort", done, { once: true });
        });
        this.mcpStartupChanged = undefined;
      }
    }
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
      this.checkpointing ||
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
      !this.leased &&
      !this.checkpointing
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
    if (method === MCP_STARTUP) {
      // Before the thread id is known, and not filtered by it: the servers
      // start while `thread/start` is still answering.
      if (typeof params.name === "string") {
        this.mcpStartup.set(params.name, {
          status: String(params.status),
          ...(typeof params.error === "string" ? { error: params.error } : {}),
        });
        this.mcpStartupChanged?.();
      }
      return;
    }
    if (params.threadId !== undefined && params.threadId !== this.threadId) {
      return;
    }
    switch (method) {
      case "item/started": {
        const item = itemOf(params);
        if (item === undefined) return;
        if (
          item.type === "commandExecution" ||
          item.type === "fileChange" ||
          item.type === "mcpToolCall"
        ) {
          this.running.add(item.id);
          if (item.type === "fileChange") this.fileChanges.set(item.id, item);
          if (item.type === "mcpToolCall") this.mcpItems.push(item);
          this.announce(item.id, () => itemStarted(item, this.inputs));
        }
        return;
      }
      case "item/completed": {
        const item = itemOf(params);
        if (item === undefined) return;
        this.running.delete(item.id);
        this.mcpItems = this.mcpItems.filter((open) => open.id !== item.id);
        if (
          item.type === "commandExecution" ||
          item.type === "fileChange" ||
          item.type === "mcpToolCall"
        ) {
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
    // The engine asks before it calls any MCP tool, whatever the server is.
    // The answer decides nothing: the call goes to the relay, which judges it
    // with the call's own name and arguments (the request here carries
    // neither), so a platform server's call is let through to that judgment
    // and every other elicitation is declined.
    if (method === MCP_ELICITATION && params.threadId === this.threadId) {
      const server = params.serverName;
      return {
        action:
          typeof server === "string" && this.options.mcp?.servers.has(server)
            ? "accept"
            : "decline",
        content: null,
      };
    }
    if (tool === undefined || params.threadId !== this.threadId) {
      // Questions, MCP elicitations, permission grants, dynamic tools, token
      // refreshes: the profile offers none of them, so none is answered.
      throw new RpcError(`The platform does not answer ${method}`, -32601);
    }
    return { decision: await this.decide(id, tool, params) };
  }

  /**
   * The one place a platform tool call is judged, from the relay's `tools/call`
   * and before anything goes upstream. A refusal is the model's tool result.
   * The order is the Claude run's: the tool's own pre-check, then (unless the
   * server judges the tool itself) the person; a checkpoint being taken, a
   * closing run or an interrupt refuse the call.
   */
  async judgeMcpCall(
    call: RelayCall,
  ): Promise<
    { allowed: true; done: () => void } | { allowed: false; text: string }
  > {
    const refuse = (text: string) => ({ allowed: false as const, text });
    const idle = () => {
      if (this.closing || call.signal.aborted) {
        return "The session is ending, so the call was not made.";
      }
      if (this.leased || this.checkpointing) {
        return "The session is being checkpointed, so the call was not made. Call it again.";
      }
      return undefined;
    };
    const early = idle();
    if (early !== undefined) return refuse(early);
    const mcp = this.options.mcp;
    if (mcp === undefined) return refuse("No platform tools are served here");
    // In flight from here, so a checkpoint cannot start while the pre-check or
    // a person is still being waited on.
    const token = `${call.tool}:${randomUUID()}`;
    this.relayCalls.add(token);
    let verdict: string | undefined;
    try {
      // The state is read again after the last await, right before the call goes.
      verdict = (await this.judgeInFlight(call, mcp, idle)) ?? idle();
    } catch {
      verdict = "The call could not be judged, so it was not made.";
    }
    if (verdict !== undefined) {
      this.relayCalls.delete(token);
      return refuse(verdict);
    }
    return { allowed: true, done: () => this.relayCalls.delete(token) };
  }

  /** The refusal text for a call that may not go upstream, or undefined when it may. */
  private async judgeInFlight(
    call: RelayCall,
    mcp: NonNullable<CodexRunOptions["mcp"]>,
    idle: () => string | undefined,
  ): Promise<string | undefined> {
    if (this.options.precheckTool !== undefined) {
      const advice = await this.options
        .precheckTool(call.tool, call.arguments)
        .catch(() => null);
      if (advice !== null) return advice;
    }
    const itemId = this.claimMcpItem(call);
    if (!mcp.trusted.has(call.tool)) {
      const { answers, approvalPolicy } = this.options.launch;
      // `never` is bypassPermissions: nothing is asked. Otherwise a person
      // answers, except where the mode answers for them with a refusal.
      if (approvalPolicy !== "never") {
        if (answers === "none") {
          return "This tool is not permitted in the session's mode.";
        }
        const allowed = await this.askPerson(
          `mcp:${itemId}`,
          call.tool,
          itemId,
          call.arguments,
          { server: call.server },
          call.signal,
        );
        if (!allowed) return "The tool call was not approved.";
      }
    }
    return idle();
  }

  /** The engine's item for a relay call: the oldest announced one for the tool not yet claimed, or a new one announced here. */
  private claimMcpItem(call: RelayCall): string {
    const found = this.mcpItems.find(
      (item) =>
        !this.mcpClaimed.has(item.id) && mcpToolName(item) === call.tool,
    );
    if (found !== undefined) {
      this.mcpClaimed.add(found.id);
      return found.id;
    }
    const id = `mcp-${randomUUID()}`;
    const item: Item = {
      type: "mcpToolCall",
      id,
      server: call.server,
      tool: call.tool.slice(`mcp__${call.server}__`.length),
      arguments: call.arguments,
    };
    this.mcpClaimed.add(id);
    this.announce(id, () => itemStarted(item, this.inputs));
    return id;
  }

  /** One request to the person; true only for an explicit "allow once". */
  private async askPerson(
    rpcId: RpcId,
    tool: string,
    itemId: string,
    input: Record<string, unknown>,
    display: Record<string, unknown>,
    cancel?: AbortSignal,
  ): Promise<boolean> {
    let inputHash: string;
    try {
      inputHash = approvalInputHash(tool, input);
    } catch {
      return false;
    }
    const request: ApprovalRequested = {
      localId: randomUUID(),
      toolCallId: itemId,
      tool: { name: tool, input },
      inputHash,
      askedAt: performance.now(),
      kind: "permission",
      display,
    };
    this.open.set(request.localId, {
      rpcId,
      localId: request.localId,
      answeredByUs: false,
    });
    const answered = this.channel.request(
      request,
      cancel === undefined
        ? this.stop.signal
        : AbortSignal.any([this.stop.signal, cancel]),
    );
    this.events$.push({ type: "approval.requested", request });
    const answer = await answered;
    this.open.delete(request.localId);
    return answer.kind === "selected" && answer.optionKind === "allow_once";
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
    // A file change is approved for the changes the engine announced, not for
    // the directory it asks to write under: two patches to different files
    // would otherwise carry one hash. One the engine never announced is not
    // something an answer can be bound to.
    const change = isCommand ? undefined : this.fileChanges.get(itemId);
    if (!isCommand && change === undefined) return "decline";
    const input: Record<string, unknown> = isCommand
      ? { command: params.command ?? null, cwd: params.cwd ?? null }
      : {
          paths: changePaths(change as Item),
          changes_sha256: createHash("sha256")
            .update(JSON.stringify(change?.changes ?? null))
            .digest("hex"),
          grant_root: params.grantRoot ?? null,
        };
    this.announce(itemId, () =>
      itemStarted(
        isCommand
          ? { type: "commandExecution", id: itemId, ...input }
          : (change as Item),
        this.inputs,
      ),
    );
    const { answers } = this.options.launch;
    if (answers === "none") return "decline";
    // acceptEdits: file changes go through, commands still go to the person.
    if (answers === "edits" && !isCommand) return "accept";
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
          : { paths: input.paths, grant_root: params.grantRoot ?? null }),
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
