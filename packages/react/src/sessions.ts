import {
  type MutationFunctionContext,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiError,
  type SessionEventFrame as ClientEventFrame,
  type components,
  isApiError,
  type StreamState,
  subscribeSessionEvents,
  unwrap,
} from "@werft-ai/client";
import {
  type ChangeSessionProfileRequest,
  eventToolCall,
  eventToolResult,
  type PostSessionAnswerResponse,
  type PostSessionMessageResponse,
  type ReceiptAcceptedResponse,
  type SessionEventPayload,
  type TerminateSessionResponse,
} from "@werft-ai/contracts";
import {
  agentQuery,
  agentSessionListsFilter,
  pendingRequestsQuery,
  sessionGithubWorkQuery,
  sessionQuery,
  sessionsQuery,
  sessionTurnsQuery,
  sessionUsageQuery,
  waitingSessionsQuery,
} from "@werft-ai/core";
import { useEffect, useState } from "react";
import { useWerft } from "./provider.tsx";

/*
 * The session screens' data: what to fetch and when, and nothing about how it
 * looks.
 */

// Events kept on screen; older ones drop off so a long session does not
// grow the page without bound.
const EVENT_WINDOW = 200;

export function useSessions() {
  const { client } = useWerft();
  return useInfiniteQuery(sessionsQuery(client));
}

/**
 * Whether the viewer can open the agent's page: the read succeeds. A deleted
 * agent (404) or one the viewer may not read (403) leaves it unanswered, and
 * so does a read still in flight.
 */
export function useAgentOpenable(id: string | undefined): boolean {
  const { client } = useWerft();
  return useQuery({
    ...agentQuery(client, id ?? ""),
    enabled: id !== undefined,
  }).isSuccess;
}

export function useSession(id: string) {
  const { client } = useWerft();
  return useQuery(sessionQuery(client, id));
}

export function useSessionUsage(id: string, enabled: boolean) {
  const { client } = useWerft();
  return useQuery({ ...sessionUsageQuery(client, id), enabled });
}

export function usePendingRequests(id: string, enabled: boolean) {
  const { client } = useWerft();
  return useQuery({ ...pendingRequestsQuery(client, id), enabled });
}

export function useSessionTurns(id: string, enabled: boolean) {
  const { client } = useWerft();
  return useQuery({ ...sessionTurnsQuery(client, id), enabled });
}

// One key per mutate call, kept across its retries: under a new key the
// server would run a command it already took a second time. React Query
// hands onMutate and every attempt of one call the same context object, and
// each call its own, so the key hangs off that rather than the variables
// two calls may share.
const idempotencyKeys = new WeakMap<MutationFunctionContext, string>();

const newCommand = (_: unknown, context: MutationFunctionContext) => {
  idempotencyKeys.set(context, crypto.randomUUID());
};

const commandParams = (id: string, context: MutationFunctionContext) => ({
  path: { id },
  header: {
    "Idempotency-Key": idempotencyKeys.get(context) ?? crypto.randomUUID(),
  },
});

/** Moves the session onto another profile from its next turn on. */
export function useChangeSessionProfile(id: string) {
  const { client } = useWerft();
  const queryClient = useQueryClient();
  return useMutation<unknown, ApiError, ChangeSessionProfileRequest>({
    onMutate: newCommand,
    mutationFn: (body, context) =>
      unwrap(
        client.POST("/v1/sessions/{id}/profile", {
          params: commandParams(id, context),
          body,
        }),
      ),
    // The detail query's own key is the filter.
    onSettled: () => queryClient.invalidateQueries(sessionQuery(client, id)),
  });
}

/** A part of a session's server state that an event or a command can make stale. */
type SessionPart = "list" | "detail" | "pending" | "usage" | "turns" | "github";

function refreshSession(
  queryClient: QueryClient,
  client: ApiClient,
  id: string,
  parts: Iterable<SessionPart>,
) {
  for (const part of parts) {
    // The list's and the detail's keys prefix the others', so those two
    // match exactly.
    switch (part) {
      case "list":
        void queryClient.invalidateQueries({
          ...sessionsQuery(client),
          exact: true,
        });
        void queryClient.invalidateQueries({
          ...waitingSessionsQuery(client),
          exact: true,
        });
        void queryClient.invalidateQueries(agentSessionListsFilter(client));
        break;
      case "detail":
        void queryClient.invalidateQueries({
          ...sessionQuery(client, id),
          exact: true,
        });
        break;
      case "pending":
        void queryClient.invalidateQueries(pendingRequestsQuery(client, id));
        break;
      case "usage":
        void queryClient.invalidateQueries(sessionUsageQuery(client, id));
        break;
      case "turns":
        void queryClient.invalidateQueries(sessionTurnsQuery(client, id));
        break;
      case "github":
        void queryClient.invalidateQueries(sessionGithubWorkQuery(client, id));
        break;
    }
  }
}

// Request bodies as the wire takes them; the contracts' inferred types allow
// an explicit undefined the client's types refuse.
type Body = components["schemas"];

// Each mutation refreshes the cache only once the server took the command; a
// refused one leaves every query as it was and hands the caller the error.

/** Answers one of the session's pending permission or question requests. */
export function useAnswer(id: string) {
  const { client } = useWerft();
  const queryClient = useQueryClient();
  return useMutation<
    PostSessionAnswerResponse,
    ApiError,
    Body["PostSessionAnswerRequest"]
  >({
    onMutate: newCommand,
    mutationFn: (body, context) =>
      unwrap(
        client.POST("/v1/sessions/{id}/answers", {
          params: commandParams(id, context),
          body,
        }),
      ) as Promise<PostSessionAnswerResponse>,
    onSuccess: () =>
      refreshSession(queryClient, client, id, ["detail", "pending"]),
  });
}

/** Queues a message as the session's next turn. */
export function useSendMessage(id: string) {
  const { client } = useWerft();
  const queryClient = useQueryClient();
  return useMutation<
    PostSessionMessageResponse,
    ApiError,
    Omit<Body["PostSessionMessageRequest"], "mode">
  >({
    onMutate: newCommand,
    mutationFn: (body, context) =>
      unwrap(
        client.POST("/v1/sessions/{id}/messages", {
          params: commandParams(id, context),
          body: { ...body, mode: "enqueue" },
        }),
      ) as Promise<PostSessionMessageResponse>,
    onSuccess: () =>
      refreshSession(queryClient, client, id, ["list", "detail"]),
  });
}

export type SessionControl =
  | {
      readonly action: "interrupt";
      readonly body: Body["InterruptSessionRequest"];
    }
  | { readonly action: "pause"; readonly body: Body["PauseSessionRequest"] }
  | {
      readonly action: "terminate";
      readonly body: Body["TerminateSessionRequest"];
    }
  | { readonly action: "resume"; readonly body: Body["ResumeSessionRequest"] };

/** Interrupts a running turn, or pauses, terminates or resumes the session. */
export function useSessionControl(id: string) {
  const { client } = useWerft();
  const queryClient = useQueryClient();
  return useMutation<
    ReceiptAcceptedResponse | TerminateSessionResponse,
    ApiError,
    SessionControl
  >({
    onMutate: newCommand,
    mutationFn: (command, context) => {
      const params = commandParams(id, context);
      switch (command.action) {
        case "interrupt":
          return unwrap(
            client.POST("/v1/sessions/{id}/interrupt", {
              params,
              body: command.body,
            }),
          ) as Promise<ReceiptAcceptedResponse>;
        case "pause":
          return unwrap(
            client.POST("/v1/sessions/{id}/pause", {
              params,
              body: command.body,
            }),
          ) as Promise<ReceiptAcceptedResponse>;
        case "terminate":
          return unwrap(
            client.POST("/v1/sessions/{id}/terminate", {
              params,
              body: command.body,
            }),
          ) as Promise<TerminateSessionResponse>;
        case "resume":
          return unwrap(
            client.POST("/v1/sessions/{id}/resume", {
              params,
              body: command.body,
            }),
          ) as Promise<ReceiptAcceptedResponse>;
      }
    },
    // A terminate closes the open requests too.
    onSuccess: () =>
      refreshSession(queryClient, client, id, ["list", "detail", "pending"]),
  });
}

/**
 * What each event kind can make stale. Message and tool events only add to
 * the stream itself, so they refetch nothing.
 */
const EVENT_STALES: Partial<
  Record<SessionEventPayload["event"], readonly SessionPart[]>
> = {
  question: ["detail", "pending"],
  status: ["list", "detail", "pending", "usage", "turns", "github"],
  result: ["detail", "usage", "github"],
  error: ["detail"],
};

export type EventStreamState = StreamState;

/** One event as the client delivers it, a tool result's call named. */
export interface SessionEventFrame extends ClientEventFrame {
  /** A tool result's call, named when the result arrived. */
  readonly toolName?: string;
}

// Tool results wait for their call's name; calls whose result never comes
// are dropped oldest first past this many.
const PENDING_CALLS_MAX = EVENT_WINDOW;

function toolCalls(payload: SessionEventPayload) {
  if (payload.event !== "tool_use" && payload.event !== "assistant") return [];
  const call = eventToolCall(payload.data);
  return call === null ? [] : [[call.id, call.name] as const];
}

/**
 * The tool_use id a call, its result or a request holding it back carries,
 * for drawing them in one row. An event with several calls has none: one
 * result would end them all.
 */
export function eventToolCallId(
  payload: SessionEventPayload,
): string | undefined {
  if (payload.event === "question") return payload.data.tool_use_id;
  if (payload.event !== "tool_result") {
    const calls = toolCalls(payload);
    return calls.length === 1 ? calls[0]?.[0] : undefined;
  }
  return eventToolResult(payload.data)?.tool_call_id;
}

/**
 * The session's event stream, replayed from the start. The client resumes
 * with Last-Event-ID after a dropped connection and delivers each event once;
 * a refusal (the share taken back, the login gone) closes it for good and the
 * screen says so. An event that changes the session's state refreshes the
 * queries it makes stale.
 */
export function useSessionEvents(id: string, enabled: boolean) {
  const { client, onUnauthorized, eventRetry } = useWerft();
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<readonly SessionEventFrame[]>([]);
  const [state, setState] = useState<EventStreamState>("connecting");

  useEffect(() => {
    if (!enabled) return;
    setEvents([]);
    setState("connecting");
    const stop = new AbortController();
    const callNames = new Map<string, string>();
    // The replay on connect and a busy turn deliver events in bursts, every
    // frame of a read in one go; a burst refetches each stale query once.
    const stale = new Set<SessionPart>();
    let flush: ReturnType<typeof setTimeout> | undefined;
    void subscribeSessionEvents(client, id, {
      signal: stop.signal,
      onEvent: (frame) => {
        const { payload } = frame;
        for (const part of EVENT_STALES[payload.event] ?? []) stale.add(part);
        if (
          payload.event === "system" &&
          payload.data.subtype === "workspace_limit_mode"
        )
          stale.add("detail");
        if (stale.size > 0 && flush === undefined) {
          flush = setTimeout(() => {
            flush = undefined;
            refreshSession(queryClient, client, id, stale);
            stale.clear();
          }, 0);
        }
        for (const [callId, name] of toolCalls(payload)) {
          callNames.set(callId, name);
          if (callNames.size > PENDING_CALLS_MAX) {
            callNames.delete(callNames.keys().next().value as string);
          }
        }
        const callId =
          payload.event === "tool_result"
            ? eventToolCallId(payload)
            : undefined;
        const toolName =
          callId === undefined ? undefined : callNames.get(callId);
        if (callId !== undefined) callNames.delete(callId);
        const event: SessionEventFrame =
          toolName === undefined ? frame : { ...frame, toolName };
        setEvents((current) => [...current, event].slice(-EVENT_WINDOW));
      },
      // The old subscription closes after the next one started.
      onState: (next) => {
        if (!stop.signal.aborted) setState(next);
      },
      onError: (error) => {
        if (isApiError(error, "UNAUTHORIZED")) onUnauthorized?.();
      },
      ...(eventRetry ? { retry: eventRetry } : {}),
    });
    return () => {
      stop.abort();
      clearTimeout(flush);
    };
  }, [client, queryClient, onUnauthorized, eventRetry, id, enabled]);

  return { events, state };
}
