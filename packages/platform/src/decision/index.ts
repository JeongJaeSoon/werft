import type {
  PostSessionAnswerRequest,
  PostSessionAnswerResponse,
  PushRequest,
  PushResolution,
} from "@werft-ai/contracts";

// The two places a channel hands a person's answer to the platform (R5 in
// surface-action-modules.md). A channel takes these types, never a store.
// `Actor` is the caller type of the service behind the entrance: decision/
// imports nothing from the domains that implement it, so those domains
// depend on this file and not the other way round.

/** A person's answer to a permission request or a question. */
export interface PendingAnswerEntrance<Actor> {
  answer(
    actor: Actor,
    sessionId: string,
    input: { idempotencyKey: string; body: PostSessionAnswerRequest },
  ): Promise<PostSessionAnswerResponse>;
}

/** A person's approval or refusal of a push request. */
export interface PushDecisionEntrance<Actor> {
  decide(
    actor: Actor,
    sessionId: string,
    pushRequestId: string,
    input: {
      idempotencyKey: string;
      readBody: () => Promise<PushResolution>;
    },
  ): Promise<PushRequest>;
}
