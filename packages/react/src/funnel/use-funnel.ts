import {
  type AnyFunnelState,
  createUseFunnel,
  type FunnelStepOption,
  funnelStepOptionIsGuard,
  type UseFunnelOptions,
  type UseFunnelResults,
} from "@use-funnel/core";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Where a flow keeps its steps: the host app implements it over its own
 * router, so this package never imports one.
 */
export type FunnelRouter = Parameters<typeof createUseFunnel>[0];
type FunnelRouterResult = ReturnType<FunnelRouter>;
type RouteOption = Parameters<FunnelRouterResult["push"]>[1];

export type StepContextMap = Record<string, Record<string, unknown>>;

export interface FunnelReset {
  /**
   * A step's guard turned its input away, so the flow went back to its first
   * step. Stays set until dismissed, for the screen to say so.
   */
  readonly reset: boolean;
  readonly dismissReset: () => void;
}

export type Funnel<TStepContextMap extends StepContextMap> = UseFunnelResults<
  TStepContextMap,
  NonNullable<RouteOption>
> &
  FunnelReset;

export type UseFunnel = <TStepContextMap extends StepContextMap>(
  options: UseFunnelOptions<TStepContextMap>,
) => Funnel<TStepContextMap>;

type StepOptions = Record<string, FunnelStepOption<unknown> | undefined>;

interface Channel {
  /** What the router stored, before an unknown step is swapped out. */
  readonly routerRef: RefObject<FunnelRouterResult | null>;
  readonly turnedAway: RefObject<boolean>;
}

const isStep = (steps: StepOptions | undefined, step: string): boolean =>
  steps === undefined || Object.hasOwn(steps, step);

/** Whether the flow may show this state: a known step its guard accepts. */
const fits = (
  steps: StepOptions | undefined,
  { step, context }: AnyFunnelState,
): boolean => {
  if (!isStep(steps, step)) return false;
  const option = steps?.[step];
  return (
    option === undefined ||
    !funnelStepOptionIsGuard(option) ||
    option.guard(context)
  );
};

/**
 * `@use-funnel/core`'s useFunnel over the given router. Run steps behind a
 * `guard`, never a `parse`, and list every step in `steps`: input kept in
 * history from before a deploy can name a step that is gone or stop matching
 * its schema. A guard sends the flow back to its initial step where a parse
 * would throw; the core does that silently and renders a step it does not
 * know, so this also turns unknown steps away, clears the stored input and
 * raises `reset`.
 */
export function createFunnel(router: FunnelRouter): UseFunnel {
  const useCoreFunnel = createUseFunnel((option) => {
    const result = router(option);
    // The core spreads the hook's options into this call, so the refs that
    // useFunnel adds below arrive on `option`, outside its declared type.
    const channel = option as unknown as Channel;
    channel.routerRef.current = result;
    const current = result.history[result.currentIndex];
    if (!current || isStep(option.steps as StepOptions, current.step))
      return result;
    channel.turnedAway.current = true;
    return {
      ...result,
      history: [
        ...result.history.slice(0, result.currentIndex),
        option.initialState,
      ],
    };
  });

  return function useFunnel<TStepContextMap extends StepContextMap>(
    options: UseFunnelOptions<TStepContextMap>,
  ): Funnel<TStepContextMap> {
    const routerRef = useRef<FunnelRouterResult | null>(null);
    const turnedAway = useRef(false);
    const [reset, setReset] = useState(false);
    const dismissReset = useCallback(() => setReset(false), []);

    const steps = options.steps as StepOptions | undefined;
    const watched = steps
      ? Object.fromEntries(
          Object.entries(steps).map(([name, option]) => [
            name,
            option && funnelStepOptionIsGuard(option)
              ? {
                  guard: (data: unknown): data is unknown => {
                    const ok = option.guard(data);
                    if (!ok) turnedAway.current = true;
                    return ok;
                  },
                }
              : option,
          ]),
        )
      : undefined;

    // The core's type parameters are conditional on the step map, which a
    // generic caller cannot resolve; the shapes are the same.
    const funnel = (
      useCoreFunnel as unknown as (
        options: UseFunnelOptions<TStepContextMap> & Channel,
      ) => UseFunnelResults<TStepContextMap, NonNullable<RouteOption>>
    )({
      ...options,
      ...(watched ? { steps: watched as typeof options.steps } : {}),
      routerRef,
      turnedAway,
    });
    // Set while this render validated the stored step, or by a transition.
    const turnedAwayNow = turnedAway.current;

    useEffect(() => {
      if (!turnedAway.current) return;
      turnedAway.current = false;
      setReset(true);
      // A transition that failed its guard already went to the initial
      // state; input that failed on the way in is still stored, so a reload
      // would only fail again. An initial state that does not fit itself
      // would be written forever.
      const initial: AnyFunnelState = {
        step: options.initial.step,
        context: options.initial.context ?? {},
      };
      const stored = routerRef.current;
      const current = stored?.history[stored.currentIndex];
      if (current && !fits(steps, current) && fits(steps, initial))
        void stored?.replace(initial);
    });

    return { ...funnel, reset: reset || turnedAwayNow, dismissReset };
  };
}
