import { useMutation, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@werft-ai/client";
import { useWerft } from "@werft-ai/react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  formatTableDateTime,
  Text,
  Textarea,
} from "@werft-ai/ui";
import { type FormEvent, useState } from "react";
import { useI18n } from "../../../i18n/i18n.tsx";
import { slackKey } from "./queries.ts";
import { type Binding, slackFailure } from "./shared.ts";

/** contracts' emergency-stop reason max; apps/web imports contracts as types only. */
const REASON_MAX = 500;

/** What the dialog is for: stopping a channel, or turning a stopped one on. */
export type EmergencyStopTarget = {
  readonly kind: "stop" | "resume";
  readonly row: Binding;
  readonly name: string;
} | null;

/** Who stopped a channel, when and why: the row's line while it holds. */
export function EmergencyStopLine({ row }: { readonly row: Binding }) {
  const { t, locale } = useI18n();
  const stop = row.emergency_stop;
  if (!stop) return null;
  const at = formatTableDateTime(stop.stopped_at, locale);
  return (
    <Text as="span" variant="sub" className="[overflow-wrap:anywhere]">
      {stop.stopped_by
        ? t("slack.emergencyStop.by", {
            who: stop.stopped_by.name,
            at,
            reason: stop.reason,
          })
        : t("slack.emergencyStop.byUnknown", { at, reason: stop.reason })}
    </Text>
  );
}

export function EmergencyStopDialog({
  agentId,
  target,
  onClose,
  onDone,
}: {
  readonly agentId: string;
  readonly target: EmergencyStopTarget;
  readonly onClose: () => void;
  /** Said once the write is in: what was stopped, or that it is on again. */
  readonly onDone: (message: string) => void;
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {target ? (
          <ReasonForm
            key={`${target.kind}:${target.row.id}`}
            agentId={agentId}
            target={target}
            onClose={onClose}
            onDone={onDone}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ReasonForm({
  agentId,
  target,
  onClose,
  onDone,
}: {
  readonly agentId: string;
  readonly target: NonNullable<EmergencyStopTarget>;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const [blank, setBlank] = useState(false);
  const tooLong = reason.trim().length > REASON_MAX;
  const { kind, row, name } = target;
  const write = useMutation({
    mutationFn: async (text: string) => {
      if (kind === "stop") {
        const stopped = await unwrap(
          client.POST(
            "/v1/agents/{id}/slack-bindings/{binding_id}/emergency-stop",
            {
              params: { path: { id: agentId, binding_id: row.id } },
              body: { reason: text },
            },
          ),
        );
        return t("slack.emergencyStop.done", {
          channel: name,
          sessions: stopped.stopped.sessions,
          turns: stopped.stopped.turns,
          posts: stopped.stopped.posts,
        });
      }
      await unwrap(
        client.PUT("/v1/agents/{id}/slack-bindings", {
          params: { path: { id: agentId } },
          body: {
            channel_id: row.external_surface_id,
            mode: "on",
            home: row.home,
            ceiling: row.ceiling,
            reason: text,
          },
        }),
      );
      return t("slack.emergencyStop.resumed", { channel: name });
    },
    onSuccess: (message) => {
      onDone(message);
      onClose();
    },
    // A refusal may mean the row moved (stopped or turned on elsewhere).
    onSettled: () =>
      cache.invalidateQueries({
        queryKey: [...slackKey(client, agentId), "bindings"],
      }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (write.isPending) return;
    const trimmed = reason.trim();
    if (trimmed === "") {
      setBlank(true);
      return;
    }
    if (tooLong) return;
    write.mutate(trimmed);
  };
  const stop = kind === "stop";
  return (
    <form onSubmit={submit} className="grid min-w-0 gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>
          {t(
            stop
              ? "slack.emergencyStop.title"
              : "slack.emergencyStop.resumeTitle",
            { channel: name },
          )}
        </DialogTitle>
        <DialogDescription>
          {t(
            stop
              ? "slack.emergencyStop.description"
              : "slack.emergencyStop.resumeDescription",
          )}
        </DialogDescription>
      </DialogHeader>
      {stop ? null : <EmergencyStopLine row={row} />}
      <Field>
        <FieldLabel>{t("slack.emergencyStop.reason")}</FieldLabel>
        <Textarea
          rows={3}
          value={reason}
          readOnly={write.isPending}
          required
          aria-invalid={blank || tooLong ? true : undefined}
          onChange={(event) => {
            setReason(event.target.value);
            setBlank(false);
          }}
        />
        <FieldDescription>
          {t("slack.emergencyStop.reasonHint")}
        </FieldDescription>
        <FieldError>
          {blank
            ? t("slack.emergencyStop.reasonRequired")
            : tooLong
              ? t("slack.emergencyStop.reasonTooLong", { max: REASON_MAX })
              : null}
        </FieldError>
      </Field>
      {write.error ? (
        <FieldError>{slackFailure(write.error, t)}</FieldError>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={write.isPending}>
            {t("slack.emergencyStop.cancel")}
          </Button>
        </DialogClose>
        <Button
          type="submit"
          variant={stop ? "destructive" : "default"}
          disabled={write.isPending}
        >
          {t(
            write.isPending
              ? stop
                ? "slack.emergencyStop.submitting"
                : "slack.emergencyStop.resumeSubmitting"
              : stop
                ? "slack.emergencyStop.submit"
                : "slack.emergencyStop.resumeSubmit",
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}
