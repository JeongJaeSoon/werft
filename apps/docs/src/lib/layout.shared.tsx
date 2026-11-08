import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import type { Locale } from "./i18n";
import { appName } from "./shared";

const contributeLabel: Record<Locale, string> = {
  ko: "기여하기",
  en: "Contribute",
  ja: "貢献する",
};

export function baseOptions(lang: Locale): BaseLayoutProps {
  return {
    nav: {
      title: <span className="font-semibold tracking-tight">{appName}</span>,
    },
    // A link, not a tab: the contributing guide is one page.
    links: [
      {
        type: "main",
        text: contributeLabel[lang],
        url: `/${lang}/contributing`,
      },
    ],
  };
}
