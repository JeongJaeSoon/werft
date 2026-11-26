import { useMutation, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@werft-ai/client";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Code,
  CopyButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Input,
  Link,
  NativeSelect,
  NativeSelectOption,
  RowAction,
  RowList,
  RowListItem,
  SettingRow,
  SettingsSection,
  Skeleton,
  Switch,
  Text,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import {
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useHasPermission } from "../../../auth/guard.tsx";
import { useManagesAgent } from "../../../components/agent-access.tsx";
import { LoadFailure } from "../../../components/load-failure.tsx";
import type { Notify } from "../../../components/toast.tsx";
import { type MessageKey, useI18n } from "../../../i18n/i18n.tsx";
import { reasonCodeOf } from "../../workspace-slack.tsx";
import type { SlackApp } from "./actions.ts";
import { Outcome, RecheckButton, RecheckError } from "./app.tsx";
import {
  EmergencyStopDialog,
  EmergencyStopLine,
  type EmergencyStopTarget,
} from "./emergency-stop.tsx";
import {
  slackKey,
  useSlackBindings,
  useSlackChannels,
  useSlackNotice,
} from "./queries.ts";
import {
  type Binding,
  type BindingChange,
  eventSubscriptionsUrl,
  SECTION,
  SECTION_TARGET,
  slackFailure,
  slackReason,
} from "./shared.ts";

/**
 * The server joins a public channel once its response is on, so a private
 * channel waits for `/invite`, and a public one only after a person removed
 * the bot from it. The binding's membership wins; a channel not bound or
 * not checked yet falls back to the channel list.
 */
function awaitsInvite(
  binding: Binding | undefined,
  listed: { readonly private?: boolean; readonly member: boolean } | undefined,
): boolean {
  if (binding?.membership)
    return binding.membership.state === "awaiting_invite";
  const isPrivate = binding
    ? binding.surface_kind === "private_channel"
    : listed?.private;
  return Boolean(isPrivate && listed && !listed.member);
}

/** Copies the `/invite` line for a channel the bot has not joined. */
function InviteCopy({
  command,
  notify,
}: {
  readonly command: string;
  readonly notify: Notify;
}) {
  const { t } = useI18n();
  const [manual, setManual] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (manual) field.current?.focus();
  }, [manual]);
  return (
    <>
      <CopyButton
        value={command}
        variant="ghost"
        size="sm"
        className="h-5 min-w-5 px-1"
        aria-label={t("slack.copyInvite")}
        title={command}
        icon="copy"
        iconClassName="size-3.5 shrink-0"
        fallbackField={field}
        onResult={(ok) => {
          setManual(!ok);
          notify(t(ok ? "slack.copied" : "slack.copyFailed"));
        }}
      />
      {manual ? (
        <Input
          ref={field}
          readOnly
          value={command}
          size={command.length}
          aria-label={t("slack.inviteCommand")}
          className="h-6 w-auto px-2 font-mono text-caption"
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : null}
    </>
  );
}

const LISTEN_LABEL = {
  free: "slack.listen.free",
  mention: "slack.listen.mention",
  off: "slack.listen.off",
} as const satisfies Record<Binding["listen"], MessageKey>;

function VisibilityBadge({ isPrivate }: { readonly isPrivate: boolean }) {
  const { t } = useI18n();
  return (
    <Badge variant={isPrivate ? "gray" : "green"}>
      {t(isPrivate ? "slack.private" : "slack.public")}
    </Badge>
  );
}

// A Slack channel name has no break point, so a long one must be allowed to
// break anywhere or it runs under the tag in the right column.
function ChannelName({ children }: { readonly children: string }) {
  return <span className="[overflow-wrap:anywhere]">{children}</span>;
}

function ChannelSkeleton() {
  const { t } = useI18n();
  return (
    <RowList
      variant="joined"
      framed={false}
      aria-busy="true"
      aria-label={t("slack.channelsLoading")}
    >
      {["first", "second"].map((key) => (
        <RowListItem key={key}>
          <div className="flex min-h-[calc(1.25rem+var(--werft-row-line-gap)+1rem)] w-full items-center">
            <Skeleton
              lines={2}
              className="w-full"
              label={t("slack.channelsLoading")}
            />
          </div>
        </RowListItem>
      ))}
    </RowList>
  );
}

export function SlackChannels({
  agentId,
  invite,
  notify,
  homeStep = false,
  slack,
  lockedApp = null,
  canRecheck = false,
  installed = true,
}: {
  readonly agentId: string;
  /** The line to paste in a channel to add the bot. */
  readonly invite: string;
  readonly notify: Notify;
  /** Installed with no home yet: only picking the home is offered. */
  readonly homeStep?: boolean;
  /** The app's actions, for the lock's Recheck. */
  readonly slack: SlackApp;
  /**
   * The Slack app ID while Slack has not checked its Request URL, so no
   * channel would hear the bot. The lock is the tab's one notice of it.
   */
  readonly lockedApp?: string | null;
  /** This viewer may recheck: the address section offers it too. */
  readonly canRecheck?: boolean;
  /**
   * An active bot to invite. After a disconnect the tab keeps its layout,
   * but `/invite` would add a bot that hears nothing.
   */
  readonly installed?: boolean;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const key = slackKey(client, agentId);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickHome, setPickHome] = useState(false);
  const pickerOpener = useRef<HTMLButtonElement | null>(null);
  const lockAction = useRef<HTMLDivElement>(null);
  const locked = lockedApp !== null;
  // Said only once the switch is known to be off, so it never flashes on load.
  const switchOff = useSlackNotice(agentId).data?.rollout === "off";
  // A lock that arrives with the picker open closes it.
  useEffect(() => {
    if (locked) setPicking(false);
  }, [locked]);
  const [notice, setNotice] = useState("");
  const [stopTarget, setStopTarget] = useState<EmergencyStopTarget>(null);
  const [names, setNames] = useState<
    Record<string, { readonly name: string; readonly member: boolean }>
  >({});
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);
  const manages = useManagesAgent();
  const bindings = useSlackBindings(agentId);
  const channels = useSlackChannels(agentId, query, manages);
  const update = useMutation({
    onMutate: () => setNotice(""),
    mutationFn: ({ body }: BindingChange) =>
      unwrap(
        client.PUT("/v1/agents/{id}/slack-bindings", {
          params: { path: { id: agentId } },
          body,
        }),
      ),
    onSuccess: async (result, change) => {
      if (change.kind === "connect") notify(t("slack.channelConnected"));
      else
        setNotice(
          t(
            change.kind === "home"
              ? "slack.homeSaved"
              : change.kind === "cap"
                ? "slack.capSaved"
                : change.kind !== "listen"
                  ? "slack.saved"
                  : (result.dropped_buffered ?? 0) > 0
                    ? "slack.listenSavedDropped"
                    : "slack.listenSaved",
          ),
        );
      setPicking(false);
      await cache.invalidateQueries({ queryKey: [...key, "bindings"] });
    },
    onError: (failure, change) => {
      // The picker's FieldError already announces it.
      if (change.kind === "connect")
        notify(slackFailure(failure, t), { silent: true });
    },
  });
  // The server lets only a workspace owner or admin approve, not an agent's admin.
  const canApprove = useHasPermission("binding.approve");
  const approve = useMutation({
    onMutate: () => setNotice(""),
    mutationFn: (row: Binding) =>
      unwrap(
        client.POST("/v1/agents/{id}/slack-bindings/{binding_id}/approve", {
          params: { path: { id: agentId, binding_id: row.id } },
          body: { revision: row.revision },
        }),
      ),
    onSuccess: () => notify(t("slack.approved")),
    // A conflict means the row moved (left, approved elsewhere): show it as it is.
    onSettled: () =>
      cache.invalidateQueries({ queryKey: [...key, "bindings"] }),
  });
  const refusalId = useId();
  const refusedRow = update.isError ? update.variables?.row : undefined;
  const rows =
    bindings.data?.items.filter((row) => row.surface_kind !== "dm") ?? [];
  const listed = [
    ...new Map(
      channels.data?.pages.flatMap((page) =>
        page.items.map((item) => [item.id, item] as const),
      ) ?? [],
    ).values(),
  ];
  useEffect(() => {
    if (!channels.data) return;
    setNames((previous) => ({
      ...previous,
      ...Object.fromEntries(
        channels.data.pages.flatMap((page) =>
          page.items.map((item) => [
            item.id,
            { name: item.name, member: item.is_member },
          ]),
        ),
      ),
    }));
  }, [channels.data]);
  const readError = bindings.error ?? channels.error;
  const connectChannel = (channelId: string) => {
    if (locked) return;
    const row = rows.find((item) => item.external_surface_id === channelId);
    update.mutate({
      kind: pickHome ? "home" : "connect",
      body: {
        channel_id: channelId,
        // The first home is always in use, even a channel someone switched off.
        mode: row && !homeStep ? row.mode : "on",
        home: pickHome || (row?.home ?? false),
        ...(row ? { ceiling: row.ceiling } : {}),
      },
    });
  };
  const change = (row: Binding, mode: Binding["mode"], name: string) => {
    // Turning a stopped channel on again asks why, for the audit.
    if (mode === "on" && row.emergency_stop && !locked) {
      setStopTarget({ kind: "resume", row, name });
      return;
    }
    if (!update.isPending && !locked)
      update.mutate({
        kind: "reaction",
        body: {
          channel_id: row.external_surface_id,
          mode,
          home: row.home,
          ceiling: row.ceiling,
        },
      });
  };
  // The one write that carries `listen`: every other one leaves it out, so a
  // channel the server moved to mention is never put back to free.
  const changeListen = (
    row: Binding,
    name: string,
    listen: Binding["listen"],
  ) => {
    if (update.isPending || locked || listen === row.listen) return;
    update.mutate({
      kind: "listen",
      row: { id: row.id, name },
      body: {
        channel_id: row.external_surface_id,
        mode: row.mode,
        listen,
        home: row.home,
        ceiling: row.ceiling,
      },
    });
  };
  /** False when nothing was sent: the input goes back to the saved value. */
  const changeCap = (row: Binding, name: string, cap: number) => {
    if (update.isPending || locked || cap === row.m1_judgments_per_hour)
      return false;
    update.mutate({
      kind: "cap",
      row: { id: row.id, name },
      body: {
        channel_id: row.external_surface_id,
        mode: row.mode,
        m1_judgments_per_hour: cap,
        home: row.home,
        ceiling: row.ceiling,
      },
    });
    return true;
  };
  const actions =
    // Until the bindings load, it is not known which step this is.
    bindings.isPending || !manages || locked ? null : (
      <>
        <Button
          type="button"
          variant={homeStep ? "default" : "outline"}
          size="sm"
          onClick={(event) => {
            pickerOpener.current = event.currentTarget;
            setPickHome(true);
            setPicking(true);
          }}
        >
          {t(homeStep ? "slack.pickHome" : "slack.setHome")}
        </Button>
        {homeStep ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(event) => {
              pickerOpener.current = event.currentTarget;
              setPickHome(false);
              setPicking(true);
            }}
          >
            <Plus aria-hidden="true" strokeWidth={1.5} />
            {t("slack.addChannel")}
          </Button>
        )}
      </>
    );
  const empty = !homeStep && bindings.isSuccess && rows.length === 0;
  return (
    <>
      <SettingsSection
        id={SECTION.channels}
        tabIndex={-1}
        className={SECTION_TARGET}
        titleAs="h3"
        title={t(homeStep ? "slack.homeStep" : "slack.connectedChannels")}
        description={
          <>
            {homeStep ? <p className="m-0">{t("slack.homeStepHint")}</p> : null}
            {/* A channel's replies follow no session sharing (agent-rbac (b)). */}
            <p className="m-0">{t("slack.channelsAudience")}</p>
            {switchOff ? <p className="m-0">{t("slack.listenHint")}</p> : null}
          </>
        }
        actions={actions}
        box={empty && !locked}
        rows={
          manages && installed ? (
            <InviteRow command={invite} notify={notify} />
          ) : undefined
        }
      >
        {/* Outside the lock: "verified" is said after the lock has gone. */}
        <Outcome slack={slack} at="channels" />
        {locked ? (
          <ChannelsLock
            appId={lockedApp}
            slack={canRecheck ? slack : null}
            action={lockAction}
          />
        ) : (
          <div className="flex min-w-0 flex-col gap-[var(--werft-space-block)]">
            <output
              aria-live="polite"
              className={notice ? "text-control" : "sr-only"}
            >
              {notice}
            </output>
            {/* The card above reports a failed bindings read. */}
            {channels.error ? (
              <LoadFailure
                error={channels.error}
                guidance={slackReason(channels.error, t)}
                kept={channels.data !== undefined}
                onRetry={() => void channels.refetch()}
              />
            ) : null}
            {update.error ? (
              <div>
                <FieldError id={refusalId}>
                  {refusedRow && update.variables?.kind === "cap"
                    ? t("slack.capFailed", {
                        channel: refusedRow.name,
                        reason: slackFailure(update.error, t),
                      })
                    : refusedRow
                      ? t(
                          reasonCodeOf(update.error) ===
                            "external_shared_channel"
                            ? "slack.listenExternalShared"
                            : "slack.listenFailed",
                          {
                            channel: refusedRow.name,
                            reason: slackFailure(update.error, t),
                          },
                        )
                      : slackFailure(update.error, t)}
                </FieldError>
              </div>
            ) : null}
            {/* FieldError is an alert, so a failed approval is announced too. */}
            {approve.error ? (
              <div>
                <FieldError>{slackFailure(approve.error, t)}</FieldError>
              </div>
            ) : null}
            {homeStep ? null : bindings.isPending ? (
              <ChannelSkeleton />
            ) : bindings.isError && !bindings.data ? null : empty ? (
              <div className="flex flex-col gap-1">
                <Text weight="medium">{t("slack.noConnectedChannels")}</Text>
                <Text variant="sub">{t("slack.addChannelHint")}</Text>
              </div>
            ) : (
              <GridTable
                aria-label={t("slack.connectedChannels")}
                columns={COLUMNS}
                align={["start", "start", "end", "end"]}
                framed
              >
                <GridTableHeader>
                  <GridTableColumnHeader>
                    {t("slack.channelColumn")}
                  </GridTableColumnHeader>
                  <GridTableColumnHeader>
                    {t("slack.listenColumn")}
                  </GridTableColumnHeader>
                  <GridTableColumnHeader>
                    {t("slack.capColumn")}
                  </GridTableColumnHeader>
                  <GridTableColumnHeader>
                    {t("slack.useColumn")}
                  </GridTableColumnHeader>
                </GridTableHeader>
                {rows.map((row) => {
                  const known = row.external_surface_id
                    ? names[row.external_surface_id]
                    : undefined;
                  const name =
                    row.surface_kind === "dm"
                      ? t("slack.dm")
                      : known
                        ? `#${known.name}`
                        : t("slack.channelId", {
                            id: row.external_surface_id ?? "",
                          });
                  const meta =
                    row.status === "gone" ? (
                      <Text as="span" variant="sub">
                        {t("slack.goneHint")}
                      </Text>
                    ) : row.status === "left" ? (
                      <span className="flex flex-wrap items-center gap-1">
                        <Text as="span" variant="sub">
                          {t("slack.leftHint")}
                        </Text>
                        <InviteCopy command={invite} notify={notify} />
                      </span>
                    ) : row.status === "pending_approval" ? (
                      <Text as="span" variant="sub">
                        {t("slack.pendingApprovalHint")}
                      </Text>
                    ) : row.emergency_stop ? (
                      <EmergencyStopLine row={row} />
                    ) : awaitsInvite(row, known) ? (
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge variant="gray">{t("slack.privateInvite")}</Badge>
                        <InviteCopy command={invite} notify={notify} />
                      </span>
                    ) : null;
                  return (
                    <GridTableRow key={row.id}>
                      <GridTableCell className="py-3">
                        <div className="flex min-w-0 flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Text as="span" weight="medium">
                              <ChannelName>{name}</ChannelName>
                            </Text>
                            {row.surface_kind === "dm" ? null : (
                              <VisibilityBadge
                                isPrivate={
                                  row.surface_kind === "private_channel"
                                }
                              />
                            )}
                            {row.home ? (
                              <Badge variant="gray">{t("slack.home")}</Badge>
                            ) : null}
                            {row.emergency_stop ? (
                              <Badge variant="red">
                                {t("slack.emergencyStop.badge")}
                              </Badge>
                            ) : null}
                            {row.status === "pending_approval" ? (
                              <Badge variant="amber">
                                {t("slack.pendingApproval")}
                              </Badge>
                            ) : row.status === "left" ? (
                              <Badge variant="red">{t("slack.left")}</Badge>
                            ) : row.status === "gone" ? (
                              <Badge variant="red">{t("slack.gone")}</Badge>
                            ) : null}
                          </div>
                          {meta}
                        </div>
                      </GridTableCell>
                      <GridTableCell>
                        {manages &&
                        row.status !== "left" &&
                        row.status !== "gone" ? (
                          <span className="flex items-center gap-2">
                            <NativeSelect
                              size="sm"
                              // In a table the select's w-full squeezes it to one character.
                              className="w-auto"
                              aria-label={t("slack.listenOf", {
                                channel: name,
                              })}
                              value={row.listen}
                              aria-disabled={update.isPending}
                              aria-invalid={refusedRow?.id === row.id}
                              aria-describedby={
                                refusedRow?.id === row.id
                                  ? refusalId
                                  : undefined
                              }
                              onChange={(event) =>
                                changeListen(
                                  row,
                                  name,
                                  event.target.value as Binding["listen"],
                                )
                              }
                            >
                              {BINDING_LISTEN.map((value) => (
                                <NativeSelectOption key={value} value={value}>
                                  {t(LISTEN_LABEL[value])}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                            {refusedRow?.id === row.id ? (
                              <Badge variant="red">
                                {t("slack.listenRefused")}
                              </Badge>
                            ) : null}
                          </span>
                        ) : (
                          <Text as="span" variant="sub">
                            {t(LISTEN_LABEL[row.listen])}
                          </Text>
                        )}
                      </GridTableCell>
                      <GridTableCell>
                        {manages &&
                        row.status !== "left" &&
                        row.status !== "gone" ? (
                          <CapInput
                            key={`${row.id}:${row.m1_judgments_per_hour}`}
                            value={row.m1_judgments_per_hour}
                            label={t("slack.capOf", { channel: name })}
                            busy={update.isPending}
                            refused={
                              refusedRow?.id === row.id &&
                              update.variables?.kind === "cap"
                            }
                            describedBy={
                              refusedRow?.id === row.id ? refusalId : undefined
                            }
                            onSave={(cap) => changeCap(row, name, cap)}
                          />
                        ) : (
                          <Text
                            as="span"
                            variant="sub"
                            className="tabular-nums"
                          >
                            {row.m1_judgments_per_hour}
                          </Text>
                        )}
                      </GridTableCell>
                      <GridTableCell>
                        {
                          // A left or gone binding takes no input and sends
                          // nothing, so a switch that reads "on" would be a lie.
                          row.status === "left" || row.status === "gone" ? (
                            <Text as="span" variant="sub">
                              {t("slack.inactive")}
                            </Text>
                          ) : manages ? (
                            <>
                              {row.status === "pending_approval" &&
                              canApprove ? (
                                <RowAction
                                  aria-label={t("slack.approveChannel", {
                                    channel: name,
                                  })}
                                  disabled={approve.isPending}
                                  onClick={() => approve.mutate(row)}
                                >
                                  {t("slack.approve")}
                                </RowAction>
                              ) : null}
                              <Switch
                                aria-label={t("slack.inUseOf", {
                                  channel: name,
                                })}
                                checked={row.mode !== "off"}
                                aria-disabled={update.isPending}
                                onCheckedChange={(checked) =>
                                  change(row, checked ? "on" : "off", name)
                                }
                              />
                              {row.emergency_stop ? null : (
                                <RowAction
                                  aria-label={t(
                                    "slack.emergencyStop.actionOf",
                                    { channel: name },
                                  )}
                                  disabled={update.isPending}
                                  onClick={() =>
                                    setStopTarget({ kind: "stop", row, name })
                                  }
                                >
                                  {t("slack.emergencyStop.action")}
                                </RowAction>
                              )}
                            </>
                          ) : (
                            <Text as="span" variant="sub">
                              {t(row.mode !== "off" ? "slack.on" : "slack.off")}
                            </Text>
                          )
                        }
                      </GridTableCell>
                    </GridTableRow>
                  );
                })}
              </GridTable>
            )}
          </div>
        )}
      </SettingsSection>
      <EmergencyStopDialog
        agentId={agentId}
        target={stopTarget}
        onClose={() => setStopTarget(null)}
        onDone={setNotice}
      />
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (locked
              ? lockAction.current?.querySelector<HTMLElement>("a, button")
              : pickerOpener.current
            )?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t(pickHome ? "slack.setHome" : "slack.addChannel")}
            </DialogTitle>
            <DialogDescription>{t("slack.joinHintAuto")}</DialogDescription>
          </DialogHeader>
          {readError ? (
            // An alert even before any result: a full failure state does not
            // fit inside the dialog.
            <LoadFailure
              error={readError}
              guidance={slackReason(readError, t)}
              kept
              onRetry={() => {
                for (const read of [bindings, channels])
                  if (read.isError) void read.refetch();
              }}
            />
          ) : null}
          {update.error ? (
            <FieldError>{slackFailure(update.error, t)}</FieldError>
          ) : null}
          <Field>
            <FieldLabel>{t("slack.search")}</FieldLabel>
            <Input
              value={input}
              maxLength={80}
              onChange={(event) => setInput(event.target.value)}
            />
          </Field>
          <div
            className="max-h-80 overflow-y-auto"
            aria-busy={channels.isFetching || input.trim() !== query}
          >
            {listed.length > 0 ? (
              <RowList variant="joined">
                {listed.map((channel) => (
                  <SettingRow
                    key={channel.id}
                    title={<ChannelName>{`#${channel.name}`}</ChannelName>}
                    description={
                      awaitsInvite(
                        rows.find(
                          (row) => row.external_surface_id === channel.id,
                        ),
                        {
                          private: channel.is_private,
                          member: channel.is_member,
                        },
                      ) ? (
                        <span className="flex flex-wrap items-center gap-1">
                          <Badge variant="gray">
                            {t("slack.privateInvite")}
                          </Badge>
                          <InviteCopy command={invite} notify={notify} />
                        </span>
                      ) : undefined
                    }
                    actions={
                      <span className="flex items-center gap-2">
                        <VisibilityBadge isPrivate={channel.is_private} />
                        <RowAction
                          aria-label={t(
                            pickHome
                              ? "slack.channelHome"
                              : "slack.channelConnect",
                            {
                              channel: `#${channel.name}`,
                            },
                          )}
                          disabled={
                            update.isPending ||
                            !bindings.isSuccess ||
                            channels.isPlaceholderData ||
                            input.trim() !== query ||
                            // The server refuses a home on a binding the bot left
                            // or one whose channel Slack deleted.
                            (pickHome &&
                              rows.some(
                                (row) =>
                                  row.external_surface_id === channel.id &&
                                  (row.status === "left" ||
                                    row.status === "gone"),
                              )) ||
                            (!pickHome &&
                              rows.some(
                                (row) => row.external_surface_id === channel.id,
                              ))
                          }
                          onClick={() => connectChannel(channel.id)}
                        >
                          {t(pickHome ? "slack.setHome" : "slack.add")}
                        </RowAction>
                      </span>
                    }
                  />
                ))}
              </RowList>
            ) : null}
            {channels.isSuccess && listed.length === 0 ? (
              <p>{t("slack.noChannels")}</p>
            ) : null}
            {channels.data?.pages.some(
              (page) => page.stale || page.truncated,
            ) ? (
              <p className="text-muted-foreground">{t("slack.partial")}</p>
            ) : null}
            {channels.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                disabled={channels.isFetching}
                onClick={() => void channels.fetchNextPage()}
              >
                {t("slack.more")}
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// The channel, its state and what to do about it; what it listens to; then
// the in-use switch and any approve button beside it, as wide as the widest
// row's.
const COLUMNS = "minmax(0,1fr) max-content max-content max-content";
const CAP_MAX = 60;

/**
 * M1's judgments per hour in one channel, 1 to 60: saved when it leaves the
 * field or on Enter, and only a whole number in range.
 */
function CapInput({
  value,
  label,
  busy,
  refused,
  describedBy,
  onSave,
}: {
  readonly value: number;
  readonly label: string;
  readonly busy: boolean;
  readonly refused: boolean;
  readonly describedBy: string | undefined;
  readonly onSave: (cap: number) => boolean;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(String(value));
  const hintId = useId();
  const parsed = Number(draft);
  const valid = /^\d+$/.test(draft) && parsed >= 1 && parsed <= CAP_MAX;
  const save = () => {
    // Another save holds the row's request: a value kept here would look saved.
    if (valid && !onSave(parsed)) setDraft(String(value));
  };
  return (
    <span className="flex flex-col items-end gap-1">
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        max={CAP_MAX}
        step={1}
        value={draft}
        aria-label={label}
        aria-invalid={!valid || refused}
        aria-disabled={busy}
        aria-describedby={
          [valid ? undefined : hintId, describedBy].filter(Boolean).join(" ") ||
          undefined
        }
        className="h-8 w-20 text-end tabular-nums"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
          if (event.key === "Escape") setDraft(String(value));
        }}
      />
      {valid ? null : (
        <Text as="span" variant="sub" id={hintId}>
          {t("slack.capRange", { max: CAP_MAX })}
        </Text>
      )}
    </span>
  );
}
const BINDING_LISTEN = Object.keys(LISTEN_LABEL) as Binding["listen"][];

/** The `/invite` line, for any channel the bot should join. */
function InviteRow({
  command,
  notify,
}: {
  readonly command: string;
  readonly notify: Notify;
}) {
  const { t } = useI18n();
  return (
    <SettingRow
      title={t("slack.inviteTitle")}
      description={t("slack.inviteHint")}
      // On a refused copy the reader selects this line by hand.
      meta={<Code>{command}</Code>}
      actions={
        <CopyButton
          value={command}
          variant="outline"
          size="sm"
          aria-label={t("slack.copyInvite")}
          label={t("slack.copy")}
          icon="copy"
          iconClassName="stroke-[1.5]"
          onResult={(ok) =>
            notify(t(ok ? "slack.copied" : "slack.copyInviteFailed"))
          }
        />
      }
    />
  );
}

/**
 * The tab's one notice that Slack has not checked the Request URL, in place
 * of the channels: Recheck here first, then Slack's own Verify.
 */
function ChannelsLock({
  appId,
  slack,
  action,
}: {
  readonly appId: string;
  /** The app, when this viewer may recheck it. */
  readonly slack: SlackApp | null;
  readonly action: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const bodyId = useId();
  // Runs before React detaches the card: focus in it would fall to <body>.
  useLayoutEffect(
    () => () => {
      if (action.current?.contains(document.activeElement))
        document
          .getElementById(SECTION.channels)
          ?.focus({ preventScroll: true });
    },
    [action],
  );
  return (
    <Alert
      ref={action}
      variant="amber"
      role="group"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
    >
      <AlertTitle id={titleId}>{t("slack.channelsLocked.title")}</AlertTitle>
      <AlertDescription id={bodyId}>
        {t(
          slack
            ? "slack.channelsLocked.bodyRecheck"
            : "slack.channelsLocked.body",
        )}
      </AlertDescription>
      {slack ? <RecheckError slack={slack} site="channels" /> : null}
      <AlertActions>
        {slack ? <RecheckButton slack={slack} site="channels" /> : null}
        <Link
          href={eventSubscriptionsUrl(appId)}
          target="_blank"
          newTabLabel={t("slack.newTab")}
          underline="always"
        >
          {t("slack.channelsLocked.open")}
        </Link>
      </AlertActions>
    </Alert>
  );
}
