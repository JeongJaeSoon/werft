import {
  GridTable,
  GridTableColumnHeader,
  GridTableHeader,
} from "@werft-ai/ui";
import type { ReactNode } from "react";

import { SESSION_NARROW_TEMPLATE, SESSION_TEMPLATE } from "./session-row.tsx";

export interface SessionTableProps {
  readonly label: string;
  readonly messages: {
    readonly id: string;
    readonly status: string;
    readonly admission: string;
    readonly runtime: string;
    readonly lastEvent: string;
    readonly created: string;
  };
  readonly children: ReactNode;
}

export function SessionTable({ label, messages, children }: SessionTableProps) {
  return (
    // The row opener's focus ring sits outside the row, so this frame must
    // not clip overflow.
    <div className="w-full min-w-0 rounded-card border bg-card">
      <GridTable
        aria-label={label}
        columns={SESSION_TEMPLATE}
        narrowAt={820}
        narrowColumns={SESSION_NARROW_TEMPLATE}
      >
        <GridTableHeader>
          <GridTableColumnHeader>{messages.id}</GridTableColumnHeader>
          <GridTableColumnHeader>{messages.status}</GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow={true}>
            {messages.admission}
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow={true}>
            {messages.runtime}
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            <span className="truncate">
              {messages.lastEvent} / {messages.created}
            </span>
          </GridTableColumnHeader>
        </GridTableHeader>
        {children}
      </GridTable>
    </div>
  );
}
