import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { WorkspaceRole } from "@werft-ai/contracts";
import { inviteStep } from "@werft-ai/core/forms";
import {
  formAlerts,
  submitStep,
  useMemberPages,
  useStepForm,
  useStepper,
  useWerft,
} from "@werft-ai/react";
import {
  Button,
  buttonVariants,
  ConfirmDialog,
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  formatTimestamp,
  Input,
  NativeSelect,
  NativeSelectOption,
  Stepper,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { queryKeysOf } from "../api/queries.ts";
import { roleLabel, useRole, WORKSPACE_ROLE_VALUES } from "../auth/guard.tsx";
import { ReasonButton } from "../auth/reason-button.tsx";
import { FormError } from "../components/auth-page.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { SEARCH_MAX, useSearchTerm } from "../components/search-term.ts";
import { useDialogFunnel } from "../funnel/tanstack-funnel.tsx";
import { useI18n } from "../i18n/i18n.tsx";

// The least authority; anything more is a choice the inviter makes.
const DEFAULT_INVITE_ROLE: WorkspaceRole = "member";

type InviteSteps = {
  details: { expires?: string };
  link: { expires: string };
};

const isObject = (data: unknown): data is InviteSteps["details"] =>
  typeof data === "object" && data !== null;
const hasExpiry = (data: unknown): data is InviteSteps["link"] =>
  isObject(data) && typeof (data as { expires?: unknown }).expires === "string";

/** Opens the invite flow: who and with which role, then the link to hand over. */
export function InviteDialog({
  reason,
  assignableRoles,
  refusal,
}: {
  /** From the member list; the invite accepts these and no other. */
  readonly assignableRoles: readonly WorkspaceRole[];
  readonly reason: string | undefined;
  /** Words a refused request the way the page words a disabled action. */
  readonly refusal: (error: ApiError, role: string | undefined) => string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // A link on screen that was never copied: leaving loses it for good.
  const [uncopied, setUncopied] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const confirmLeave = (leave: () => void) => {
    if (uncopied) setLeaving(() => leave);
    else leave();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else confirmLeave(() => setOpen(false));
      }}
    >
      {/* As the trigger, the button gets the focus back when the dialog closes. */}
      <DialogTrigger asChild>
        <ReasonButton
          type="button"
          className={buttonVariants()}
          reason={reason}
        >
          <Plus aria-hidden="true" />
          {t("members.invite.open")}
        </ReasonButton>
      </DialogTrigger>
      <DialogContent>
        <InviteFlow
          assignableRoles={assignableRoles}
          refusal={refusal}
          onUncopied={setUncopied}
          confirmLeave={confirmLeave}
        />
        {/* Inside the content, so Radix stacks it over the invite dialog:
            Escape and outside clicks close this one alone. */}
        <ConfirmDialog
          open={leaving !== null}
          onOpenChange={(next) => {
            if (!next) setLeaving(null);
          }}
          title={t("members.invite.leave.title")}
          consequence={t("members.invite.leave.consequence")}
          confirmLabel={t("members.invite.leave.confirm")}
          cancelLabel={t("members.invite.leave.cancel")}
          tone="danger"
          onConfirm={() => {
            leaving?.();
            setLeaving(null);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/*
 * Mounted while the dialog is open, so each opening starts on the first
 * step. The link holds a token that works once: it stays in this component
 * and never goes into the flow's stored input, where history would keep it.
 */
function InviteFlow({
  assignableRoles,
  refusal,
  onUncopied,
  confirmLeave,
}: {
  readonly assignableRoles: readonly WorkspaceRole[];
  readonly onUncopied: (uncopied: boolean) => void;
  /** Runs `leave` now, or once the inviter agrees to lose the link. */
  readonly confirmLeave: (leave: () => void) => void;
  readonly refusal: (error: ApiError, role: string | undefined) => string;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const [url, setUrl] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Every link the clipboard took, so copies that finish out of order after
  // browser Back still count for their own link only.
  const [copiedUrls, setCopiedUrls] = useState<ReadonlySet<string>>(new Set());
  const linkRef = useRef<HTMLInputElement>(null);
  // A request still out when the dialog closes must not move the next opening.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const funnel = useDialogFunnel<InviteSteps>({
    id: "invite",
    initial: { step: "details", context: {} },
    steps: {
      details: { guard: isObject },
      link: { guard: hasExpiry },
    },
  });
  const stepper = useStepper({
    steps: [
      { id: "details", label: t("members.invite.step.details") },
      { id: "link", label: t("members.invite.step.link") },
    ],
    currentStepId: funnel.step,
  });
  // Only the link step asks: after browser Back the link is already off screen.
  const uncopied =
    funnel.step === "link" && url !== null && !copiedUrls.has(url);
  useEffect(() => {
    onUncopied(uncopied);
    return () => onUncopied(false);
  }, [uncopied, onUncopied]);

  const invite = useMutation<
    { invite_token: string; expires_at: string },
    ApiError,
    { email: string; role: WorkspaceRole }
  >({
    mutationFn: (body) => unwrap(client.POST("/v1/invites", { body })),
    // The response carries the token; keep it nowhere but the screen.
    gcTime: 0,
    onSuccess: async (created) => {
      if (mounted.current) {
        // A new link after browser Back: the last one's copy notice is not about it.
        setOutcome(null);
        setUrl(
          `${window.location.origin}/invite/${encodeURIComponent(created.invite_token)}`,
        );
        await funnel.history.push("link", { expires: created.expires_at });
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).invites,
      });
    },
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("members.invite.title")}</DialogTitle>
        <DialogDescription>{t("members.invite.description")}</DialogDescription>
      </DialogHeader>
      <Stepper label={t("members.invite.steps")} {...stepper} />
      <funnel.Render
        details={() => (
          <DetailsStep
            assignableRoles={assignableRoles}
            pending={invite.isPending}
            send={(values) => invite.mutateAsync(values)}
            serverMessage={(error) => refusal(error as ApiError, role)}
          />
        )}
        link={({ context, history }) =>
          url === null ? (
            // Forward into a link step from an earlier opening: its link
            // was never kept, so the flow starts over.
            <StartOver onStart={() => void history.replace("details", {})} />
          ) : (
            <div className="flex flex-col gap-4" data-testid="invite-link">
              <Field>
                <FieldLabel>{t("members.invite.link")}</FieldLabel>
                <LinkFocus target={linkRef} />
                <Input
                  ref={linkRef}
                  className="font-mono"
                  type="text"
                  readOnly
                  value={url}
                  onFocus={(event) => event.target.select()}
                />
                <FieldDescription>
                  {t("members.invite.linkOnce", {
                    expires: formatTimestamp(context.expires, locale),
                  })}
                </FieldDescription>
              </Field>
              <OutcomeLine outcome={outcome} />
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    confirmLeave(() => {
                      setUrl(null);
                      setOutcome(null);
                      // Detach the observer so gcTime 0 drops the response too.
                      invite.reset();
                      void history.replace("details", {});
                    })
                  }
                >
                  {t("members.invite.again")}
                </Button>
                <CopyButton
                  value={url}
                  variant="outline"
                  label={t("members.invite.copy")}
                  icon="none"
                  fallbackField={linkRef}
                  onResult={(worked, copiedUrl) => {
                    if (worked)
                      setCopiedUrls((copied) => new Set(copied).add(copiedUrl));
                    setOutcome(
                      worked
                        ? { kind: "notice", text: t("members.invite.copied") }
                        : {
                            kind: "error",
                            text: t("members.invite.copyFailed"),
                          },
                    );
                  }}
                />
                <DialogClose asChild>
                  <Button type="button">{t("members.invite.close")}</Button>
                </DialogClose>
              </DialogFooter>
            </div>
          )
        }
      />
    </>
  );
}

function StartOver({ onStart }: { readonly onStart: () => void }) {
  // Once, when the empty step shows.
  useEffect(onStart, []);
  return null;
}

/** Puts the focus on the new link, which selects it ready to copy. */
function LinkFocus({
  target,
}: {
  readonly target: RefObject<HTMLInputElement | null>;
}) {
  useEffect(() => target.current?.focus(), [target]);
  return null;
}

const FIELDS = ["email", "role"] as const;

function DetailsStep({
  assignableRoles: grantable,
  pending,
  send,
  serverMessage,
}: {
  readonly assignableRoles: readonly WorkspaceRole[];
  readonly pending: boolean;
  readonly send: (values: {
    email: string;
    role: WorkspaceRole;
  }) => Promise<unknown>;
  readonly serverMessage: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const form = useStepForm(inviteStep, {
    defaultValues: { email: "", role: DEFAULT_INVITE_ROLE },
  });
  const { errors } = form.formState;
  const email = form.watch("email");
  // On opening Radix does this; back from the link step the button that was
  // focused is gone and the keyboard would land on <body>.
  const { setFocus } = form;
  useEffect(() => setFocus("email"), [setFocus]);

  // Re-inviting someone whose membership is off leads nowhere when their
  // account has no password (Google sign-in only): the invite asks for one.
  // Enabling the membership is the way back for everyone. The server
  // searches for the typed address once typing pauses, instead of the
  // dialog reading every member; it matches what contains the term, so the
  // longest term it takes still finds a longer address.
  const typed = useSearchTerm(email);
  const searched = typed?.includes("@")
    ? typed.slice(0, SEARCH_MAX)
    : undefined;
  const matches = useMemberPages(searched, { enabled: searched !== undefined });
  const address = email.trim().toLowerCase();
  const sameAddress = matches.data?.pages
    .flatMap((page) => page.items)
    .find((member) => member.email.toLowerCase() === address);
  const disabledMatch =
    sameAddress && sameAddress.disabled_at !== null ? sameAddress : undefined;
  // Other addresses containing this one may fill the first pages. A page
  // that failed stops the search: the hint is advice, not a check.
  const { hasNextPage, isFetching, isError, fetchNextPage } = matches;
  const keepLooking =
    searched !== undefined &&
    !sameAddress &&
    hasNextPage &&
    !isFetching &&
    !isError;
  useEffect(() => {
    if (keepLooking) void fetchNextPage();
  }, [keepLooking, fetchNextPage]);

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={submitStep(form, send, serverMessage)}
    >
      {formAlerts(errors, FIELDS).map((alert) => (
        <FormError key={alert}>{alert}</FormError>
      ))}
      <Field>
        <FieldLabel>{t("members.invite.email")}</FieldLabel>
        <Input type="email" autoComplete="off" {...form.register("email")} />
        {disabledMatch ? (
          <FieldDescription>
            {t("members.invite.disabledHint", {
              name: disabledMatch.display_name,
            })}
          </FieldDescription>
        ) : null}
        <FieldError>{errors.email?.message}</FieldError>
      </Field>
      <Field>
        <FieldLabel>{t("members.invite.role")}</FieldLabel>
        <NativeSelect {...form.register("role")}>
          {WORKSPACE_ROLE_VALUES.map((value) => (
            <NativeSelectOption
              key={value}
              value={value}
              disabled={!grantable.includes(value)}
            >
              {roleLabel(t, value)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {!grantable.includes("owner") ? (
          <FieldDescription>{t("members.roleOwnerGrant")}</FieldDescription>
        ) : null}
        <FieldError>{errors.role?.message}</FieldError>
      </Field>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t("common.cancel")}
          </Button>
        </DialogClose>
        <Button
          type="submit"
          disabled={pending || !grantable.includes(form.watch("role"))}
        >
          {pending
            ? t("members.invite.submitting")
            : t("members.invite.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
