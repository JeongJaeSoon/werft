import {
  GridTable,
  GridTableColumnHeader,
  GridTableHeader,
} from "@werft-ai/ui";
import type { ReactNode } from "react";

import { SESSION_TEMPLATE } from "./session-row.tsx";

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
    // Five columns stay legible only from about 52rem; a narrower box
    // scrolls the table sideways.
    <div className="w-full min-w-0">
      <GridTable aria-label={label} columns={SESSION_TEMPLATE} minWidth="52rem">
        <GridTableHeader>
          <GridTableColumnHeader>{messages.id}</GridTableColumnHeader>
          <GridTableColumnHeader>{messages.status}</GridTableColumnHeader>
          <GridTableColumnHeader>{messages.admission}</GridTableColumnHeader>
          <GridTableColumnHeader>{messages.runtime}</GridTableColumnHeader>
          <GridTableColumnHeader align="end">
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
