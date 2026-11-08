import {
  GridTable,
  GridTableColumnHeader,
  GridTableHeader,
} from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import { useI18n } from "../i18n/i18n.tsx";

// Role and actions keep one width on every row, so badges and buttons line
// up under their headers; the actions track never drops below its button.
export const MEMBER_COLUMNS =
  "minmax(0,1.6fr) 120px minmax(var(--werft-row-action-min-width),1fr)";
export const MEMBER_NARROW_COLUMNS =
  "minmax(0,1fr) 72px var(--werft-row-action-min-width)";
// 320px of columns plus the frame's 1px border on each side.
const MEMBER_TABLE_MIN = "min-w-[322px]";

/**
 * The frame and the three columns (who, role, actions) of the members and
 * invites tables. The rows are the caller's: GridTableRow children whose
 * cells follow the same order and the header's alignment.
 */
export function MemberTableFrame({
  label,
  firstColumn,
  children,
}: {
  readonly label: string;
  /** The first header: what one row is (a member, an invite). */
  readonly firstColumn: string;
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
        columns={MEMBER_COLUMNS}
        narrowAt={640}
        narrowColumns={MEMBER_NARROW_COLUMNS}
        framed={true}
        className={MEMBER_TABLE_MIN}
      >
        <GridTableHeader>
          <GridTableColumnHeader>{firstColumn}</GridTableColumnHeader>
          <GridTableColumnHeader>
            {t("members.column.role")}
          </GridTableColumnHeader>
          <GridTableColumnHeader action={true}>
            {t("members.column.actions")}
          </GridTableColumnHeader>
        </GridTableHeader>
        {children}
      </GridTable>
    </div>
  );
}
