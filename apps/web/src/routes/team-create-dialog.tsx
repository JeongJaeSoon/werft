import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { TeamChangeResponse } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Button,
  buttonVariants,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  FieldLabel,
  Input,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { queryKeysOf } from "../api/queries.ts";
import { refusalText, useRole } from "../auth/guard.tsx";
import { ReasonButton } from "../auth/reason-button.tsx";
import { useI18n } from "../i18n/i18n.tsx";

/**
 * The 팀 tab's head button: a team's name in a dialog, then the new team.
 * `onCreated` gets the new team's name.
 */
export function TeamCreateDialog({
  reason,
  onCreated,
}: {
  readonly reason: string | undefined;
  readonly onCreated: (name: string) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Leaving the list unmounts this button, and with it the dialog: only
  // the dialog's own state is skipped then. The toast still says the team
  // exists.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const create = useMutation<TeamChangeResponse, ApiError, string>({
    mutationFn: (name) => unwrap(client.POST("/v1/teams", { body: { name } })),
    onMutate: () => setError(null),
    onSuccess: async ({ team }) => {
      if (mounted.current) setOpen(false);
      // The toast belongs to the page, so it says so even after a visit away.
      onCreated(team.name);
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).teams,
      });
    },
    onError: (failure) =>
      setError(
        failure.code === "ALREADY_EXISTS"
          ? t("teams.nameTaken")
          : refusalText(t, failure, "team.manage", role),
      ),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Open until the request answers, so its answer lands in this opening.
        if (create.isPending) return;
        setError(null);
        setOpen(next);
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
          {t("teams.create")}
        </ReasonButton>
      </DialogTrigger>
      <DialogContent>
        <TeamCreateForm
          pending={create.isPending}
          error={error}
          onSubmit={(name) => {
            if (!create.isPending) create.mutate(name);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

// Mounted while the dialog is open, so each opening starts empty.
function TeamCreateForm({
  pending,
  error,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (name: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(name.trim());
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{t("teams.create")}</DialogTitle>
        <DialogDescription>{t("teams.createDescription")}</DialogDescription>
      </DialogHeader>
      {error === null ? null : (
        <Alert variant="red" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Field>
        <FieldLabel>{t("teams.name")}</FieldLabel>
        <Input
          name="team-name"
          required
          maxLength={100}
          autoComplete="off"
          value={name}
          readOnly={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <DialogFooter>
        <DialogClose asChild>
          <Button
            type="button"
            variant="outline"
            aria-disabled={pending || undefined}
          >
            {t("common.cancel")}
          </Button>
        </DialogClose>
        {/* aria-disabled, not disabled: Enter on it keeps the focus there. */}
        <Button type="submit" aria-disabled={pending || undefined}>
          {pending ? t("teams.creating") : t("teams.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
