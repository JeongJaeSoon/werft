import {
  GridTable,
  GridTableColumnHeader,
  GridTableHeader,
} from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import { useI18n } from "../i18n/i18n.tsx";

// Name | email | role | status | ⋯. Role and status keep one width on every
// row, so badges and dots line up under their headers.
const MEMBER_COLUMNS = "minmax(0,1.3fr) minmax(0,1.5fr) 104px 104px 40px";

/** Columns and header of a table that is not the members table. */
export type MemberTableLayout = {
  readonly columns: string;
  /** The GridTableColumnHeader cells, in the columns' order. */
  readonly headers: ReactNode;
};

/**
 * The one table of the members area. By default it holds the members
 * table's columns (name, email, role, status, ⋯ menu); the invites and team
 * tables pass their own `layout`. The rows are the caller's: GridTableRow
 * children whose cells follow the header's order and alignment.
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
  return (
    <GridTable aria-label={label} columns={layout?.columns ?? MEMBER_COLUMNS}>
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
            {/* The ⋯ column has no visible title. */}
            <GridTableColumnHeader>
              <span className="sr-only">{t("members.column.actions")}</span>
            </GridTableColumnHeader>
          </>
        )}
      </GridTableHeader>
      {children}
    </GridTable>
  );
}
