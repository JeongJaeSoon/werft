import type { WebUiCounts } from "./architecture.test.ts";

/**
 * UI that apps/web still draws itself, per file under apps/web/src, rule and
 * count. It only shrinks: a PR that moves a screen onto packages/ui lowers or
 * removes its entry, and nothing is ever added here (see webUiRatchet).
 */
export const webUiAllowlist: WebUiCounts = {
  "components/auth-page.tsx": { "raw-destructive": 1 },
  "router.tsx": { "legacy-class": 1 },
  "routes/agents.tsx": { "legacy-class": 1 },
  "routes/layout.tsx": { "legacy-class": 1 },
  "styles.css": { "legacy-class": 33 },
};
