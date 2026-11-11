import type { ApiError } from "@werft-ai/client";
import type {
  PendingRequest,
  SessionDetail as SessionDetailData,
} from "@werft-ai/contracts";
import {
  Badge,
  Button,
  ConfirmDialog,
  cn,
  formatTimestamp,
  RowAction,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";
import {
  ChevronDown,
  type LucideIcon,
  Play,
  Power,
  Square,
} from "lucide-react";
import {
  type Dispatch,
  type ReactNode,
  type Ref,
  type SetStateAction,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Pause } from "../components/console-icons.ts";
import {
  ApprovalCard,
  ApprovalRow,
  Composer,
  QuestionCard,
  shortSessionId,
} from "../components/index.ts";
import { useExpired, useExpiryFocus } from "../components/session/expiry.ts";
import {
  type SessionControl,
  useAnswer,
  useSendMessage,
  useSessionControl,
} from "../sessions.ts";
import { useBlockText } from "./text.ts";

/** What a reader can do to a session from these blocks. */
export type SessionAction = "answer" | "control" | "send";

export interface SessionActionProps {
  /**
   * Why the reader may not take an action, by action. A named one is drawn
   * disabled with that reason; the server refuses it either way.
   */
  readonly unavailable?: Partial<Record<SessionAction, string>> | undefined;
  /** The host's words for a command the server refused. */
  readonly refusal?: ((error: ApiError) => string) | undefined;
}

/**
 * A permission request as the full card, as one line of a list, or as a
 * list line under its session's name (`heading`), the answer at its end.
 */
export type ApprovalLayout = "card" | "row" | "summary";

type Outcome = { readonly kind: "notice" | "error"; readonly text: string };

function OutcomeLine({
  outcome,
  ref,
  className,
}: {
  readonly outcome: Outcome | null;
  readonly ref?: Ref<HTMLOutputElement>;
  readonly className?: string | undefined;
}) {
  // Always mounted, so a screen reader hears the line when it changes.
  return (
    <output
      ref={ref}
      tabIndex={-1}
      className={cn(
        outcome?.kind === "error"
          ? "m-0 text-destructive text-body"
          : "m-0 text-muted-foreground text-body",
        className,
      )}
    >
      {outcome?.text}
    </output>
  );
}

/** Whether focus fell back to the page, as when its element was removed. */
export function focusLost(node: Element | null): boolean {
  const page = node?.ownerDocument;
  return page !== undefined && page.activeElement === page.body;
}

// While another answer is on its way the buttons are off; the next card's
// folded input still takes focus.
function nextRequest(root: HTMLElement | null) {
  return (
    root?.querySelector<HTMLElement>(
      "li button:not(:disabled), li input:not(:disabled)",
    ) ?? root?.querySelector<HTMLElement>("li summary")
  );
}

/** The title of the section the list sits in, made able to take focus. */
function listTitle(root: HTMLElement | null) {
  const title = root?.closest("section")?.querySelector<HTMLElement>("h2, h3");
  if (title && !title.hasAttribute("tabindex")) title.tabIndex = -1;
  return title ?? undefined;
}

// The run an answer started is over; "the session continues" no longer holds.
const RUN_ENDED: ReadonlySet<SessionDetailData["status"]> = new Set([
  "idle",
  "failed",
  "stopped",
]);

function Reason({ text }: { readonly text: string }) {
  return <p className="m-0 text-muted-foreground text-body">{text}</p>;
}

/**
 * A question as a list line: what it asks and until when, its form folded
 * below so every line in the list keeps one height until opened. The form
 * stays mounted while folded and keeps what was chosen.
 */
function SummaryQuestion({
  request,
  heading,
  badge,
  meta,
  messages,
  children,
}: {
  readonly request: Extract<PendingRequest, { kind: "question" }>;
  readonly heading: ReactNode;
  readonly badge: string;
  readonly meta: ReactNode;
  readonly messages: {
    readonly open: string;
    readonly expires: string;
    readonly expired: string;
  };
  readonly children: ReactNode;
}) {
  const formId = useId();
  const formRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  const [open, setOpen] = useState(false);
  const expired = useExpired(
    request.request_id,
    request.expires_at,
    Date.now(),
  );
  // Expiry takes the line's toggle away; the form's own notice may be hidden.
  const { noticeRef, within } = useExpiryFocus(expired);
  const prompt = request.questions[0]?.prompt;

  useEffect(() => {
    if (open && focusOnOpen.current) {
      formRef.current
        ?.querySelector<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled)",
        )
        ?.focus();
    }
    focusOnOpen.current = false;
  }, [open]);

  return (
    <>
      <div
        className="flex min-h-[var(--werft-row-min-height)] flex-wrap items-center justify-end gap-x-4 gap-y-2 px-[var(--werft-row-padding-x)] py-[var(--werft-row-padding-y)]"
        {...within}
      >
        <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
          <p className="m-0 flex min-w-0 items-center gap-2 font-medium text-control leading-5">
            <span className="min-w-0 truncate">{heading}</span>
            {/* One short word: the name gives way, never the badge. */}
            <Badge variant="amber" className="shrink-0">
              {badge}
            </Badge>
          </p>
          {/* Open, the form below asks it in full. */}
          {prompt === undefined || open ? null : (
            <p className="m-0 truncate text-control leading-5">{prompt}</p>
          )}
          <p
            ref={noticeRef}
            tabIndex={expired ? -1 : undefined}
            className="m-0 text-caption text-muted-foreground leading-4 [overflow-wrap:anywhere]"
          >
            {meta}
            {meta === undefined ? null : <span aria-hidden="true"> · </span>}
            {expired ? messages.expired : messages.expires}
          </p>
        </div>
        {expired ? null : (
          <RowAction
            className="shrink-0"
            aria-expanded={open}
            aria-controls={formId}
            onClick={() => {
              focusOnOpen.current = !open;
              setOpen(!open);
            }}
          >
            {messages.open}
            <ChevronDown
              className={cn(
                "transition-transform motion-reduce:transition-none",
                open && "rotate-180",
              )}
              aria-hidden="true"
            />
          </RowAction>
        )}
      </div>
      <div
        ref={formRef}
        id={formId}
        // Open past its expiry, the form stays: its notice takes the focus.
        hidden={!open}
        className="px-[var(--werft-row-padding-x)] pb-[var(--werft-row-padding-y)]"
      >
        {children}
      </div>
    </>
  );
}

// Refusals that read the same on any host; the rest are the host's words.
const SESSION_REFUSALS = [
  "REQUEST_EXPIRED",
  "REQUEST_STALE",
  "TURN_NOT_STARTED",
  "REVISION_CONFLICT",
  "PAUSE_COMMITTING",
  "SESSION_PAUSED",
  "SESSION_RESUMING",
  "SESSION_STOPPED",
  "SESSION_CLOSED",
  "RECOVERY_REQUIRED",
] as const;

function useRefusal(refusal: SessionActionProps["refusal"]) {
  const { t } = useBlockText();
  return (error: ApiError) => {
    const code = SESSION_REFUSALS.find((known) => known === error.code);
    if (code) return t(`session.refused.${code}`);
    return refusal?.(error) ?? t("session.command.refused");
  };
}

/** The session's open requests, each answerable where it is drawn. */
export function PendingAnswers({
  sessionId,
  items,
  unavailable,
  refusal,
  onAnswered,
  showEmpty = true,
  subject,
  answerable = true,
  layout = "card",
  heading,
  meta,
  announceSent = true,
  status,
}: SessionActionProps & {
  readonly sessionId: string;
  readonly items: readonly PendingRequest[];
  /** The session's work status: the sent notice leaves once its run ends. */
  readonly status?: SessionDetailData["status"] | undefined;
  /** False when the reader only sees the session and may not answer for it. */
  readonly answerable?: boolean;
  readonly onAnswered?: () => void;
  readonly showEmpty?: boolean;
  /** What each request belongs to, drawn on its card's title line. */
  readonly subject?: ReactNode;
  /** How a permission request is drawn; a question is always a card. */
  readonly layout?: ApprovalLayout | undefined;
  /** The session as the summary layout's first line names it. */
  readonly heading?: ReactNode;
  /** The summary layout's second line for a request, such as its wait. */
  readonly meta?: ((request: PendingRequest) => ReactNode) | undefined;
  /** False when the host says an answer went, as the inbox's heading does. */
  readonly announceSent?: boolean;
}) {
  const { t, locale } = useBlockText();
  const summary = layout === "summary";
  const Approval = layout === "card" ? ApprovalCard : ApprovalRow;
  const short = shortSessionId(sessionId);
  // A summary line always names its session, given a heading or not.
  const lineHeading = heading ?? subject ?? short;
  const answer = useAnswer(sessionId);
  const refused = useRefusal(refusal);
  const [outcome, setOutcome] = useState<
    | (Outcome & {
        readonly requestId: string;
        /** The requests listed when the answer went. */
        readonly listed: ReadonlySet<string>;
      })
    | null
  >(null);
  const reason =
    unavailable?.answer ??
    (answerable ? undefined : t("session.answer.notAnswerer"));
  // A list line has no room above it; why the reader may not answer joins
  // the line instead.
  const metaFor = (request: PendingRequest) => {
    const lead = meta?.(request);
    if (reason === undefined) return lead;
    return lead === undefined ? (
      reason
    ) : (
      <>
        {lead}
        <span aria-hidden="true"> · </span>
        {reason}
      </>
    );
  };
  const busyId = answer.isPending ? answer.variables?.request_id : undefined;
  const listRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLOutputElement>(null);
  // The request just answered, whose card may still hold the keyboard.
  const answered = useRef<string | null>(null);

  // An answered card leaves with the next read and takes focus with it:
  // hand the keyboard to the next request, or to the notice when none is left.
  useLayoutEffect(() => {
    const id = answered.current;
    if (id === null || items.some((request) => request.request_id === id)) {
      return;
    }
    answered.current = null;
    if (!focusLost(listRef.current)) return;
    const root = listRef.current;
    const next =
      nextRequest(root) ??
      (announceSent
        ? noticeRef.current
        : // The notice line stays empty when the host announces the answer
          // elsewhere; only lapsed requests are left, so their visible
          // expiry notice takes the keyboard.
          Array.from(
            root?.querySelectorAll<HTMLElement>("li [tabindex='-1']") ?? [],
          ).find((notice) => notice.closest("[hidden]") === null));
    next?.focus();
  }, [items, announceSent]);

  // The sent notice holds until the run it started ends or a new request
  // comes; an error stays on its card.
  const passed =
    outcome?.kind === "notice" &&
    ((status !== undefined && RUN_ENDED.has(status)) ||
      items.some((request) => !outcome.listed.has(request.request_id)));
  // After the effect above, which may have handed the notice the keyboard.
  useLayoutEffect(() => {
    if (!passed) return;
    const notice = noticeRef.current;
    const held =
      notice !== null && notice.ownerDocument.activeElement === notice;
    setOutcome(null);
    if (!held) return;
    const root = listRef.current;
    (nextRequest(root) ?? listTitle(root))?.focus();
  }, [passed]);

  const send = (body: Parameters<typeof answer.mutate>[0]) => {
    // The buttons are off while an answer is on its way; a second press
    // that beats the render must not send twice.
    if (answer.isPending) return;
    setOutcome(null);
    // Marked before the request: an event can take the card away before
    // the answer's receipt comes back.
    answered.current = body.request_id;
    const listed = new Set(items.map((request) => request.request_id));
    answer.mutate(body, {
      onSuccess: () => {
        setOutcome({
          kind: "notice",
          requestId: body.request_id,
          listed,
          text: t("session.answer.sent"),
        });
        onAnswered?.();
      },
      onError: (error) => {
        answered.current = null;
        setOutcome({
          kind: "error",
          requestId: body.request_id,
          listed,
          text: refused(error),
        });
      },
    });
  };
  const errorFor = (request: PendingRequest) =>
    outcome?.kind === "error" && outcome.requestId === request.request_id
      ? outcome.text
      : undefined;
  const expires = (at: string) => t("session.pending.expires", { at });
  const question = (
    request: Extract<PendingRequest, { kind: "question" }>,
    variant: "card" | "plain",
  ) => (
    <QuestionCard
      variant={variant}
      request={request}
      locale={locale}
      pending={busyId === request.request_id}
      disabled={reason !== undefined || busyId !== undefined}
      error={errorFor(request)}
      messages={{
        title: t("session.pending.question"),
        expires,
        expired: t("session.pending.expired"),
        freeText: t("session.answer.freeText"),
        unanswered: t("session.answer.unanswered"),
        submit: t("session.answer.submit"),
      }}
      onSubmit={(answers) =>
        send({
          request_id: request.request_id,
          kind: "question",
          answers,
        })
      }
    />
  );
  // An error shows on its card; once the card is gone, it shows here.
  const shownHere =
    outcome !== null &&
    (outcome.kind === "notice"
      ? announceSent && !passed
      : !items.some((request) => request.request_id === outcome.requestId));

  return (
    <div
      ref={listRef}
      data-slot="pending-answers"
      className={cn("flex flex-col", summary ? null : "gap-2")}
    >
      <OutcomeLine
        ref={noticeRef}
        outcome={shownHere ? outcome : null}
        // In a list line an empty notice must not open a gap.
        className={
          summary
            ? "px-[var(--werft-row-padding-x)] [&:not(:empty)]:pt-[var(--werft-row-padding-y)]"
            : undefined
        }
      />
      {reason === undefined || summary ? null : <Reason text={reason} />}
      {items.length === 0 ? (
        showEmpty ? (
          <p className="m-0 text-muted-foreground text-body">
            {t("session.pending.empty")}
          </p>
        ) : null
      ) : (
        <ul
          className={cn(
            "m-0 flex list-none flex-col p-0",
            summary ? "divide-y" : "gap-2",
          )}
        >
          {items.map((request) => (
            <li key={request.request_id}>
              {request.kind === "permission" ? (
                <Approval
                  request={request}
                  subject={subject}
                  {...(summary
                    ? { heading: lineHeading, meta: metaFor(request) }
                    : undefined)}
                  locale={locale}
                  pending={busyId === request.request_id}
                  disabled={reason !== undefined || busyId !== undefined}
                  error={errorFor(request)}
                  messages={{
                    title: (tool) => t("session.pending.permission", { tool }),
                    summary: (verb) => t(verb.key, verb.params),
                    input: t("session.answer.input"),
                    expires,
                    expired: t("session.pending.expired"),
                    allow: t("session.answer.allow"),
                    deny: t("session.answer.deny"),
                    allowName: (tool) =>
                      t("session.answer.allowFor", { tool, session: short }),
                    denyName: (tool) =>
                      t("session.answer.denyFor", { tool, session: short }),
                    denyReason: t("session.answer.denyReason"),
                    denySubmit: t("session.answer.denySubmit"),
                    cancel: t("session.answer.cancel"),
                  }}
                  onAllow={() =>
                    send({
                      request_id: request.request_id,
                      kind: "permission",
                      action: "allow",
                    })
                  }
                  onDeny={(text) =>
                    send({
                      request_id: request.request_id,
                      kind: "permission",
                      action: "deny",
                      reason: text,
                    })
                  }
                />
              ) : summary ? (
                <SummaryQuestion
                  request={request}
                  heading={lineHeading}
                  badge={t("session.pending.question")}
                  meta={metaFor(request)}
                  messages={{
                    open: t("session.answer.open"),
                    expires: expires(
                      formatTimestamp(request.expires_at, locale),
                    ),
                    expired: t("session.pending.expired"),
                  }}
                >
                  {question(request, "plain")}
                </SummaryQuestion>
              ) : (
                <>
                  {subject === undefined ? null : (
                    // QuestionCard has no title-line slot yet.
                    <p className="m-0 mb-2 text-caption">{subject}</p>
                  )}
                  {question(request, "card")}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type ControlAction = SessionControl["action"];

// On the way to a state that takes different commands.
const MOVING: ReadonlySet<SessionDetailData["admission_state"]> = new Set([
  "pausing",
  "resuming",
  "stopping",
]);

/**
 * The commands an admission state takes. Recovery decisions are their own
 * screen; a closed or stopping session takes nothing here.
 */
export function actionsFor(
  session: SessionDetailData,
): readonly ControlAction[] {
  switch (session.admission_state) {
    case "active":
      return session.current_turn_id === null
        ? ["pause", "terminate"]
        : ["interrupt", "pause", "terminate"];
    case "pausing":
    case "paused":
      return ["resume", "terminate"];
    case "resuming":
    case "recovery_required":
    case "closing":
      return ["terminate"];
    case "stopped":
      return ["resume"];
    case "stopping":
    case "closed":
      return [];
  }
}

function commandFor(
  action: ControlAction,
  session: SessionDetailData,
): SessionControl {
  const expected_revision = session.revision;
  switch (action) {
    case "interrupt":
      return {
        action,
        body: { target_turn_id: session.current_turn_id ?? "" },
      };
    case "pause":
      return { action, body: { expected_revision } };
    case "terminate":
      return { action, body: { expected_revision } };
    case "resume":
      return { action, body: { expected_revision } };
  }
}

const CONTROL_ICON = {
  interrupt: Square,
  pause: Pause,
  resume: Play,
  terminate: Power,
} as const satisfies Record<ControlAction, LucideIcon>;

export interface SessionControlsProps extends SessionActionProps {
  readonly session: SessionDetailData;
  /**
   * `head`, for a page header, draws each command with its icon and label
   * from 1280px and as a square icon below, where the body is too narrow to
   * keep the title beside labelled buttons; `icons` draws square icon
   * buttons at every width; `buttons` (the default) draws labelled buttons.
   */
  readonly variant?: "buttons" | "head" | "icons";
  /** Drawn after the commands at the right end of their row, such as a back link. */
  readonly trailing?: ReactNode;
}

export function SessionControls({
  session,
  unavailable,
  refusal,
  variant = "buttons",
  trailing,
}: SessionControlsProps) {
  const { t } = useBlockText();
  const control = useSessionControl(session.id);
  const refused = useRefusal(refusal);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirming, setConfirming] = useState(false);
  const reason = unavailable?.control;
  const actions = actionsFor(session);
  const actionSet = actions.join(" ");
  const groupRef = useRef<HTMLDivElement>(null);
  const outcomeRef = useRef<HTMLOutputElement>(null);
  // The commands drawn when one ran; a pause swaps its button for resume.
  const ranOn = useRef<string | null>(null);
  // Focus sits on the outcome line only until a command other than
  // terminate is drawn again.
  const parked = useRef(false);
  const moving = MOVING.has(session.admission_state);

  // A command's button may leave with the new state, taking focus with it:
  // hand the keyboard to what the session takes now, until the state the
  // command made has settled or the command was refused. Never to terminate:
  // while resuming it is the only button, and Enter would open its dialog.
  useLayoutEffect(() => {
    if (ranOn.current === null) return;
    const line = outcomeRef.current;
    if (
      focusLost(line) ||
      (parked.current && line?.ownerDocument.activeElement === line)
    ) {
      const next = groupRef.current?.querySelector<HTMLElement>(
        "button:not(:disabled):not([data-action='terminate'])",
      );
      if (next) {
        next.focus();
        parked.current = false;
      } else if (!parked.current) {
        line?.focus();
        parked.current = true;
      }
    }
    if (
      control.isError ||
      (control.isSuccess && actionSet !== ranOn.current && !moving)
    ) {
      ranOn.current = null;
      parked.current = false;
    }
  }, [actionSet, control.isError, control.isSuccess, moving]);

  // The confirm dialog gives focus back to what was focused last outside it,
  // and the terminate button that opened it may be gone by now; the outcome
  // line stays.
  const settle = (next: Outcome) => {
    if (confirming) outcomeRef.current?.focus();
    setConfirming(false);
    setOutcome(next);
  };

  const run = (action: ControlAction) => {
    setOutcome(null);
    ranOn.current = actionSet;
    control.mutate(commandFor(action, session), {
      onSuccess: () =>
        settle({ kind: "notice", text: t("session.control.sent") }),
      onError: (error) => settle({ kind: "error", text: refused(error) }),
    });
  };

  const head = variant !== "buttons";
  const icons = variant === "icons";
  const buttons = actions.map((action) => {
    const label = t(`session.control.${action}`);
    const Icon = CONTROL_ICON[action];
    const button = (
      <Button
        type="button"
        data-action={action}
        variant={action === "terminate" && !head ? "destructive" : "outline"}
        // Not `disabled`: Chrome takes focus off a disabled button, and the
        // keyboard would lose its place while a command runs; a withheld one
        // still takes hover and focus to say why.
        aria-disabled={reason !== undefined || control.isPending || undefined}
        size={icons ? "icon-sm" : "sm"}
        className={cn(
          "aria-disabled:opacity-50",
          head &&
            action === "terminate" &&
            "text-destructive hover:text-destructive",
          head &&
            !icons &&
            "max-xl:w-[var(--werft-control-height-sm)] max-xl:px-0",
        )}
        aria-label={icons ? label : undefined}
        // The ui Tooltip opens on a press too, which a command cannot share;
        // the native one names the icon where the label is hidden. A
        // withheld command has nothing to press, so it shows the reason.
        title={head && reason === undefined ? label : undefined}
        onClick={() => {
          if (reason !== undefined || control.isPending) return;
          if (action === "terminate") setConfirming(true);
          else run(action);
        }}
      >
        {icons ? (
          <Icon strokeWidth={1.5} aria-hidden="true" />
        ) : head ? (
          <>
            <Icon strokeWidth={1.5} aria-hidden="true" />
            <span className="max-xl:sr-only">{label}</span>
          </>
        ) : (
          label
        )}
      </Button>
    );
    // One tree either way, so a reason that clears keeps the focus.
    return (
      <Tooltip key={action} {...(reason === undefined && { open: false })}>
        <TooltipTrigger asChild={true}>{button}</TooltipTrigger>
        <TooltipContent side="top">{reason}</TooltipContent>
      </Tooltip>
    );
  });
  const group = (
    <div ref={groupRef} className="flex flex-wrap gap-2">
      {buttons}
    </div>
  );

  return (
    <>
      {head ? (
        // Under the title on a narrow page, the row starts at the left.
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1 md:items-end">
          <div className="flex flex-wrap items-center gap-2 self-stretch md:justify-end">
            {actions.length === 0 ? null : group}
            {trailing === undefined ? null : (
              <div className="ms-auto flex">{trailing}</div>
            )}
          </div>
          <OutcomeLine ref={outcomeRef} outcome={outcome} />
        </div>
      ) : (
        <>
          {actions.length === 0 ? (
            <p className="m-0 text-muted-foreground text-body">
              {t("session.control.none")}
            </p>
          ) : (
            group
          )}
          <OutcomeLine ref={outcomeRef} outcome={outcome} />
        </>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!control.isPending) setConfirming(open);
        }}
        title={t("session.control.terminate.title")}
        consequence={t("session.control.terminate.consequence")}
        confirmLabel={t("session.control.terminate.confirm")}
        cancelLabel={t("session.control.cancel")}
        tone="danger"
        role="alertdialog"
        busy={control.isPending}
        onConfirm={() => run("terminate")}
      />
    </>
  );
}

export function SessionComposer({
  session,
  unavailable,
  refusal,
  draft,
  onDraftChange,
}: SessionActionProps & {
  readonly session: SessionDetailData;
  readonly draft?: string;
  readonly onDraftChange?: Dispatch<SetStateAction<string>>;
}) {
  const { t } = useBlockText();
  const send = useSendMessage(session.id);
  const refused = useRefusal(refusal);
  const [notice, setNotice] = useState<Outcome | null>(null);
  const inactive = session.admission_state !== "active";
  const reason =
    unavailable?.send ??
    (inactive ? t("session.composer.inactive") : undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLOutputElement>(null);

  // The send button turns off while sending and Chrome drops focus to the
  // page: give it back to the field, or to the notice if the field is off.
  // Not when the reader pointed or tabbed elsewhere meanwhile, even at blank
  // page, which leaves focus on <body> just the same.
  const keepFocus = async (sending: Promise<void>) => {
    const root = rootRef.current;
    const page = root?.ownerDocument;
    let movedOn = false;
    const away = (event: Event) => {
      if (!root?.contains(event.target as Node)) movedOn = true;
    };
    page?.addEventListener("pointerdown", away, true);
    page?.addEventListener("focusin", away, true);
    let refusal: ApiError | null = null;
    try {
      await sending;
    } catch (error) {
      refusal = error as ApiError;
    } finally {
      page?.removeEventListener("pointerdown", away, true);
      page?.removeEventListener("focusin", away, true);
    }
    const field = root?.querySelector<HTMLElement>("textarea:not(:disabled)");
    // A refusal shows under the field; with the field off (the session
    // stopped meanwhile) it shows on the notice, where focus goes.
    if (refusal && !field) setNotice({ kind: "error", text: refused(refusal) });
    if (!movedOn && focusLost(root)) (field ?? noticeRef.current)?.focus();
    if (refusal) throw refusal;
  };

  return (
    <div ref={rootRef} className="flex flex-col">
      <Composer
        messages={{
          label: t("session.composer.label"),
          send: t("session.composer.send"),
          hint: t("session.composer.hint"),
          queued: t("session.composer.queued"),
        }}
        value={draft}
        onValueChange={onDraftChange}
        disabled={reason !== undefined}
        disabledReason={reason}
        pending={send.isPending}
        error={
          send.error && notice?.kind !== "error"
            ? refused(send.error)
            : undefined
        }
        onSend={(message) => {
          setNotice(null);
          return keepFocus(
            send.mutateAsync({ message }).then((accepted) => {
              setNotice({
                kind: "notice",
                text: t("session.composer.sent", { turn: accepted.turn_id }),
              });
            }),
          );
        }}
      />
      {/* Empty, the line would leave a gap under the send button, the
          page's last control. */}
      <OutcomeLine
        ref={noticeRef}
        outcome={notice}
        className="not-empty:mt-2"
      />
    </div>
  );
}
