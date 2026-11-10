import { cn } from "@werft-ai/ui";
import { Bot } from "lucide-react";
import type { JSX } from "react";

/** The agent's icon: a bot in a round fill, the same for every agent. */
export function AgentMark({
  size = "lg",
  className,
}: {
  readonly size?: "lg" | "two-line";
  readonly className?: string | undefined;
}): JSX.Element {
  return (
    <span
      data-slot="agent-mark"
      aria-hidden="true"
      className={cn(
        "inline-grid flex-none place-items-center rounded-full bg-muted text-muted-foreground",
        size === "lg"
          ? "size-8"
          : "size-(--werft-size-tile-two-line) self-start",
        className,
      )}
    >
      <Bot className="size-4" strokeWidth={1.5} aria-hidden="true" />
    </span>
  );
}
