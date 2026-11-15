import { Button } from "@werft-ai/ui/primitives";
import Link from "next/link";
import { type Locale, localizeHref, messages } from "@/lib/i18n";

export function HomeHero({ lang }: { lang: Locale }) {
  return (
    <div
      lang={lang}
      className="not-prose mb-10 flex flex-col items-start gap-4 border-b pb-10"
    >
      <h1 className="text-3xl font-medium">Werft</h1>
      <p className="text-lg text-fd-muted-foreground">
        {messages[lang].homeLead}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href={localizeHref("/getting-started/quickstart", lang)}>
            Quickstart
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={localizeHref("/getting-started/install", lang)}>
            TypeScript SDK
          </Link>
        </Button>
      </div>
    </div>
  );
}
