import type { JSX } from "react";

/**
 * Slack's mark, beside the word "Slack" where a session came from there.
 * Decorative: the word next to it names the channel.
 */
export function SlackMark({
  className,
}: {
  readonly className?: string | undefined;
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#E01E5A"
        d="M5.04 15.17a2.53 2.53 0 1 1-2.52-2.53h2.52v2.53Zm1.27 0a2.53 2.53 0 0 1 5.05 0v6.31a2.53 2.53 0 1 1-5.05 0v-6.31Z"
      />
      <path
        fill="#36C5F0"
        d="M8.83 5.04a2.53 2.53 0 1 1 2.53-2.52v2.52H8.83Zm0 1.27a2.53 2.53 0 0 1 0 5.05H2.52a2.53 2.53 0 0 1 0-5.05h6.31Z"
      />
      <path
        fill="#2EB67D"
        d="M18.96 8.83a2.53 2.53 0 1 1 2.52 2.53h-2.52V8.83Zm-1.27 0a2.53 2.53 0 0 1-5.05 0V2.52a2.53 2.53 0 1 1 5.05 0v6.31Z"
      />
      <path
        fill="#ECB22E"
        d="M15.17 18.96a2.53 2.53 0 1 1-2.53 2.52v-2.52h2.53Zm0-1.27a2.53 2.53 0 0 1 0-5.05h6.31a2.53 2.53 0 1 1 0 5.05h-6.31Z"
      />
    </svg>
  );
}
