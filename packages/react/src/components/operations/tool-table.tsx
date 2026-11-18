import {
  Card,
  Code,
  cn,
  EmptyState,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
  Meter,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import type { JSX } from "react";

import type { ToolTableMessages } from "./messages.ts";
import type { UsageTool } from "./tools.ts";
import { useOperationsMessages } from "./use-messages.ts";

// Name, calls, total, median, failed; at 480px and under the two times go.
const COLUMNS = "minmax(0,1fr) max-content max-content max-content max-content";
const NARROW_COLUMNS = "minmax(0,1fr) max-content max-content";

export interface ToolTableProps {
  /** GET /v1/usage/tools `tools`, in the order to show; undefined while read. */
  readonly tools: readonly UsageTool[] | undefined;
  /** Names the table, e.g. "도구와 명령". */
  readonly label: string;
  /** The `name` of the row whose tool is shown below the list. */
  readonly selected?: string | undefined;
  readonly onSelect?: ((name: string) => void) | undefined;
  /** The id of the section a row opens, which each opener points at. */
  readonly controls?: string | undefined;
  /**
   * A short note under a name, such as "셸 명령"; not an API field. Loading
   * rows keep a note line whenever this is given.
   */
  readonly describe?: ((name: string) => string | undefined) | undefined;
  /** Placeholder rows while `tools` is read, e.g. the last count seen. */
  readonly loadingRows?: number | undefined;
  /** `tools` is a search's matches, so none means no match. */
  readonly searched?: boolean | undefined;
  readonly messages?: Partial<ToolTableMessages> | undefined;
}

/**
 * Tools by calls, time and failures. A row opens below the list: its opener is a
 * toggle button, pressed for the row shown, since the table is
 * role="table" and its rows cannot be selected.
 */
export function ToolTable({
  tools,
  label,
  selected,
  onSelect,
  controls,
  describe,
  loadingRows = 3,
  searched = false,
  messages: override,
}: ToolTableProps): JSX.Element {
  const { messages, format } = useOperationsMessages("toolTable", override);
  if (tools?.length === 0) {
    return <EmptyState title={searched ? messages.noMatch : messages.empty} />;
  }
  const most = Math.max(0, ...(tools ?? []).map((tool) => tool.calls));
  return (
    <Card flush>
      <GridTable
        aria-label={label}
        aria-busy={tools === undefined || undefined}
        columns={COLUMNS}
        narrowAt={480}
        narrowColumns={NARROW_COLUMNS}
        align={["start", "end", "end", "end", "end"]}
      >
        <GridTableHeader>
          <GridTableColumnHeader>{messages.name}</GridTableColumnHeader>
          <GridTableColumnHeader>{messages.calls}</GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>
            {messages.total}
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>
            {messages.median}
          </GridTableColumnHeader>
          <GridTableColumnHeader>{messages.failed}</GridTableColumnHeader>
        </GridTableHeader>
        {tools === undefined
          ? Array.from({ length: loadingRows }, (_, row) => row).map((row) => (
              <GridTableRow key={row}>
                {/* A tool row's lines at their heights, so rows do not grow
                    when the tools come; the table says it once. */}
                <GridTableCell lines className="gap-1">
                  <Skeleton
                    decorative
                    width="40%"
                    height="1lh"
                    className="justify-center"
                  />
                  {describe ? (
                    <Skeleton
                      decorative
                      width="25%"
                      height="1lh"
                      className="justify-center text-caption"
                    />
                  ) : null}
                  <Skeleton decorative height="0.25rem" />
                  {row === 0 ? (
                    <span className="sr-only">{messages.loading}</span>
                  ) : null}
                </GridTableCell>
                <GridTableCell />
                <GridTableCell hideNarrow />
                <GridTableCell hideNarrow />
                <GridTableCell />
              </GridTableRow>
            ))
          : tools.map((tool) => {
              const pressed = tool.name === selected;
              const note = describe?.(tool.name);
              return (
                <GridTableRow
                  key={tool.name}
                  data-selected={pressed || undefined}
                  className={cn(pressed && "bg-active hover:bg-active")}
                >
                  <GridTableCell lines className="gap-1">
                    <GridTableRowOpener
                      aria-label={messages.open(tool.name)}
                      aria-pressed={pressed}
                      aria-controls={controls}
                      // The picked tool's heading sticks to the screen's
                      // bottom; a row the keyboard reaches stops above it.
                      className="scroll-mb-18"
                      onClick={() => onSelect?.(tool.name)}
                    />
                    <Text as="span" weight="medium">
                      <Code size="inherit">{tool.name}</Code>
                    </Text>
                    {note ? (
                      <Text
                        as="span"
                        variant="meta"
                        // subtle-foreground falls under AA on bg-active.
                        className={cn(pressed && "text-muted-foreground")}
                      >
                        {note}
                      </Text>
                    ) : null}
                    <Meter
                      size="inline"
                      value={tool.calls}
                      max={most}
                      label={messages.callsMeter(tool.name)}
                      className="w-full"
                    />
                  </GridTableCell>
                  <GridTableCell className="tabular-nums">
                    {format.count(tool.calls)}
                  </GridTableCell>
                  <GridTableCell hideNarrow className="tabular-nums">
                    {format.elapsed(tool.total_ms)}
                  </GridTableCell>
                  <GridTableCell hideNarrow className="tabular-nums">
                    {format.elapsed(tool.median_ms)}
                  </GridTableCell>
                  <GridTableCell
                    className={cn(
                      "tabular-nums",
                      tool.failed > 0 && "text-(color:--werft-tone-danger-fg)",
                    )}
                  >
                    {format.count(tool.failed)}
                  </GridTableCell>
                </GridTableRow>
              );
            })}
      </GridTable>
    </Card>
  );
}
