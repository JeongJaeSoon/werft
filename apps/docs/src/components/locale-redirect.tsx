import { i18n, localeNames, localeStorageKey } from "@/lib/i18n";
import { appName, basePath } from "@/lib/shared";

// A static export has no server to read Accept-Language, so a path without a
// language picks one in the browser: the stored choice, then the browser's
// languages, then Korean. It keeps the rest of the path, query and hash.
const script = `(() => {
  const languages = ${JSON.stringify(i18n.languages)};
  let lang;
  try {
    lang = localStorage.getItem(${JSON.stringify(localeStorageKey)});
  } catch {}
  if (!languages.includes(lang)) {
    const preferred = navigator.languages?.length ? navigator.languages : [navigator.language ?? ""];
    lang = preferred.map((tag) => tag.toLowerCase().split("-")[0]).find((tag) => languages.includes(tag)) ?? ${JSON.stringify(i18n.defaultLanguage)};
  }
  const base = ${JSON.stringify(basePath)};
  const rest = location.pathname.slice(base.length);
  location.replace(base + "/" + lang + rest + location.search + location.hash);
})();`;

/** Without JavaScript the script never runs; the links still lead on. */
export function LocaleRedirect({ path }: { path: string }) {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-3 p-8">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant built above, no user input */}
      <script dangerouslySetInnerHTML={{ __html: script }} />
      <p className="font-medium">{appName}</p>
      {i18n.languages.map((lang) => (
        <a
          key={lang}
          href={`${basePath}/${lang}${path}`}
          lang={lang}
          className="text-fd-primary underline"
        >
          {localeNames[lang]}
        </a>
      ))}
    </main>
  );
}
