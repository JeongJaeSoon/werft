import { useEffect } from "react";
import { useToast } from "../components/toast.tsx";
import { initialLocale, type Locale, translate } from "../i18n/i18n.tsx";

export type DemoNoticeKind = "write" | "leave" | "download";

const COPY: Record<
  Locale,
  Record<"standing" | "leave" | "download", string>
> = {
  ko: {
    standing: "읽기 전용 데모 · 예시 데이터이며 바꾼 내용은 저장되지 않습니다",
    leave: "데모에서는 다른 사이트로 이동하지 않습니다.",
    download: "데모에서는 파일을 내려받을 수 없습니다.",
  },
  en: {
    standing: "Read-only demo · sample data, changes are not saved",
    leave: "Links to other sites are disabled in the demo.",
    download: "Files cannot be downloaded in the demo.",
  },
  ja: {
    standing: "読み取り専用デモ · サンプルデータで、変更は保存されません",
    leave: "デモでは他のサイトに移動しません。",
    download: "デモではファイルをダウンロードできません。",
  },
};

export const DEMO_NOTICE = "demo-notice";

/** Read when shown: the person may have switched language since. */
function text(kind: DemoNoticeKind | "standing"): string {
  const locale = initialLocale();
  return kind === "write"
    ? translate(locale, "error.DEMO_READ_ONLY")
    : COPY[locale][kind];
}

/**
 * The standing note that this is the demo, and a toast for each act the demo
 * does not carry out. Acts arrive as DEMO_NOTICE events on `notices`.
 */
export function DemoNotice({ notices }: { readonly notices: EventTarget }) {
  const { notify, toast } = useToast();
  useEffect(() => {
    const show = (event: Event) =>
      notify(text((event as CustomEvent<DemoNoticeKind>).detail));
    notices.addEventListener(DEMO_NOTICE, show);
    return () => notices.removeEventListener(DEMO_NOTICE, show);
  }, [notices, notify]);
  return (
    <>
      {/* Room below the page, so its last line scrolls clear of the badge. */}
      <div aria-hidden="true" className="h-16" />
      <p
        data-slot="demo-badge"
        className="pointer-events-none fixed right-4 bottom-4 z-50 m-0 max-w-[calc(100vw-2rem)] rounded-full border bg-popover px-3 py-1.5 text-caption text-popover-foreground shadow-pop sm:right-6 sm:bottom-6"
      >
        {text("standing")}
      </p>
      {toast}
    </>
  );
}
