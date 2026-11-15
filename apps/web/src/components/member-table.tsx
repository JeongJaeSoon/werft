import {
  GridTable,
  GridTableColumnHeader,
  GridTableHeader,
} from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import { useI18n } from "../i18n/i18n.tsx";

// Role and actions keep one width on every row, so badges and buttons line
// up under their headers; the actions track never drops below its button.
const MEMBER_COLUMNS =
  "minmax(0,1.6fr) 120px minmax(var(--werft-row-action-min-width),1fr)";

/** Columns and header of a table that is not who / role / actions. */
export type MemberTableLayout = {
  readonly columns: string;
  /** The GridTableColumnHeader cells, in the columns' order. */
  readonly headers: ReactNode;
};

/**
 * The one table of the members area. By default it holds the
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
  return (
    <GridTable aria-label={label} columns={layout?.columns ?? MEMBER_COLUMNS}>
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
  );
}
