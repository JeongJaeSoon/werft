import type {
  BindingMode,
  MemoryWritePolicy,
  SurfaceBindingStatus,
  SurfaceCeiling,
  SurfaceChannelKind,
  SurfaceMembership,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/policy.ts";

export type SurfaceBindingRecord = {
  id: string;
  workspaceId: string;
  agentId: string;
  installationId: string | null;
  /** The Slack channel id; null on the install's DM binding. */
  channelId: string | null;
  channelKind: SurfaceChannelKind | null;
  mode: BindingMode;
  ceiling: SurfaceCeiling;
  home: boolean;
  memoryWritePolicy: MemoryWritePolicy;
  status: SurfaceBindingStatus;
  approvedAt: Date | null;
  /** Null until Slack was asked; always null on the DM binding. */
  membership: SurfaceMembership | null;
  muted: boolean;
  revision: number;
  createdAt: Date;
  revokedAt: Date | null;
};

export type SetSurfaceBindingResult =
  | { outcome: "set"; binding: SurfaceBindingRecord; receiptId: string }
  | { outcome: "agent_not_found" }
  // The agent has no live identity, so no install to bind a channel of.
  | { outcome: "not_installed" }
  // A concurrent write took the channel, the DM row or the home first.
  | { outcome: "conflict" }
  | { outcome: "pending_home" }
  | { outcome: "actor_inactive" }
  | { outcome: "outranked" };

export type ResolveSurfaceBindingInput = {
  principal: Principal;
  workspaceId: string;
  agentId: string;
  bindingId: string;
  revision: number;
  approverRoles: readonly WorkspaceRole[];
};

export type ResolveSurfaceBindingResult =
  | { outcome: "resolved"; binding: SurfaceBindingRecord; receiptId: string }
  | { outcome: "replayed"; binding: SurfaceBindingRecord }
  | { outcome: "not_found" }
  | { outcome: "conflict" }
  | { outcome: "actor_inactive" }
  | { outcome: "outranked" };

export interface SurfaceBindingStore {
  /**
   * Replaces the live binding of one channel of the agent's install, or its
   * DM binding when `channelId` is null, and moves the agent's home here
   * when `home` is set. Re-reads the caller's right in the same transaction
   * and writes a `set_surface_binding` receipt. A private channel not yet
   * bound, or bound as a public one, waits for approval
   * (`request_surface_binding` receipt); one already approved stays so.
   */
  set(input: {
    principal: Principal;
    workspaceId: string;
    agentId: string;
    channelId: string | null;
    channelKind: SurfaceChannelKind;
    mode: BindingMode;
    home: boolean;
    ceiling: SurfaceCeiling;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<SetSurfaceBindingResult>;
  /** The agent's live bindings, home first, then oldest first. */
  list(
    workspaceId: string,
    agentId: string,
    limit: number,
  ): Promise<SurfaceBindingRecord[]>;
  /**
   * The live binding of a channel of an install, or of its DMs when
   * `channelId` is null. Read for every event; never cached.
   */
  resolveSlackChannel(
    installationId: string,
    channelId: string | null,
  ): Promise<SurfaceBindingRecord | null>;
  /**
   * The install's DM binding, made on its first DM when it has none
   * (`mention`, the default ceiling, no receipt: no person set it). Two
   * first DMs at once make one row. Null when the install has no live agent
   * identity or its DM row is not ready.
   */
  ensureDmBinding(installationId: string): Promise<SurfaceBindingRecord | null>;
  /**
   * The live binding of a channel the install's bot was invited to, made
   * when it has none (in use with the agent's default mode, the default
   * ceiling, `joined`; a private channel starts `pending_approval`, with a
   * `request_surface_binding` receipt for the installation, since no person
   * set it). A binding already there is returned as it is whatever its
   * status, so a channel someone switched off stays off. Null when the
   * install has no live agent identity.
   */
  ensureInvitedChannel(
    installationId: string,
    channelId: string,
    channelKind: "public_channel" | "private_channel",
  ): Promise<SurfaceBindingRecord | null>;
  /**
   * The live binding of a channel whatever its status, for the membership
   * record and the receive-time privacy guard; input is only ever resolved
   * through `resolveSlackChannel`.
   */
  findLiveSlackChannel(
    installationId: string,
    channelId: string,
  ): Promise<SurfaceBindingRecord | null>;
  /**
   * Whether the channel's last binding was a private one rejected before it
   * was ever approved; for a channel with no live binding.
   */
  wasRejected(installationId: string, channelId: string): Promise<boolean>;
  /**
   * The binding of a private channel that waits for approval, or null.
   * `revision` changes every time it waits again, so a notice can be sent
   * once per wait.
   */
  findPendingApproval(
    installationId: string,
    channelId: string,
  ): Promise<{ id: string; revision: number } | null>;
  /**
   * A ready binding set for a public channel whose channel Slack now says
   * is private: kind `private_channel`, `pending_approval`, no longer home,
   * a `request_surface_binding` receipt for the installation. Null when
   * the binding is no longer ready.
   */
  requireApproval(bindingId: string): Promise<SurfaceBindingRecord | null>;
  /**
   * Notes that Slack reported a join of the bot to a channel at `at`
   * (microseconds since the epoch). False when a later join or leave of that
   * channel was already noted, so the join is old news and must change
   * nothing. An equal time passes, since a retried event runs its effect
   * again. A null `at` (no time in the event) cannot be ordered and passes
   * without being noted.
   * Also, before any Slack call: a join newer than anything noted (or with no
   * time) of an approved private channel recorded as `joined` means a leave was
   * missed (Slack sends no join to a member), so the binding waits for approval
   * again at once, as after a leave; mentions are not served until the late
   * leave arrives.
   */
  observeLifecycle(
    installationId: string,
    channelId: string,
    at: number | null,
  ): Promise<boolean>;
  /**
   * The join's last write: the binding's membership becomes `joined`, in one
   * transaction with the order check of `observeLifecycle`, so a leave noted
   * after the join was first seen is not overwritten. False, and nothing
   * written, when the join has been overtaken. A `left` binding goes to
   * `pending_approval` here (reason `rejoined_channel`) only for a join
   * stamped strictly after the last noted leave; a tie, or a join with no
   * time, cannot be ordered against that leave, so the binding stays `left`
   * and the call is false.
   */
  recordJoin(
    installationId: string,
    channelId: string,
    bindingId: string,
    at: number | null,
  ): Promise<boolean>;
  /**
   * The bot left a channel, or was removed from it, at `at`. When this is
   * the newest event noted for the channel, a private channel's `ready` or
   * `pending_approval` binding becomes `left`: inactive (no input, nothing
   * sent), no longer home, its approval cleared, membership
   * `awaiting_invite`, a `set_surface_binding` receipt (reason
   * `bot_left_channel`) for the installation; its mode and ceiling stay. A
   * binding already `left` is not written again. A leave older than a noted
   * join means the bot is back in: the binding is not `left`, and a `ready`
   * one waits for approval (`request_surface_binding`) unless its approval
   * already knew of this leave (`at` not after the newest event noted when
   * it was given). A public channel's binding is left alone. False when the
   * leave is older than a noted event.
   */
  botLeft(
    installationId: string,
    channelId: string,
    at: number | null,
  ): Promise<boolean>;
  approve(
    input: ResolveSurfaceBindingInput,
  ): Promise<ResolveSurfaceBindingResult>;
  reject(
    input: ResolveSurfaceBindingInput,
  ): Promise<ResolveSurfaceBindingResult>;
  /**
   * Records what Slack said about the bot's place in a live binding's
   * channel. Observed state, not a setting: no revision, no receipt.
   * With `expected`, only while the binding still holds it, so a slow
   * answer does not undo an invite recorded meanwhile.
   */
  setMembership(
    bindingId: string,
    membership: SurfaceMembership,
    expected?: SurfaceMembership | null,
  ): Promise<void>;
}
