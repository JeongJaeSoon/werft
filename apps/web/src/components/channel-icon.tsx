import { Globe, Plug, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { GitHubMark, SlackMark } from "./brand-marks.tsx";

const MARKS: Record<string, ReactNode> = {
  slack: <SlackMark className="size-4" />,
  github: <GitHubMark className="size-4" />,
  web: <Globe className="size-4" strokeWidth={1.5} aria-hidden="true" />,
  api: <Terminal className="size-4" strokeWidth={1.5} aria-hidden="true" />,
};

/** The interface a session came in through, named for screen readers. */
export function ChannelIcon({ channel }: { readonly channel: string | null }) {
  const name = channel ?? "—";
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className="inline-flex size-6 items-center justify-center text-muted-foreground"
    >
      {MARKS[name] ?? (
        <Plug className="size-4" strokeWidth={1.5} aria-hidden="true" />
      )}
    </span>
  );
}
