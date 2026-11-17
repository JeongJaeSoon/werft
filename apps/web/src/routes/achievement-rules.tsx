import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  AchievementCategory,
  AchievementCategoryChangeResponse,
  AchievementEvidenceKind,
  AchievementJudgeChangeResponse,
  AchievementJudgeResponse,
  AchievementJudgeSettings,
  AchievementRule,
  AchievementRuleChangeResponse,
  AchievementRuleJudge,
  AchievementType,
  AchievementTypeChangeResponse,
  ListAchievementCategoriesResponse,
  ListAchievementRulesResponse,
  ListAchievementTypesResponse,
  UsageAchievementsResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { OPERATIONS_MESSAGES } from "@werft-ai/react/components";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  buttonVariants,
  Checkbox,
  Code,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  NativeSelect,
  NativeSelectOption,
  Page,
  RadioGroup,
  RadioGroupItem,
  SettingsSection,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  Textarea,
} from "@werft-ai/ui";
import { Lock } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { memberSummariesQuery, scopedKey } from "../api/queries.ts";
import {
  permissionReason,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { ReasonButton } from "../auth/reason-button.tsx";
import { FormRow } from "../components/form-row.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { type Translate, useI18n } from "../i18n/i18n.tsx";
import { achievementPeriod } from "./achievements.tsx";
import {
  useAchievementJudge,
  useDecisionModelSetup,
} from "./decision-model.tsx";

// The server's ceilings; the web takes contracts as types only, so a test
// keeps these equal to the contract's values.
export const ACHIEVEMENT_RULE_DEFINITION_MAX = 2_000;
export const ACHIEVEMENT_CATEGORY_NAME_MAX = 32;
export const ACHIEVEMENT_TYPE_NAME_MAX = 40;
export const ACHIEVEMENT_RULE_TITLE_MAX = 80;
export const ACHIEVEMENT_TYPE_LIMIT = 50;
export const ACHIEVEMENT_RULE_LIMIT = 30;

const EVIDENCE_KINDS: readonly AchievementEvidenceKind[] = [
  "github_pull_request",
  "github_review",
  "out_file",
  "conversation",
];
// What a person must confirm before it counts (achievement-rules.md §3).
const NEEDS_REVIEW: ReadonlySet<AchievementEvidenceKind> = new Set([
  "out_file",
  "conversation",
]);
const BUILTIN_FIELDS = {
  pull_request: "achievementRules.fields.pull_request",
  code_review: "achievementRules.fields.code_review",
  document: "achievementRules.fields.document",
} as const;
const NEW_TYPE = "__new_type__";
const EDITOR_ID = "achievement-rule-editor";

// Below md each row stacks its cells, each under its column's name (data-k),
// so no table scrolls sideways at phone width.
const STACK_TABLE =
  "[&_tr>*:first-child]:pl-0 [&_tr>*:last-child]:pr-0 max-md:block max-md:[&>tbody]:block max-md:[&>thead]:hidden max-md:[&_tr]:block max-md:[&_tr]:h-auto max-md:[&_tr]:px-0 max-md:[&_tr]:py-2.5";
// The settings layout zeroes --werft-row-padding-x for its list rows; the table
// cells halve it for the gap between columns, so it is put back here. The
// container scrolls, which clips a focus ring that sits outside its
// control, so -m-1 p-1 leaves the ring's 4px inside the clip (as members.tsx).
const TABLE_FRAME =
  "-m-1 rounded-none border-0 p-1 [--werft-row-padding-x:var(--werft-space-4)]";
// The name takes a fixed width so every value starts at one x, left-aligned
// as in the table. max-w-none and whitespace-normal undo the `text` and
// `nowrap` column widths, which mean nothing once a cell is a line.
const STACK_CELL =
  "max-md:flex max-md:w-full max-md:min-w-0 max-md:max-w-none max-md:whitespace-normal max-md:items-center max-md:gap-x-1.5 max-md:px-0 max-md:py-0.5 max-md:first:pl-0 max-md:last:pr-0 max-md:[overflow-wrap:anywhere] max-md:before:w-24 max-md:before:flex-none max-md:before:text-caption max-md:before:text-subtle-foreground max-md:before:content-[attr(data-k)]";
const NUM = "tabular-nums";
const SMALL_BUTTON = buttonVariants({ variant: "outline", size: "sm" });

type Reason = string | undefined;

function reasonCode(error: ApiError): unknown {
  return (error.details as { reason_code?: unknown } | null)?.reason_code;
}

/** Which of the workspace's limits a write can reach. */
type Limit = "type" | "rule";

function changeRefusal(
  t: Translate,
  error: ApiError,
  role: string | undefined,
  limit?: Limit,
): string {
  switch (reasonCode(error)) {
    case "limit_reached":
      if (limit === "type")
        return t("achievementRules.typeLimit", { max: ACHIEVEMENT_TYPE_LIMIT });
      if (limit === "rule")
        return t("achievementRules.ruleLimit", { max: ACHIEVEMENT_RULE_LIMIT });
      break;
    case "name_taken":
      return t("achievementRules.nameTaken");
    case "key_taken":
      return t("achievementRules.type.keyTaken");
    case "category_in_use":
      return t("achievementRules.category.inUse");
    case "type_in_use":
      return t("achievementRules.rules.typeInUse");
  }
  return refusalText(t, error, "achievement_rule.manage", role);
}

/** Renders `template` with `mark` in place of its one variable. */
function Marked({
  template,
  mark,
}: {
  readonly template: (slot: string) => string;
  readonly mark: ReactNode;
}) {
  const slot = "\u0000";
  const [before, after] = template(slot).split(slot);
  return (
    <>
      {before}
      <Text as="span" weight="medium">
        {mark}
      </Text>
      {after}
    </>
  );
}

// 이 after a final consonant, 가 after a vowel; a name not ending in Hangul
// gets both, as the console writes 을(를).
export function subjectParticle(name: string): string {
  const code = [...name].at(-1)?.codePointAt(0) ?? 0;
  if (code < 0xac00 || code > 0xd7a3) return "이(가)";
  return (code - 0xac00) % 28 === 0 ? "가" : "이";
}

function useCatalog() {
  const { client } = useWerft();
  const categories = useQuery({
    queryKey: scopedKey(client, "achievement-categories"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/achievement-categories"),
      ) as Promise<ListAchievementCategoriesResponse>,
    retry: false,
  });
  const types = useQuery({
    queryKey: scopedKey(client, "achievement-types"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/achievement-types"),
      ) as Promise<ListAchievementTypesResponse>,
    retry: false,
  });
  const rules = useQuery({
    queryKey: scopedKey(client, "achievement-rules"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/achievement-rules"),
      ) as Promise<ListAchievementRulesResponse>,
    retry: false,
  });
  return { categories, types, rules };
}

/**
 * The workspace's figures for a period, or `readable: false` for a caller
 * who cannot read the whole installation: a caller's own sessions would pass
 * for the workspace's spend.
 */
function useUsage(period: "1" | "30" | "month") {
  const { client } = useWerft();
  const allowed = useHasPermission("usage.installation_read");
  const query = {
    scope: "installation",
    ...achievementPeriod(period),
  } as const;
  const figures = useQuery({
    queryKey: scopedKey(client, "usage-achievements", query),
    queryFn: () =>
      unwrap(
        client.GET("/v1/usage/achievements", { params: { query } }),
      ) as Promise<UsageAchievementsResponse>,
    enabled: allowed,
    retry: false,
  });
  return { data: figures.data, readable: allowed && !figures.isError };
}

function useInvalidate() {
  const { client } = useWerft();
  const queryClient = useQueryClient();
  return (...names: string[]) =>
    Promise.all(
      names.map((name) =>
        queryClient.invalidateQueries({ queryKey: scopedKey(client, name) }),
      ),
    );
}

/** The workspace's achievement rules: judging, categories, types and rules. */
export function AchievementRulesScreen() {
  const { t } = useI18n();
  const role = useRole();
  const reason: Reason = useHasPermission("achievement_rule.manage")
    ? undefined
    : permissionReason(t, "achievement_rule.manage", role);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // A rule family's id, "new", or nothing open.
  const [editing, setEditing] = useState<string | null>(null);
  const { categories, types, rules } = useCatalog();
  const failed = [categories, types, rules].find((query) => query.isError);
  const judge = useAchievementJudge();
  // The server refuses every change until a decision model is enabled.
  const locked =
    judge.data !== undefined && judge.data.connections.length === 0;
  const setup = useDecisionModelSetup(setOutcome);
  const writeReason =
    reason ?? (locked ? t("decisionModel.lockedReason") : undefined);
  const open = (target: string) => {
    setOutcome(null);
    setEditing(target);
  };

  return (
    <Page
      title={t("achievementRules.title")}
      description={t("achievementRules.description")}
      actions={
        <>
          <ReasonButton
            className={buttonVariants({ variant: "outline" })}
            reason={setup.reason}
            onClick={(event) => setup.open(event.currentTarget)}
          >
            {t("decisionModel.setup")}
          </ReasonButton>
          <ReasonButton
            className={buttonVariants()}
            reason={writeReason}
            onClick={() => open("new")}
          >
            {t("achievementRules.addRule")}
          </ReasonButton>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-[var(--werft-space-section)]">
        <OutcomeLine outcome={outcome} />
        <div className="relative min-w-0">
          <div
            inert={locked}
            className="flex min-w-0 flex-col gap-[var(--werft-space-section)]"
          >
            <JudgeCard reason={writeReason} onOutcome={setOutcome} />
            {failed ? (
              <div>
                <LoadFailure
                  error={failed.error}
                  onRetry={() => {
                    for (const query of [categories, types, rules]) {
                      if (query.isError) void query.refetch();
                    }
                  }}
                />
              </div>
            ) : categories.data && types.data && rules.data ? (
              <>
                <CategoriesCard
                  categories={categories.data.items}
                  rules={rules.data.items}
                  reason={writeReason}
                />
                <TypesCard
                  types={types.data.items}
                  rules={rules.data.items}
                  reason={writeReason}
                />
                <RulesCard
                  categories={categories.data.items}
                  types={types.data.items}
                  rules={rules.data.items}
                  reason={writeReason}
                  onEdit={open}
                  onOutcome={setOutcome}
                />
                {editing === null ? null : (
                  <RuleEditor
                    key={editing}
                    rule={rules.data.items.find(
                      (rule) => rule.family_id === editing,
                    )}
                    categories={categories.data.items}
                    types={types.data.items}
                    rules={rules.data.items}
                    reason={writeReason}
                    onClose={() => setEditing(null)}
                    onOutcome={setOutcome}
                  />
                )}
              </>
            ) : (
              <Skeleton height="12rem" />
            )}
          </div>
          {locked ? <DecisionModelLock /> : null}
        </div>
      </div>
      {setup.dialogs}
    </Page>
  );
}

// The header's "판정 모델 설정" is the way out; the notice only names the lock.
function DecisionModelLock() {
  const { t } = useI18n();
  const titleId = useId();
  return (
    // overflow-clip, not hidden: the blur below may not widen the page, and a
    // scroll container here would stop the notice sticking.
    <div className="absolute inset-0 flex justify-center overflow-clip rounded-card bg-muted/70">
      {/* Sticky, so the notice stays in view over a long page. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls, this is a notice */}
      <div
        role="group"
        aria-labelledby={titleId}
        className="sticky top-[30vh] isolate mx-4 mt-16 flex max-w-prose flex-col items-center gap-2 self-start text-center text-muted-foreground before:absolute before:-inset-x-16 before:-inset-y-12 before:-z-10 before:backdrop-blur-lg before:[mask-image:radial-gradient(closest-side,#000_80%,transparent)]"
      >
        <Lock aria-hidden="true" className="size-6" />
        <Text id={titleId} weight="medium" className="text-muted-foreground">
          {t("decisionModel.lock.title")}
        </Text>
        <Text variant="sub">{t("decisionModel.lock.body")}</Text>
      </div>
    </div>
  );
}

function RulesSection({
  id,
  title,
  count,
  description,
  foot,
  titleRef,
  onSubmit,
  children,
}: {
  readonly id?: string;
  readonly title: string;
  readonly count?: number;
  readonly description: ReactNode;
  readonly foot?: ReactNode;
  readonly titleRef?: Ref<HTMLHeadingElement>;
  readonly onSubmit?: (event: FormEvent) => void;
  readonly children: ReactNode;
}) {
  return (
    <SettingsSection
      id={id}
      title={title}
      titleRef={titleRef}
      description={description}
      badge={
        count === undefined ? null : (
          <Text as="span" variant="sub" numeric>
            {count}
          </Text>
        )
      }
      foot={foot}
      onSubmit={onSubmit}
    >
      {children}
    </SettingsSection>
  );
}

interface JudgeDraft {
  /** "" for none. */
  readonly connection: string;
  readonly on_evidence: boolean;
  readonly turnsOn: boolean;
  readonly turns: string;
  readonly on_idle: boolean;
  readonly transcript: AchievementJudgeSettings["transcript"];
  readonly budget: string;
  readonly perSession: string;
}

function judgeDraft(settings: AchievementJudgeSettings): JudgeDraft {
  return {
    connection: settings.connection_id ?? "",
    on_evidence: settings.on_evidence,
    turnsOn: settings.every_n_turns !== null,
    turns: `${settings.every_n_turns ?? 10}`,
    on_idle: settings.on_idle,
    transcript: settings.transcript,
    budget: `${settings.daily_budget_usd}`,
    perSession: `${settings.max_per_session}`,
  };
}

// The threshold has no field here; it goes back as read.
export function judgeBody(
  settings: AchievementJudgeSettings,
  draft: JudgeDraft,
): AchievementJudgeSettings {
  return {
    connection_id: draft.connection === "" ? null : draft.connection,
    threshold: settings.threshold,
    on_evidence: draft.on_evidence,
    every_n_turns: draft.turnsOn ? Number(draft.turns) : null,
    on_idle: draft.on_idle,
    transcript: draft.transcript,
    daily_budget_usd: Number(draft.budget),
    max_per_session: Number(draft.perSession),
  };
}

function JudgeCard({
  reason,
  onOutcome,
}: {
  readonly reason: Reason;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const format = OPERATIONS_MESSAGES[locale].format;
  const workspaceId = useMe()?.workspace?.id ?? "";
  const key = scopedKey(client, "achievement-judge");
  const judge = useAchievementJudge();
  const today = useUsage("1");
  const month = useUsage("month");
  const settings = judge.data?.achievement_judge;
  const connections = judge.data?.connections ?? [];
  // Untouched, the form follows the server's values as they refresh.
  const [draft, setDraft] = useState<JudgeDraft | null>(null);
  const form = draft ?? (settings ? judgeDraft(settings) : null);
  const set = (patch: Partial<JudgeDraft>) =>
    form && setDraft({ ...form, ...patch });
  const turnsId = useId();
  const budgetId = useId();
  const perSessionId = useId();

  const save = useMutation<
    AchievementJudgeChangeResponse,
    ApiError,
    AchievementJudgeSettings
  >({
    mutationFn: (body) =>
      unwrap(
        client.PUT("/v1/workspaces/{id}/achievement-judge", {
          params: { path: { id: workspaceId } },
          body,
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: ({ achievement_judge }) => {
      queryClient.setQueryData<AchievementJudgeResponse>(key, (old) => ({
        achievement_judge,
        connections: old?.connections ?? [],
      }));
      setDraft(null);
      onOutcome({ kind: "notice", text: t("achievementRules.judge.saved") });
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: changeRefusal(t, error, role),
      }),
  });

  if (judge.isError) {
    return (
      <div>
        <LoadFailure error={judge.error} onRetry={() => void judge.refetch()} />
      </div>
    );
  }
  if (!settings || !form) return <Skeleton height="16rem" />;

  const locked = reason !== undefined || save.isPending;
  const usd = (figures: typeof today) =>
    figures.data ? format.usd(figures.data.judge_cost_usd) : "—";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending || reason !== undefined) return;
    save.mutate(judgeBody(settings, form));
  };

  return (
    <RulesSection
      title={t("achievementRules.judge.title")}
      description={t("achievementRules.judge.description")}
      onSubmit={submit}
      foot={
        <>
          {today.readable && month.readable ? (
            <Text as="span" variant="meta">
              <Marked
                template={(slot) =>
                  t("achievementRules.judge.cost", {
                    today: slot,
                    budget: format.usd(settings.daily_budget_usd),
                    month: usd(month),
                  })
                }
                mark={usd(today)}
              />
            </Text>
          ) : null}
          <ReasonButton
            type="submit"
            className={buttonVariants({ size: "sm" })}
            reason={reason}
            aria-disabled={save.isPending || undefined}
          >
            {t("achievementRules.save")}
          </ReasonButton>
        </>
      }
    >
      {/* One block: the form's gap-4 would otherwise add to each row's rule. */}
      <div>
        <FormRow
          label={t("achievementRules.judge.judge")}
          hint={t("achievementRules.judge.judgeHint")}
        >
          <div className="max-w-85 *:w-full">
            <NativeSelect
              aria-label={t("achievementRules.judge.connection")}
              value={form.connection}
              disabled={locked}
              onChange={(event) => set({ connection: event.target.value })}
            >
              <NativeSelectOption value="">
                {t("achievementRules.judge.noConnection")}
              </NativeSelectOption>
              {connections.map((id) => (
                <NativeSelectOption key={id} value={id}>
                  {id}
                </NativeSelectOption>
              ))}
              {/* Named before it was disabled: kept so a save keeps it. */}
              {settings.connection_id === null ||
              connections.includes(settings.connection_id) ? null : (
                <NativeSelectOption value={settings.connection_id}>
                  {t("achievementRules.judge.unavailable", {
                    id: settings.connection_id,
                  })}
                </NativeSelectOption>
              )}
            </NativeSelect>
          </div>
          <Text variant="meta">{t("achievementRules.judge.sent")}</Text>
        </FormRow>
        <FormRow
          label={t("achievementRules.judge.when")}
          hint={t("achievementRules.judge.whenHint")}
        >
          <Field orientation="horizontal">
            <Checkbox
              checked={form.on_evidence}
              disabled={locked}
              onCheckedChange={(on) => set({ on_evidence: on === true })}
            />
            <FieldLabel className="font-normal">
              {t("achievementRules.judge.onEvidence")}
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              checked={form.turnsOn}
              disabled={locked}
              onCheckedChange={(on) => set({ turnsOn: on === true })}
            />
            <Input
              id={turnsId}
              type="number"
              inputMode="numeric"
              className="w-16 shrink-0"
              min={5}
              max={100}
              step={1}
              aria-label={t("achievementRules.judge.turns")}
              value={form.turns}
              disabled={locked}
              onChange={(event) => set({ turns: event.target.value })}
            />
            <FieldLabel className="font-normal">
              {t("achievementRules.judge.everyTurns")}
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              checked={form.on_idle}
              disabled={locked}
              onCheckedChange={(on) => set({ on_idle: on === true })}
            />
            <FieldLabel className="font-normal">
              {t("achievementRules.judge.onIdle")}
            </FieldLabel>
          </Field>
        </FormRow>
        <FormRow
          label={t("achievementRules.judge.transcript")}
          hint={t("achievementRules.judge.transcriptHint")}
        >
          <RadioGroup
            aria-label={t("achievementRules.judge.transcript")}
            value={form.transcript}
            disabled={locked}
            onValueChange={(value) =>
              set({ transcript: value as JudgeDraft["transcript"] })
            }
            className="gap-2"
          >
            {(["none", "recent"] as const).map((value) => (
              <Field key={value} orientation="horizontal">
                <RadioGroupItem value={value} />
                <FieldLabel className="font-normal">
                  {t(
                    value === "none"
                      ? "achievementRules.judge.transcriptNone"
                      : "achievementRules.judge.transcriptRecent",
                  )}
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
        </FormRow>
        <FormRow
          label={t("achievementRules.judge.limits")}
          hint={t("achievementRules.judge.limitsHint")}
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-1.5">
              <FieldLabel htmlFor={budgetId} className="font-normal">
                {t("achievementRules.judge.dailyBudget")}
              </FieldLabel>
              <Text as="span" variant="sub" aria-hidden="true">
                $
              </Text>
              <Input
                id={budgetId}
                type="number"
                inputMode="decimal"
                className="w-20"
                min={0}
                step="any"
                value={form.budget}
                disabled={locked}
                onChange={(event) => set({ budget: event.target.value })}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <FieldLabel htmlFor={perSessionId} className="font-normal">
                {t("achievementRules.judge.maxPerSession")}
              </FieldLabel>
              <Input
                id={perSessionId}
                type="number"
                inputMode="numeric"
                className="w-20"
                min={1}
                step={1}
                value={form.perSession}
                disabled={locked}
                onChange={(event) => set({ perSession: event.target.value })}
              />
              {/* The label already says what it counts; this is the unit. */}
              <Text as="span" variant="sub" aria-hidden="true">
                {t("achievementRules.judge.perSessionUnit")}
              </Text>
            </div>
          </div>
        </FormRow>
      </div>
    </RulesSection>
  );
}

type Change<V> = {
  readonly mutate: (value: V) => void;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly reset: () => void;
};

/** A catalog write: refreshes the lists it touched, says why it was refused. */
function useChange<V, R>(
  request: (value: V) => Promise<R>,
  lists: readonly string[],
  onDone: (result: R) => void,
  limit?: Limit,
): Change<V> {
  const { t } = useI18n();
  const role = useRole();
  const invalidate = useInvalidate();
  const [error, setError] = useState<string | null>(null);
  const change = useMutation<R, ApiError, V>({
    mutationFn: request,
    onMutate: () => setError(null),
    onSuccess: async (result) => {
      onDone(result);
      await invalidate(...lists);
    },
    onError: (failure) => setError(changeRefusal(t, failure, role, limit)),
  });
  return {
    mutate: (value) => {
      if (!change.isPending) change.mutate(value);
    },
    isPending: change.isPending,
    error,
    reset: () => setError(null),
  };
}

/**
 * Hands focus back to what opened a dialog once it closes; the dialogs here
 * have no Radix trigger to return to.
 */
function returnFocusTo(target: () => HTMLElement | null) {
  return (event: Event) => {
    const element = target();
    if (!element) return;
    event.preventDefault();
    element.focus();
  };
}

function DialogError({ error }: { readonly error: string | null }) {
  return error === null ? null : (
    <Alert variant="red" role="alert" className="border-0">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

function CategoriesCard({
  categories,
  rules,
  reason,
}: {
  readonly categories: readonly AchievementCategory[];
  readonly rules: readonly AchievementRule[];
  readonly reason: Reason;
}) {
  const { t } = useI18n();
  // null: closed; "new"; or the category being renamed.
  const [dialog, setDialog] = useState<AchievementCategory | "new" | null>(
    null,
  );
  const opener = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const open = (
    target: AchievementCategory | "new",
    event: { readonly currentTarget: HTMLElement },
  ) => {
    opener.current = event.currentTarget;
    setDialog(target);
  };
  const shown = categories.filter((category) => category.archived_at === null);
  return (
    <RulesSection
      title={t("achievementRules.category.title")}
      count={shown.length}
      description={t("achievementRules.category.description")}
    >
      <div ref={list} className="flex flex-wrap items-center gap-2 py-3">
        <ul className="m-0 contents list-none p-0">
          {shown.map((category) => (
            <li
              key={category.id}
              className="inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-3"
            >
              {category.name}
              <Text as="span" variant="meta">
                {t("achievementRules.category.rules", {
                  count: rules.filter(
                    (rule) => rule.category_id === category.id,
                  ).length,
                })}
              </Text>
              <ReasonButton
                className={buttonVariants({
                  variant: "ghost",
                  size: "sm",
                  className: "h-6 rounded-full text-caption",
                })}
                reason={reason}
                aria-label={t("achievementRules.category.renameOf", {
                  name: category.name,
                })}
                onClick={(event) => open(category, event)}
              >
                {t("achievementRules.category.rename")}
              </ReasonButton>
            </li>
          ))}
        </ul>
        <ReasonButton
          className={SMALL_BUTTON}
          reason={reason}
          onClick={(event) => open("new", event)}
        >
          {t("achievementRules.category.add")}
        </ReasonButton>
      </div>
      {dialog === null ? null : (
        // Mounted only while open: each opening starts from the saved name.
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setDialog(null);
          }}
        >
          <DialogContent onCloseAutoFocus={returnFocusTo(() => opener.current)}>
            <CategoryForm
              category={dialog === "new" ? undefined : dialog}
              inUse={
                dialog !== "new" &&
                rules.some(
                  (rule) =>
                    rule.category_id === dialog.id && rule.disabled_at === null,
                )
              }
              onDone={() => setDialog(null)}
              // The archived category's button leaves the list with it.
              onArchived={() => {
                // The add button sits beside the list, not in it.
                opener.current =
                  list.current?.querySelector<HTMLElement>(":scope > button") ??
                  null;
                setDialog(null);
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </RulesSection>
  );
}

function CategoryForm({
  category,
  inUse,
  onDone,
  onArchived,
}: {
  readonly category: AchievementCategory | undefined;
  readonly inUse: boolean;
  readonly onDone: () => void;
  readonly onArchived: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const [name, setName] = useState(category?.name ?? "");
  const lists = ["achievement-categories", "achievement-rules"];
  const save = useChange<string, AchievementCategoryChangeResponse>(
    (value) =>
      unwrap(
        category
          ? client.PATCH("/v1/achievement-categories/{id}", {
              params: { path: { id: category.id } },
              body: { name: value },
            })
          : client.POST("/v1/achievement-categories", {
              body: { name: value },
            }),
      ),
    lists,
    onDone,
  );
  const archive = useChange<string, AchievementCategoryChangeResponse>(
    (id) =>
      unwrap(
        client.POST("/v1/achievement-categories/{id}/archive", {
          params: { path: { id } },
        }),
      ),
    lists,
    onArchived,
  );
  const pending = save.isPending || archive.isPending;
  const title = category
    ? t("achievementRules.category.renameOf", { name: category.name })
    : t("achievementRules.category.add");

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        archive.reset();
        save.mutate(name.trim());
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogError error={save.error ?? archive.error} />
      <Field>
        <FieldLabel>{t("achievementRules.category.name")}</FieldLabel>
        <Input
          autoComplete="off"
          maxLength={ACHIEVEMENT_CATEGORY_NAME_MAX}
          value={name}
          readOnly={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <DialogFooter>
        {category ? (
          <ReasonButton
            className={buttonVariants({
              variant: "danger",
              className: "sm:mr-auto",
            })}
            reason={inUse ? t("achievementRules.category.inUse") : undefined}
            aria-disabled={pending || undefined}
            onClick={() => {
              save.reset();
              archive.mutate(category.id);
            }}
          >
            {t("achievementRules.category.archive")}
          </ReasonButton>
        ) : null}
        <Button type="button" variant="outline" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" aria-disabled={pending || undefined}>
          {t("achievementRules.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function typeFields(t: Translate, type: AchievementType): string {
  if (type.builtin && type.key in BUILTIN_FIELDS) {
    return t(BUILTIN_FIELDS[type.key as keyof typeof BUILTIN_FIELDS]);
  }
  return t("achievementRules.fields.custom");
}

function TypesCard({
  types,
  rules,
  reason,
}: {
  readonly types: readonly AchievementType[];
  readonly rules: readonly AchievementRule[];
  readonly reason: Reason;
}) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<AchievementType | "new" | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = (
    target: AchievementType | "new",
    event: { readonly currentTarget: HTMLElement },
  ) => {
    opener.current = event.currentTarget;
    setDialog(target);
  };
  const shown = types.filter((type) => type.archived_at === null);
  const k = {
    name: t("achievementRules.type.name"),
    key: t("achievementRules.type.key"),
    evidence: t("achievementRules.type.evidence"),
    fields: t("achievementRules.type.fieldsShort"),
    rules: t("achievementRules.type.rulesShort"),
  };
  return (
    <RulesSection
      title={t("achievementRules.type.title")}
      count={shown.length}
      description={t("achievementRules.type.description")}
      foot={
        <>
          <Text as="span" variant="meta">
            {t("achievementRules.type.kinds")}
          </Text>
          <ReasonButton
            className={SMALL_BUTTON}
            reason={reason}
            onClick={(event) => open("new", event)}
          >
            {t("achievementRules.type.add")}
          </ReasonButton>
        </>
      }
    >
      <TableContainer
        label={t("achievementRules.type.title")}
        className={TABLE_FRAME}
      >
        <Table className={STACK_TABLE}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" variant="nowrap">
                {k.name}
              </TableHead>
              <TableHead scope="col" variant="nowrap">
                {k.key}
              </TableHead>
              <TableHead scope="col" variant="nowrap">
                {k.evidence}
              </TableHead>
              <TableHead scope="col" variant="nowrap">
                {t("achievementRules.type.fields")}
              </TableHead>
              {/* The other columns keep their content's width; the text
                  column's 10rem floor would push the buttons out of view. */}
              <TableHead scope="col" variant="text" className="min-w-24">
                {t("achievementRules.type.rules")}
              </TableHead>
              <TableHead scope="col" variant="actions">
                <Text as="span" className="sr-only">
                  {t("achievementRules.type.rename")}
                </Text>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((type) => (
              <TableRow key={type.id}>
                <TableCell
                  data-k={k.name}
                  variant="nowrap"
                  className={STACK_CELL}
                >
                  {type.name}{" "}
                  {type.builtin ? (
                    <Badge variant="gray">
                      {t("achievementRules.type.builtin")}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell
                  data-k={k.key}
                  variant="nowrap"
                  className={STACK_CELL}
                >
                  <Code>{type.key}</Code>
                </TableCell>
                <TableCell
                  data-k={k.evidence}
                  variant="nowrap"
                  className={STACK_CELL}
                >
                  {t(`achievementRules.evidence.${type.evidence_kind}`)}
                </TableCell>
                <TableCell
                  data-k={k.fields}
                  variant="nowrap"
                  className={STACK_CELL}
                >
                  {typeFields(t, type)}
                </TableCell>
                <TableCell
                  data-k={k.rules}
                  variant="text"
                  className={`${STACK_CELL} min-w-24 [overflow-wrap:anywhere]`}
                >
                  {rules
                    .filter((rule) => rule.type_id === type.id)
                    .map((rule) => rule.title)
                    .join(", ")}
                </TableCell>
                <TableCell data-k="" variant="actions" className={STACK_CELL}>
                  {type.builtin ? null : (
                    <ReasonButton
                      className={SMALL_BUTTON}
                      reason={reason}
                      aria-label={t("achievementRules.type.renameOf", {
                        name: type.name,
                      })}
                      onClick={(event) => open(type, event)}
                    >
                      {t("achievementRules.type.rename")}
                    </ReasonButton>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <TypeDialog
        open={dialog !== null}
        type={dialog === "new" || dialog === null ? undefined : dialog}
        onClose={() => setDialog(null)}
        returnFocus={() => opener.current}
      />
    </RulesSection>
  );
}

function TypeDialog({
  open,
  type,
  onClose,
  onCreated,
  returnFocus,
}: {
  readonly open: boolean;
  readonly type: AchievementType | undefined;
  readonly onClose: () => void;
  readonly onCreated?: (type: AchievementType) => void;
  readonly returnFocus: () => HTMLElement | null;
}) {
  if (!open) return null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent onCloseAutoFocus={returnFocusTo(returnFocus)}>
        <TypeForm type={type} onClose={onClose} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

function TypeForm({
  type,
  onClose,
  onCreated,
}: {
  readonly type: AchievementType | undefined;
  readonly onClose: () => void;
  readonly onCreated: ((type: AchievementType) => void) | undefined;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const [name, setName] = useState(type?.name ?? "");
  const [key, setKey] = useState("");
  const [evidence, setEvidence] = useState<AchievementEvidenceKind>(
    "github_pull_request",
  );
  const save = useChange<void, AchievementTypeChangeResponse>(
    () =>
      unwrap(
        type
          ? client.PATCH("/v1/achievement-types/{id}", {
              params: { path: { id: type.id } },
              body: { name: name.trim() },
            })
          : client.POST("/v1/achievement-types", {
              body: {
                key: key.trim(),
                name: name.trim(),
                evidence_kind: evidence,
              },
            }),
      ),
    ["achievement-types"],
    (result) => {
      if (!type) onCreated?.(result.type);
      onClose();
    },
    "type",
  );

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {type
            ? t("achievementRules.type.renameOf", { name: type.name })
            : t("achievementRules.type.add")}
        </DialogTitle>
      </DialogHeader>
      <DialogError error={save.error} />
      <Field>
        <FieldLabel>{t("achievementRules.type.name")}</FieldLabel>
        <Input
          autoComplete="off"
          maxLength={ACHIEVEMENT_TYPE_NAME_MAX}
          value={name}
          readOnly={save.isPending}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      {type ? null : (
        <>
          <Field>
            <FieldLabel>{t("achievementRules.type.key")}</FieldLabel>
            <Input
              autoComplete="off"
              className="font-mono"
              value={key}
              readOnly={save.isPending}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>{t("achievementRules.type.evidence")}</FieldLabel>
            <NativeSelect
              value={evidence}
              disabled={save.isPending}
              onChange={(event) =>
                setEvidence(event.target.value as AchievementEvidenceKind)
              }
            >
              {EVIDENCE_KINDS.map((kind) => (
                <NativeSelectOption key={kind} value={kind}>
                  {t(`achievementRules.evidence.${kind}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" aria-disabled={save.isPending || undefined}>
          {t("achievementRules.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RulesCard({
  categories,
  types,
  rules,
  reason,
  onEdit,
  onOutcome,
}: {
  readonly categories: readonly AchievementCategory[];
  readonly types: readonly AchievementType[];
  readonly rules: readonly AchievementRule[];
  readonly reason: Reason;
  readonly onEdit: (familyId: string) => void;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const invalidate = useInvalidate();
  const usage = useUsage("30");
  const typeOf = new Map(types.map((type) => [type.id, type]));
  const counts = new Map(
    (usage.data?.by_rule ?? []).map((row) => [row.family_id, row]),
  );
  // The server lists rules by their category's order; keep it.
  const groups: { id: string; rules: AchievementRule[] }[] = [];
  for (const rule of rules) {
    const last = groups.at(-1);
    if (last?.id === rule.category_id) last.rules.push(rule);
    else groups.push({ id: rule.category_id, rules: [rule] });
  }
  const toggle = useMutation<
    AchievementRuleChangeResponse,
    ApiError,
    { readonly familyId: string; readonly on: boolean }
  >({
    mutationFn: ({ familyId, on }) =>
      unwrap(
        client.POST(
          on
            ? "/v1/achievement-rules/{family_id}/enable"
            : "/v1/achievement-rules/{family_id}/disable",
          { params: { path: { family_id: familyId } } },
        ),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: () => invalidate("achievement-rules"),
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: changeRefusal(t, error, role, "rule"),
      }),
  });
  const k = {
    title: t("achievementRules.rules.ruleTitle"),
    type: t("achievementRules.rules.typeShort"),
    judge: t("achievementRules.rules.judge"),
    version: t("achievementRules.rules.version"),
    recent: t("achievementRules.rules.recent"),
    use: t("achievementRules.rules.use"),
  };

  return (
    <RulesSection
      title={t("achievementRules.rules.title")}
      count={rules.length}
      description={t("achievementRules.rules.description")}
    >
      <TableContainer
        label={t("achievementRules.rules.title")}
        className={TABLE_FRAME}
      >
        <Table className={STACK_TABLE}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" variant="text">
                {k.title}
              </TableHead>
              <TableHead scope="col" variant="nowrap">
                {t("achievementRules.rules.type")}
              </TableHead>
              <TableHead scope="col" variant="nowrap">
                {k.judge}
              </TableHead>
              <TableHead scope="col" variant="nowrap">
                {k.version}
              </TableHead>
              {usage.readable ? (
                <TableHead scope="col" variant="nowrap" className={NUM}>
                  {k.recent}
                </TableHead>
              ) : null}
              <TableHead scope="col" variant="nowrap">
                {k.use}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <RuleGroup
                key={group.id}
                columns={usage.readable ? 6 : 5}
                name={
                  categories.find((category) => category.id === group.id)
                    ?.name ?? ""
                }
              >
                {group.rules.map((rule) => {
                  const type = typeOf.get(rule.type_id);
                  const count = counts.get(rule.family_id);
                  return (
                    <TableRow key={rule.family_id}>
                      <TableCell
                        data-k={k.title}
                        variant="text"
                        className={STACK_CELL}
                      >
                        <Button
                          type="button"
                          variant="link"
                          className="h-auto min-w-0 shrink whitespace-normal p-0 text-left font-normal [overflow-wrap:anywhere]"
                          aria-controls={EDITOR_ID}
                          onClick={() => onEdit(rule.family_id)}
                        >
                          {rule.title}
                        </Button>
                      </TableCell>
                      <TableCell
                        data-k={k.type}
                        variant="nowrap"
                        className={STACK_CELL}
                      >
                        <Code>{type?.key ?? ""}</Code>
                      </TableCell>
                      <TableCell
                        data-k={k.judge}
                        variant="nowrap"
                        className={STACK_CELL}
                      >
                        {rule.judge === "luna" ? (
                          <Badge variant="blue">
                            {t("achievementRules.rules.luna")}
                          </Badge>
                        ) : (
                          <Badge variant="gray">
                            {t("achievementRules.rules.always")}
                          </Badge>
                        )}{" "}
                        {type && NEEDS_REVIEW.has(type.evidence_kind) ? (
                          <Badge variant="amber">
                            {t("achievementRules.rules.review")}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell
                        data-k={k.version}
                        variant="nowrap"
                        className={STACK_CELL}
                      >
                        {t("achievements.version", { version: rule.version })}
                      </TableCell>
                      {usage.readable ? (
                        <TableCell
                          data-k={k.recent}
                          variant="nowrap"
                          className={`${STACK_CELL} ${NUM}`}
                        >
                          {usage.data ? (count?.achievement_count ?? 0) : "—"}
                          {count && count.needs_review_count > 0 ? (
                            <>
                              {" "}
                              <Text as="span" variant="meta">
                                {t("achievementRules.rules.waiting", {
                                  count: count.needs_review_count,
                                })}
                              </Text>
                            </>
                          ) : null}
                        </TableCell>
                      ) : null}
                      <TableCell
                        data-k={k.use}
                        variant="nowrap"
                        className={STACK_CELL}
                      >
                        <Switch
                          // Inline, it sits on the cell's text baseline, 1.8px above centre.
                          className="flex"
                          aria-label={t("achievementRules.rules.useOf", {
                            title: rule.title,
                          })}
                          checked={rule.disabled_at === null}
                          disabled={reason !== undefined}
                          aria-disabled={toggle.isPending || undefined}
                          onCheckedChange={(on) => {
                            if (!toggle.isPending) {
                              toggle.mutate({ familyId: rule.family_id, on });
                            }
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </RuleGroup>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </RulesSection>
  );
}

function RuleGroup({
  name,
  columns,
  children,
}: {
  readonly name: string;
  readonly columns: number;
  readonly children: ReactNode;
}) {
  return (
    <>
      <TableRow className="bg-surface-sunken">
        <TableCell
          colSpan={columns}
          className="font-medium max-md:block max-md:px-0 max-md:py-0 max-md:first:pl-0"
        >
          {name}
        </TableCell>
      </TableRow>
      {children}
    </>
  );
}

interface RuleDraft {
  readonly category_id: string;
  readonly title: string;
  readonly type_id: string;
  readonly definition: string;
  readonly judge: AchievementRuleJudge;
}

/**
 * The types a rule may count: none another rule in use counts already, its
 * own included, as the server refuses a version that takes one.
 */
export function pickableTypes(
  types: readonly AchievementType[],
  rules: readonly AchievementRule[],
  familyId: string | undefined,
): AchievementType[] {
  const taken = new Set(
    rules
      .filter(
        (rule) => rule.disabled_at === null && rule.family_id !== familyId,
      )
      .map((rule) => rule.type_id),
  );
  return types.filter(
    (type) => type.archived_at === null && !taken.has(type.id),
  );
}

function RuleEditor({
  rule,
  categories,
  types,
  rules,
  reason,
  onClose,
  onOutcome,
}: {
  readonly rule: AchievementRule | undefined;
  readonly categories: readonly AchievementCategory[];
  readonly types: readonly AchievementType[];
  readonly rules: readonly AchievementRule[];
  readonly reason: Reason;
  readonly onClose: () => void;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const invalidate = useInvalidate();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const pickable = pickableTypes(types, rules, rule?.family_id);
  const shownCategories = categories.filter(
    (category) =>
      category.archived_at === null || category.id === rule?.category_id,
  );
  const [draft, setDraft] = useState<RuleDraft>(() =>
    rule
      ? {
          category_id: rule.category_id,
          title: rule.title,
          // A type taken since, or archived, would be refused; start from
          // one the rule may count, as the select shows it.
          type_id: pickable.some((type) => type.id === rule.type_id)
            ? rule.type_id
            : (pickable[0]?.id ?? ""),
          definition: rule.definition,
          judge: rule.judge,
        }
      : {
          category_id: shownCategories[0]?.id ?? "",
          title: "",
          type_id: pickable[0]?.id ?? "",
          definition: "",
          judge: "always",
        },
  );
  const set = (patch: Partial<RuleDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const [makingType, setMakingType] = useState(false);
  const listsMembers = useHasPermission("member.manage");
  const creator = useQuery({
    ...memberSummariesQuery(client, rule ? [rule.created_by] : []),
    enabled: listsMembers && rule !== undefined,
  });
  const creatorName = creator.data?.items.find(
    (member) => member.user_id === rule?.created_by,
  )?.display_name;
  const type = types.find((candidate) => candidate.id === draft.type_id);
  const ids = {
    category: useId(),
    title: useId(),
    type: useId(),
    definition: useId(),
    judge: useId(),
  };

  useEffect(() => {
    titleRef.current?.scrollIntoView?.({ block: "start" });
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  const save = useMutation<AchievementRuleChangeResponse, ApiError>({
    mutationFn: () => {
      const body = {
        category_id: draft.category_id,
        title: draft.title.trim(),
        type_id: draft.type_id,
        definition: draft.definition,
        judge: draft.judge,
      };
      return unwrap(
        rule
          ? client.POST("/v1/achievement-rules/{family_id}/versions", {
              params: { path: { family_id: rule.family_id } },
              body,
            })
          : client.POST("/v1/achievement-rules", { body }),
      );
    },
    onMutate: () => onOutcome(null),
    onSuccess: async (result) => {
      onOutcome({
        kind: "notice",
        text: t("achievementRules.edit.saved", {
          title: result.rule.title,
          version: result.rule.version,
        }),
      });
      onClose();
      await invalidate("achievement-rules");
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: changeRefusal(t, error, role, "rule"),
      }),
  });

  const locked = reason !== undefined || save.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending || reason !== undefined) return;
    save.mutate();
  };
  const evidenceName = type
    ? t(`achievementRules.evidence.${type.evidence_kind}`)
    : "";
  const fields = type
    ? type.builtin
      ? typeFields(t, type)
      : t("achievementRules.edit.customFields", { evidence: evidenceName })
    : "";
  const pullRequest = type?.evidence_kind === "github_pull_request";

  // Beside the form, not in it: a portal's submit still bubbles through the
  // React tree and would save the rule as well.
  const typeDialog = (
    <TypeDialog
      open={makingType}
      type={undefined}
      onClose={() => setMakingType(false)}
      onCreated={(created) => set({ type_id: created.id })}
      returnFocus={() => document.getElementById(ids.type)}
    />
  );

  return (
    <>
      {typeDialog}
      <RulesSection
        id={EDITOR_ID}
        titleRef={titleRef}
        title={
          rule
            ? t("achievementRules.edit.title", { title: rule.title })
            : t("achievementRules.addRule")
        }
        description={
          rule
            ? creatorName === undefined
              ? t("achievementRules.edit.meta", {
                  version: rule.version,
                  date: rule.created_at.slice(0, 10),
                })
              : t("achievementRules.edit.metaBy", {
                  version: rule.version,
                  date: rule.created_at.slice(0, 10),
                  // Korean marks the maker with a particle the name decides.
                  name:
                    locale === "ko"
                      ? `${creatorName}${subjectParticle(creatorName)}`
                      : creatorName,
                })
            : ""
        }
        onSubmit={submit}
        foot={
          <>
            <Text as="span" variant="meta">
              {rule ? (
                <Marked
                  template={(slot) =>
                    t("achievementRules.edit.nextVersion", { version: slot })
                  }
                  mark={`v${rule.version + 1}`}
                />
              ) : null}
            </Text>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onClose}
              >
                {t("common.cancel")}
              </Button>
              <ReasonButton
                type="submit"
                className={buttonVariants({ size: "sm" })}
                reason={reason}
                aria-disabled={save.isPending || undefined}
              >
                {rule
                  ? t("achievementRules.edit.saveVersion")
                  : t("achievementRules.save")}
              </ReasonButton>
            </div>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
            <Field>
              <FieldLabel htmlFor={ids.category}>
                {t("achievementRules.edit.category")}
              </FieldLabel>
              <NativeSelect
                id={ids.category}
                value={draft.category_id}
                disabled={locked}
                onChange={(event) => set({ category_id: event.target.value })}
              >
                {shownCategories.map((category) => (
                  <NativeSelectOption key={category.id} value={category.id}>
                    {category.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor={ids.title}>
                {t("achievementRules.edit.ruleTitle")}
              </FieldLabel>
              <Input
                id={ids.title}
                autoComplete="off"
                maxLength={ACHIEVEMENT_RULE_TITLE_MAX}
                value={draft.title}
                disabled={locked}
                onChange={(event) => set({ title: event.target.value })}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor={ids.type}>
              {t("achievementRules.edit.type")}
            </FieldLabel>
            <div className="max-w-85 *:w-full max-md:max-w-none">
              <NativeSelect
                id={ids.type}
                value={draft.type_id}
                disabled={locked}
                onChange={(event) => {
                  if (event.target.value === NEW_TYPE) setMakingType(true);
                  else set({ type_id: event.target.value });
                }}
              >
                {pickable.map((option) => (
                  <NativeSelectOption key={option.id} value={option.id}>
                    {t("achievementRules.edit.typeOption", {
                      key: option.key,
                      name: option.name,
                      evidence: t(
                        `achievementRules.evidence.${option.evidence_kind}`,
                      ),
                    })}
                  </NativeSelectOption>
                ))}
                <NativeSelectOption value={NEW_TYPE}>
                  {t("achievementRules.edit.newType")}
                </NativeSelectOption>
              </NativeSelect>
            </div>
            <FieldDescription>
              {t("achievementRules.edit.typeHint", { fields })}
              {pullRequest && !type?.builtin
                ? ` ${t("achievementRules.edit.prStateHint")}`
                : null}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={ids.definition}>
              {t("achievementRules.edit.definition")}
            </FieldLabel>
            <Textarea
              id={ids.definition}
              rows={4}
              maxLength={ACHIEVEMENT_RULE_DEFINITION_MAX}
              value={draft.definition}
              disabled={locked}
              onChange={(event) => set({ definition: event.target.value })}
            />
            <FieldDescription>
              {t("achievementRules.edit.length", {
                count: draft.definition.length,
                max: ACHIEVEMENT_RULE_DEFINITION_MAX,
              })}
              {pullRequest
                ? ` · ${t("achievementRules.edit.prDefinitionHint")}`
                : null}
            </FieldDescription>
          </Field>
          <FieldSet>
            <FieldLegend id={ids.judge} variant="label">
              {t("achievementRules.edit.judge")}
            </FieldLegend>
            <RadioGroup
              aria-labelledby={ids.judge}
              value={draft.judge}
              disabled={locked}
              onValueChange={(value) =>
                set({ judge: value as AchievementRuleJudge })
              }
              className="gap-2"
            >
              {(["always", "luna"] as const).map((value) => (
                <Field key={value} orientation="horizontal">
                  <RadioGroupItem value={value} />
                  <FieldLabel className="font-normal">
                    {t(
                      value === "always"
                        ? "achievementRules.edit.always"
                        : "achievementRules.edit.luna",
                    )}
                  </FieldLabel>
                </Field>
              ))}
            </RadioGroup>
          </FieldSet>
          <div className="flex flex-col gap-1.5">
            <Text as="div" weight="medium">
              {t("achievementRules.edit.agents")}
            </Text>
            <Text>{t("achievementRules.edit.allAgents")}</Text>
            <Text variant="meta">{t("achievementRules.edit.agentsLater")}</Text>
          </div>
        </div>
      </RulesSection>
    </>
  );
}
