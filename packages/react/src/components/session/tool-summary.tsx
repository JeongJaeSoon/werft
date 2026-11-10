import type {
  ToolRequestPresentation,
  ToolVerbMessage,
} from "@werft-ai/contracts";
import { CodeBlock, Text } from "@werft-ai/ui";
import type { JSX } from "react";

/**
 * What a tool request does and to what, in the words Slack's card uses
 * (`presentPendingRequest`), so the person need not read the raw input to
 * decide. Draws nothing for a server that sent no summary.
 */
export function ToolSummary({
  summary,
  verb,
}: {
  readonly summary: ToolRequestPresentation | undefined;
  readonly verb: ((message: ToolVerbMessage) => string) | undefined;
}): JSX.Element | null {
  if (summary === undefined || verb === undefined) return null;
  return (
    <div data-slot="tool-summary" className="flex min-w-0 flex-col gap-1">
      <Text variant="meta" className="[overflow-wrap:anywhere]">
        <span className="font-medium text-foreground">
          {verb(summary.verb)}
        </span>
        {summary.target === null ? null : (
          <>
            {" · "}
            <span>{summary.target}</span>
          </>
        )}
      </Text>
      {summary.excerpt === null ? null : (
        <CodeBlock className="max-h-24 overflow-y-auto">
          {summary.excerpt}
        </CodeBlock>
      )}
    </div>
  );
}
