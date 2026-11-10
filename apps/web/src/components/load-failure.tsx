import { ApiError } from "@werft-ai/client";
import {
  ApiErrorState,
  ERROR_GUIDANCE,
  guidanceFor,
} from "@werft-ai/react/components";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Button,
} from "@werft-ai/ui";
import { errorKey, useI18n } from "../i18n/i18n.tsx";

/**
 * A read that failed, with a button that asks again. A first read shows
 * `ApiErrorState` in the reader's language; a read that failed while an
 * earlier answer is still on screen (`kept`) is an alert above it. A 403 is
 * not this; each screen says who may see it instead.
 */
export function LoadFailure({
  error,
  onRetry,
  guidance,
  kept = false,
  title,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
  /** The screen's own instruction, where it knows more than the code. */
  readonly guidance?: string | undefined;
  readonly kept?: boolean;
  /** A kept alert's heading, naming what failed to refresh. */
  readonly title?: string | undefined;
}) {
  const { t, locale } = useI18n();
  const code = error instanceof ApiError ? error.code : undefined;
  // Codes only the web client makes (NETWORK_ERROR) are not in the shared table.
  const said =
    guidance ??
    (code && !Object.hasOwn(ERROR_GUIDANCE, code)
      ? t(errorKey(code))
      : undefined);
  if (kept) {
    return (
      <Alert variant="red" role="alert">
        <AlertTitle>{title ?? t("status.loadFailed")}</AlertTitle>
        <AlertDescription>
          {said ?? guidanceFor(code, locale) ?? t("error.UNKNOWN")}
        </AlertDescription>
        <AlertActions>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        </AlertActions>
      </Alert>
    );
  }
  return (
    <ApiErrorState
      locale={locale}
      title={t("status.loadFailed")}
      code={code}
      guidance={said}
      // Without a code there is no guidance to lead with.
      message={code || said ? undefined : t("error.UNKNOWN")}
      retry={onRetry}
      retryLabel={t("common.retry")}
    />
  );
}
