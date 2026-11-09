import {
  GridTable,
  GridTableColumnHeader,
  GridTableHeader,
} from "@werft-ai/ui";
import type { ComponentProps, JSX, ReactNode } from "react";

import { useI18n } from "../i18n/i18n.tsx";

// Role and actions keep one width on every row, so badges and buttons line
// up under their headers; the actions track never drops below its button.
export const MEMBER_COLUMNS =
  "minmax(0,1.6fr) 120px minmax(var(--werft-row-action-min-width),1fr)";
export const MEMBER_NARROW_COLUMNS =
  "minmax(0,1fr) 72px var(--werft-row-action-min-width)";
// 320px of columns plus the frame's 1px border on each side.
const MEMBER_TABLE_MIN = "min-w-[322px]";

/** Columns and header of a table that is not who / role / actions. */
export type MemberTableLayout = {
  readonly columns: string;
  readonly narrowColumns: string;
  readonly narrowAt: NonNullable<ComponentProps<typeof GridTable>["narrowAt"]>;
  /** The GridTableColumnHeader cells, in the columns' order. */
  readonly headers: ReactNode;
};

/**
 * The frame of every table in the members area. By default it holds the
 * three columns (who, role, actions) of the members and invites tables; the
 * team tables pass their own `layout`. The rows are the caller's:
 * GridTableRow children whose cells follow the header's order and alignment.
 */
export function MemberTableFrame({
  label,
  firstColumn,
  layout,
  children,
}: {
  readonly label: string;
  /** The first header: what one row is (a member, an invite). */
  readonly firstColumn?: string;
  readonly layout?: MemberTableLayout;
  readonly children: ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  // Below the table's minimum the actions would cover the role badges, so it
  // scrolls instead. The padding keeps the opener's focus ring, 2px outside
  // the row, inside the scroller's clip.
  return (
    <div className="-m-1 grid overflow-x-auto p-1">
      <GridTable
        aria-label={label}
        columns={layout?.columns ?? MEMBER_COLUMNS}
        narrowAt={layout?.narrowAt ?? 640}
        narrowColumns={layout?.narrowColumns ?? MEMBER_NARROW_COLUMNS}
        framed={true}
        className={layout ? undefined : MEMBER_TABLE_MIN}
      >
        <GridTableHeader>
          {layout ? (
            layout.headers
          ) : (
            <>
              <GridTableColumnHeader>{firstColumn}</GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("members.column.role")}
              </GridTableColumnHeader>
              <GridTableColumnHeader action={true}>
                {t("members.column.actions")}
              </GridTableColumnHeader>
            </>
          )}
        </GridTableHeader>
        {children}
      </GridTable>
    </div>
  );
}
