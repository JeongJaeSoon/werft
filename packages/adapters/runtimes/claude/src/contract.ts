import { randomUUID } from "node:crypto";
import type { SessionEvent } from "@werft-ai/contracts";
import {
  CLAUDE_DESCRIPTOR,
  CLAUDE_RUNTIME_FINGERPRINT,
  CLAUDE_TOOL_CATALOGS,
  claudeCheckpointCodec,
  equivalentToolCatalogVersions,
} from "@werft-ai/runtime-claude-codec";
import {
  type AdmissionHold,
  type AgentInput,
  type AgentRun,
  type AgentRuntime,
  type AnswerResult,
  type ApprovalAnswer,
  ApprovalChannel,
  type ApprovalRequested,
  approvalInputHash,
  type CancelReason,
  type CheckpointLeaseGrant,
  type CheckpointPoint,
  type CheckpointPreparation,
  type ImageRuntime,
  type NegotiatedCapabilities,
  type ParkReadiness,
  type RejectedCheckpoint,
  type RuntimeEvent,
  type RuntimeHostDeps,
  RuntimeMismatch,
  type RuntimeModule,
  type RuntimeProfileInput,
  type RuntimeStart,
} from "@werft-ai/runtime-core";

import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
  type ClaudeRuntimeConfig,
  type RuntimeProfile,
} from "./config.ts";
import type {
  AgentFrame,
  DriverRun,
  EngineRule,
  NativeSdkMessage,
  PermissionDecision,
  PermissionRequest,
  RuntimeHooks,
} from "./driver.ts";
import { approvalView, rememberView, sdkAnswers } from "./mapper.ts";
import {
  CLAUDE_PROFILE_DIGEST_SCHEME,
  claudeProfileFingerprint,
} from "./profile-fingerprint.ts";
import { remoteMcpRelay } from "./remote-mcp.ts";
import { instructionText } from "./repository-instructions.ts";
import { ClaudeSdkRuntime } from "./runtime.ts";
import { sameRules, sessionRuleUpdate } from "./session-rules.ts";
import { ClaudeSessionStore } from "./session-store.ts";
import { TurnAccounting } from "./turn-accounting.ts";
import { namedInputs, turnEndedOf } from "./turn-ended.ts";

const TOOL_CALL_WAIT_MS = 10_000;
const TOOL_CALLS_REMEMBERED = 1_000;

const CANCELLED: Record<CancelReason, string> = {
  park: "The approval was set aside for a later turn",
  shutdown: "This worker is shutting down",
  interrupt: "The run stopped before this was answered",
  expired: "No answer arrived in time",
  refused: "The answer could not be applied",
};

export type ClaudeProfileConfig = Pick<
  Extract<ClaudeRuntimeConfig, { mode: "new" }>,
  | "appendSystemPrompt"
  | "cwd"
  | "home"
  | "identities"
  | "maxTurns"
  | "mcpServers"
  | "model"
  | "permissionMode"
  | "plugins"
  | "profile"
  | "repositoryClaudeMd"
  | "settingSources"
  | "tools"
>;

/**
 * The SDK configuration a profile means. Shared by the run and by the
 * fingerprint its checkpoints are stamped with, so the two cannot describe
 * different runs. None of the repository's own Claude settings: their hooks
 * would run commands no permission callback sees, so `settingSources` is
 * always empty and the repository's instructions come in only as the bundle
 * says.
 */
export function claudeProfileConfig(
  profile: RuntimeProfileInput,
): ClaudeProfileConfig {
  const { bundle, config } = profile;
  const append = bundle.instructions.map(instructionText);
  return {
    ...(append.length === 0 ? {} : { appendSystemPrompt: append.join("\n\n") }),
    cwd: config.cwd,
    home: config.home,
    ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }),
    model: config.model,
    permissionMode: config.permissionMode,
    profile: engineProfile(profile.bindings),
    ...(bundle.repoInstructions === null
      ? {}
      : { repositoryClaudeMd: { contents: bundle.repoInstructions.text } }),
    settingSources: [],
    tools: [...config.tools],
    ...componentConfig(bundle),
  };
}

function componentConfig(
  bundle: RuntimeStart["bundle"],
): Pick<ClaudeProfileConfig, "identities" | "mcpServers" | "plugins"> {
  const mcp = mcpConfig(bundle.mcpServers);
  const bundles = bundle.extensions ?? [];
  if (bundles.length === 0) return mcp;
  return {
    ...mcp,
    identities: {
      ...mcp.identities,
      plugins: Object.fromEntries(bundles.map((b) => [b.path, b.digest])),
    },
    plugins: bundles.map((b) => ({ path: b.path, type: "local" as const })),
  };
}

function engineProfile(
  bindings: RuntimeProfileInput["bindings"],
): RuntimeProfile {
  const { auth, endpoint, kind } = bindings.provider;
  const principal = bindings.principal;
  if (kind === "litellm") return { kind, endpoint, auth, principal };
  if (auth.kind === "bearer") {
    throw new Error(
      "An anthropic provider takes an API key or an egress token",
    );
  }
  return { kind, endpoint, auth, principal };
}

function mcpConfig(
  servers: RuntimeStart["bundle"]["mcpServers"],
): Pick<ClaudeProfileConfig, "identities" | "mcpServers"> {
  if (servers.length === 0) return {};
  return {
    identities: {
      mcpServers: Object.fromEntries(servers.map((s) => [s.name, s.binding])),
    },
    mcpServers: Object.fromEntries(
      servers.map((s) => [
        s.name,
        remoteMcpRelay({
          name: s.name,
          url: s.url,
          token: s.token,
          tools: s.tools,
        }),
      ]),
    ),
  };
}

// Only a `platform` server's own tools, and only those it also exposes: a
// name that is not in the server's allowlist share is never trusted.
function trustedToolsOf(
  servers: RuntimeStart["bundle"]["mcpServers"],
): Pick<ClaudeRuntimeConfig, "trustedTools"> {
  const trusted = servers.flatMap((s) =>
    s.platform === true
      ? (s.trusted ?? []).filter(
          (tool) =>
            tool.startsWith(`mcp__${s.name}__`) && s.tools.includes(tool),
        )
      : [],
  );
  return trusted.length === 0 ? {} : { trustedTools: trusted };
}

export function claudeStartConfig(
  start: RuntimeStart,
  deps: RuntimeHostDeps,
): ClaudeRuntimeConfig {
  const { bindings, config } = start;
  const base = {
    ...claudeProfileConfig(start),
    claudeConfigDir: deps.stateDir,
    correlationId: config.correlationId,
    // Not in claudeProfileConfig: the fingerprint must not move when a
    // claim names another commit author.
    ...(config.gitEnvironment === undefined
      ? {}
      : { gitEnvironment: config.gitEnvironment }),
    ...trustedToolsOf(start.bundle.mcpServers),
    ...(config.disallowedTools === undefined
      ? {}
      : { disallowedTools: config.disallowedTools }),
    ...(deps.providerMaxRetries === undefined
      ? {}
      : { providerMaxRetries: deps.providerMaxRetries }),
    ...(config.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: config.maxBudgetUsd }),
    ...(bindings.transcript === undefined
      ? {}
      : { sessionStore: bindings.transcript }),
  };
  if (config.mode === "new") return { ...base, mode: "new" };
  return {
    ...base,
    mode: "resume",
    resume: config.resume,
    ...(config.localTranscriptResume === true
      ? { localTranscriptResume: true as const }
      : {}),
  };
}

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly descriptor = CLAUDE_DESCRIPTOR;

  constructor(private readonly deps: RuntimeHostDeps) {}

  start(start: RuntimeStart): AgentRun {
    const config = claudeStartConfig(start, this.deps);
    const driver = new ClaudeSdkRuntime(
      {
        endpoints: [start.bindings.provider.endpoint],
        models: [start.config.model],
      },
      this.deps.processObserver,
    );
    return claudeContractRun((hooks) => driver.start(config, hooks), {
      ...(this.deps.toolCallWaitMs === undefined
        ? {}
        : { toolCallWaitMs: this.deps.toolCallWaitMs }),
    });
  }
}

export const claudeRuntimeModule: RuntimeModule = {
  descriptor: CLAUDE_DESCRIPTOR,
  checkpointCodec: claudeCheckpointCodec,
  /**
   * A session made for another build is refused, unless that build's tool
   * catalog is this one's: a profile row left at the version before an SDK
   * upgrade then still starts. The transcript a checkpoint resumes is only
   * replayable on the build that wrote it, and the checkpoint's own
   * fingerprint holds it to that, whatever version the row names.
   */
  assertCompatible(runtime) {
    if (
      runtime.version !== CLAUDE_AGENT_SDK_VERSION &&
      runtime.version !== CLAUDE_CODE_VERSION &&
      !equivalentToolCatalogVersions(
        CLAUDE_TOOL_CATALOGS,
        runtime.kind,
        CLAUDE_AGENT_SDK_VERSION,
      ).includes(runtime.version)
    ) {
      throw new RuntimeMismatch(
        `Session needs runtime version ${runtime.version}; this worker ships Agent SDK ${CLAUDE_AGENT_SDK_VERSION} (Claude Code ${CLAUDE_CODE_VERSION})`,
      );
    }
  },
  fingerprint: (profile) => ({
    ...CLAUDE_RUNTIME_FINGERPRINT,
    profileSha256: claudeProfileFingerprint(claudeProfileConfig(profile)),
  }),
  createRuntime: (deps) => new ClaudeAgentRuntime(deps),
  imageFingerprint: () =>
    JSON.stringify({
      ...CLAUDE_RUNTIME_FINGERPRINT,
      profileDigestScheme: CLAUDE_PROFILE_DIGEST_SCHEME,
    } satisfies ImageRuntime),
  openTranscriptStore: (options) => new ClaudeSessionStore(options),
};

/**
 * The runtime contract over a driver run: the SDK's, or the scripted fake's.
 * `start` is handed the hooks the driver asks permissions through.
 */
export function claudeContractRun(
  start: (hooks: RuntimeHooks) => DriverRun,
  options: { toolCallWaitMs?: number } = {},
): AgentRun {
  return new ClaudeContractRun(
    start,
    options.toolCallWaitMs ?? TOOL_CALL_WAIT_MS,
  );
}

type AwaitingCall = {
  request: ApprovalRequested;
  timer: ReturnType<typeof setTimeout>;
};

class ClaudeContractRun implements AgentRun {
  private readonly channel = new ApprovalChannel();
  private readonly accounting = new TurnAccounting();
  private readonly driver: DriverRun;
  private readonly awaitingCall: AwaitingCall[] = [];
  private readonly outbox: RuntimeEvent[] = [];
  private readonly unaskedCalls = new Map<string, number>();
  private readonly emitted = new Set<string>();
  private readonly answered = new Set<string>();
  private wake: (() => void) | undefined;
  private consumed = false;
  private latestInput: string | undefined;

  constructor(
    start: (hooks: RuntimeHooks) => DriverRun,
    private readonly toolCallWaitMs: number,
  ) {
    this.driver = start({ onPermission: (request) => this.ask(request) });
  }

  async ready(): Promise<NegotiatedCapabilities> {
    await this.driver.ready();
    this.accounting.continueFrom(await this.driver.savedCost?.());
    const { capabilities } = CLAUDE_DESCRIPTOR;
    return {
      effective: {
        ...capabilities,
        approvalCheckpoint:
          capabilities.approvalCheckpoint &&
          this.driver.approvalCheckpoints === true,
      },
      effectiveExtraFeatures: CLAUDE_DESCRIPTOR.extraFeatures,
    };
  }

  async *events(): AsyncIterable<RuntimeEvent> {
    if (this.consumed) throw new Error("This run's events are already read");
    this.consumed = true;
    const frames = this.driver.events()[Symbol.asyncIterator]();
    let next: Promise<IteratorResult<AgentFrame>> | undefined;
    try {
      for (;;) {
        const queued = this.outbox.shift();
        if (queued !== undefined) {
          yield queued;
          continue;
        }
        const askedWhilePulling = new Promise<undefined>((resolve) => {
          this.wake = () => resolve(undefined);
        });
        next ??= frames.next();
        if (this.outbox.length > 0) this.wake?.();
        const frame = await Promise.race([next, askedWhilePulling]);
        this.wake = undefined;
        if (frame === undefined) continue;
        next = undefined;
        if (frame.done === true) return;
        yield* this.eventsOf(frame.value);
      }
    } finally {
      this.refuseAwaitingCall();
      void frames.return?.();
    }
  }

  send(input: AgentInput): void {
    this.driver.send(input);
    this.latestInput = input.uuid;
  }

  finishInput(): void {
    this.driver.finishInput();
  }

  holdsInput(uuid: string): Promise<boolean> {
    return this.driver.holdsInput(uuid);
  }

  answer(answer: ApprovalAnswer): Promise<AnswerResult> {
    const result = this.channel.answer(answer);
    if (result === "applied") this.answered.add(answer.localId);
    return Promise.resolve(result);
  }

  interrupt(): Promise<{ stillQueued: string[] }> {
    return this.driver.interrupt();
  }

  parkable(): ParkReadiness {
    return this.driver.parkable();
  }

  prepareCheckpoint(point: CheckpointPoint): Promise<CheckpointPreparation> {
    if (point === "turn_end") return this.driver.prepareCheckpoint();
    if (this.driver.approvalCheckpoints !== true) {
      return Promise.resolve(unsupported(point));
    }
    return this.driver.prepareCheckpoint(point);
  }

  leaseCheckpoint(point: CheckpointPoint): Promise<CheckpointLeaseGrant> {
    if (point === "turn_end") return this.driver.leaseCheckpoint();
    if (this.driver.approvalCheckpoints !== true) {
      return Promise.resolve({ lease: null, preparation: unsupported(point) });
    }
    return this.driver.leaseCheckpoint(point);
  }

  holdAdmission(guard: (toolCallId: string) => Promise<void>): AdmissionHold {
    const hold = this.driver.holdAdmission?.(guard);
    if (hold === undefined) {
      throw new Error("This run admits tools through no gate a host can hold");
    }
    return hold;
  }

  abort(): void {
    this.driver.abort();
  }

  close(): Promise<void> {
    this.refuseAwaitingCall();
    this.driver.close();
    return Promise.resolve();
  }

  private async ask(request: PermissionRequest): Promise<PermissionDecision> {
    const askedAt = performance.now();
    let inputHash: string;
    try {
      inputHash = approvalInputHash(request.tool, request.input);
    } catch {
      return {
        behavior: "deny",
        message: "The tool arguments cannot be identified for an approval",
      };
    }
    const view = approvalView(request.tool, request.input);
    // What the person is offered is the redacted copy; what the engine is
    // given back is built from the rules it proposed, and only if the answer
    // names exactly the copy that was shown.
    // A rule that redaction would change is not offered at all: two different
    // rules can redact to the same text, so the copy shown would not tell a
    // later answer or a resumed turn which one the person agreed to.
    const proposed =
      view.kind === "permission" ? (request.suggestedRules ?? []) : [];
    const redacted = rememberView(proposed);
    const offered = sameRules(proposed, redacted) ? proposed : [];
    const shown = offered.length === 0 ? [] : redacted;
    const approval: ApprovalRequested = {
      localId: randomUUID(),
      toolCallId: request.toolUseId,
      tool: { name: request.tool, input: request.input },
      inputHash,
      askedAt,
      ...view,
      ...(view.kind === "permission" && shown.length > 0
        ? { rememberOffer: shown }
        : {}),
    };
    const answered = this.channel.request(approval, request.signal);
    this.offer(approval);
    const answer = await answered;
    this.unhold(approval.localId);
    if (this.withdrawnByEngine(approval.localId)) {
      this.push({
        type: "approval.resolved",
        localId: approval.localId,
        outcome: "withdrawn",
      });
    }
    return decisionOf(answer, request.input, { offered, shown });
  }

  private offer(request: ApprovalRequested): void {
    if (this.takeCall(request.toolCallId)) {
      this.emit(request);
      return;
    }
    const timer = setTimeout(() => {
      if (!this.unhold(request.localId)) return;
      this.channel.answer({
        localId: request.localId,
        inputHash: request.inputHash,
        kind: "cancelled",
        reason: "refused",
        message: `The events before this request could not be stored: The tool call ${request.toolCallId} did not reach the event stream within ${this.toolCallWaitMs}ms`,
      });
    }, this.toolCallWaitMs);
    this.awaitingCall.push({ request, timer });
  }

  private eventsOf(frame: AgentFrame): RuntimeEvent[] {
    const message = frame.envelope.message;
    this.accounting.observe(message);
    const named = namedInputs(message);
    const inputs = named.length > 0 ? named : frame.inputs;
    const calls = toolCallsOf(message);
    for (const call of calls) this.callEmitted(call.toolCallId);
    // The mapper gives each content block an event of its own, so a call is
    // named right after the one that carries it and stored no later.
    const unplaced = [...calls];
    const events = frame.events.flatMap((event): RuntimeEvent[] => {
      const carried = unplaced.findIndex(
        (call) => call.toolCallId === toolCallIdOf(event),
      );
      const [call] = carried === -1 ? [] : unplaced.splice(carried, 1);
      return [
        { type: "public", event, ...(inputs === undefined ? {} : { inputs }) },
        ...(call === undefined
          ? []
          : [{ type: "tool.called", ...call } satisfies RuntimeEvent]),
      ];
    });
    return [
      ...(events.length === 0 && inputs !== undefined && inputs.length > 0
        ? [{ type: "inputs.named", inputs } satisfies RuntimeEvent]
        : []),
      ...events,
      ...unplaced.map(
        (call): RuntimeEvent => ({ type: "tool.called", ...call }),
      ),
      ...this.outcomeOf(message),
    ];
  }

  private outcomeOf(message: NativeSdkMessage): RuntimeEvent[] {
    if (message.type === "result") {
      return [
        {
          type: "turn.ended",
          turn: turnEndedOf(message, this.accounting, this.latestInput),
        },
      ];
    }
    if (message.type === "system" && message.subtype === "mirror_error") {
      return [
        {
          type: "runtime.warning",
          kind: "transcript_mirror_failed",
          detail: {
            error:
              typeof message.error === "string" && message.error.length > 0
                ? message.error
                : "unspecified error",
          },
        },
      ];
    }
    return [];
  }

  private callEmitted(toolCallId: string): void {
    const count = (this.unaskedCalls.get(toolCallId) ?? 0) + 1;
    this.unaskedCalls.delete(toolCallId);
    this.unaskedCalls.set(toolCallId, count);
    if (this.unaskedCalls.size > TOOL_CALLS_REMEMBERED) {
      const [oldest] = this.unaskedCalls.keys();
      if (oldest !== undefined) this.unaskedCalls.delete(oldest);
    }
    for (const held of [...this.awaitingCall]) {
      if (held.request.toolCallId !== toolCallId) continue;
      if (!this.takeCall(toolCallId)) break;
      this.unhold(held.request.localId);
      this.emit(held.request);
    }
  }

  private takeCall(toolCallId: string): boolean {
    const count = this.unaskedCalls.get(toolCallId) ?? 0;
    if (count === 0) return false;
    if (count === 1) this.unaskedCalls.delete(toolCallId);
    else this.unaskedCalls.set(toolCallId, count - 1);
    return true;
  }

  private unhold(localId: string): boolean {
    const index = this.awaitingCall.findIndex(
      (held) => held.request.localId === localId,
    );
    if (index === -1) return false;
    const [held] = this.awaitingCall.splice(index, 1);
    clearTimeout(held?.timer);
    return true;
  }

  private withdrawnByEngine(localId: string): boolean {
    return this.emitted.has(localId) && !this.answered.has(localId);
  }

  private emit(request: ApprovalRequested): void {
    this.emitted.add(request.localId);
    this.push({ type: "approval.requested", request });
  }

  private push(event: RuntimeEvent): void {
    this.outbox.push(event);
    this.wake?.();
  }

  private refuseAwaitingCall(): void {
    for (const held of this.awaitingCall.splice(0)) {
      clearTimeout(held.timer);
      this.channel.answer({
        localId: held.request.localId,
        inputHash: held.request.inputHash,
        kind: "cancelled",
        reason: "shutdown",
      });
    }
  }
}

function unsupported(point: CheckpointPoint): RejectedCheckpoint {
  return {
    status: "rejected",
    reason: "turn_in_flight",
    detail: `${point} checkpoints are not supported`,
  };
}

function decisionOf(
  answer: ApprovalAnswer,
  input: Record<string, unknown>,
  offer: { offered: readonly EngineRule[]; shown: readonly EngineRule[] },
): PermissionDecision {
  switch (answer.kind) {
    case "selected":
      return answer.optionKind === "allow_once"
        ? { behavior: "allow", ...rememberedBy(answer.remember, offer) }
        : { behavior: "deny", message: personDenial(answer.message) };
    case "answered":
      return {
        behavior: "allow",
        updatedInput: { ...input, answers: sdkAnswers(input, answer.answers) },
      };
    case "cancelled":
      return {
        behavior: "deny",
        message: answer.message ?? CANCELLED[answer.reason],
        ...(answer.reason === "park" ? { interrupt: true } : {}),
      };
  }
}

/**
 * The engine keeps rules only when the answer names the very rules this
 * request offered: a resumed turn asks again and the engine may propose
 * something broader than what the person agreed to. Otherwise the allow
 * stands for this one call.
 */
function rememberedBy(
  remember: { scope: "session"; rules: readonly EngineRule[] } | undefined,
  offer: { offered: readonly EngineRule[]; shown: readonly EngineRule[] },
): Pick<PermissionDecision & { behavior: "allow" }, "updatedPermissions"> {
  if (remember === undefined || offer.offered.length === 0) return {};
  if (!sameRules(remember.rules, offer.shown)) return {};
  return { updatedPermissions: sessionRuleUpdate(offer.offered) };
}

// A bare reason reaches the model as a tool error, which real models took for
// a hook's refusal or a prompt injection.
function personDenial(reason: string | undefined): string {
  const said = reason?.trim() ?? "";
  return said === ""
    ? "The user denied this request without giving a reason."
    : `The user denied this request. Their reason: ${said}`;
}

function toolCallIdOf(event: SessionEvent): string | undefined {
  if (event.event !== "tool_use") return undefined;
  const content = (event.data.message as { content?: unknown } | null)?.content;
  const block = Array.isArray(content) ? content[0] : undefined;
  const id = (block as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

function toolCallsOf(
  message: NativeSdkMessage,
): { toolCallId: string; tool: string }[] {
  if (message.type !== "assistant" || typeof message.error === "string") {
    return [];
  }
  const native = message.message;
  const content =
    native !== null && typeof native === "object" && "content" in native
      ? (native as { content?: unknown }).content
      : undefined;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block === null || typeof block !== "object") return [];
    const { id, name, type } = block as Record<string, unknown>;
    if (type !== "tool_use" || typeof id !== "string") return [];
    return [{ toolCallId: id, tool: typeof name === "string" ? name : "" }];
  });
}
