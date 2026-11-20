import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  SessionDetail as SessionDetailData,
  TakeOverSessionResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  FieldError,
  FieldLabel,
  Textarea,
} from "@werft-ai/ui";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { queryKeysOf, takeoversQuery } from "../api/queries.ts";
import { useHasPermission } from "../auth/guard.tsx";
import { FormError } from "../components/auth-page.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";

/** contracts justificationSchema's max; apps/web imports contracts as types only. */
const REASON_MAX = 1000;

/**
 * The takeover of a session whose requester was disabled, offered to whoever
 * may read the takeover list while the session is on it. `session` is
 * undefined when the caller cannot read it, and the server then wants a
 * reason. `done` lives with the screen: a session the caller could not read
 * becomes readable on success, and the notice moves under the header.
 */
export function SessionTakeover({
  id,
  session,
  done,
  onDone,
}: {
  readonly id: string;
  readonly session: SessionDetailData | undefined;
  readonly done: boolean;
  readonly onDone: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const permitted = useHasPermission("member.manage");
  const takeovers = useQuery({
    ...takeoversQuery(client, { sessionId: id }),
    enabled: permitted && !done,
  });
  if (done) return <TakenOver />;
  const sessionId = id.toLowerCase();
  const waiting =
    permitted &&
    (takeovers.data?.items.some((item) => item.session_id === sessionId) ??
      false);
  if (!waiting) return null;
  return (
    <Alert variant="amber" className="border-0">
      <AlertDescription>{t("session.takeover.notice")}</AlertDescription>
      <AlertActions>
        <TakeoverDialog
          id={id}
          reasonRequired={session === undefined}
          onDone={onDone}
        />
      </AlertActions>
    </Alert>
  );
}

// The dialog's trigger goes with the takeover, so the keyboard lands here.
function TakenOver() {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // After the dialog's own focus return, which runs on a zero timeout.
    const timer = setTimeout(() => ref.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Alert ref={ref} tabIndex={-1} role="status" className="border-0">
      <AlertDescription>{t("session.takeover.done")}</AlertDescription>
    </Alert>
  );
}

function TakeoverDialog({
  id,
  reasonRequired,
  onDone,
}: {
  readonly id: string;
  readonly reasonRequired: boolean;
  readonly onDone: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [blank, setBlank] = useState(false);
  const tooLong = reason.trim().length > REASON_MAX;
  const take = useMutation<TakeOverSessionResponse, ApiError, string | null>({
    mutationFn: (justification) =>
      unwrap(
        client.POST("/v1/sessions/{id}/takeover", {
          params: { path: { id } },
          body: justification === null ? {} : { justification },
        }),
      ) as Promise<TakeOverSessionResponse>,
    onSuccess: () => {
      setOpen(false);
      onDone();
      // The session, its lists and the takeover lists all sit under it.
      void queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).sessions,
      });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (take.isPending) return;
    const trimmed = reason.trim();
    if (reasonRequired && trimmed === "") {
      setBlank(true);
      return;
    }
    if (tooLong) return;
    take.mutate(trimmed === "" ? null : trimmed);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!take.isPending) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          {t("session.takeover.open")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid min-w-0 gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t("session.takeover.title")}</DialogTitle>
            <DialogDescription>
              {t("session.takeover.description")}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={fieldId}>
              {reasonRequired
                ? t("session.takeover.reason")
                : t("session.takeover.reasonOptional")}
            </FieldLabel>
            <Textarea
              id={fieldId}
              rows={3}
              value={reason}
              readOnly={take.isPending}
              required={reasonRequired}
              aria-invalid={blank || tooLong ? true : undefined}
              onChange={(event) => {
                setReason(event.target.value);
                setBlank(false);
              }}
            />
            <FieldError>
              {blank
                ? t("session.takeover.reasonRequired")
                : tooLong
                  ? t("session.takeover.reasonTooLong", { max: REASON_MAX })
                  : null}
            </FieldError>
          </Field>
          {take.error ? (
            <FormError>{t(errorKey(take.error.code))}</FormError>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={take.isPending}>
                {t("session.takeover.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={take.isPending}>
              {take.isPending
                ? t("session.takeover.submitting")
                : t("session.takeover.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
