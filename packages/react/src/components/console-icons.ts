import { createLucideIcon } from "lucide-react";

/*
 * Console v4 draws these with Lucide 0.468.0, whose paths differ from the
 * lucide-react this package pins. The design's own nodes, so the icons match.
 */

export const Sparkles = createLucideIcon("sparkles", [
  [
    "path",
    {
      d: "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
      key: "sparkles-0",
    },
  ],
  ["path", { d: "M20 3v4", key: "sparkles-1" }],
  ["path", { d: "M22 5h-4", key: "sparkles-2" }],
  ["path", { d: "M4 17v2", key: "sparkles-3" }],
  ["path", { d: "M5 18H3", key: "sparkles-4" }],
]);

export const Pause = createLucideIcon("pause", [
  [
    "rect",
    { x: "14", y: "4", width: "4", height: "16", rx: "1", key: "pause-0" },
  ],
  [
    "rect",
    { x: "6", y: "4", width: "4", height: "16", rx: "1", key: "pause-1" },
  ],
]);
