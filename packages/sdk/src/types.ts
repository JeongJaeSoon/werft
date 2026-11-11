import type { components, paths, SessionEventFrame } from "@werft-ai/client";

type Schemas = components["schemas"];

/** A string union that still admits a value a newer server sends. */
export type Open<K extends string> = K | (string & {});

type UnionToIntersection<U> = (
  U extends unknown
    ? (value: U) => void
    : never
) extends (value: infer I) => void
  ? I
  : never;
type IsUnion<T> = [T] extends [UnionToIntersection<T>] ? false : true;

type OpenString<S> = [S] extends [never]
  ? never
  : string extends S
    ? S
    : IsUnion<S> extends true
      ? Open<S & string>
      : S;
type OpenValue<V> =
  | OpenString<Extract<V, string>>
  | OpenShape<Exclude<V, string>>;
type OpenShape<V> = V extends readonly (infer I)[]
  ? OpenValue<I>[]
  : V extends object
    ? { [K in keyof V]: OpenValue<V[K]> }
    : V;

/**
 * A response type with every enum opened. A union of two or more literals
 * becomes Open<...>; a single literal stays closed, so a union of objects
 * still narrows on its discriminant.
 */
export type Opened<T> = OpenShape<T>;

type Query<P extends keyof paths> = paths[P] extends {
  get: { parameters: { query?: infer Q } };
}
  ? NonNullable<Q>
  : never;

export type SessionId = string;
export type TurnId = string;
export type ReceiptId = string;
export type RequestId = string;
export type PushRequestId = string;

// Request types stay closed: the server rejects a value it does not know.
export type CreateSessionParams = Schemas["CreateSessionRequest"];
export type ListSessionsParams = Omit<Query<"/v1/sessions">, "cursor">;
export type ListTurnsParams = Omit<Query<"/v1/sessions/{id}/turns">, "cursor">;
// The generator makes a field with a default required; the server fills it in.
export type SendMessageParams = Omit<
  Schemas["PostSessionMessageRequest"],
  "mode"
> &
  Partial<Pick<Schemas["PostSessionMessageRequest"], "mode">>;
export type InterruptParams = Schemas["InterruptSessionRequest"];
export type PauseParams = Schemas["PauseSessionRequest"];
export type ResumeParams = Schemas["ResumeSessionRequest"];
export type TerminateParams = Schemas["TerminateSessionRequest"];
export type RecoveryDecisionParams = Schemas["RecoveryDecisionRequest"];
export type AnswerBody = Schemas["PostSessionAnswerRequest"];
export type ResolvePushParams = Schemas["ResolvePushRequestRequest"];
export type OpenPullRequestParams = Schemas["OpenPullRequestRequest"];
export type CommentPullRequestParams = Schemas["CommentPullRequestRequest"];

export type ApiRoot = Opened<Schemas["ApiRootResponse"]>;
export type AuthMe = Opened<Schemas["AuthMeResponse"]>;
export type InstallationLimits = Opened<Schemas["InstallationLimitsResponse"]>;
export type Connections = Opened<Schemas["ListConnectionOptionsResponse"]>;
export type Receipt = Opened<Schemas["Receipt"]>;
export type ReceiptAccepted = Opened<Schemas["ReceiptAcceptedResponse"]>;
export type SessionCreated = Opened<Schemas["CreateSessionResponse"]>;
export type Session = Opened<Schemas["SessionDetail"]>;
export type SessionSummary = Opened<Schemas["SessionSummary"]>;
export type SessionShare = Opened<Schemas["SessionShare"]>;
export type SessionUsage = Opened<Schemas["SessionUsageResponse"]>;
export type TerminateAccepted = Opened<Schemas["TerminateSessionResponse"]>;
export type MessageAccepted = Opened<Schemas["PostSessionMessageResponse"]>;
export type Turn = Opened<Schemas["TurnDetail"]>;
export type TurnSummary = Opened<Schemas["TurnSummary"]>;
export type PendingRequest = Opened<
  Schemas["ListPendingRequestsResponse"]["items"][number]
>;
export type PermissionRequest = Extract<PendingRequest, { kind: "permission" }>;
export type QuestionRequest = Extract<PendingRequest, { kind: "question" }>;
export type AnswerAccepted = Opened<Schemas["PostSessionAnswerResponse"]>;
export type PushRequest = Opened<Schemas["PushRequest"]>;
// `openPullRequest` never sends `?schedule=true`, so it answers the opened form.
export type PullRequestResult = Opened<Schemas["OpenPullRequestResponse"]>;
export type PullRequestCommentResult = Opened<
  Schemas["CommentPullRequestResponse"]
>;

export type ApiErrorCode = Opened<Schemas["ApiErrorResponse"]>["error"]["code"];
export type AdmissionState = Session["admission_state"];
export type SessionAttention = NonNullable<Session["attention"]>;
export type TurnStatus = Turn["status"];
export type TerminalTurnStatus = Extract<
  Schemas["TurnDetail"]["status"],
  "completed" | "failed" | "interrupted" | "cancelled" | "outcome_unknown"
>;

/** A denial needs a reason the model can act on. */
export type PermissionAnswer =
  | { action: "allow"; reason?: string }
  | { action: "deny"; reason: string };
export type QuestionAnswer = {
  answers: Extract<AnswerBody, { kind: "question" }>["answers"];
};

/** Opaque SSE cursor; pass it back as `lastEventId` to resume after it. */
export type EventCursor = string;

type EventKinds<P> = P extends { event: infer K; data: infer D }
  ? { kind: K; payload: Opened<D> }
  : never;
export type SessionEvent = {
  id: EventCursor;
  turn_id: TurnId | null;
  attempt_id: string | null;
  occurred_at: string;
} & EventKinds<SessionEventFrame["payload"]>;
