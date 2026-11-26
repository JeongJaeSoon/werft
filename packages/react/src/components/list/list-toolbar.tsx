import {
  cn,
  SearchInput,
  type SearchInputProps,
  SegmentedControl,
  SegmentedControlItem,
} from "@werft-ai/ui";
import type { ComponentType, JSX, ReactNode, SVGProps } from "react";

export interface ListToolbarProps {
  /**
   * The list's categories on the left, usually a SegmentedControl with
   * counts.
   */
  readonly filter: ReactNode;
  /** Secondary filters, usually FilterMenu chips, first on the right. */
  readonly filters?: ReactNode;
  /** How the list is drawn (cards or table), usually a ListViewSwitch. */
  readonly view?: ReactNode;
  /** The search field, last on the right. */
  readonly search?: SearchInputProps | undefined;
  readonly className?: string | undefined;
}

/*
 * The list toolbar of the session and agent lists: categories on the left;
 * on the right the chips, the view switch, then the search. Every control is
 * 32px with the control corner and the input edge. The search keeps a fixed
 * 260px beside the categories; below `sm` the right group takes its own
 * full-width row and the search fills what the others leave. From `lg` it
 * is one row: the categories give way (a scrolling SegmentedControl scrolls)
 * and the right group keeps its width.
 */
export function ListToolbar({
  filter,
  filters,
  view,
  search,
  className,
}: ListToolbarProps): JSX.Element {
  return (
    <div
      data-slot="list-toolbar"
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 lg:flex-nowrap",
        className,
      )}
    >
      {filter}
      {filters || search || view ? (
        <div
          data-slot="list-toolbar-end"
          className="ml-auto flex w-full items-center gap-2 sm:w-auto lg:shrink-0"
        >
          {filters}
          {view}
          {search ? (
            <SearchInput
              {...search}
              wrapperClassName={cn(
                "min-w-0 max-w-none flex-1 sm:w-[260px] sm:flex-none",
                search.wrapperClassName,
              )}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface ListViewOption<View extends string> {
  readonly value: View;
  /** Visible from `sm` up; below it the icon alone shows and this is its name. */
  readonly label: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export interface ListViewSwitchProps<View extends string> {
  readonly "aria-label": string;
  readonly value: View;
  readonly onValueChange: (value: View) => void;
  readonly options: readonly ListViewOption<View>[];
}

/** Cards or table, as a toolbar-sized segment that folds to icons on phones. */
export function ListViewSwitch<View extends string>({
  "aria-label": label,
  value,
  onValueChange,
  options,
}: ListViewSwitchProps<View>): JSX.Element {
  return (
    <SegmentedControl
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option) onValueChange(option.value);
      }}
      className="shrink-0 flex-nowrap"
    >
      {options.map(({ value: option, label: name, icon: Icon }) => (
        <SegmentedControlItem key={option} value={option}>
          <Icon aria-hidden="true" />
          <span className="max-sm:sr-only">{name}</span>
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
