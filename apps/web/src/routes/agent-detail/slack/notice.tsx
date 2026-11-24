import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type components, unwrap } from "@werft-ai/client";
import { type Locale, useWerft } from "@werft-ai/react";
import {
  Badge,
  Button,
  ConfirmDialog,
  FieldError,
  Link,
  SegmentedControl,
  SegmentedControlItem,
  SettingRow,
  SettingsSection,
  Skeleton,
  Switch,
  TableTime,
  Text,
} from "@werft-ai/ui";
import { useState } from "react";
import { LoadFailure } from "../../../components/load-failure.tsx";
import type { Notify } from "../../../components/toast.tsx";
import {
  type MessageKey,
  type Translate,
  useI18n,
} from "../../../i18n/i18n.tsx";
import { slackKey, useSlackNotice } from "./queries.ts";
import {
  SECTION,
  SECTION_TARGET,
  slackFailure,
  slackReason,
} from "./shared.ts";

type Notice = components["schemas"]["GetSlackNoticeResponse"];
type NoticeLocale =
  components["schemas"]["ApproveSlackNoticeRequest"]["locale"];

const STATE = {
  no_notice: { badge: "gray", label: "slack.notice.state.no_notice" },
  not_installed: { badge: "gray", label: "slack.notice.state.not_installed" },
  not_approved: { badge: "gray", label: "slack.notice.state.not_approved" },
  reapproval_required: {
    badge: "amber",
    label: "slack.notice.state.reapproval_required",
  },
  approved: { badge: "green", label: "slack.notice.state.approved" },
} as const satisfies Record<
  Notice["state"],
  { badge: string; label: MessageKey }
>;

/**
 * The notice is written in Korean and Japanese only: a screen in either
 * shows that one; an English screen lets the reader pick, Japanese first.
 */
export function noticeLocaleOf(locale: Locale): NoticeLocale | null {
  return locale === "ko" || locale === "ja" ? locale : null;
}

/**
 * The notice a workspace owner or admin approves before the agent listens in
 * Slack, drawn from the published version as written. Everyone who reads the
 * agent's Slack tab sees it and who approved it; the server says who may act.
 */
export function SlackNoticeSection({
  agentId,
  notify,
}: {
  readonly agentId: string;
  readonly notify: Notify;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const notice = useSlackNotice(agentId);
  const key = [...slackKey(client, agentId), "notice"];
  const fixed = noticeLocaleOf(locale);
  const [picked, setPicked] = useState<NoticeLocale>("ja");
  const shown = fixed ?? picked;
  const [revoking, setRevoking] = useState(false);
  const saved = (view: Notice, message: string) => {
    cache.setQueryData(key, view);
    notify(message);
  };
  const approve = useMutation({
    mutationFn: (version: number) =>
      unwrap(
        client.POST("/v1/agents/{id}/slack/notice/approve", {
          params: { path: { id: agentId } },
          body: { notice_version: version, locale: shown },
        }),
      ),
    onSuccess: (view) => saved(view, t("slack.notice.approvedNotice")),
    // A stale version means the words changed under the reader: show the new ones.
    onError: () => void cache.invalidateQueries({ queryKey: key }),
  });
  const revoke = useMutation({
    mutationFn: () =>
      unwrap(
        client.POST("/v1/agents/{id}/slack/notice/revoke", {
          params: { path: { id: agentId } },
        }),
      ),
    onSuccess: (view) => {
      setRevoking(false);
      saved(view, t("slack.notice.revokedNotice"));
    },
  });
  const data = notice.data;
  const text = data?.notice?.text[shown];
  const busy = approve.isPending || revoke.isPending;
  const canApprove =
    data !== undefined &&
    data.notice !== null &&
    data.state !== "not_installed" &&
    data.state !== "approved";
  // Revoke follows the live approvals, not the state: one Slack team approved
  // beside another not yet approved must still be withdrawable.
  const action = !data ? null : !data.can_approve ? (
    <Text as="p" variant="sub">
      {t("slack.notice.adminOnly")}
    </Text>
  ) : (
    <div className="flex flex-wrap items-center gap-2">
      {data.state === "approved" ? null : (
        <Button
          aria-disabled={!canApprove || busy}
          onClick={() => {
            if (canApprove && !busy && data.notice)
              approve.mutate(data.notice.version);
          }}
        >
          {t(
            data.state === "reapproval_required"
              ? "slack.notice.reapprove"
              : "slack.notice.approve",
          )}
        </Button>
      )}
      {data.approvals.length > 0 ? (
        <Button
          variant="danger"
          onClick={() => setRevoking(true)}
          disabled={busy}
        >
          {t("slack.notice.revoke")}
        </Button>
      ) : null}
    </div>
  );
  return (
    <SettingsSection
      id={SECTION.notice}
      tabIndex={-1}
      className={SECTION_TARGET}
      titleAs="h3"
      title={t("slack.notice")}
      badge={
        data ? (
          <Badge variant={STATE[data.state].badge}>
            {t(STATE[data.state].label)}
          </Badge>
        ) : null
      }
      description={t("slack.noticeHint")}
      box={true}
    >
      {notice.isPending ? (
        <Skeleton className="h-16 w-full" label={t("status.loading.title")} />
      ) : !data ? (
        <LoadFailure
          error={notice.error}
          guidance={slackReason(notice.error, t)}
          kept={false}
          onRetry={() => void notice.refetch()}
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          {data.state === "reapproval_required" ? (
            <Text as="p">{t("slack.notice.reapprovalHint")}</Text>
          ) : null}
          {data.state === "not_installed" ? (
            <Text as="p" variant="sub">
              {t("slack.notice.notInstalled")}
            </Text>
          ) : null}
          {data.notice === null || text === undefined ? (
            <Text as="p" variant="sub">
              {t("slack.notice.placeholder")}
            </Text>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
              {fixed === null ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Text as="p" variant="sub">
                    {t("slack.notice.languageNote")}
                  </Text>
                  <SegmentedControl
                    aria-label={t("slack.notice.language")}
                    value={picked}
                    onValueChange={(value) => setPicked(value as NoticeLocale)}
                  >
                    <SegmentedControlItem value="ja">
                      日本語
                    </SegmentedControlItem>
                    <SegmentedControlItem value="ko">
                      한국어
                    </SegmentedControlItem>
                  </SegmentedControl>
                </div>
              ) : null}
              <div
                lang={shown}
                className="flex min-w-0 flex-col gap-2 [overflow-wrap:anywhere]"
              >
                {text.body.map((paragraph, index) => (
                  // The paragraphs are fixed for a version; their order is their identity.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  <Text as="p" key={index}>
                    {paragraph}
                  </Text>
                ))}
                <p>
                  <Link
                    href={text.policy_link.href}
                    target="_blank"
                    newTabLabel={t("slack.newTab")}
                  >
                    {text.policy_link.label}
                  </Link>
                </p>
              </div>
              <Text as="p" variant="sub">
                {t("slack.notice.version", {
                  version: String(data.notice.version),
                })}
              </Text>
            </div>
          )}
          {data.approvals.length > 0 ? (
            <ul
              aria-label={t("slack.notice.approvals")}
              className="flex min-w-0 flex-col gap-1"
            >
              {data.approvals.map((approval) => (
                <li
                  key={approval.id}
                  className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-control [overflow-wrap:anywhere]"
                >
                  <span>{approval.approved_by.display_name}</span>
                  {approval.approved_by.email ? (
                    <Text as="span" variant="sub">
                      {approval.approved_by.email}
                    </Text>
                  ) : null}
                  <TableTime value={approval.approved_at} locale={locale} />
                  <Text as="span" variant="sub">
                    {t("slack.notice.version", {
                      version: String(approval.notice_version),
                    })}
                  </Text>
                  <Text as="span" variant="sub">
                    {t("slack.notice.team", { team: approval.slack_team_id })}
                  </Text>
                  {approval.counts ? null : (
                    <Badge variant="gray">{t("slack.notice.older")}</Badge>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">{action}</div>
          {approve.error ? (
            <FieldError>{noticeFailure(approve.error, t)}</FieldError>
          ) : null}
          <SlackRolloutRow
            agentId={agentId}
            data={data}
            onSaved={(view) =>
              saved(
                view,
                t(
                  view.rollout === "off"
                    ? "slack.rollout.savedOff"
                    : "slack.rollout.savedOn",
                ),
              )
            }
            onStale={() => void cache.invalidateQueries({ queryKey: key })}
          />
        </div>
      )}
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title={t("slack.notice.revoke")}
        consequence={t("slack.notice.revokeConsequence")}
        confirmLabel={t("slack.notice.revoke")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => revoke.mutate()}
      >
        {revoke.error ? (
          <FieldError>{slackFailure(revoke.error, t)}</FieldError>
        ) : null}
      </ConfirmDialog>
    </SettingsSection>
  );
}

/**
 * The agent's conversation switch, off or shadow. It is raised only once the
 * notice is approved and can always be lowered; the server lowers it by
 * itself when the approval stops counting.
 */
function SlackRolloutRow({
  agentId,
  data,
  onSaved,
  onStale,
}: {
  readonly agentId: string;
  readonly data: Notice;
  readonly onSaved: (view: Notice) => void;
  readonly onStale: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const change = useMutation({
    mutationFn: (rollout: Notice["rollout"]) =>
      unwrap(
        client.POST("/v1/agents/{id}/slack/notice/rollout", {
          params: { path: { id: agentId } },
          body: { rollout },
        }),
      ),
    onSuccess: onSaved,
    // Refused because the approval changed under the reader: show it now.
    onError: onStale,
  });
  const raised = data.rollout !== "off";
  const locked = !raised && data.state !== "approved";
  const unavailable = locked || change.isPending;
  return (
    <SettingRow
      title={t("slack.rollout")}
      description={t("slack.rolloutHint")}
      status={
        <Text as="span" variant="sub">
          {t(raised ? "slack.on" : "slack.off")}
        </Text>
      }
      meta={
        <>
          {!data.can_approve ? (
            <Text as="span" variant="sub">
              {t("slack.rollout.adminOnly")}
            </Text>
          ) : locked ? (
            <Text as="span" variant="sub">
              {t("slack.rollout.locked")}
            </Text>
          ) : null}
          {change.error ? (
            <FieldError>{rolloutFailure(change.error, t)}</FieldError>
          ) : null}
        </>
      }
      control={
        data.can_approve ? (
          <Switch
            aria-label={t("slack.rollout")}
            checked={raised}
            aria-disabled={unavailable}
            onCheckedChange={(checked) => {
              if (!unavailable) change.mutate(checked ? "shadow" : "off");
            }}
          />
        ) : null
      }
    />
  );
}

function rolloutFailure(error: unknown, t: Translate): string {
  const reason = (error as { details?: { reason_code?: unknown } } | null)
    ?.details?.reason_code;
  if (reason === "notice_not_approved" || reason === "no_notice")
    return t("slack.rollout.locked");
  return slackFailure(error, t);
}

function noticeFailure(error: unknown, t: Translate): string {
  const reason = (error as { details?: { reason_code?: unknown } } | null)
    ?.details?.reason_code;
  if (reason === "notice_version_stale") return t("slack.notice.stale");
  return slackFailure(error, t);
}
