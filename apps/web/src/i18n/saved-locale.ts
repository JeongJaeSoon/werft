import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { UserLocale } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { useEffect, useRef } from "react";
import { queryKeys } from "../api/queries.ts";
import { useMe } from "../auth/guard.tsx";
import { type Locale, useI18n } from "./i18n.tsx";

// DEFAULT_USER_LOCALE; apps/web takes only types from contracts.
const SLACK_FALLBACK = "en" satisfies UserLocale;

/**
 * Keeps the signed-in user's saved language and the one this console shows
 * in step, since Slack writes to the user in the saved one: a saved language
 * wins when the console opens, and every later change is saved. With none
 * saved, Slack falls back to en, so a console that opens in another language
 * saves it. A failed save is not retried until the language changes again;
 * the console still switches.
 */
export function useSavedLocale() {
  const saved = useMe()?.user?.locale;
  const { locale, setLocale } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const { mutate: save } = useMutation<unknown, ApiError, Locale>({
    mutationFn: (next) =>
      unwrap(client.PATCH("/v1/auth/me", { body: { locale: next } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
    // One at a time, in the order picked, so the last pick is the one kept.
    scope: { id: "saved-locale" },
  });
  // Undefined until the saved language is first seen.
  const sent = useRef<Locale | undefined>(undefined);
  useEffect(() => {
    // Not loaded, an API key, or an API from before the field.
    if (saved === undefined) return;
    if (sent.current === undefined) {
      sent.current = saved ?? SLACK_FALLBACK;
      if (saved !== null && saved !== locale) {
        setLocale(saved);
        return;
      }
    }
    if (locale === sent.current) return;
    sent.current = locale;
    save(locale);
  }, [saved, locale, setLocale, save]);
}
