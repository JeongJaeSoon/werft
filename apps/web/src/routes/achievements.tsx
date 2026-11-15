import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import { unwrap } from "@werft-ai/client";
import type {
  ListAchievementCategoriesResponse,
  ListAchievementTypesResponse,
  UsageAchievementsResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  OPERATIONS_MESSAGES,
  shortSessionId,
} from "@werft-ai/react/components";
import {
  Badge,
  Button,
  Card,
  Code,
  EmptyState,
  formatRelativeTime,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Link,
  NativeSelect,
  NativeSelectOption,
  Page,
  Section,
  Skeleton,
  StatCard,
  Text,
} from "@werft-ai/ui";
import { type ReactNode, useState } from "react";
import { agentsQuery, scopedKey } from "../api/queries.ts";
import { useHasPermission } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";

const DAY_MS = 86_400_000;

const ACHIEVEMENT_PERIODS = ["30", "7", "month"] as const;
export type AchievementPeriod = (typeof ACHIEVEMENT_PERIODS)[number];

// Cut at the next UTC midnight, as the usage screens are, so the query key
// stays the same all day.
export function achievementPeriod(
  period: AchievementPeriod | "1",
  now = new Date(),
): { readonly since: string; readonly until: string } {
  const until = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  const since =
    period === "month"
      ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
      : until - Number(period) * DAY_MS;
  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
  };
}

type Recent = UsageAchievementsResponse["recent"][number];

const STATE_BADGE = {
  auto: ["green", "achievements.state.counted"],
  confirmed: ["green", "achievements.state.counted"],
  needs_review: ["amber", "achievements.state.needsReview"],
  rejected: ["gray", "achievements.state.rejected"],
} as const;

export function AchievementsScreen() {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const format = OPERATIONS_MESSAGES[locale].format;
  const scope = useHasPermission("usage.installation_read")
    ? "installation"
    : "me";
  const [period, setPeriod] = useState<AchievementPeriod>("30");
  const [agentId, setAgentId] = useState("");
  const [typeId, setTypeId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const { since, until } = achievementPeriod(period);
  const query = {
    scope,
    since,
    until,
    ...(agentId ? { agent_id: agentId } : {}),
    ...(typeId ? { type_id: typeId } : {}),
    ...(categoryId ? { category_id: categoryId } : {}),
  } as const;
  const figures = useQuery({
    queryKey: scopedKey(client, "usage-achievements", query),
    queryFn: () =>
      unwrap(
        client.GET("/v1/usage/achievements", { params: { query } }),
      ) as Promise<UsageAchievementsResponse>,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const agents = useQuery(agentsQuery(client));
  const types = useQuery({
    queryKey: scopedKey(client, "achievement-types"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/achievement-types"),
      ) as Promise<ListAchievementTypesResponse>,
    retry: false,
  });
  const categories = useQuery({
    queryKey: scopedKey(client, "achievement-categories"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/achievement-categories"),
      ) as Promise<ListAchievementCategoriesResponse>,
    retry: false,
  });
  const data = figures.data;
  const value = (text: (data: UsageAchievementsResponse) => ReactNode) =>
    data ? (
      text(data)
    ) : (
      <Skeleton inline decorative width="4rem" height="1lh" />
    );
  const usdOrDash = (amount: string | null) =>
    amount === null ? "—" : format.usd(amount);
  // The usage screen's cost card warns the same way: a partial sum must not
  // pass for the whole spend.
  const costNote = (note: ReactNode) =>
    data && !data.cost_complete ? (
      <>
        {note}
        <span className="block">
          {OPERATIONS_MESSAGES[locale].usageKpis.costIncomplete}
        </span>
      </>
    ) : (
      note
    );

  return (
    <Page
      title={t("achievements.title")}
      description={t("achievements.description")}
      actions={
        <Button asChild variant="outline">
          <RouterLink to="/settings/workspace/achievement-rules">
            {t("achievementRules.nav")}
          </RouterLink>
        </Button>
      }
    >
      <div className="flex flex-wrap gap-2">
        <Filter
          label={t("achievements.filter.period")}
          value={period}
          onChange={(next) => setPeriod(next as AchievementPeriod)}
          options={ACHIEVEMENT_PERIODS.map((choice) => [
            choice,
            choice === "month"
              ? t("achievements.filter.month")
              : t("achievements.filter.days", { days: choice }),
          ])}
        />
        <Filter
          label={t("achievements.filter.agent")}
          value={agentId}
          onChange={setAgentId}
          options={[
            ["", t("achievements.filter.allAgents")],
            ...(agents.data?.items ?? []).map(
              (agent) => [agent.id, agent.name] as const,
            ),
          ]}
        />
        <Filter
          label={t("achievements.filter.type")}
          value={typeId}
          onChange={setTypeId}
          options={[
            ["", t("achievements.filter.allTypes")],
            ...(types.data?.items ?? []).map(
              (type) => [type.id, type.key] as const,
            ),
          ]}
        />
        <Filter
          label={t("achievements.filter.category")}
          value={categoryId}
          onChange={setCategoryId}
          options={[
            ["", t("achievements.filter.allCategories")],
            ...(categories.data?.items ?? []).map(
              (category) => [category.id, category.name] as const,
            ),
          ]}
        />
      </div>
      {figures.isError && !data ? (
        <Card className="py-0">
          <LoadFailure
            error={figures.error}
            onRetry={() => void figures.refetch()}
          />
        </Card>
      ) : (
        <div
          aria-busy={figures.isFetching || undefined}
          className="flex min-w-0 flex-col gap-[var(--werft-space-section)]"
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              label={t("achievements.counted")}
              value={value((d) => format.count(d.achievement_count))}
              description={
                data &&
                t("achievements.countedNote", {
                  waiting: format.count(data.needs_review_count),
                  rejected: format.count(data.rejected_count),
                })
              }
            />
            <StatCard
              label={t("achievements.sessionCost")}
              value={value((d) => format.usd(d.cost_usd))}
              description={
                data &&
                costNote(
                  t("achievements.sessionCostNote", {
                    sessions: format.count(data.session_count),
                    earned: format.count(data.sessions_with_achievement_count),
                  }),
                )
              }
            />
            <StatCard
              label={t("achievements.judgeCost")}
              value={value((d) => format.usd(d.judge_cost_usd))}
              description={
                data &&
                t("achievements.judgeCostNote", {
                  judgments: format.count(data.judgment_count),
                  calls: format.count(data.judge_calls),
                })
              }
            />
            <StatCard
              label={t("achievements.perAchievement")}
              value={value((d) => usdOrDash(d.cost_per_achievement_usd))}
              description={
                data && data.achievement_count > 0
                  ? costNote(
                      t("achievements.perAchievementNote", {
                        usd: format.usd(
                          (Number(data.cost_usd) +
                            Number(data.judge_cost_usd)) /
                            data.achievement_count,
                        ),
                      }),
                    )
                  : undefined
              }
            />
          </div>
          {data ? (
            <>
              <div className="grid grid-cols-1 gap-[var(--werft-space-section)] lg:grid-cols-2">
                <Section title={t("achievements.byRule")}>
                  {data.by_rule.length === 0 ? (
                    <EmptyState title={t("achievements.empty")} />
                  ) : (
                    <GridTable
                      aria-label={t("achievements.byRule")}
                      columns={
                        "minmax(0,1fr) minmax(0,1.6fr) minmax(0,1fr) 72px 72px"
                      }
                      minWidth="32rem"
                    >
                      <GridTableHeader>
                        <GridTableColumnHeader>
                          {t("achievements.column.category")}
                        </GridTableColumnHeader>
                        <GridTableColumnHeader>
                          {t("achievements.column.rule")}
                        </GridTableColumnHeader>
                        <GridTableColumnHeader>
                          {t("achievements.column.type")}
                        </GridTableColumnHeader>
                        <GridTableColumnHeader align="end">
                          {t("achievements.column.achievements")}
                        </GridTableColumnHeader>
                        <GridTableColumnHeader align="end">
                          {t("achievements.column.waiting")}
                        </GridTableColumnHeader>
                      </GridTableHeader>
                      {data.by_rule.map((rule) => (
                        <GridTableRow key={rule.id}>
                          <GridTableCell>{rule.category_name}</GridTableCell>
                          <GridTableCell>
                            {rule.title}{" "}
                            <Text as="span" variant="meta">
                              {t("achievements.version", {
                                version: rule.version,
                              })}
                            </Text>
                          </GridTableCell>
                          <GridTableCell>
                            <Code>{rule.type_key}</Code>
                          </GridTableCell>
                          <GridTableCell align="end" className="tabular-nums">
                            {format.count(rule.achievement_count)}
                          </GridTableCell>
                          <GridTableCell align="end" className="tabular-nums">
                            {format.count(rule.needs_review_count)}
                          </GridTableCell>
                        </GridTableRow>
                      ))}
                    </GridTable>
                  )}
                </Section>
                <Section title={t("achievements.byAgent")}>
                  {data.by_agent.length === 0 ? (
                    <EmptyState title={t("achievements.empty")} />
                  ) : (
                    <GridTable
                      aria-label={t("achievements.byAgent")}
                      columns={"minmax(0,1.6fr) 64px 64px 88px 88px"}
                      minWidth="32rem"
                    >
                      <GridTableHeader>
                        <GridTableColumnHeader>
                          {t("achievements.column.agent")}
                        </GridTableColumnHeader>
                        <GridTableColumnHeader align="end">
                          {t("achievements.column.sessions")}
                        </GridTableColumnHeader>
                        <GridTableColumnHeader align="end">
                          {t("achievements.column.achievements")}
                        </GridTableColumnHeader>
                        <GridTableColumnHeader align="end">
                          {t("achievements.column.sessionCost")}
                        </GridTableColumnHeader>
                        <GridTableColumnHeader align="end">
                          {t("achievements.column.perAchievement")}
                        </GridTableColumnHeader>
                      </GridTableHeader>
                      {data.by_agent.map((agent) => (
                        <GridTableRow key={agent.id ?? ""}>
                          <GridTableCell>
                            {agent.name ??
                              OPERATIONS_MESSAGES[locale].usageCostTable
                                .noAgent}
                          </GridTableCell>
                          <GridTableCell align="end" className="tabular-nums">
                            {format.count(agent.session_count)}
                          </GridTableCell>
                          <GridTableCell align="end" className="tabular-nums">
                            {format.count(agent.achievement_count)}
                          </GridTableCell>
                          <GridTableCell align="end" className="tabular-nums">
                            {format.usd(agent.cost_usd)}
                          </GridTableCell>
                          <GridTableCell align="end" className="tabular-nums">
                            {usdOrDash(agent.cost_per_achievement_usd)}
                          </GridTableCell>
                        </GridTableRow>
                      ))}
                    </GridTable>
                  )}
                </Section>
              </div>
              <Section
                title={t("achievements.recent")}
                description={t("achievements.recentNote")}
              >
                {data.recent.length === 0 ? (
                  <EmptyState title={t("achievements.empty")} />
                ) : (
                  // Below 44rem the evidence and session would wrap a letter
                  // a line; the table scrolls instead.
                  <GridTable
                    aria-label={t("achievements.recent")}
                    columns="88px minmax(0,1.4fr) minmax(0,1fr) minmax(0,1.4fr) auto auto"
                    minWidth="44rem"
                  >
                    <GridTableHeader>
                      <GridTableColumnHeader>
                        {t("achievements.column.at")}
                      </GridTableColumnHeader>
                      <GridTableColumnHeader>
                        {t("achievements.column.session")}
                      </GridTableColumnHeader>
                      <GridTableColumnHeader>
                        {t("achievements.column.rule")}
                      </GridTableColumnHeader>
                      <GridTableColumnHeader>
                        {t("achievements.column.evidence")}
                      </GridTableColumnHeader>
                      <GridTableColumnHeader>
                        {t("achievements.column.judge")}
                      </GridTableColumnHeader>
                      <GridTableColumnHeader>
                        {t("achievements.column.state")}
                      </GridTableColumnHeader>
                    </GridTableHeader>
                    {data.recent.map((row) => (
                      <RecentRow key={row.id} row={row} />
                    ))}
                  </GridTable>
                )}
              </Section>
            </>
          ) : null}
        </div>
      )}
    </Page>
  );
}

function RecentRow({ row }: { readonly row: Recent }) {
  const { t, locale } = useI18n();
  const [variant, state] = STATE_BADGE[row.review_state];
  const github =
    row.evidence_kind === "github_pull_request" ||
    row.evidence_kind === "github_review";
  return (
    <GridTableRow>
      <GridTableCell className="whitespace-nowrap">
        <time dateTime={row.created_at}>
          {formatRelativeTime(row.created_at, locale)}
        </time>
      </GridTableCell>
      <GridTableCell>
        {row.session_id === null ? (
          OPERATIONS_MESSAGES[locale].toolCalls.hidden
        ) : (
          <Link asChild variant="table">
            <RouterLink to="/sessions/$id" params={{ id: row.session_id }}>
              {row.session_title || shortSessionId(row.session_id)}
            </RouterLink>
          </Link>
        )}
      </GridTableCell>
      <GridTableCell>{row.rule_title}</GridTableCell>
      <GridTableCell>
        {row.title === null || row.link === null ? (
          OPERATIONS_MESSAGES[locale].toolCalls.hidden
        ) : github ? (
          <Link
            href={row.link}
            target="_blank"
            rel="noreferrer"
            variant="table"
          >
            {row.title}
          </Link>
        ) : (
          row.title
        )}
      </GridTableCell>
      <GridTableCell className="whitespace-nowrap">
        {row.judge === "luna"
          ? t("achievements.judge.luna")
          : t("achievements.judge.always")}
      </GridTableCell>
      <GridTableCell className="whitespace-nowrap">
        <Badge variant={variant}>{t(state)}</Badge>
      </GridTableCell>
    </GridTableRow>
  );
}

function Filter({
  label,
  value,
  onChange,
  options,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly (readonly [string, string])[];
}) {
  return (
    <div className="min-w-35 max-w-85 *:w-full max-md:min-w-0 max-md:flex-[1_1_140px]">
      <NativeSelect
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([option, text]) => (
          <NativeSelectOption key={option} value={option}>
            {text}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}
