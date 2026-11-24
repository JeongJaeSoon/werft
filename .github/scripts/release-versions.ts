#!/usr/bin/env bun
// Which release the things shared by every release follow: the GitHub Release
// marked "Latest" (release-latest.sh) and the Pages site (pages-target.sh).
// They follow the highest stable version
// of all that exist, never the version of the run that happens to write them,
// so a hotfix on an older line or a prerelease moves nothing.
//
// usage: release-versions.ts latest   (tags on stdin, one per line)

// A stable version as release-auto.sh accepts one: no prerelease part, no
// leading zero in a number.
const STABLE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The highest stable version among `tags`; anything else in the list is ignored. */
export function highestStable(tags: string[]): string | undefined {
  let best: { tag: string; parts: bigint[] } | undefined;
  for (const tag of tags) {
    const match = STABLE.exec(tag);
    if (!match) continue;
    // BigInt: release-auto.sh allows numbers of up to 18 digits.
    const parts = match.slice(1).map(BigInt);
    if (!best || isHigher(parts, best.parts)) best = { tag, parts };
  }
  return best?.tag;
}

function isHigher(a: bigint[], b: bigint[]): boolean {
  for (const [index, part] of a.entries()) {
    const other = b[index] ?? 0n;
    if (part !== other) return part > other;
  }
  return false;
}

async function main(argv: string[]): Promise<void> {
  if (argv.length !== 1 || argv[0] !== "latest") {
    console.error("usage: release-versions.ts latest < tags");
    process.exit(2);
  }
  const tags = (await Bun.stdin.text()).split("\n").map((line) => line.trim());
  const latest = highestStable(tags);
  if (latest !== undefined) console.log(latest);
}

if (import.meta.main) await main(process.argv.slice(2));
