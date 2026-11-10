import {
  DEFAULT_SURFACE_CEILING,
  type ListSlackBindingsResponse,
  type PutSlackBindingRequest,
  type PutSlackBindingResponse,
  type ResolveSlackBindingRequest,
  type ResolveSlackBindingResponse,
  SLACK_BINDING_LIST_LIMIT,
  SLACK_BINDING_MESSAGES,
  type SurfaceBinding,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  SurfaceBindingRecord,
  SurfaceBindingStore,
} from "../ports/surface-binding-store.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import type { AgentWelcomable } from "../surface/ports/agent-welcomable.ts";
import type { ChannelJoinable } from "../surface/ports/channel-joinable.ts";
import type { ChannelKindReadable } from "../surface/ports/channel-kind-readable.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "./policy.ts";

// Design 4.1's "Slack 앱 설치·채널 설정" row: `binding.manage` on the
// agent, which owner, admin and that agent's admins hold.
const ACTION = "binding.manage";
const MANAGERS: readonly WorkspaceRole[] = MANAGEMENT_ROLES[ACTION] ?? [];
const APPROVE_ACTION = "binding.approve";
const APPROVERS: readonly WorkspaceRole[] =
  MANAGEMENT_ROLES[APPROVE_ACTION] ?? [];

export function surfaceBindingView(
  record: SurfaceBindingRecord,
): SurfaceBinding {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    owner_id: record.workspaceId,
    surface: "slack",
    installation_id: record.installationId,
    external_surface_id: record.channelId,
    surface_kind: record.channelKind,
    agent_id: record.agentId,
    mode: record.mode,
    ceiling: record.ceiling,
    home: record.home,
    memory_write_policy: record.memoryWritePolicy,
    status: record.status,
    ...(record.approvedAt === null
      ? {}
      : { approved_at: record.approvedAt.toISOString() }),
    ...(record.membership === null ? {} : { membership: record.membership }),
    muted: record.muted,
    revision: record.revision,
    created_at: record.createdAt.toISOString(),
    revoked_at: record.revokedAt?.toISOString() ?? null,
  };
}

export function createSurfaceBindingService(deps: {
  authorization: AuthorizationPolicy;
  store: SurfaceBindingStore;
  channels: ChannelKindReadable;
  /** Joins a bound channel; absent where no bot token can be read. */
  join?: ChannelJoinable;
  welcome?: Pick<AgentWelcomable, "welcome">;
}) {
  const { authorization, store, channels } = deps;

  // A channel the bot cannot join yet is still bound: the binding says why,
  // and the invite, or the next save, carries on.
  async function joined(
    binding: SurfaceBindingRecord,
  ): Promise<SurfaceBindingRecord> {
    // A channel the bot left holds no bot; asking Slack would only race the
    // leave (the store ignores the answer), so the record stays as it is.
    if (binding.status === "left") return binding;
    let membership = binding.membership;
    try {
      membership = (await deps.join?.(binding)) ?? membership;
      if (binding.home && membership?.state === "joined") {
        await deps.welcome?.welcome(binding.workspaceId, binding.agentId, {
          ask: false,
        });
      }
    } catch {
      // The binding is saved; what Slack or the outbox refused is retried
      // on the next save, the invite or the next activation.
    }
    return { ...binding, membership };
  }

  const permitted = (
    caller: Caller,
    agentId: string,
    action: typeof ACTION | typeof APPROVE_ACTION = ACTION,
  ) =>
    requirePermitted(authorization, caller, action, {
      kind: "agent",
      id: agentId,
    });

  async function resolveBinding(
    caller: Caller,
    agentId: string,
    bindingId: string,
    request: ResolveSlackBindingRequest,
    decision: "approve" | "reject",
  ): Promise<ResolveSlackBindingResponse> {
    await permitted(caller, agentId, APPROVE_ACTION);
    const result = await store[decision]({
      principal: caller,
      workspaceId: caller.ownerId,
      agentId,
      bindingId,
      revision: request.revision,
      approverRoles: APPROVERS,
    });
    switch (result.outcome) {
      case "resolved":
        return {
          slack_binding: surfaceBindingView(
            decision === "approve"
              ? await joined(result.binding)
              : result.binding,
          ),
          receipt_id: result.receiptId,
        };
      case "replayed":
        return {
          slack_binding: surfaceBindingView(result.binding),
          receipt_id: null,
        };
      case "not_found":
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      case "conflict":
        throw new SessionServiceError(
          "REVISION_CONFLICT",
          SLACK_BINDING_MESSAGES.notPending,
        );
      case "outranked":
        throw new SessionServiceError(
          "FORBIDDEN",
          "The caller no longer holds this right",
          undefined,
          { reason_code: "role" },
        );
      default:
        throw new SessionServiceError(
          "FORBIDDEN",
          "This principal is no longer a member of the workspace",
        );
    }
  }

  return {
    async putSlackBinding(
      caller: Caller,
      agentId: string,
      request: PutSlackBindingRequest,
    ): Promise<PutSlackBindingResponse> {
      await permitted(caller, agentId);
      const channelKind =
        request.channel_id === null
          ? "dm"
          : await channels.kindOf(caller.ownerId, agentId, request.channel_id);
      if (request.channel_id !== null && channelKind === "dm") {
        throw new SessionServiceError(
          "BAD_REQUEST",
          SLACK_BINDING_MESSAGES.dmChannel,
        );
      }
      const result = await store.set({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        channelId: request.channel_id,
        channelKind,
        mode: request.mode,
        home: request.home,
        ceiling: request.ceiling ?? DEFAULT_SURFACE_CEILING,
        managerRoles: MANAGERS,
      });
      switch (result.outcome) {
        case "set":
          return {
            slack_binding: surfaceBindingView(await joined(result.binding)),
            receipt_id: result.receiptId,
          };
        case "agent_not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "not_installed":
          throw new SessionServiceError(
            "SLACK_NOT_INSTALLED",
            SLACK_BINDING_MESSAGES.notInstalled,
          );
        case "conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            SLACK_BINDING_MESSAGES.conflict,
          );
        case "pending_home":
          throw new SessionServiceError(
            "BAD_REQUEST",
            SLACK_BINDING_MESSAGES.pendingHome,
          );
        case "outranked":
          throw new SessionServiceError(
            "FORBIDDEN",
            "The caller no longer holds this right",
            undefined,
            { reason_code: "role" },
          );
        default:
          throw new SessionServiceError(
            "FORBIDDEN",
            "This principal is no longer a member of the workspace",
          );
      }
    },

    approveSlackBinding: (
      caller: Caller,
      agentId: string,
      bindingId: string,
      request: ResolveSlackBindingRequest,
    ) => resolveBinding(caller, agentId, bindingId, request, "approve"),

    rejectSlackBinding: (
      caller: Caller,
      agentId: string,
      bindingId: string,
      request: ResolveSlackBindingRequest,
    ) => resolveBinding(caller, agentId, bindingId, request, "reject"),

    async listSlackBindings(
      caller: Caller,
      agentId: string,
    ): Promise<ListSlackBindingsResponse> {
      await requirePermitted(authorization, caller, "agent.settings_read", {
        kind: "agent",
        id: agentId,
      });
      const rows = await store.list(
        caller.ownerId,
        agentId,
        SLACK_BINDING_LIST_LIMIT,
      );
      return { items: rows.map(surfaceBindingView) };
    },
  };
}

export type SurfaceBindingService = ReturnType<
  typeof createSurfaceBindingService
>;
