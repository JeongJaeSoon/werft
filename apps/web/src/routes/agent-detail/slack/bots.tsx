import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type components, unwrap } from "@werft-ai/client";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSet,
  Input,
  SettingRow,
  Text,
} from "@werft-ai/ui";
import { useId, useState } from "react";
import { useManagesAgent } from "../../../components/agent-access.tsx";
import { LoadFailure } from "../../../components/load-failure.tsx";
import type { Notify } from "../../../components/toast.tsx";
import { useI18n } from "../../../i18n/i18n.tsx";
import { slackKey, useSlackBots } from "./queries.ts";
import { slackFailure, slackReason } from "./shared.ts";

type SlackBot =
  components["schemas"]["GetSlackAppBotsResponse"]["items"][number];

/** The bots whose direct mentions the agent answers, picked from Slack's list. */
export function SlackAllowedBots({
  agentId,
  notify,
}: {
  readonly agentId: string;
  readonly notify: Notify;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const manages = useManagesAgent();
  const bots = useSlackBots(agentId);
  const key = [...slackKey(client, agentId), "bots"];
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const save = useMutation({
    mutationFn: (ids: readonly string[]) =>
      unwrap(
        client.PUT("/v1/agents/{id}/slack/app/bots", {
          params: {
            path: { id: agentId },
            header: { "Idempotency-Key": crypto.randomUUID() },
          },
          body: { allowed_user_ids: [...ids] },
        }),
      ),
    onSuccess: (saved) => {
      cache.setQueryData(key, saved);
      setPicking(false);
      notify(t("slack.botsSaved"));
    },
    // Slack's list may have moved on; read it again either way.
    onSettled: () => cache.invalidateQueries({ queryKey: key }),
  });
  const items = bots.data?.items ?? [];
  const allowed = items.filter((bot) => bot.allowed);
  const lost = bots.isError && !bots.data;
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState("");
  const typedId = useId();
  // Slack's list stopped short: a bot past it is added by its id, which the
  // server looks up. It saves at once, beside what is saved already, so the
  // ticks not yet saved stay as they are.
  const add = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        client.PUT("/v1/agents/{id}/slack/app/bots", {
          params: {
            path: { id: agentId },
            header: { "Idempotency-Key": crypto.randomUUID() },
          },
          body: { allowed_user_ids: [...allowed.map((b) => b.user_id), id] },
        }),
      ),
    onSuccess: (saved, id) => {
      cache.setQueryData(key, saved);
      setChosen((now) => (now.includes(id) ? now : [...now, id]));
      setTyped("");
      notify(t("slack.botAdded"));
    },
    onSettled: () => cache.invalidateQueries({ queryKey: key }),
  });
  // Both write the whole list: one at a time, or the later drops the other's.
  const busy = save.isPending || add.isPending;
  const addTyped = () => {
    const id = typed.trim();
    setTypedError("");
    add.reset();
    if (!/^[UW][A-Z0-9]{2,20}$/.test(id)) {
      setTypedError(t("slack.botIdInvalid"));
      return;
    }
    if (items.some((bot) => bot.user_id === id && bot.state === "active")) {
      setChosen((now) => (now.includes(id) ? now : [...now, id]));
      setTyped("");
      return;
    }
    add.mutate(id);
  };
  const open = () => {
    save.reset();
    add.reset();
    setTyped("");
    setTypedError("");
    setChosen(allowed.map((bot) => bot.user_id));
    setPicking(true);
  };
  return (
    <>
      <SettingRow
        title={t("slack.bots")}
        description={t("slack.botsHint")}
        status={
          <Text as="span" variant="sub">
            {lost
              ? "—"
              : bots.data
                ? allowed.length === 0
                  ? t("slack.botsNone")
                  : t("slack.botsCount", { count: allowed.length })
                : null}
          </Text>
        }
        meta={
          bots.error || allowed.length > 0 ? (
            <>
              {bots.error ? (
                <LoadFailure
                  error={bots.error}
                  guidance={slackReason(bots.error, t)}
                  kept={bots.data !== undefined}
                  onRetry={() => void bots.refetch()}
                />
              ) : null}
              {allowed.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {allowed.map((bot) => (
                    <li key={bot.user_id}>
                      <BotName bot={bot} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : undefined
        }
        control={
          lost || !manages ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              // Opening resets both writes; one still running stays tracked.
              disabled={!bots.isSuccess || busy}
              onClick={open}
            >
              {t("slack.botsEdit")}
            </Button>
          )
        }
      />
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("slack.botsTitle")}</DialogTitle>
            <DialogDescription>{t("slack.botsDialogHint")}</DialogDescription>
          </DialogHeader>
          {save.error ? (
            <FieldError>{slackFailure(save.error, t)}</FieldError>
          ) : null}
          {items.length === 0 ? (
            <Text>{t("slack.botsEmpty")}</Text>
          ) : (
            <FieldSet className="max-h-80 overflow-y-auto">
              {items.map((bot) => (
                <Field key={bot.user_id} orientation="horizontal">
                  <Checkbox
                    id={`slack-bot-${bot.user_id}`}
                    checked={chosen.includes(bot.user_id)}
                    // A bot Slack lost can be let go but not picked again.
                    disabled={
                      bot.state === "gone" && !chosen.includes(bot.user_id)
                    }
                    onCheckedChange={(checked) =>
                      setChosen((now) =>
                        checked === true
                          ? [...now, bot.user_id]
                          : now.filter((id) => id !== bot.user_id),
                      )
                    }
                  />
                  <FieldLabel htmlFor={`slack-bot-${bot.user_id}`}>
                    <BotName bot={bot} />
                  </FieldLabel>
                </Field>
              ))}
            </FieldSet>
          )}
          {bots.data?.truncated ? (
            <Field>
              <FieldLabel htmlFor={typedId}>{t("slack.botAddById")}</FieldLabel>
              <FieldDescription>{t("slack.botsTruncated")}</FieldDescription>
              <div className="flex gap-2">
                <Input
                  id={typedId}
                  value={typed}
                  maxLength={21}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="U0123ABCD"
                  aria-invalid={typedError !== "" || add.isError}
                  onChange={(event) => setTyped(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (!busy) addTyped();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || typed.trim() === ""}
                  onClick={addTyped}
                >
                  {t("slack.botAdd")}
                </Button>
              </div>
              {typedError ? <FieldError>{typedError}</FieldError> : null}
              {add.error ? (
                <FieldError>{slackFailure(add.error, t)}</FieldError>
              ) : null}
            </Field>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPicking(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => save.mutate(chosen)}
            >
              {t("slack.botsSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function BotName({ bot }: { readonly bot: SlackBot }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Text as="span">{bot.name ?? bot.user_id}</Text>
      {bot.state === "gone" ? (
        <Badge variant="gray">{t("slack.botGone")}</Badge>
      ) : null}
    </span>
  );
}
