import {
  GridTable,
  type GridTableColumnAlign,
  GridTableColumnHeader,
  GridTableHeader,
} from "@werft-ai/ui";
import type { ComponentProps, JSX, ReactNode } from "react";

import { useI18n } from "../i18n/i18n.tsx";

// Name | email | role | status | ⋯. Role, status and the ⋯ button keep one
// width on every row, so badges and dots line up under their headers.
const MEMBER_COLUMNS =
  "minmax(0,1.3fr) minmax(0,1.5fr) 104px 104px var(--werft-control-height-sm)";
// Name and email keep enough to read the start of each; status fits
// "Suspended" with its dot, and "Expired"/"期限切れ" with the expiry icon.
const MEMBER_NARROW_COLUMNS =
  "minmax(6rem,1fr) minmax(8rem,1fr) 72px 96px var(--werft-control-height-sm)";
const MEMBER_ALIGN: readonly GridTableColumnAlign[] = [
  "start",
  "start",
  "start",
  "start",
  "action",
];
// 420px of narrow tracks, four 16px gaps, the row's 16px padding on each side
// and the frame's 1px border on each side.
const MEMBER_TABLE_MIN = "min-w-[518px]";

/** Columns and header of a table that is not the members table. */
export type MemberTableLayout = {
  readonly columns: string;
  readonly narrowColumns: string;
  readonly narrowAt: NonNullable<ComponentProps<typeof GridTable>["narrowAt"]>;
  readonly align: readonly GridTableColumnAlign[];
  /** The GridTableColumnHeader cells, in the columns' order. */
  readonly headers: ReactNode;
};

/**
 * The frame of every table in the members area. By default it holds the
 * members table's columns (name, email, role, status, ⋯ menu); the invites
 * and team tables pass their own `layout`. The rows are the caller's:
 * GridTableRow children whose cells follow the header's order.
 */
export function MemberTableFrame({
  label,
  layout,
  children,
}: {
  readonly label: string;
  readonly layout?: MemberTableLayout;
  readonly children: ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  // Below the table's minimum the columns would cover each other, so it
  // scrolls instead. The padding keeps the opener's focus ring, 2px outside
  // the row, inside the scroller's clip.
  return (
    <div className="-m-1 grid overflow-x-auto p-1">
      <GridTable
        aria-label={label}
        columns={layout?.columns ?? MEMBER_COLUMNS}
        align={layout?.align ?? MEMBER_ALIGN}
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
              <GridTableColumnHeader>
                {t("members.column.name")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("members.column.email")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("members.column.role")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("members.column.status")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
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
