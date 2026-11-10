import { CLAUDE_DESCRIPTOR } from "@werft-ai/runtime-claude-codec";
import type {
  AgentRun,
  AgentRuntime,
  RuntimeHostDeps,
  RuntimeStart,
  ToolDecisionObserver,
} from "@werft-ai/runtime-core";
import {
  type InterruptCut,
  type ScriptDialect,
  ScriptedEngine,
  type ScriptedPermission,
  type ScriptedRuntime,
  type ScriptedRuntimeOptions,
  type ScriptedStep,
} from "@werft-ai/runtime-core/testing";

import type { ClaudeRuntimeConfig } from "../config.ts";
import { claudeContractRun, claudeStartConfig } from "../contract.ts";
import type {
  AgentFrame,
  DriverRun,
  NativeSdkMessage,
  RuntimeHooks,
} from "../driver.ts";
import { frameFromNativeMessage } from "../mapper.ts";
import type { InterruptedResult } from "../run.ts";
import { TurnLedger } from "../turn-ledger.ts";

export type FakeStep = ScriptedStep;
export type FakeRuntimeOptions = ScriptedRuntimeOptions;

const claudeDialect: ScriptDialect<AgentFrame> = {
  initialSessionId: "fake-session",
  ledger: (resume) => new TurnLedger(resume),
  frame: (message, correlationId, cursor, inputs) => {
    const frame = frameFromNativeMessage(
      message as NativeSdkMessage,
      correlationId,
      cursor,
    );
    return inputs === undefined ? frame : { ...frame, inputs };
  },
  sessionIdOf: (message) => {
    const sessionId = (message as NativeSdkMessage).session_id;
    return typeof sessionId === "string" ? sessionId : undefined;
  },
  toolCallMessage,
  interruptedMessage: (pending, cut, sessionId) =>
    interruptedMessage(pending, TERMINAL_REASONS[cut], sessionId),
};

/** A scripted engine: `run` gives the contract run the real runtime would. */
export class FakeAgentRuntime {
  private readonly engine: ScriptedEngine<AgentFrame>;

  constructor(steps: FakeStep[], options: FakeRuntimeOptions = {}) {
    this.engine = new ScriptedEngine(steps, claudeDialect, options);
  }

  get inputs(): ScriptedRuntime["inputs"] {
    return this.engine.inputs;
  }

  get permissionDecisions(): ScriptedRuntime["permissionDecisions"] {
    return this.engine.permissionDecisions;
  }

  get toolAdmissions(): ScriptedRuntime["toolAdmissions"] {
    return this.engine.toolAdmissions;
  }

  run(
    config: ClaudeRuntimeConfig,
    options: {
      toolCallWaitMs?: number;
      toolDecisions?: ToolDecisionObserver;
    } = {},
  ): AgentRun {
    return claudeContractRun((hooks) => this.start(config, hooks), options);
  }

  /** The driver run itself, for this package's own driver tests. */
  start(config: ClaudeRuntimeConfig, hooks: RuntimeHooks): DriverRun {
    return this.engine.start(config, hooks.onPermission);
  }
}

/**
 * The fake behind the runtime contract alone, as hosts get it: started from a
 * `RuntimeStart` the way `ClaudeAgentRuntime` is.
 */
export function scriptedClaudeRuntime(
  steps: FakeStep[],
  options: FakeRuntimeOptions = {},
  deps: Partial<RuntimeHostDeps> = {},
): ScriptedRuntime {
  const fake = new FakeAgentRuntime(steps, options);
  const hostDeps: RuntimeHostDeps = { stateDir: "/tmp/fake/config", ...deps };
  const runtime: AgentRuntime = {
    descriptor: CLAUDE_DESCRIPTOR,
    start: (start: RuntimeStart) =>
      fake.run(claudeStartConfig(start, hostDeps), {
        ...(hostDeps.toolCallWaitMs === undefined
          ? {}
          : { toolCallWaitMs: hostDeps.toolCallWaitMs }),
        ...(start.toolDecisions === undefined
          ? {}
          : { toolDecisions: start.toolDecisions }),
      }),
  };
  return {
    descriptor: runtime.descriptor,
    start: runtime.start,
    get inputs() {
      return fake.inputs;
    },
    get permissionDecisions() {
      return fake.permissionDecisions;
    },
    get toolAdmissions() {
      return fake.toolAdmissions;
    },
  };
}

// Typed against the SDK: a value no real run sends would let a host that
// branches on it pass here and fail against the engine.
type TerminalReason = NonNullable<InterruptedResult["terminal_reason"]>;

const TERMINAL_REASONS: Record<InterruptCut, TerminalReason> = {
  tools: "aborted_tools",
  streaming: "aborted_streaming",
};

function toolCallMessage(
  requests: readonly ScriptedPermission[],
): NativeSdkMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: requests.map((request) => ({
        type: "tool_use",
        id: request.toolUseId,
        name: request.tool,
        input: request.input,
      })),
    },
    parent_tool_use_id: null,
    session_id: "fake-session",
  };
}

// An interrupt drops every queued input, so the terminal frame attributes all
// of them the way the SDK attributes a batch: last uuid plus the full list.
function interruptedMessage(
  pending: readonly string[],
  reason: TerminalReason,
  sessionId: string,
): NativeSdkMessage {
  const last = pending.at(-1);
  const message: InterruptedResult = {
    type: "result",
    subtype: "error_during_execution",
    session_id: sessionId,
    is_error: true,
    terminal_reason: reason,
    ...(last === undefined
      ? {}
      : { user_message_uuid: last, user_message_uuids: [...pending] }),
  };
  return message;
}
