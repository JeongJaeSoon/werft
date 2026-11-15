import { cn, GitHubMark, GoogleDriveMark, SlackMark } from "@werft-ai/ui";

// The marks themselves live in @werft-ai/ui so the session table in
// @werft-ai/react can draw the Slack mark too; the console keeps importing
// them from here.
export { GitHubMark, GoogleDriveMark, SlackMark };

type MarkProps = { readonly className?: string };

// An IconTile is one ink colour on every page, so a mark drawn on one paints
// every path in the tile's foreground, whatever colours its source gives.
const ON_TILE = "text-(--werft-color-tile-foreground) [&_path]:fill-current";

export function GitHubTileMark({ className }: MarkProps) {
  return <GitHubMark className={cn(className, ON_TILE)} />;
}

export function SlackTileMark({ className }: MarkProps) {
  return <SlackMark className={cn(className, ON_TILE)} />;
}

export function GoogleDriveTileMark({ className }: MarkProps) {
  return <GoogleDriveMark className={cn(className, ON_TILE)} />;
}
