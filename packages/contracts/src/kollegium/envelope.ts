import { z } from "zod";

import { messageTextSchema } from "../api/index.ts";
import { humanActorSchema, serviceActorSchema } from "../musterrolle/index.ts";
import {
  agentIdSchema,
  agentReleaseIdSchema,
  installationIdSchema,
  opaqueIdSchema,
  ownerScopeSchema,
  revisionSchema,
  sessionIdSchema,
  sessionLinkIdSchema,
  surfaceBindingIdSchema,
  timestampSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

// These envelopes are the internal contract between a chat adapter and the
// platform, not public API JSON, so they keep the camelCase field names of
// 03b §3 rather than the snake_case of `src/api`.

export const CHAT_ENVELOPE_VERSION = 1 as const;

export const CHAT_TRIGGER_VALUES = [
  "mention",
  "thread_reply",
  "direct_message",
] as const;
export const chatTriggerSchema = z.enum(CHAT_TRIGGER_VALUES);

/** Stable per logical event and across retries, e.g. `team:app:event`. */
export const surfaceEventIdSchema = z.string().min(1).max(256);
/** Thread identity inside a binding, e.g. Slack's `thread_ts ?? ts`. */
export const conversationKeySchema = z.string().min(1).max(128);

/**
 * One inbound message, already verified and normalised by an adapter. The
 * adapter never creates a session; it produces this and the binder decides.
 */
export const chatInboundEnvelopeSchema = z
  .object({
    version: z.literal(CHAT_ENVELOPE_VERSION),
    interfaceKind: z.string().min(1).max(32),
    installationId: installationIdSchema,
    workspaceId: workspaceIdSchema,
    eventId: surfaceEventIdSchema,
    occurredAt: timestampSchema,
    /**
     * The person who spoke. Never replaced by the app's own principal — and
     * the kinds are pinned so an adapter that swaps the two fields fails here
     * instead of handing the human service authority (03b §4.1).
     */
    actor: humanActorSchema,
    /** The installation acting on their behalf; it lends no authority of its own. */
    servicePrincipal: serviceActorSchema,
    surfaceBindingId: surfaceBindingIdSchema,
    conversationKey: conversationKeySchema,
    messageId: opaqueIdSchema,
    trigger: chatTriggerSchema,
    text: messageTextSchema,
    /** Explicit session target skips classification, never the access check. */
    target: z.object({ sessionId: sessionIdSchema }).strict().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    // The binder matches grants on the service principal, so an envelope
    // authenticated for installation A must not be able to ask for B's.
    if (envelope.servicePrincipal.id !== envelope.installationId) {
      ctx.addIssue({
        code: "custom",
        path: ["servicePrincipal"],
        message: "must be the installation the event was authenticated for",
      });
    }
  });

/** What a binder resolved: which session this conversation is, and under which release. */
export const scopedSessionBindingSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    ownerId: ownerScopeSchema,
    surfaceBindingId: surfaceBindingIdSchema,
    bindingRevision: revisionSchema,
    sessionLinkId: sessionLinkIdSchema,
    sessionId: sessionIdSchema,
    agentId: agentIdSchema,
    releaseId: agentReleaseIdSchema,
  })
  .strict();

export const CHAT_OUTBOUND_CATEGORY_VALUES = [
  "answer",
  "progress",
  "approval",
  "system",
] as const;
export const chatOutboundCategorySchema = z.enum(CHAT_OUTBOUND_CATEGORY_VALUES);

export const CHAT_CONTENT_FORMAT_VALUES = ["markdown", "plain_text"] as const;
export const chatContentSchema = z
  .object({
    format: z.enum(CHAT_CONTENT_FORMAT_VALUES),
    text: z.string(),
  })
  .strict();

/**
 * The audience captured when the intent was created. Delivery re-checks the
 * current ACL against it and sends to the intersection, so a widened channel
 * never fans an older, narrower result out (03b §3 step 6).
 */
export const chatAudienceSchema = z
  .object({
    surfaceBindingId: surfaceBindingIdSchema,
    policyRevision: revisionSchema,
    authorizedActorIds: z.array(opaqueIdSchema),
  })
  .strict();

/**
 * Where a delivery is posted. Not the same thing as `audience` (who may see
 * it) nor a session link's `visibility` (how much of the session it shows).
 */
export const CHAT_OUTBOUND_VISIBILITY_VALUES = [
  "thread",
  "channel",
  "requester_only",
] as const;
export const chatOutboundVisibilitySchema = z.enum(
  CHAT_OUTBOUND_VISIBILITY_VALUES,
);

export const chatOutboundEnvelopeSchema = z
  .object({
    deliveryId: opaqueIdSchema,
    sourceEventId: surfaceEventIdSchema,
    scope: scopedSessionBindingSchema,
    /** Who the delivery is attributed to — the app, never a human. */
    actor: serviceActorSchema,
    audience: chatAudienceSchema,
    category: chatOutboundCategorySchema,
    content: chatContentSchema,
    visibility: chatOutboundVisibilitySchema.default("thread"),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    // The other values are named so the column has its final shape, but no
    // delivery path posts outside the thread yet.
    if (envelope.visibility !== "thread") {
      ctx.addIssue({
        code: "custom",
        path: ["visibility"],
        message: "unsupported visibility",
      });
    }
    // Delivery sends to `scope`'s binding but intersects with `audience`'s
    // ACL, so two bindings would let B's actors authorise a post into A.
    if (
      envelope.audience.surfaceBindingId !== envelope.scope.surfaceBindingId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["audience", "surfaceBindingId"],
        message: "must be the binding the delivery is scoped to",
      });
    }
  });

/**
 * Mute suppresses output; it does not stop admission — that is the binding's
 * `mode: off`. Unmuting never replays what was suppressed.
 */
export const muteDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send") }).strict(),
  z
    .object({ action: z.literal("suppress"), reason: z.string().min(1) })
    .strict(),
  z
    .object({
      action: z.literal("defer"),
      until: timestampSchema,
      reason: z.string().min(1),
    })
    .strict(),
]);

export type ChatTrigger = z.infer<typeof chatTriggerSchema>;
export type ChatInboundEnvelope = z.infer<typeof chatInboundEnvelopeSchema>;
export type ScopedSessionBinding = z.infer<typeof scopedSessionBindingSchema>;
export type ChatOutboundCategory = z.infer<typeof chatOutboundCategorySchema>;
export type ChatContent = z.infer<typeof chatContentSchema>;
export type ChatAudience = z.infer<typeof chatAudienceSchema>;
export type ChatOutboundVisibility = z.infer<
  typeof chatOutboundVisibilitySchema
>;
export type ChatOutboundEnvelope = z.infer<typeof chatOutboundEnvelopeSchema>;
/** What a producer builds; `visibility` may be left to its default. */
export type ChatOutboundEnvelopeInput = z.input<
  typeof chatOutboundEnvelopeSchema
>;
export type MuteDecision = z.infer<typeof muteDecisionSchema>;
