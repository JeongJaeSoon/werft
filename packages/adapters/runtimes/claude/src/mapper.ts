import {
  type PendingQuestion,
  type QuestionAnswer,
  type SessionEvent,
  sessionEventSchema,
} from "@werft-ai/contracts";

import { CLAUDE_AGENT_SDK_VERSION } from "./config.ts";
import type {
  AgentFrame,
  EngineRule,
  NativeEnvelope,
  NativeSdkMessage,
} from "./driver.ts";

const REDACTED = "[REDACTED]";
// Paths are not secrets: an approval has to say which file it touches.
const SENSITIVE_KEY =
  /authorization|cookie|credential|secret|password|api[_-]?key|auth[_-]?token|(^|_)home$/i;
const SENSITIVE_VALUE =
  /\bBearer\s+\S+|\b(?:s[k]-ant(?:-api\d+)?|csp)[_-][A-Za-z0-9_-]+/gi;
const SENSITIVE_NAME =
  /\b(?:authorization|cookie|credential|secret|password|api[-_ ]?key|auth[-_ ]?token|access[-_ ]?key|private[-_ ]?key)\b\s*([:=])[ \t]*/gi;
// One plain word, or one quoted string with nothing to expand.
const PLAIN_VALUE = /"[^"\\$`\n]*"|'[^'\n]*'|[^\s"'\\$`&;|<>()]+/y;
const VALUE_END = /[\s&;|)]|$/y;

export const TOOL_DESCRIPTION_MAX_CODE_POINTS = 200;

/**
 * `toolDescriptions` are what the MCP relays were told of their tools, by
 * engine name, when `message` is the engine's init. The engine itself names
 * its tools there but describes none, not even in `mcpServerStatus()`.
 */
export function frameFromNativeMessage(
  message: NativeSdkMessage,
  correlationId: string,
  cursor: string,
  toolDescriptions?: ReadonlyMap<string, string>,
): AgentFrame {
  const envelope: NativeEnvelope = {
    correlation_id: correlationId,
    message: sanitizeNativeMessage(message),
    schema_version: "sdk-envelope/v1",
    sdk_version: CLAUDE_AGENT_SDK_VERSION,
  };
  return {
    envelope,
    events: projectPublicEvents(envelope, cursor, toolDescriptions),
  };
}

export function isEngineInit(message: NativeSdkMessage): boolean {
  return message.type === "system" && message.subtype === "init";
}

export function sanitizeNativeMessage(
  message: NativeSdkMessage,
): NativeSdkMessage {
  return sanitizeValue(message) as NativeSdkMessage;
}

export function redactToolInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeValue(input) as Record<string, unknown>;
}

export function projectPublicEvents(
  envelope: NativeEnvelope,
  cursor: string,
  toolDescriptions?: ReadonlyMap<string, string>,
): SessionEvent[] {
  const message = envelope.message;
  if (message.type === "assistant") {
    if (typeof message.error === "string") {
      return [
        event(cursor, "error", {
          code: message.error,
          message: "Agent SDK assistant request failed",
        }),
      ];
    }
    const nativeMessage = record(message.message);
    const content = Array.isArray(nativeMessage?.content)
      ? nativeMessage.content
      : [];
    return content.map((block, index) => {
      const safeBlock = record(block) ?? { type: "unknown" };
      return event(
        `${cursor}:${index}`,
        safeBlock.type === "tool_use" ? "tool_use" : "assistant",
        {
          type: "assistant",
          message: { ...nativeMessage, content: [safeBlock] },
          parent_tool_use_id:
            typeof message.parent_tool_use_id === "string"
              ? message.parent_tool_use_id
              : null,
        },
      );
    });
  }
  if (message.type === "user") {
    const nativeMessage = record(message.message);
    if (!Array.isArray(nativeMessage?.content)) return [];
    return nativeMessage.content.flatMap((block, index) => {
      const safeBlock = record(block);
      if (safeBlock?.type !== "tool_result") return [];
      return [event(`${cursor}:${index}`, "tool_result", safeBlock)];
    });
  }
  if (message.type === "result") {
    return [
      event(cursor, "result", {
        type: "result",
        subtype:
          typeof message.subtype === "string" ? message.subtype : "unknown",
        session_id:
          typeof message.session_id === "string"
            ? message.session_id
            : "unknown-session",
        is_error: message.is_error,
        stop_reason: message.stop_reason,
        terminal_reason: message.terminal_reason,
        usage: message.usage,
      }),
    ];
  }
  if (message.type === "stream_event") return [];
  if (message.type === "system" && message.subtype === "mirror_error") {
    return [
      event(cursor, "error", {
        code: "mirror_error",
        message: "Agent SDK transcript mirror failed",
      }),
    ];
  }
  if (isEngineInit(message)) {
    return [
      event(cursor, "system", {
        type: "system",
        subtype: "init",
        tools: toolCatalog(message.tools, toolDescriptions),
      }),
    ];
  }
  if (message.type === "system") {
    return [
      event(cursor, "system", {
        type: "system",
        subtype:
          typeof message.subtype === "string" ? message.subtype : "unknown",
      }),
    ];
  }
  return [
    event(cursor, "system", {
      type: "system",
      subtype: "sdk_event",
      native_type: message.type,
      schema_version: envelope.schema_version,
      sdk_version: envelope.sdk_version,
      correlation_id: envelope.correlation_id,
    }),
  ];
}

const QUESTION_TOOL = "AskUserQuestion";

/**
 * What people are shown of an approval request, redacted. Redaction keeps the
 * shape, so question and option ids still name the unredacted questions an
 * answer is turned back into. A question with nothing to show is asked as a
 * permission.
 */
export function approvalView(
  tool: string,
  input: Record<string, unknown>,
):
  | { kind: "permission"; display: Record<string, unknown> }
  | { kind: "question"; questions: PendingQuestion[] } {
  const questions = tool === QUESTION_TOOL ? questionsOf(input) : null;
  return questions === null
    ? {
        kind: "permission",
        display: sanitizeValue(input) as Record<string, unknown>,
      }
    : {
        kind: "question",
        questions: sanitizeValue(questions) as PendingQuestion[],
      };
}

/**
 * The rules a person is asked to keep allowing, as they are shown: the same
 * redaction as the tool input. What the engine gets back is built from the
 * run's own copy, never from this one.
 */
export function rememberView(rules: readonly EngineRule[]): EngineRule[] {
  return sanitizeValue(rules.map((rule) => ({ ...rule }))) as EngineRule[];
}

/** The SDK takes answers on the tool input, keyed by each question as asked. */
export function sdkAnswers(
  input: Record<string, unknown>,
  answers: readonly QuestionAnswer[],
): Record<string, string> {
  return Object.fromEntries(
    (questionsOf(input) ?? []).flatMap((question) => {
      const answer = answers.find(
        (item) => item.question_id === question.question_id,
      );
      return answer === undefined
        ? []
        : [[question.prompt, answerText(question, answer)]];
    }),
  );
}

function answerText(question: PendingQuestion, answer: QuestionAnswer): string {
  const labels = answer.selected_option_ids.map(
    (id) =>
      question.options.find((candidate) => candidate.option_id === id)?.label ??
      id,
  );
  if (answer.free_text !== undefined) labels.push(answer.free_text);
  return labels.join(", ");
}

/**
 * The questions an AskUserQuestion input asks, or null when it carries none
 * to show. Ids are positional so an answer can only name a question and an
 * option that was offered.
 */
function questionsOf(input: Record<string, unknown>): PendingQuestion[] | null {
  const raw = input.questions;
  if (!Array.isArray(raw)) return null;
  const questions = raw.flatMap((value, index) => {
    if (value === null || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const prompt = typeof item.question === "string" ? item.question : null;
    if (prompt === null) return [];
    const options = Array.isArray(item.options) ? item.options : [];
    return [
      {
        question_id: `q${index}`,
        prompt,
        options: options.flatMap((option, position) => {
          const label =
            option !== null &&
            typeof option === "object" &&
            typeof (option as Record<string, unknown>).label === "string"
              ? ((option as Record<string, unknown>).label as string)
              : null;
          return label === null
            ? []
            : [{ option_id: `q${index}o${position}`, label }];
        }),
        multi_select: item.multiSelect === true,
        allow_free_text: true,
      },
    ];
  });
  return questions.length > 0 ? questions : null;
}

/**
 * The engine's tools by name, each MCP tool with its server's description.
 * A description is server-supplied text, so it is redacted like any engine
 * output, kept to one line and cut to TOOL_DESCRIPTION_MAX_CODE_POINTS.
 */
function toolCatalog(
  names: unknown,
  descriptions: ReadonlyMap<string, string> | undefined,
): { name: string; description?: string }[] {
  return (Array.isArray(names) ? names : [])
    .filter((name): name is string => typeof name === "string" && name !== "")
    .map((name) => {
      const given = descriptions?.get(name);
      const description =
        given === undefined ? undefined : descriptionLine(given);
      return description === undefined ? { name } : { name, description };
    });
}

function descriptionLine(text: string): string | undefined {
  const line = (sanitizeValue(text) as string)
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
  const points = [...line];
  if (points.length <= TOOL_DESCRIPTION_MAX_CODE_POINTS) {
    return line === "" ? undefined : line;
  }
  return `${points
    .slice(0, TOOL_DESCRIPTION_MAX_CODE_POINTS - 1)
    .join("")
    .trimEnd()}…`;
}

function event(
  id: string,
  eventName: SessionEvent["event"],
  data: unknown,
): SessionEvent {
  return sessionEventSchema.parse({ id, event: eventName, data });
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") {
    return hideNamedValues(value.replace(SENSITIVE_VALUE, REDACTED));
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeValue(childValue, childKey),
    ]),
  );
}

// A `name=value` loses just its value when the value visibly ends. Anything
// else — `name: value`, escapes, `$'…'`, concatenated quotes, a value on the
// next line — hides the whole text.
function hideNamedValues(text: string): string {
  let shown = "";
  let from = 0;
  for (const name of text.matchAll(SENSITIVE_NAME)) {
    if (name.index < from) continue;
    if (name[1] === ":") return REDACTED;
    const start = name.index + name[0].length;
    PLAIN_VALUE.lastIndex = start;
    const value = PLAIN_VALUE.exec(text);
    if (value === null) return REDACTED;
    const end = start + value[0].length;
    VALUE_END.lastIndex = end;
    if (!VALUE_END.test(text)) return REDACTED;
    shown += text.slice(from, start) + REDACTED;
    from = end;
  }
  return shown + text.slice(from);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
