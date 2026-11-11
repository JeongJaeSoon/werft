import { z } from "zod";

import { credentialRefSchema } from "../kollegium/agents.ts";
import {
  agentIdSchema,
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";

/**
 * What a requester whose session could not start reads:
 * no credential names, which are the admins' to fix, only who to ask.
 */
export const CREDENTIAL_UNBOUND_GUIDANCE =
  "연결 설정이 바뀌어 시작하지 못했어요. 에이전트 관리자에게 문의하세요";

export const agentContactSchema = z
  .object({
    user_id: userIdSchema,
    display_name: z.string(),
    email: z.string(),
  })
  .strict();

/**
 * `details` of a 409 CREDENTIAL_UNBOUND from POST /v1/sessions and from a
 * message appended to a session whose release lost a binding.
 */
export const sessionCredentialUnboundDetailsSchema = z
  .object({
    reason_code: z.literal("credential_unbound"),
    guidance: z.literal(CREDENTIAL_UNBOUND_GUIDANCE),
    agent_id: agentIdSchema,
    /** The failed create_session or append_message receipt of the refusal. */
    receipt_id: receiptIdSchema,
    /** The agent's admins, or its workspace's owners and admins when none is left. */
    admins: z.array(agentContactSchema),
    /** A `mailto:` link to every admin above; null when there is no one. */
    admin_link: z.string().nullable(),
  })
  .strict();

/** `details` of a 409 CREDENTIAL_UNBOUND from activation: the missing names. */
export const activationCredentialUnboundDetailsSchema = z
  .object({
    reason_code: z.literal("credential_unbound"),
    missing: z.array(credentialRefSchema).min(1),
  })
  .strict();

export type SessionCredentialUnboundDetails = z.infer<
  typeof sessionCredentialUnboundDetailsSchema
>;
export type ActivationCredentialUnboundDetails = z.infer<
  typeof activationCredentialUnboundDetailsSchema
>;

/**
 * What the unbind screen says beside the running count: unbinding stops the
 * next session and the next message of a running one at once, and a
 * running session's remote MCP calls within 30 seconds. A call already
 * sent still finishes, and the value's owner is the one who can revoke it.
 */
export const CREDENTIAL_REVOKE_NOTICE =
  "해제하면 실행 중인 세션도 다음 메시지부터 막히고, 원격 MCP 호출은 30초 안에 끊겨요. 이미 보낸 호출은 끝까지 실행되니 값 자체는 외부 서비스에서 폐기하세요";

export const credentialBindingIdSchema = z.uuid();

export const credentialBindingSchema = z
  .object({
    id: credentialBindingIdSchema,
    agent_id: agentIdSchema,
    credential_ref: credentialRefSchema,
    bound_by: userIdSchema,
    bound_at: timestampSchema,
    revoked_at: timestampSchema.nullable(),
    /** Sessions on this agent's releases that name it and have not closed. */
    running_sessions: z.number().int().nonnegative(),
  })
  .strict();

export const credentialBindingParamsSchema = z
  .object({ id: agentIdSchema, binding_id: credentialBindingIdSchema })
  .strict();

export const listCredentialBindingsResponseSchema = z
  .object({
    items: z.array(credentialBindingSchema),
    revoke_notice: z.literal(CREDENTIAL_REVOKE_NOTICE),
  })
  .strict();

export const createCredentialBindingRequestSchema = z
  .object({ credential_ref: credentialRefSchema })
  .strict();

/** `created: false` and a null receipt when the name was bound already. */
export const createCredentialBindingResponseSchema = z
  .object({
    binding: credentialBindingSchema,
    created: z.boolean(),
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

export const revokeCredentialBindingResponseSchema = z
  .object({
    binding: credentialBindingSchema,
    revoke_notice: z.literal(CREDENTIAL_REVOKE_NOTICE),
    receipt_id: receiptIdSchema,
  })
  .strict();

export type CredentialBindingView = z.infer<typeof credentialBindingSchema>;
export type ListCredentialBindingsResponse = z.infer<
  typeof listCredentialBindingsResponseSchema
>;
export type CreateCredentialBindingRequest = z.infer<
  typeof createCredentialBindingRequestSchema
>;
export type CreateCredentialBindingResponse = z.infer<
  typeof createCredentialBindingResponseSchema
>;
export type RevokeCredentialBindingResponse = z.infer<
  typeof revokeCredentialBindingResponseSchema
>;
