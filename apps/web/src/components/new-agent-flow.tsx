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
  ModelSource,
  ProfileSummary,
  SaveAgentResponse,
} from "@werft-ai/contracts";
import { AGENT_DESCRIPTION_MAX_LENGTH } from "@werft-ai/contracts/agent-card";
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
  ConfirmDialog,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
  Stepper,
  Text,
  Textarea,
} from "@werft-ai/ui";
import { Suspense, useEffect, useId, useRef, useState } from "react";
import { useWatch } from "react-hook-form";
import type { z } from "zod";
import {
  agentListsFilter,
  agentQuery,
  profilesQuery,
  queryKeysOf,
  scopedKey,
} from "../api/queries.ts";
import { FunnelResetNotice, useFunnel } from "../funnel/tanstack-funnel.tsx";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";
import { saveFailureText } from "../routes/agent-detail/effective-behavior.tsx";
import {
  AGENT_FORM,
  AgentCardFields,
  type ApiCard,
  CARD_ERROR_FIELDS,
  type CardDraft,
  type CardErrors,
  cardDraftOf,
  chosenProfile,
  EMPTY_DRAFT,
  toolsBlocked,
} from "./agent-card-form.tsx";
import { Notice } from "./auth-page.tsx";
import { LoadFailure } from "./load-failure.tsx";
import { useTeamChoices } from "./managing-team.tsx";
import { pickable } from "./profile-options.tsx";
import { StepHeading, useStepMoved } from "./step-heading.tsx";

const releasable = (profile: ProfileSummary) =>
  pickable(profile) && profile.repository_mode !== "required";

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

const STEP_IDS = ["name", "job", "channels"] as const;
const STEP_LABEL = {
  channels: "agents.flow.channels",
  name: "agents.flow.name",
  job: "agents.flow.job",
} as const satisfies Record<keyof Steps, MessageKey>;

const NEW_CARD_STEP = agentCardStep();
const CARD_FIELDS = Object.keys(EMPTY_DRAFT) as (keyof CardDraft)[];
const KEEP_INPUT_DELAY_MS = 300;

/**
 * The slug a name suggests: what is left of it in lowercase kebab-case. A
 * name with no Latin letters or digits suggests nothing.
 */
export function slugFromName(name: string): string {
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
  readonly card: CardDraft;
  readonly profileId: string | null;
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
      card: cardDraftOf(draft.card) ?? EMPTY_DRAFT,
      profileId: typeof draft.profileId === "string" ? draft.profileId : null,
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
      channels: {
        guard: (data): data is Steps["channels"] =>
          ours(data, ["flow", "name", "slug", "agentId"]),
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
  const [previewId, setPreviewId] = useState<string | undefined>(
    saved?.profileId ?? undefined,
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
    profileId: null,
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
  const catalog = useQuery(profilesQuery(client));
  const savedPastJob = funnel.step === "channels";
  const moved = useStepMoved(funnel.step);

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
    // Past the save, the stepper does not lead back to making another.
    disabled: step.disabled || (savedPastJob && step.id !== funnel.step),
  }));

  const saveAgent = async (
    values: z.output<typeof NEW_CARD_STEP>,
    context: Steps["job"],
    profile: ProfileSummary,
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
    const release = {
      runtime_profile_id: profile.id,
      model_source: (profile.model === input.model.trim()
        ? "profile"
        : "fixed") as ModelSource,
    };
    const response = (await unwrap(
      saved
        ? client.PATCH("/v1/agents/{id}", {
            params: { path: { id: saved.agentId } },
            body: {
              ...(context.name !== saved.name ? { name: context.name } : {}),
              ...(description !== saved.description ? { description } : {}),
              card: sent as unknown as ApiCard,
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
              card: sent as unknown as ApiCard,
              ...release,
            },
          }),
    )) as SaveAgentResponse;
    const detail: AgentDetail = response;
    const draft = {
      agentId: detail.agent.id,
      name: detail.agent.name,
      slug: detail.agent.slug,
      description: detail.agent.description ?? "",
      managingTeamId: detail.agent.managing_team_id,
      card: input,
      profileId: profile.id,
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
    const done =
      (response.release.status === "applied" ||
        response.release.status === "unchanged") &&
      detail.agent.active_release_id !== null;
    return {
      agentId: detail.agent.id,
      card: input,
      done,
      failure: done
        ? null
        : response.release.status === "superseded"
          ? t("agent.save.superseded")
          : t("agents.flow.releaseFailed", {
              reason: saveFailureText(t, response.release.reason),
            }),
    };
  };

  return (
    <div className="flex flex-col gap-[var(--werft-space-block)]">
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
            previewId={previewId}
            onPreviewChange={setPreviewId}
            failure={releaseFailure}
            savedAgentId={saved?.agentId}
            onSave={async (values, profile) => {
              clearTimeout(keepTimer.current);
              setReleaseFailure(null);
              const result = await saveAgent(values, context, profile);
              if (result.done) {
                await history.push("channels", {
                  agentId: result.agentId,
                  card: result.card,
                });
              } else {
                setReleaseFailure(result.failure);
              }
            }}
            refuse={refuse}
          />
        )}
        channels={({ context }) => (
          <section className={AGENT_FORM}>
            <StepHeading focus={moved}>{t("agents.flow.channels")}</StepHeading>
            <Notice>{t("agents.flow.done", { name: context.name })}</Notice>
            <Suspense fallback={<Skeleton label={t("slack.working")} />}>
              <SlackConnect agentId={context.agentId} />
            </Suspense>
            <LaterLink agentId={context.agentId} />
          </section>
        )}
      />
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
      onSubmit={form.handleSubmit((values) => {
        if (!locked && team === "") {
          setTeamMissing(true);
          document.getElementById(teamSelect)?.focus();
          return;
        }
        onNext(values);
      })}
    >
      <StepHeading focus={focus}>{t("agents.flow.name")}</StepHeading>
      <Field>
        <FieldLabel>{t("agents.name")}</FieldLabel>
        <Input maxLength={120} {...name} />
        <FieldError>{errors.name?.message}</FieldError>
      </Field>
      <Field>
        <FieldLabel>{t("agents.slug")}</FieldLabel>
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
          <Text id={teamSelect}>
            {team === "" ? t("managingTeam.unassigned") : (savedTeam ?? team)}
          </Text>
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
      <div>
        <Button type="submit">{t("agents.flow.next")}</Button>
      </div>
    </form>
  );
}

function JobStep({
  form,
  catalog,
  focus,
  previewId,
  onPreviewChange,
  failure,
  savedAgentId,
  onSave,
  refuse,
}: {
  readonly form: StepForm<typeof NEW_CARD_STEP>;
  readonly catalog: UseQueryResult<{ items: ProfileSummary[] }>;
  readonly focus: boolean;
  readonly previewId: string | undefined;
  readonly onPreviewChange: (profileId: string) => void;
  readonly failure: string | null;
  readonly savedAgentId: string | undefined;
  readonly onSave: (
    card: z.output<typeof NEW_CARD_STEP>,
    profile: ProfileSummary,
  ) => Promise<unknown>;
  readonly refuse: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const draft = useWatch({ control: form.control }) as CardDraft;
  const { errors, isSubmitted, isSubmitting } = form.formState;
  const chosen = catalog.isSuccess
    ? chosenProfile(catalog.data.items, draft.model, previewId, releasable)
    : undefined;
  const profile = chosen && releasable(chosen) ? chosen : undefined;
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
          if (profile) await onSave(values, profile);
        },
        refuse,
      )}
    >
      <StepHeading focus={focus}>{t("agents.flow.job")}</StepHeading>
      <Text variant="sub">{t("agents.flow.jobIntro")}</Text>
      <AgentCardFields
        draft={draft}
        catalog={catalog}
        onChange={change}
        errors={fieldErrors}
        previewId={previewId}
        onPreviewChange={onPreviewChange}
        previewable={releasable}
      />
      <Alerts lines={formAlerts(errors, CARD_ERROR_FIELDS)} />
      {catalog.isSuccess && profile === undefined && draft.model !== "" ? (
        <Alerts lines={[t("agents.flow.noProfile")]} />
      ) : null}
      {failure ? <Alerts lines={[failure]} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={
            isSubmitting ||
            !catalog.isSuccess ||
            (draft.model !== "" && profile === undefined) ||
            toolsBlocked(catalog.data.items, draft)
          }
        >
          {isSubmitting ? t("agents.flow.saving") : t("agents.flow.saveNext")}
        </Button>
        {savedAgentId ? <LaterLink agentId={savedAgentId} /> : null}
      </div>
    </form>
  );
}

function LaterLink({ agentId }: { readonly agentId: string }) {
  const { t } = useI18n();
  return (
    <Button asChild variant="ghost">
      <Link to="/agents/$id" params={{ id: agentId }}>
        {t("agents.flow.later")}
      </Link>
    </Button>
  );
}
