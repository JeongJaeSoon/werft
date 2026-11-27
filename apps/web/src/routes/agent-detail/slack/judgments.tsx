import type { components } from "@werft-ai/client";
import type { AgentDetail } from "@werft-ai/contracts";
import {
  Badge,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Link,
  RelativeTime,
  SettingsSection,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { LoadFailure } from "../../../components/load-failure.tsx";
import { type MessageKey, useI18n } from "../../../i18n/i18n.tsx";
import {
  useSlackChannelNames,
  useSlackInstructionsHead,
  useSlackJudgments,
} from "./queries.ts";
import { SECTION, SECTION_TARGET, slackReason } from "./shared.ts";

type Judgments = components["schemas"]["GetSlackJudgmentsResponse"];
type Reason = Judgments["recent"][number]["reason"];

const REASON_LABEL = {
  not_for_agent: "slack.judgments.reason.not_for_agent",
  human_conversation: "slack.judgments.reason.human_conversation",
  already_handled: "slack.judgments.reason.already_handled",
  out_of_scope: "slack.judgments.reason.out_of_scope",
  needs_agent: "slack.judgments.reason.needs_agent",
  unclear: "slack.judgments.reason.unclear",
  invalid_target: "slack.judgments.reason.invalid_target",
  budget_refused: "slack.judgments.reason.budget_refused",
  concurrency_limited: "slack.judgments.reason.concurrency_limited",
  rate_limited: "slack.judgments.reason.rate_limited",
  input_too_large: "slack.judgments.reason.input_too_large",
  no_active_release: "slack.judgments.reason.no_active_release",
  model_unavailable: "slack.judgments.reason.model_unavailable",
  timed_out: "slack.judgments.reason.timed_out",
  unreachable: "slack.judgments.reason.unreachable",
  provider_error: "slack.judgments.reason.provider_error",
  malformed: "slack.judgments.reason.malformed",
} as const satisfies Record<Reason, MessageKey>;

// Channel, then the counts (numbers end-aligned), then the reasons.
const CHANNEL_COLUMNS =
  "minmax(8rem,1fr) max-content max-content minmax(0,2fr)";
// When, channel, decision and reason, then the link.
const RECENT_COLUMNS =
  "max-content minmax(6rem,1fr) max-content minmax(0,1fr) max-content";

/**
 * The instruction file M1 judges with: the active release's snapshot, and
 * whether the repository's branch has moved past it (`newer`; false when
 * GitHub was not read).
 */
function InstructionsLine({
  release,
  newer,
}: {
  readonly release: AgentDetail["active_release"];
  readonly newer: boolean;
}) {
  const { t } = useI18n();
  const snapshot = release?.instructions_snapshot;
  const lines: string[] = [];
  if (!release) lines.push(t("slack.judgments.noRelease"));
  else if (snapshot == null) lines.push(t("slack.judgments.noSnapshot"));
  else if (snapshot.kind === "no_repository")
    lines.push(t("slack.judgments.noRepository"));
  else if (snapshot.kind === "read_failed")
    lines.push(t("agent.releases.instructionsReadFailed"));
  else {
    const vars = {
      release: release.label,
      commit: snapshot.commit.slice(0, 7),
    };
    lines.push(
      t(
        snapshot.kind === "absent"
          ? "slack.judgments.instructionsAbsent"
          : "slack.judgments.instructions",
        vars,
      ),
    );
    if (newer) lines.push(t("slack.judgments.instructionsNewer"));
    if (snapshot.kind === "refused")
      lines.push(t("agent.releases.instructionsRefused"));
    if (snapshot.kind === "text" && snapshot.truncated)
      lines.push(t("agent.releases.instructionsTruncated"));
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {lines.map((line) => (
        <Text key={line} variant="sub" className="wrap-anywhere">
          {line}
        </Text>
      ))}
    </div>
  );
}

/**
 * M1's shadow judgments of the agent's channels (a1/S3): counts per channel
 * and the newest records, each a link to its Slack message and a reason
 * code; private channels are in it like the rest.
 */
export function SlackJudgments({
  agentId,
  activeRelease,
  manages,
}: {
  readonly agentId: string;
  readonly activeRelease: AgentDetail["active_release"];
  /** Owner, admin or the agent's admin: who the server answers. */
  readonly manages: boolean;
}) {
  const { t, locale } = useI18n();
  const judgments = useSlackJudgments(agentId, manages);
  const snapshot = activeRelease?.instructions_snapshot;
  const head = useSlackInstructionsHead(
    agentId,
    activeRelease?.id ?? null,
    manages && snapshot != null && "commit" in snapshot,
  );
  const data = judgments.data;
  const names = useSlackChannelNames(
    agentId,
    data?.channels.map((channel) => channel.channel_id) ?? [],
  );
  const nameOf = (id: string) => {
    const found = names.data?.items.find(
      (item) => item.id === id && item.state === "known",
    );
    return found ? `#${found.name}` : t("slack.channelId", { id });
  };
  const forbidden =
    !manages ||
    (judgments.error as { code?: string } | null)?.code === "FORBIDDEN";
  return (
    <SettingsSection
      id={SECTION.judgments}
      tabIndex={-1}
      className={SECTION_TARGET}
      titleAs="h3"
      title={t("slack.judgments")}
      description={
        <>
          <p className="m-0">
            {t("slack.judgments.hint", { days: data?.window_days ?? 7 })}
          </p>
          <p className="m-0">{t("slack.judgments.knobs")}</p>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-[var(--werft-space-block)]">
        <InstructionsLine
          release={activeRelease}
          newer={
            !head.isError && head.data?.state === "read" && head.data.newer
          }
        />
        {forbidden ? (
          <Text variant="sub">{t("slack.judgments.forbidden")}</Text>
        ) : judgments.isPending ? (
          <Skeleton lines={3} label={t("slack.judgments.loading")} />
        ) : judgments.error && !data ? (
          <LoadFailure
            error={judgments.error}
            guidance={slackReason(judgments.error, t)}
            kept={false}
            onRetry={() => void judgments.refetch()}
          />
        ) : !data || data.channels.length === 0 ? (
          <div className="flex flex-col gap-1">
            <Text weight="medium">{t("slack.judgments.empty")}</Text>
            <Text variant="sub">{t("slack.judgments.emptyHint")}</Text>
          </div>
        ) : (
          <>
            <GridTable
              aria-label={t("slack.judgments.byChannel")}
              columns={CHANNEL_COLUMNS}
              align={["start", "end", "end", "start"]}
              narrowAt={640}
              narrowCards={true}
              framed
            >
              <GridTableHeader>
                <GridTableColumnHeader>
                  {t("slack.channelColumn")}
                </GridTableColumnHeader>
                <GridTableColumnHeader>
                  {t("slack.judgments.count")}
                </GridTableColumnHeader>
                <GridTableColumnHeader>
                  {t("slack.judgments.speakRate")}
                </GridTableColumnHeader>
                <GridTableColumnHeader>
                  {t("slack.judgments.reasons")}
                </GridTableColumnHeader>
              </GridTableHeader>
              {data.channels.map((channel) => (
                <GridTableRow
                  key={`${channel.slack_team_id}:${channel.channel_id}`}
                >
                  <GridTableCell className="py-3">
                    <Text as="span" weight="medium" className="wrap-anywhere">
                      {nameOf(channel.channel_id)}
                    </Text>
                  </GridTableCell>
                  <GridTableCell
                    cardLabel={t("slack.judgments.count")}
                    className="tabular-nums"
                  >
                    {channel.judgments}
                  </GridTableCell>
                  <GridTableCell
                    cardLabel={t("slack.judgments.speakRate")}
                    className="tabular-nums"
                  >
                    {t("slack.judgments.speakOf", {
                      percent: Math.round(
                        (channel.speak / Math.max(channel.judgments, 1)) * 100,
                      ),
                      speak: channel.speak,
                    })}
                  </GridTableCell>
                  <GridTableCell cardLabel={t("slack.judgments.reasons")}>
                    <span className="flex flex-wrap gap-1">
                      {channel.reasons.map((reason) => (
                        <Badge key={reason.reason} variant="gray">
                          {t("slack.judgments.reasonCount", {
                            reason: t(REASON_LABEL[reason.reason]),
                            count: reason.count,
                          })}
                        </Badge>
                      ))}
                    </span>
                  </GridTableCell>
                </GridTableRow>
              ))}
            </GridTable>
            <GridTable
              aria-label={t("slack.judgments.recent")}
              columns={RECENT_COLUMNS}
              align={["start", "start", "start", "start", "end"]}
              narrowAt={640}
              narrowCards={true}
              framed
            >
              <GridTableHeader>
                <GridTableColumnHeader>
                  {t("slack.judgments.when")}
                </GridTableColumnHeader>
                <GridTableColumnHeader>
                  {t("slack.channelColumn")}
                </GridTableColumnHeader>
                <GridTableColumnHeader>
                  {t("slack.judgments.decision")}
                </GridTableColumnHeader>
                <GridTableColumnHeader>
                  {t("slack.judgments.reason")}
                </GridTableColumnHeader>
                <GridTableColumnHeader>
                  <span className="sr-only">
                    {t("slack.judgments.message")}
                  </span>
                </GridTableColumnHeader>
              </GridTableHeader>
              {data.recent.map((item) => (
                <GridTableRow key={item.id}>
                  <GridTableCell className="py-3">
                    <RelativeTime value={item.judged_at} locale={locale} />
                  </GridTableCell>
                  <GridTableCell cardLabel={t("slack.channelColumn")}>
                    <span className="wrap-anywhere">
                      {nameOf(item.channel_id)}
                    </span>
                  </GridTableCell>
                  <GridTableCell cardLabel={t("slack.judgments.decision")}>
                    <Badge
                      variant={item.decision === "speak" ? "green" : "gray"}
                    >
                      {t(
                        item.decision === "speak"
                          ? "slack.judgments.speak"
                          : "slack.judgments.quiet",
                      )}
                    </Badge>
                  </GridTableCell>
                  <GridTableCell cardLabel={t("slack.judgments.reason")}>
                    {t(REASON_LABEL[item.reason])}
                  </GridTableCell>
                  <GridTableCell cardLabel={t("slack.judgments.message")}>
                    <Link
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      variant="table"
                      aria-label={t("slack.judgments.openOf", {
                        channel: nameOf(item.channel_id),
                      })}
                    >
                      {t("slack.judgments.open")}
                    </Link>
                  </GridTableCell>
                </GridTableRow>
              ))}
            </GridTable>
          </>
        )}
      </div>
    </SettingsSection>
  );
}
