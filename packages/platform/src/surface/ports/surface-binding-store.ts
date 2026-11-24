import type {
  BindingListen,
  BindingMode,
  MemoryWritePolicy,
  SessionShareScope,
  SurfaceBindingStatus,
  SurfaceCeiling,
  SurfaceChannelKind,
  SurfaceMembership,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { Principal } from "../../musterrolle/index.ts";

/** A Slack channel some agent's linked sessions came from. */
export type ChannelSessionPlace = {
  workspaceId: string;
  agentId: string;
  installationId: string;
  teamId: string;
  channelId: string;
};

/** What Slack says a channel is now. */
export type ChannelKindNow = "public_channel" | "private_channel";

/** What `kindNow` may read inside the move, under its lock on the channel. */
export type ChannelKindInside = {
  /**
   * The kind the channel's bindings record, as the private channel's door
   * reads them; null when none knows it.
   */
  bindingKind(): Promise<ChannelKindNow | null>;
};

/**
 * Why a session of a private channel is not moved: its channel's
 * conversation cannot be decided (the link names no usable channel, or the
 * session's parent is another conversation), or it has no workspace to
 * share in, or its share changed while it was being moved (run again).
 */
export type ChannelSessionSkip =
  | "no_channel_conversation"
  | "no_workspace"
  | "share_changed";

export type ChannelScopeMove = {
  sessionId: string;
  from: SessionShareScope;
  to: SessionShareScope;
};

/** How a channel's sessions follow its kind (answer 15, 94S-2001). */
export type ChannelScopePlan = {
  moves: ChannelScopeMove[];
  /** Narrowed to their creator: kept private, never widened to the channel. */
  keptPrivate: string[];
  unchanged: string[];
  skipped: { sessionId: string; reason: ChannelSessionSkip }[];
};

export type ChannelKindChanged = ChannelScopePlan & {
  binding: "now_private" | "now_public" | "unchanged";
};

/**
 * Who changed a channel's kind. With it, every session the move writes gets a
 * `share_session` receipt in the move's transaction, and the binding's
 * receipt carries the same `ref`.
 */
export type ChannelScopeChange = {
  /** The operator's run (`run_id`) or the Slack event (`event_id`). */
  ref: { run_id: string } | { event_id: string };
  reason: "operator_private_channel_migration" | "slack_channel_converted";
  by: "operator_cli" | "slack_event";
  /** Read after `kindNow`: the kind did not come from Slack (no install or no bot token). */
  noInstall(): boolean;
  /**
   * How many people stop seeing each of the channel's sessions if narrowed,
   * read in the move's transaction (`tx`, the store's database handle) after
   * the sessions are locked and before the binding or a share is written.
   * Null when it is not checked; the receipts then say null.
   */
  peopleLosing:
    | ((
        tx: unknown,
        sessionIds: readonly string[],
      ) => Promise<ReadonlyMap<string, number> | null>)
    | null;
};

export type SurfaceBindingRecord = {
  id: string;
  workspaceId: string;
  agentId: string;
  installationId: string | null;
  /** The Slack channel id; null on the install's DM binding. */
  channelId: string | null;
  channelKind: SurfaceChannelKind | null;
  mode: BindingMode;
  listen: BindingListen;
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
    /** Absent keeps the channel's; a new channel then listens to all. */
    listen?: BindingListen;
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
   * written, when the join has been overtaken. A `left` or `gone` binding
   * goes to `pending_approval` (a public `gone` one to `ready`) here (reason `rejoined_channel`) only for a join
   * stamped strictly after the last noted leave; a tie, or a join with no
   * time, cannot be ordered against that leave, so the binding stays `left`
   * and the call is false. `kind` is what Slack says the channel is now: a
   * public `gone` binding whose channel turned private waits for approval as
   * a private channel (reason `channel_now_private`) instead.
   */
  recordJoin(
    installationId: string,
    channelId: string,
    bindingId: string,
    at: number | null,
    kind?: "public_channel" | "private_channel",
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
   * it was given). A public channel's binding keeps its status and approval;
   * its membership becomes `awaiting_invite` when the leave is the newest
   * event noted. False when the leave is older than a noted event.
   */
  botLeft(
    installationId: string,
    channelId: string,
    at: number | null,
  ): Promise<boolean>;
  /**
   * What the channel is now, as `kindNow` asks Slack inside the transaction
   * after a lock on the channel, so of two conversions racing the later read
   * is the one written (a conversion event, or the operator command). Null
   * when `kindNow` cannot tell: nothing changes. In one transaction: a live
   * binding still of the other kind follows, a public one turned private waiting for
   * approval (reason `channel_now_private`), a private one turned public
   * ready (a `left` one stays, its kind checked by the table); then the
   * channel's sessions follow (`ChannelScopePlan`). Running it again with
   * the same kind changes nothing. A failed receipt write undoes it all.
   */
  channelKindChanged(
    place: ChannelSessionPlace,
    kindNow: (inside: ChannelKindInside) => Promise<ChannelKindNow | null>,
    change?: ChannelScopeChange,
  ): Promise<ChannelKindChanged | null>;
  /**
   * Slack deleted the channel (`channel_deleted`, `group_deleted`) at `at`.
   * Its `ready`, `pending_approval` or `left` binding becomes `gone`:
   * inactive, no longer home, its approval cleared, a `set_surface_binding`
   * receipt (reason `channel_deleted`); mode, ceiling and kind stay. The
   * deletion is noted as the channel's leave whatever its order, so a join
   * stamped before it changes nothing; a join noted after it (a retried
   * deletion arriving late) keeps the binding as that join left it. Every
   * deletion but that late one also deletes the channel's summary, with its
   * history, whatever the binding. False when no binding changed.
   */
  channelDeleted(
    installationId: string,
    channelId: string,
    at: number | null,
  ): Promise<boolean>;
  /**
   * Slack answered `channel_not_found` for a bound channel. A public
   * channel is visible to a bot outside it, so its binding becomes `gone`.
   * A private channel hides from a bot outside it, deleted or not: a `ready`
   * binding recorded as `joined` becomes `left`, as if its `group_left`
   * was lost, and any other one stays. Both are noted as a leave with no
   * time. Receipts say `channel_not_found`. `askedAt` is when the caller
   * asked Slack, in microseconds: a join noted after it means the bot came in
   * since, so the answer is out of date, nothing changes and the result is
   * `stale`; the caller records nothing from that answer either.
   */
  channelNotFound(
    installationId: string,
    channelId: string,
    askedAt?: number,
  ): Promise<"gone" | "left" | "unchanged" | "stale">;
  /**
   * Whether the newest join or leave noted for the channel is a leave (a
   * tie counts as the leave, as in `recordJoin`). The channel's event record,
   * not the binding's membership, which a later Slack answer or error writes
   * over. False for a channel with nothing noted.
   */
  botRemovedFrom(installationId: string, channelId: string): Promise<boolean>;
  /**
   * The time of the newest leave noted for the channel, null when none: read
   * before Slack is asked, it is the mark `setMembership` checks the answer
   * against.
   */
  lastLeaveNoted(
    installationId: string,
    channelId: string,
  ): Promise<number | null>;
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
   * answer does not undo an invite recorded meanwhile. With `leaveNoted`
   * (`lastLeaveNoted` before Slack was asked), only while no newer leave was
   * noted: a leave can leave the membership as it was, and the value alone
   * would not show it.
   */
  setMembership(
    bindingId: string,
    membership: SurfaceMembership,
    expected?: SurfaceMembership | null,
    leaveNoted?: number | null,
  ): Promise<void>;
}
