import type { ReactNode } from "react";
// The subpath, not the package root: the barrel of @werft-ai/ui reaches this
// file, and the root would load every React Aria component with it.
import { I18nProvider, useLocale } from "react-aria-components/I18nProvider";

/** The app's language setting; the BCP 47 tag React Aria wants is derived here. */
export type AriaLocaleName = "ko" | "ja" | "en";

const TAGS = {
  ko: "ko-KR",
  ja: "ja-JP",
  en: "en-US",
} as const satisfies Record<AriaLocaleName, string>;

/**
 * Makes React Aria's built-in strings and date/number formats follow the
 * app's language. It stores nothing: the host owns the locale and passes it
 * in. It sets no `lang` or `dir` on the DOM either; the host does that.
 */
export function AriaLocale({
  locale,
  children,
}: {
  readonly locale: AriaLocaleName;
  readonly children: ReactNode;
}) {
  return <I18nProvider locale={TAGS[locale]}>{children}</I18nProvider>;
}

/** The BCP 47 tag React Aria uses below `AriaLocale`. */
export function useAriaLocale(): string {
  return useLocale().locale;
}
