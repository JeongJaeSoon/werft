import { useI18n } from "../i18n/i18n.tsx";

/**
 * Said while a list or count left out private channels whose members the
 * server is still confirming. It names no count: how many were left out
 * would tell of channels the reader may not see.
 */
export function PrivateChannelsPending({
  pending,
}: {
  readonly pending: boolean;
}) {
  const { t } = useI18n();
  // The live region stays mounted so the words are announced when they come.
  return (
    <output className="block text-caption text-muted-foreground empty:hidden">
      {pending ? t("common.privateChannelsPending") : null}
    </output>
  );
}
