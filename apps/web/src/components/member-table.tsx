import {
  GridTable,
  type GridTableColumnAlign,
  GridTableColumnHeader,
  GridTableHeader,
} from "@werft-ai/ui";
import type { ComponentProps, JSX, ReactNode } from "react";

import { useI18n } from "../i18n/i18n.tsx";

// Name | email | role | status | ⋯. Role, status and the ⋯ button are as
// wide as their widest cell; name and email share the rest. At 640px or
// less each row is a card, so no column is cut off on a phone.
const MEMBER_COLUMNS =
  "minmax(0,1.3fr) minmax(0,1.5fr) max-content max-content max-content";
const MEMBER_ALIGN: readonly GridTableColumnAlign[] = [
  "start",
  "start",
  "start",
  "start",
  "action",
];

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
 * members table's columns (name, email, role, status, ⋯ menu), drawn as
 * cards when narrow; give those rows' cells after the email a `cardLabel`.
 * The team tables pass their own `layout`. The rows are the caller's:
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
  // A team table below its columns' minimum scrolls instead of letting them
  // cover each other. The padding keeps the opener's focus ring, 2px outside
  // the row, inside the scroller's clip.
  return (
    <div className="-m-1 grid overflow-x-auto p-1">
      <GridTable
        aria-label={label}
        columns={layout?.columns ?? MEMBER_COLUMNS}
        align={layout?.align ?? MEMBER_ALIGN}
        {...(layout
          ? { narrowAt: layout.narrowAt, narrowColumns: layout.narrowColumns }
          : { narrowAt: 640 as const, narrowCards: true as const })}
        framed={true}
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
