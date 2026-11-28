import { LOCALES, type Locale } from "@werft-ai/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { en } from "./en.ts";
import { ja } from "./ja.ts";
import { ko, type MessageKey } from "./ko.ts";

export type { Locale, MessageKey };
export { LOCALES };
export type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

const catalogs: Record<Locale, Record<MessageKey, string>> = { ko, ja, en };
export const LOCALE_STORAGE_KEY = "ap.locale";

/** Each language is offered in its own words, whatever the page shows now. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  ko: "한국어",
  ja: "日本語",
  en: "English",
};

export function translate(
  locale: Locale,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  return catalogs[locale][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole,
  );
}

export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(ko, key);
}

/**
 * A GitHub refusal's label. A reason code this console does not know (a newer
 * server's) is shown as it is.
 */
export function gitHubRefusalLabel(
  t: (key: MessageKey) => string,
  code: string,
): string {
  const key = `agentGitHub.refusal.${code}`;
  return isMessageKey(key) ? t(key) : code;
}

export function errorKey(code: string): MessageKey {
  const key = `error.${code}`;
  return isMessageKey(key) ? key : "error.UNKNOWN";
}

function isLocale(value: unknown): value is Locale {
  return LOCALES.includes(value as Locale);
}

export function initialLocale(): Locale {
  try {
    const stored = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Storage can be blocked; the browser language still decides.
  }
  const navigator = globalThis.navigator;
  const languages = navigator?.languages?.length
    ? navigator.languages
    : [navigator?.language ?? ""];
  for (const language of languages) {
    const primary = language.toLowerCase().split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return "en";
}

interface I18nValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  children,
  locale: fixed,
}: {
  readonly children: ReactNode;
  readonly locale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(
    () => fixed ?? initialLocale(),
  );
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Not remembered across visits; this visit still switches.
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
    }),
    [locale, setLocale],
  );
  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n outside I18nProvider");
  return value;
}
