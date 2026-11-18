import {
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "../foundations/cn.ts";

export interface BarChartDatum {
  /** The bar's key, such as a UTC date "2026-10-24"; formatX draws it. */
  readonly x: string;
  readonly y: number;
  /** A bar whose value is not final yet, drawn hatched instead of solid. */
  readonly partial?: boolean | undefined;
}

export interface BarChartProps {
  /** Oldest first. */
  readonly data: readonly BarChartDatum[];
  /** Names the chart: what is counted and over which period. */
  readonly label: string;
  /** The x labels under the plot: first, middle and last. */
  readonly formatX: (x: string) => string;
  /** The five y ticks; full chart only. */
  readonly formatY?: ((y: number) => string) | undefined;
  /**
   * One bar's tooltip, which is also its accessible name. A custom one must
   * say when the bar is partial; the hatching alone is not read out.
   */
  readonly formatTip?: ((datum: BarChartDatum) => string) | undefined;
  /** What the default tooltip adds to a partial bar. */
  readonly partialLabel?: string | undefined;
  /** The top of the y axis; by default the largest value rounded up. */
  readonly yMax?: number | undefined;
  /**
   * A summary beside other figures: 64px, no y axis, first and last x labels, no focus.
   * The label is then the only text a screen reader gets, so it should say
   * the period, the total and the busiest day.
   */
  readonly compact?: boolean | undefined;
  readonly className?: string | undefined;
}

// A full plot is 160px with a grid line every 40px; a compact one's 64px every 16.
const PLOT_HEIGHT = {
  full: "h-40 bg-size-[100%_40px]",
  compact: "h-16 bg-size-[100%_16px]",
};

/** The largest value rounded up to 2, 4, 6… times its power of ten. */
export function niceMax(values: readonly number[]): number {
  const max = Math.max(0, ...values);
  if (max === 0) return 1;
  const unit = 2 * 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / unit) * unit;
}

const HATCH =
  "bg-[repeating-linear-gradient(135deg,var(--werft-chart-mark)_0_2px,transparent_2px_6px)] shadow-[inset_0_0_0_1px_var(--werft-chart-mark)]";

/**
 * Bars over days for one series, in greys. The full chart is one Tab stop:
 * ← → move between bars, Home and End jump to the ends, and the bar under
 * the pointer or focus shows its tooltip.
 */
export function BarChart({
  data,
  label,
  formatX,
  formatY = String,
  partialLabel = "집계 중",
  formatTip = (datum) =>
    [
      formatX(datum.x),
      formatY(datum.y),
      ...(datum.partial ? [partialLabel] : []),
    ].join(" · "),
  yMax,
  compact = false,
  className,
}: BarChartProps): JSX.Element {
  const top = yMax ?? niceMax(data.map((datum) => datum.y));
  const height = (y: number) =>
    `${Math.min(100, Math.max(0, (y / top) * 100)).toFixed(1)}%`;
  const first = data[0];
  const middle = data[Math.floor(data.length / 2)];
  const last = data.at(-1);

  if (compact) {
    return (
      <div data-slot="bar-chart" data-compact="" className={className}>
        <div
          role="img"
          aria-label={label}
          className={cn(
            "flex items-end gap-0.5 border-border-strong border-b bg-[linear-gradient(var(--werft-chart-grid)_1px,transparent_1px)]",
            PLOT_HEIGHT.compact,
          )}
        >
          {data.map((datum) => (
            <span
              key={datum.x}
              className="flex h-full min-w-0 flex-1 items-end"
            >
              <span
                className={cn(
                  "block w-full rounded-t-[4px]",
                  datum.partial ? HATCH : "bg-chart-mark",
                )}
                style={{ height: height(datum.y) }}
              />
            </span>
          ))}
        </div>
        {first && last ? (
          <div
            aria-hidden="true"
            className="flex justify-between pt-1 text-caption text-subtle-foreground leading-4 tabular-nums"
          >
            <span>{formatX(first.x)}</span>
            <span>{formatX(last.x)}</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <FullChart
      data={data}
      label={label}
      ticks={[1, 0.75, 0.5, 0.25, 0].map((share) => formatY(top * share))}
      xLabels={
        first && middle && last
          ? [formatX(first.x), formatX(middle.x), formatX(last.x)]
          : []
      }
      height={height}
      formatTip={formatTip}
      className={className}
    />
  );
}

function FullChart({
  data,
  label,
  ticks,
  xLabels,
  height,
  formatTip,
  className,
}: {
  readonly data: readonly BarChartDatum[];
  readonly label: string;
  readonly ticks: readonly string[];
  readonly xLabels: readonly string[];
  readonly height: (y: number) => string;
  readonly formatTip: (datum: BarChartDatum) => string;
  readonly className?: string | undefined;
}): JSX.Element {
  // The bar that takes Tab (the latest by default) and the one showing a tip.
  const [focusIndex, setFocusIndex] = useState(data.length - 1);
  const [tipIndex, setTipIndex] = useState<number | null>(null);
  // New data can leave the remembered bar out of range; the latest takes Tab.
  const current =
    focusIndex >= 0 && focusIndex < data.length ? focusIndex : data.length - 1;
  const [tipLeft, setTipLeft] = useState(0);
  const figure = useRef<HTMLElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const bars = useRef<(HTMLButtonElement | null)[]>([]);
  const tipDatum = tipIndex === null ? undefined : data[tipIndex];

  // Centre the tip over its bar, kept inside the chart.
  useLayoutEffect(() => {
    if (tipIndex === null) return;
    const box = figure.current?.getBoundingClientRect();
    const bar = bars.current[tipIndex]?.getBoundingClientRect();
    const width = tip.current?.offsetWidth ?? 0;
    if (!box || !bar) return;
    const centre = bar.left - box.left + bar.width / 2 - width / 2;
    setTipLeft(Math.min(Math.max(0, centre), box.width - width));
  }, [tipIndex]);

  // Escape hides the tip wherever focus is, without moving the pointer or
  // focus (WCAG 1.4.13).
  useEffect(() => {
    if (tipIndex === null) return;
    const hide = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setTipIndex(null);
    };
    window.addEventListener("keydown", hide);
    return () => window.removeEventListener("keydown", hide);
  }, [tipIndex]);

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const at = Math.floor(
      ((event.clientX - box.left) / box.width) * data.length,
    );
    setTipIndex(Math.min(Math.max(0, at), data.length - 1));
  };

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const to = {
      ArrowLeft: current - 1,
      ArrowRight: current + 1,
      Home: 0,
      End: data.length - 1,
    }[event.key];
    if (to === undefined || to < 0 || to >= data.length) return;
    event.preventDefault();
    setFocusIndex(to);
    bars.current[to]?.focus();
  };

  return (
    <figure
      ref={figure}
      data-slot="bar-chart"
      aria-label={label}
      // Leaving the chart, not the plot, hides the tip, so the pointer can
      // move onto the tip without losing it (WCAG 1.4.13).
      onPointerLeave={() => setTipIndex(null)}
      className={cn(
        "relative m-0 grid grid-cols-[48px_1fr] gap-x-2",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="flex h-40 -translate-y-2 flex-col justify-between text-right text-caption text-subtle-foreground leading-4 tabular-nums"
      >
        {ticks.map((tick, index) => (
          // Ticks can repeat once rounded ("$0" twice), so the place is the key.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <span key={index}>{tick}</span>
        ))}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move focus between the bars inside; the bars are the controls. */}
      <div
        data-slot="bar-chart-plot"
        onKeyDown={move}
        // Bars on a phone are narrower than a 24px target (WCAG 2.5.8), so the
        // whole plot is the one pointer target and the pointer's x picks the
        // bar, as on a slider track; the bar buttons are for the keyboard and
        // assistive tech. A horizontal drag scrubs, a vertical one scrolls.
        onPointerMove={point}
        onPointerDown={point}
        className={cn(
          "relative flex cursor-pointer touch-pan-y items-end gap-0.5 border-border-strong border-b bg-[linear-gradient(var(--werft-chart-grid)_1px,transparent_1px)]",
          PLOT_HEIGHT.full,
        )}
      >
        {data.map((datum, index) => {
          const text = formatTip(datum);
          return (
            <button
              key={datum.x}
              ref={(element) => {
                bars.current[index] = element;
              }}
              type="button"
              aria-label={text}
              tabIndex={index === current ? 0 : -1}
              data-active={index === tipIndex || undefined}
              data-partial={datum.partial || undefined}
              onFocus={() => {
                setFocusIndex(index);
                setTipIndex(index);
              }}
              onBlur={() => setTipIndex(null)}
              className="group pointer-events-none flex h-full min-w-0 flex-1 items-end border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2"
            >
              <span
                className={cn(
                  "block w-full rounded-t-[4px] group-data-active:[--werft-chart-mark:var(--werft-chart-mark-active)]",
                  datum.partial ? HATCH : "bg-chart-mark",
                )}
                style={{ height: height(datum.y) }}
              />
            </button>
          );
        })}
      </div>
      <div
        aria-hidden="true"
        className="col-start-2 flex justify-between pt-1 text-caption text-subtle-foreground leading-4 tabular-nums"
      >
        {xLabels.map((text, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two periods can format alike
          <span key={index}>{text}</span>
        ))}
      </div>
      {/* The bar's own name says the same, so the tip is not read twice. */}
      <div
        ref={tip}
        aria-hidden="true"
        hidden={tipDatum === undefined}
        data-slot="bar-chart-tip"
        className="absolute -top-2 left-(--tip-left) z-2 whitespace-nowrap rounded-card bg-surface px-3 py-2 text-caption leading-4 shadow-pop"
        style={{ "--tip-left": `${tipLeft}px` } as CSSProperties}
      >
        {tipDatum ? formatTip(tipDatum) : null}
      </div>
    </figure>
  );
}

export interface BarChartLegendProps {
  readonly items: readonly {
    readonly label: string;
    readonly partial?: boolean | undefined;
  }[];
  readonly className?: string | undefined;
}

/** The swatches that tell a solid bar from a hatched one. */
export function BarChartLegend({
  items,
  className,
}: BarChartLegendProps): JSX.Element {
  return (
    <div
      data-slot="bar-chart-legend"
      className={cn(
        "flex flex-wrap gap-4 text-caption text-muted-foreground leading-4",
        className,
      )}
    >
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "size-3 rounded-[4px]",
              item.partial ? HATCH : "bg-chart-mark",
            )}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
