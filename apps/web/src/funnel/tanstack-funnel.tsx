import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import {
  createFunnel,
  type FunnelReset,
  type FunnelRouter,
} from "@werft-ai/react";
import { Alert, AlertActions, Button } from "@werft-ai/ui";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n.tsx";

type FunnelState = ReturnType<FunnelRouter>["history"][number];

const isFunnelState = (value: unknown): value is FunnelState =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as FunnelState).step === "string" &&
  typeof (value as FunnelState).context === "object" &&
  (value as FunnelState).context !== null;

/*
 * Stores a flow the way @use-funnel/react-router does: the step is in the URL
 * as `?<id>.step=`, and history.state holds the states that led to it. Each
 * history entry keeps its own copy, so back, forward and a reload come back
 * to the step and its input; a copied URL carries no input and starts over.
 * Unlike that adapter, unmounting leaves the entry alone: StrictMode's
 * second mount would otherwise wipe the state it just restored.
 *
 * With `restart`, mounting starts over: a flow in a dialog mounts when the
 * dialog opens, and the entry still holds where it was when last closed.
 */
const tanstackRouterOver =
  ({ restart }: { readonly restart: boolean }): FunnelRouter =>
  ({ id, initialState }) => {
    const location = useLocation();
    const navigate = useNavigate();
    const router = useRouter();
    const [restarting, setRestarting] = useState(restart);
    const stepKey = `${id}.step`;
    const historyKey = `${id}.histories`;

    // HistoryState lists its keys and has no index signature; this key is
    // built from the flow's id.
    const saved = (location.state as unknown as Record<string, unknown>)[
      historyKey
    ];
    const history =
      !restarting &&
      Array.isArray(saved) &&
      saved.length > 0 &&
      saved.every(isFunnelState)
        ? saved
        : [initialState];
    const currentIndex = history.length - 1;

    // The flow can sit on any route, and a search updater for "." is typed
    // against every route's search at once, which no object satisfies.
    const write = (next: FunnelState[], replace: boolean) =>
      navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          [stepKey]: next.at(-1)?.step,
        }),
        state: (prev: Record<string, unknown>) => ({
          ...prev,
          [historyKey]: next,
        }),
        replace,
      } as unknown as Parameters<typeof navigate>[0]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount; StrictMode's second run writes the same entry.
    useEffect(() => {
      if (restarting)
        void write([initialState], true).then(() => setRestarting(false));
    }, []);

    return {
      history,
      currentIndex,
      push: (state) => write([...history, state], false),
      replace: (state) =>
        write([...history.slice(0, currentIndex), state], true),
      go: (delta) => router.history.go(delta),
      cleanup: () => {},
    };
  };

const tanstackFunnelRouter = tanstackRouterOver({ restart: false });

export const useFunnel = createFunnel(tanstackFunnelRouter);

/** A flow that starts over each time it mounts, as one in a dialog does. */
export const useDialogFunnel = createFunnel(
  tanstackRouterOver({ restart: true }),
);

const ANNOUNCE_DELAY_MS = 100;

/** Says a flow started over because its saved input no longer fit. */
export function FunnelResetNotice({
  funnel,
}: {
  readonly funnel: FunnelReset;
}) {
  const { t } = useI18n();
  // A live region that arrives already holding its text is not read out, and
  // a reload knows about the reset at the first render. So the region goes in
  // empty and the text follows a moment later.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div aria-live="polite">
      {ready && funnel.reset ? (
        <Alert variant="blue">
          <p className="m-0">{t("flow.reset")}</p>
          <AlertActions>
            <Button variant="ghost" size="sm" onClick={funnel.dismissReset}>
              {t("flow.reset.dismiss")}
            </Button>
          </AlertActions>
        </Alert>
      ) : null}
    </div>
  );
}
