import {
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Link,
  lazyRouteComponent,
  useBlocker,
  useRouter,
} from "@tanstack/react-router";
import { type ApiClient, unwrap } from "@werft-ai/client";
import type {
  AgentDetail,
  ListConnectionOptionsResponse,
  SaveAgentResponse,
} from "@werft-ai/contracts";
import { agentCardStep, agentIdentityStep } from "@werft-ai/core/forms";
import {
  formAlerts,
  type StepForm,
  submitStep,
  useStepForm,
  useStepper,
  useWerft,
} from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  KeyValueList,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
  Stepper,
  Text,
  Textarea,
} from "@werft-ai/ui";
import {
  type ReactNode,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useWatch } from "react-hook-form";
import type { z } from "zod";
import {
  agentListsFilter,
  agentQuery,
  connectionsQuery,
  queryKeysOf,
  scopedKey,
} from "../api/queries.ts";
import { useRole } from "../auth/guard.tsx";
import { AGENT_DESCRIPTION_MAX_LENGTH } from "../auth/limits.ts";
import { FunnelResetNotice, useFunnel } from "../funnel/tanstack-funnel.tsx";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";
import { saveFailureText } from "../routes/agent-detail/effective-behavior.tsx";
import {
  AGENT_FORM,
  AgentCardFields,
  CARD_ERROR_FIELDS,
  type CardDraft,
  type CardErrors,
  cardDraftOf,
  EMPTY_DRAFT,
  toApiCard,
} from "./agent-card-form.tsx";
import {
  PreviewChat,
  PublishDialog,
  releaseOf,
  usePublishAgent,
} from "./agent-preview.tsx";
import { agentRefusal } from "./agent-refusal.ts";
import { FormError, Notice } from "./auth-page.tsx";
import { LoadFailure } from "./load-failure.tsx";
import { useTeamChoices } from "./managing-team.tsx";
import { StepHeading, useStepMoved } from "./step-heading.tsx";

const SlackConnect = lazyRouteComponent(
  () => import("../routes/agent-detail/slack.tsx"),
  "SlackConnect",
);

/**
 * `flow` names one run of the flow; every step's input carries it. `card` is
 * the job step's input as typed, kept so a reload does not lose it.
 */
type Steps = {
  channels: {
    flow: string;
    name: string;
    slug: string;
    agentId: string;
    card?: unknown;
  };
  preview: {
    flow: string;
    name: string;
    slug: string;
    agentId: string;
    releaseId: string;
    card?: unknown;
  };
  name: {
    flow: string;
    name?: string;
    slug?: string;
    description?: string;
    managing_team_id?: string;
  };
  job: {
    flow: string;
    name: string;
    slug: string;
    description?: string;
    managing_team_id?: string;
    card?: unknown;
  };
};

const hasText = (data: unknown, keys: readonly string[]) =>
  typeof data === "object" &&
  data !== null &&
  keys.every(
    (key) => typeof (data as Record<string, unknown>)[key] === "string",
  );

const STEP_IDS = ["name", "job", "preview", "channels"] as const;
const STEP_LABEL = {
  channels: "agents.flow.channels",
  preview: "agents.flow.preview",
  name: "agents.flow.name",
  job: "agents.flow.job",
} as const satisfies Record<keyof Steps, MessageKey>;
/** What the summary beside the form says comes after each step. */
const STEP_NEXT = {
  name: "agents.summary.next.name",
  job: "agents.summary.next.job",
  preview: "agents.summary.next.preview",
  channels: "agents.summary.next.channels",
} as const satisfies Record<keyof Steps, MessageKey>;

const NEW_CARD_STEP = agentCardStep();
const CARD_FIELDS = Object.keys(EMPTY_DRAFT) as (keyof CardDraft)[];
const KEEP_INPUT_DELAY_MS = 300;

/**
 * The slug a name suggests: what is left of it in lowercase kebab-case. A
 * name with no Latin letters or digits suggests nothing.
 */
function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/** JSON with object keys sorted, so two equal cards compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

const latestCard = (detail: AgentDetail) =>
  [...detail.versions].sort((a, b) => b.version_no - a.version_no)[0]?.card;

/** What the job step saved, kept per flow so a reload or a return finds it. */
interface SavedDraft {
  readonly agentId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly managingTeamId: string | null;
  readonly managingTeamName: string;
  readonly card: CardDraft;
  readonly connectionId: string | null;
  /** The release the last save made; the preview tries it. */
  readonly releaseId: string | null;
  /** Set once the publish went through; channels open only after it. */
  readonly published: boolean;
}

/** The start of every flow id of who is signed in, in their workspace. */
const flowOwner = (client: ApiClient) => {
  const [{ actor, workspace }] = scopedKey(client);
  return `${actor}@${workspace}/`;
};

const draftKey = (flow: string) => `new-agent.${flow}`;

function readDraft(flow: string): SavedDraft | null {
  try {
    const raw = sessionStorage.getItem(draftKey(flow));
    if (!raw) return null;
    const draft = JSON.parse(raw) as SavedDraft;
    // The agent was saved, so the draft stays even when its input does not.
    return {
      ...draft,
      description:
        typeof draft.description === "string" ? draft.description : "",
      managingTeamId:
        typeof draft.managingTeamId === "string" ? draft.managingTeamId : null,
      managingTeamName:
        typeof draft.managingTeamName === "string"
          ? draft.managingTeamName
          : "",
      card: cardDraftOf(draft.card) ?? EMPTY_DRAFT,
      connectionId:
        typeof draft.connectionId === "string" ? draft.connectionId : null,
      releaseId: typeof draft.releaseId === "string" ? draft.releaseId : null,
      published: draft.published === true,
    };
  } catch {
    return null;
  }
}

function writeDraft(flow: string, draft: SavedDraft) {
  try {
    sessionStorage.setItem(draftKey(flow), JSON.stringify(draft));
  } catch {
    // Without storage the draft is known only while this page stays open.
  }
}

export function NewAgentFlow({
  refuse,
}: {
  /** The sentence for a refused request. */
  readonly refuse: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const owner = flowOwner(client);
  const [newFlow] = useState(() => `${owner}${crypto.randomUUID()}`);
  // Input this tab kept from someone else signed in before fails every
  // guard, so the flow starts over instead of showing it.
  const ours = (data: unknown, keys: readonly string[]) =>
    hasText(data, keys) && (data as { flow: string }).flow.startsWith(owner);
  const funnel = useFunnel<Steps>({
    id: "new-agent",
    initial: { step: "name", context: { flow: newFlow } },
    steps: {
      // Channels open only once the agent is published.
      channels: {
        guard: (data): data is Steps["channels"] =>
          ours(data, ["flow", "name", "slug", "agentId"]) &&
          readDraft((data as { flow: string }).flow)?.published === true,
      },
      preview: {
        guard: (data): data is Steps["preview"] =>
          ours(data, ["flow", "name", "slug", "agentId", "releaseId"]),
      },
      name: {
        guard: (data): data is Steps["name"] => ours(data, ["flow"]),
      },
      job: {
        // A job step kept from before the team was asked for starts over,
        // unless its agent is already saved.
        guard: (data): data is Steps["job"] =>
          ours(data, ["flow", "name", "slug"]) &&
          (hasText(data, ["managing_team_id"]) ||
            readDraft((data as { flow: string }).flow) !== null),
      },
    },
  });
  const { flow } = funnel.context;
  const restored = funnel.context as Partial<Steps["job"]>;
  // The draft this flow saved; going back to the first steps edits it.
  const [saved, setSaved] = useState(() => readDraft(flow));
  const identity = useStepForm(agentIdentityStep, {
    defaultValues: {
      name: restored.name ?? saved?.name ?? "",
      slug: restored.slug ?? saved?.slug ?? "",
      description:
        (typeof restored.description === "string"
          ? restored.description
          : undefined) ??
        saved?.description ??
        "",
    },
  });
  const [team, setTeam] = useState(
    (typeof restored.managing_team_id === "string"
      ? restored.managing_team_id
      : undefined) ??
      saved?.managingTeamId ??
      "",
  );
  // The first entry holds no context until written, so coming back to it
  // would start a new flow, apart from the draft this one saved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival
  useEffect(() => {
    if (funnel.index === 0)
      void funnel.history.replace(funnel.step, funnel.context);
  }, []);
  const card = useStepForm(NEW_CARD_STEP, {
    defaultValues: cardDraftOf(restored.card) ?? saved?.card ?? EMPTY_DRAFT,
  });
  const [connectionId, setConnectionId] = useState<string>(
    saved?.connectionId ?? "",
  );
  const [releaseFailure, setReleaseFailure] = useState<string | null>(null);
  const cardInput = useWatch({ control: card.control }) as CardDraft;
  const identityInput = useWatch({ control: identity.control });
  const router = useRouter();
  const keepTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the funnel object is new each render
  useEffect(() => {
    if (funnel.step !== "job") return;
    const kept = (funnel.context as Steps["job"]).card;
    if (canonical(kept ?? EMPTY_DRAFT) === canonical(cardInput)) return;
    keepTimer.current = setTimeout(() => {
      // A back or forward lands before this component hears of it; writing
      // then would put the job step over the entry just reached.
      const at = new URLSearchParams(router.history.location.search);
      if (at.get("new-agent.step") === "job")
        void funnel.history.replace("job", { card: cardInput });
    }, KEEP_INPUT_DELAY_MS);
    return () => clearTimeout(keepTimer.current);
  }, [cardInput, funnel.step]);

  // Moving between steps keeps the input; leaving the flow drops what the
  // draft does not hold.
  const kept = saved ?? {
    name: "",
    slug: "",
    description: "",
    managingTeamId: null,
    card: EMPTY_DRAFT,
  };
  const unsaved = useRef(false);
  unsaved.current =
    identityInput.name !== kept.name ||
    identityInput.slug !== kept.slug ||
    identityInput.description !== kept.description ||
    (saved === null && team !== "") ||
    canonical(cardInput) !== canonical(kept.card);
  const leaving = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      unsaved.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => unsaved.current,
    withResolver: true,
  });
  const catalog = useQuery(connectionsQuery(client));
  const published = funnel.step === "channels";
  const moved = useStepMoved(funnel.step);
  const { choices } = useTeamChoices();

  const stepper = useStepper({
    steps: STEP_IDS.map((id) => ({ id, label: t(STEP_LABEL[id]) })),
    currentStepId: funnel.step,
    onStepSelect: (id) => {
      const at = funnel.historySteps
        .map(({ step }): string => step)
        .lastIndexOf(id);
      if (at >= 0) void funnel.history.go(at - funnel.index);
    },
  });
  const steps = stepper.steps.map((step) => ({
    ...step,
    // Once published, the stepper does not lead back to changing it here.
    disabled: step.disabled || (published && step.id !== funnel.step),
  }));
  const back = () => void funnel.history.go(-1);

  const saveAgent = async (
    values: z.output<typeof NEW_CARD_STEP>,
    context: Steps["job"],
    connection: string,
  ) => {
    const input = card.getValues();
    // An edit of the draft starts from its latest card, so fields the form
    // has no input for, set elsewhere since, survive it.
    const base = saved
      ? latestCard(
          await queryClient.fetchQuery(agentQuery(client, saved.agentId)),
        )
      : undefined;
    const sent = base ? agentCardStep(base).parse(input) : values;
    const description =
      typeof context.description === "string" ? context.description : "";
    // Saved, not published: the preview step tries it first.
    const release = { connection_id: connection, activate: false };
    const response = (await unwrap(
      saved
        ? client.PATCH("/v1/agents/{id}", {
            params: { path: { id: saved.agentId } },
            body: {
              ...(context.name !== saved.name ? { name: context.name } : {}),
              ...(description !== saved.description ? { description } : {}),
              card: toApiCard(sent),
              ...release,
            },
          })
        : client.POST("/v1/agents", {
            body: {
              slug: context.slug,
              name: context.name,
              ...(description === "" ? {} : { description }),
              // The job guard lets no unsaved flow here without a team.
              managing_team_id: context.managing_team_id ?? "",
              card: toApiCard(sent),
              ...release,
            },
          }),
    )) as SaveAgentResponse;
    const { release: outcome, ...detail } = response;
    // A save that changed nothing made no release: the one already made for
    // what it saved stands, which another admin may have made meanwhile.
    const releaseId =
      outcome.status === "saved" || outcome.status === "applied"
        ? outcome.release_id
        : outcome.status === "unchanged"
          ? (releaseOf(detail, outcome.version_id, connection)?.id ?? null)
          : null;
    const draft: SavedDraft = {
      agentId: detail.agent.id,
      name: detail.agent.name,
      slug: detail.agent.slug,
      description: detail.agent.description ?? "",
      managingTeamId: detail.agent.managing_team_id,
      managingTeamName: detail.agent.managing_team_name,
      card: input,
      connectionId: connection,
      releaseId: releaseId ?? saved?.releaseId ?? null,
      published: detail.agent.active_release_id !== null,
    };
    setSaved(draft);
    setTeam(draft.managingTeamId ?? "");
    writeDraft(flow, draft);
    // The fields show what was saved, trimmed as the server keeps it.
    identity.reset({
      name: draft.name,
      slug: draft.slug,
      description: draft.description,
    });
    queryClient.setQueryData(
      queryKeysOf(client).agent(detail.agent.id),
      detail,
    );
    await queryClient.invalidateQueries(agentListsFilter(client));
    return {
      agentId: detail.agent.id,
      card: input,
      releaseId,
      failure:
        releaseId !== null
          ? null
          : outcome.status === "superseded"
            ? t("agent.save.superseded")
            : t("agents.flow.releaseFailed", {
                reason: saveFailureText(t, outcome.reason),
              }),
    };
  };

  const markPublished = () => {
    if (!saved) return;
    const next = { ...saved, published: true };
    setSaved(next);
    writeDraft(flow, next);
  };

  const teamName =
    saved?.managingTeamName ||
    choices?.find((choice) => choice.id === team)?.name ||
    "";
  return (
    // The form keeps to a readable width; the summary takes the rest, and
    // goes under the form where there is no room beside it.
    <div className="@container">
      <div className="grid items-start gap-[var(--werft-space-block)] @4xl:grid-cols-[minmax(0,45rem)_minmax(14rem,1fr)]">
        <div className="flex min-w-0 max-w-[45rem] flex-col gap-[var(--werft-space-block)]">
          <FunnelResetNotice funnel={funnel} />
          <Stepper label={t("agents.flow.label")} {...stepper} steps={steps} />
          <funnel.Render
            name={({ history }) => (
              <NameStep
                form={identity}
                locked={saved !== null}
                focus={moved}
                team={team}
                onTeamChange={setTeam}
                onNext={(values) =>
                  history.push("job", { ...values, managing_team_id: team })
                }
              />
            )}
            job={({ context, history }) => (
              <JobStep
                form={card}
                catalog={catalog}
                focus={moved}
                connectionId={connectionId}
                onConnectionChange={setConnectionId}
                failure={releaseFailure}
                onBack={back}
                onSave={async (values, connection) => {
                  clearTimeout(keepTimer.current);
                  setReleaseFailure(null);
                  const result = await saveAgent(values, context, connection);
                  if (result.releaseId !== null) {
                    await history.push("preview", {
                      agentId: result.agentId,
                      releaseId: result.releaseId,
                      card: result.card,
                    });
                  } else {
                    setReleaseFailure(result.failure);
                  }
                }}
                refuse={refuse}
              />
            )}
            preview={({ context, history }) => (
              <PreviewStep
                focus={moved}
                agentId={context.agentId}
                releaseId={context.releaseId}
                name={context.name}
                team={teamName}
                onEdit={back}
                onPublished={async () => {
                  markPublished();
                  await history.push("channels", {
                    agentId: context.agentId,
                  });
                }}
              />
            )}
            channels={({ context }) => (
              <section className={AGENT_FORM}>
                <StepHeading focus={moved}>
                  {t("agents.flow.channels")}
                </StepHeading>
                <Notice>
                  {t("agents.flow.done", {
                    name: context.name,
                    team: teamName,
                  })}
                </Notice>
                <Suspense fallback={<Skeleton label={t("slack.working")} />}>
                  <SlackConnect agentId={context.agentId} />
                </Suspense>
                <StepFooter>
                  <LaterLink agentId={context.agentId} />
                </StepFooter>
              </section>
            )}
          />
        </div>
        <AgentSummary
          name={identityInput.name ?? ""}
          slug={identityInput.slug ?? ""}
          team={teamName}
          model={cardInput.model}
          published={published}
          next={t(STEP_NEXT[funnel.step])}
        />
      </div>
      <ConfirmDialog
        open={leaving.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) leaving.reset?.();
        }}
        title={t("agents.flow.leaveTitle")}
        consequence={t("agents.flow.leaveConsequence")}
        confirmLabel={t("agents.flow.leave")}
        cancelLabel={t("agents.flow.stay")}
        tone="danger"
        onConfirm={() => leaving.proceed?.()}
      />
    </div>
  );
}

function Alerts({ lines }: { readonly lines: readonly string[] }) {
  return lines.map((line) => <FieldError key={line}>{line}</FieldError>);
}

function NameStep({
  form,
  locked,
  focus,
  team,
  onTeamChange,
  onNext,
}: {
  readonly form: StepForm<typeof agentIdentityStep>;
  readonly locked: boolean;
  readonly focus: boolean;
  readonly team: string;
  readonly onTeamChange: (teamId: string) => void;
  readonly onNext: (values: Omit<Steps["job"], "flow">) => void;
}) {
  const { t } = useI18n();
  const { errors } = form.formState;
  const { everywhere, choices, error, refetch } = useTeamChoices();
  const [teamMissing, setTeamMissing] = useState(false);
  const typedName = useWatch({ control: form.control, name: "name" });
  const teamSelect = useId();
  const only = choices?.length === 1 ? choices[0]?.id : undefined;
  const stale =
    !locked &&
    team !== "" &&
    choices !== undefined &&
    !choices.some((choice) => choice.id === team);
  useEffect(() => {
    if (!locked && (team === "" || stale) && only !== undefined)
      onTeamChange(only);
    else if (stale) onTeamChange("");
  }, [locked, team, stale, only, onTeamChange]);
  if (error) return <LoadFailure error={error} onRetry={refetch} />;
  if (!locked && choices === undefined)
    return <Skeleton label={t("agents.flow.team")} />;
  if (!locked && choices?.length === 0)
    return (
      <section className={AGENT_FORM}>
        <StepHeading focus={focus}>{t("agents.flow.name")}</StepHeading>
        <Alert variant="amber">
          <AlertDescription>
            {t(everywhere ? "agents.flow.noTeamAdmin" : "agents.flow.noTeam")}
          </AlertDescription>
          {everywhere ? (
            <AlertActions>
              <Button asChild variant="outline" size="sm">
                <Link to="/members/teams">{t("agents.flow.toTeams")}</Link>
              </Button>
            </AlertActions>
          ) : null}
        </Alert>
      </section>
    );
  const savedTeam = choices?.find((choice) => choice.id === team)?.name;
  const derived = slugFromName(typedName ?? "");
  const name = form.register("name", {
    onChange: (event: { target: { value: string } }) => {
      // The identifier follows the name until someone types their own.
      if (!locked && !form.getFieldState("slug").isDirty)
        form.setValue("slug", slugFromName(event.target.value));
    },
  });
  return (
    <form
      className={AGENT_FORM}
      noValidate
      onSubmit={form.handleSubmit(
        (values) => {
          if (!locked && team === "") {
            setTeamMissing(true);
            document.getElementById(teamSelect)?.focus();
            return;
          }
          onNext(values);
        },
        // The form keeps focus on its first invalid field; the team only
        // needs its error shown alongside.
        () => setTeamMissing(!locked && team === ""),
      )}
    >
      {/* The name field's label right below says the same word; the step
          keeps its heading for readers and for focus. */}
      <StepHeading focus={focus} hidden>
        {t("agents.flow.name")}
      </StepHeading>
      <Field>
        <FieldLabel>{t("agents.name")}</FieldLabel>
        <Input maxLength={120} {...name} />
        <FieldError>{errors.name?.message}</FieldError>
      </Field>
      <Field>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <FieldLabel>{t("agents.slug")}</FieldLabel>
          {locked || derived === "" ? null : (
            <Text as="span" variant="meta" className="wrap-anywhere">
              {t("agents.slugFromName", { slug: derived })}
            </Text>
          )}
        </div>
        <Input maxLength={64} readOnly={locked} {...form.register("slug")} />
        <FieldDescription>
          {t(locked ? "agents.slugLocked" : "agents.slugHint")}
        </FieldDescription>
        <FieldError>
          {errors.slug?.type === "invalid_format"
            ? t("field.slugFormat")
            : errors.slug?.message}
        </FieldError>
      </Field>
      <Field>
        <FieldLabel>{t("agents.descriptionOptional")}</FieldLabel>
        <Textarea
          maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
          rows={3}
          {...form.register("description")}
        />
        <FieldDescription>{t("agents.descriptionHint")}</FieldDescription>
        <FieldError>{errors.description?.message}</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor={teamSelect}>{t("agents.flow.team")}</FieldLabel>
        {locked ? (
          <Text id={teamSelect}>{savedTeam ?? team}</Text>
        ) : (
          <NativeSelect
            id={teamSelect}
            required
            aria-invalid={teamMissing && team === ""}
            value={team}
            onChange={(event) => {
              onTeamChange(event.target.value);
              setTeamMissing(false);
            }}
          >
            <NativeSelectOption value="" disabled>
              {t("managingTeam.pickPlaceholder")}
            </NativeSelectOption>
            {choices?.map((choice) => (
              <NativeSelectOption key={choice.id} value={choice.id}>
                {choice.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <FieldDescription>
          {t(locked ? "agents.flow.teamLocked" : "agents.flow.teamHint")}
        </FieldDescription>
        <FieldError>
          {teamMissing && team === "" ? t("agents.flow.teamRequired") : null}
        </FieldError>
      </Field>
      <Alerts lines={formAlerts(errors, ["name", "slug", "description"])} />
      <StepFooter
        back={
          <Button asChild variant="outline">
            <Link to="/agents">{t("common.cancel")}</Link>
          </Button>
        }
      >
        <Button type="submit">{t("agents.flow.next")}</Button>
      </StepFooter>
    </form>
  );
}

function JobStep({
  form,
  catalog,
  focus,
  connectionId,
  onConnectionChange,
  failure,
  onBack,
  onSave,
  refuse,
}: {
  readonly form: StepForm<typeof NEW_CARD_STEP>;
  readonly catalog: UseQueryResult<ListConnectionOptionsResponse>;
  readonly focus: boolean;
  readonly connectionId: string;
  readonly onConnectionChange: (connectionId: string) => void;
  readonly failure: string | null;
  readonly onBack: () => void;
  readonly onSave: (
    card: z.output<typeof NEW_CARD_STEP>,
    connectionId: string,
  ) => Promise<unknown>;
  readonly refuse: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const draft = useWatch({ control: form.control }) as CardDraft;
  const { errors, isSubmitted, isSubmitting } = form.formState;
  // Until one is picked, the first connection listed.
  const chosen =
    connectionId !== "" ? connectionId : (catalog.data?.items[0]?.id ?? "");
  const connection = catalog.data?.items.find((item) => item.id === chosen);
  // The card's model has to be one the chosen connection offers.
  const runs = connection?.models.includes(draft.model) === true;
  const change = (next: CardDraft) => {
    for (const key of CARD_FIELDS)
      if (next[key] !== draft[key])
        form.setValue(key, next[key], {
          shouldDirty: true,
          shouldValidate: isSubmitted,
        });
  };
  const fieldErrors: CardErrors = Object.fromEntries(
    CARD_ERROR_FIELDS.map((key) => [key, errors[key]?.message]),
  );
  return (
    <form
      className={AGENT_FORM}
      noValidate
      onSubmit={submitStep(
        form,
        async (values) => {
          if (runs) await onSave(values, chosen);
        },
        refuse,
      )}
    >
      <StepHeading focus={focus}>{t("agents.flow.job")}</StepHeading>
      <Text variant="sub">{t("agents.flow.jobIntro")}</Text>
      <AgentCardFields
        draft={draft}
        catalog={catalog}
        connectionId={chosen}
        onConnectionChange={onConnectionChange}
        onChange={change}
        errors={fieldErrors}
      />
      <Alerts lines={formAlerts(errors, CARD_ERROR_FIELDS)} />
      {catalog.isSuccess && !runs && draft.model !== "" ? (
        <Alerts lines={[t("agents.flow.noConnection")]} />
      ) : null}
      {failure ? <Alerts lines={[failure]} /> : null}
      <StepFooter
        back={
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={onBack}
          >
            {t("agents.flow.back")}
          </Button>
        }
      >
        <Button
          type="submit"
          disabled={
            isSubmitting || !catalog.isSuccess || (draft.model !== "" && !runs)
          }
        >
          {isSubmitting ? t("agents.flow.saving") : t("agents.flow.saveNext")}
        </Button>
      </StepFooter>
    </form>
  );
}

/**
 * Tries the saved release in a preview session, then publishes it. Until
 * then only the agent's admins and the workspace's admins see the agent.
 */
function PreviewStep({
  focus,
  agentId,
  releaseId,
  name,
  team,
  onEdit,
  onPublished,
}: {
  readonly focus: boolean;
  readonly agentId: string;
  readonly releaseId: string;
  readonly name: string;
  readonly team: string;
  readonly onEdit: () => void;
  readonly onPublished: () => Promise<void>;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const publish = usePublishAgent(agentId);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = () => {
    setFailure(null);
    // The revision the save left; a refused publish reads it again below.
    const seen = queryClient.getQueryData(agentQuery(client, agentId).queryKey)
      ?.agent.activation_revision;
    publish.mutate(
      { releaseId, expected: seen ?? -1 },
      {
        onSuccess: async () => {
          setConfirming(false);
          await onPublished();
        },
        onError: async (error) => {
          // A lost answer may still have published it, and a stale
          // revision needs the agent read again before the next press.
          const now = await queryClient
            .fetchQuery({ ...agentQuery(client, agentId), staleTime: 0 })
            .catch(() => null);
          setConfirming(false);
          if (now?.agent.active_release_id === releaseId) {
            await onPublished();
            return;
          }
          setFailure(agentRefusal(t, error, role));
        },
      },
    );
  };
  return (
    <section className={AGENT_FORM}>
      <StepHeading focus={focus}>{t("agents.flow.preview")}</StepHeading>
      <Alert variant="blue">
        <AlertDescription>{t("agents.preview.unpublished")}</AlertDescription>
      </Alert>
      <PreviewChat key={releaseId} releaseId={releaseId} agentName={name} />
      {failure ? <FormError>{failure}</FormError> : null}
      <StepFooter
        back={
          <Button type="button" variant="outline" onClick={onEdit}>
            {t("agents.flow.editSettings")}
          </Button>
        }
      >
        <LaterLink agentId={agentId} label="agents.flow.publishLater" />
        <Button
          type="button"
          disabled={publish.isPending}
          onClick={() => setConfirming(true)}
        >
          {t("agents.publish.confirm")}
        </Button>
      </StepFooter>
      <PublishDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!publish.isPending) setConfirming(open);
        }}
        team={team}
        busy={publish.isPending}
        onConfirm={run}
      />
    </section>
  );
}

/**
 * Every step's last row: the way back at the start, the way on at the end,
 * in the same place on each step.
 */
function StepFooter({
  back,
  children,
}: {
  readonly back?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-4">
      {back}
      <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
        {children}
      </div>
    </div>
  );
}

/** What is being made so far, beside the form, and what comes next. */
function AgentSummary({
  name,
  slug,
  team,
  model,
  published,
  next,
}: {
  readonly name: string;
  readonly slug: string;
  readonly team: string;
  readonly model: string;
  readonly published: boolean;
  readonly next: string;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const none = t("agents.summary.none");
  return (
    <aside aria-labelledby={titleId} className="min-w-0">
      <Card variant="inset" className="gap-3">
        <CardHeader className="px-0">
          <CardTitle id={titleId}>{t("agents.summary.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-0">
          <KeyValueList
            items={[
              { label: t("agents.name"), value: name.trim() || none },
              {
                label: t("agents.slug"),
                value: (
                  <Text as="span" className="font-mono wrap-anywhere">
                    {slug || none}
                  </Text>
                ),
              },
              { label: t("agents.flow.team"), value: team || none },
              { label: t("agentCard.model"), value: model || none },
              {
                label: t("agents.summary.state"),
                value: t(
                  published ? "agents.state.published" : "agents.state.draft",
                ),
              },
            ]}
          />
          <Text variant="sub">{next}</Text>
        </CardContent>
      </Card>
    </aside>
  );
}

function LaterLink({
  agentId,
  label = "agents.flow.later",
}: {
  readonly agentId: string;
  readonly label?: MessageKey;
}) {
  const { t } = useI18n();
  return (
    <Button asChild variant="ghost">
      <Link to="/agents/$id" params={{ id: agentId }}>
        {t(label)}
      </Link>
    </Button>
  );
}
