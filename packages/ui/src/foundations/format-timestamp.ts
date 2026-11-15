/*
 * The zone is fixed to Asia/Seoul — the product is Korean-facing. Swap it for
 * the user's profile timezone when 설정 gains one (I0 설정 화면).
 *
 * The *pattern* is assembled by hand rather than left to `dateStyle: "short"`,
 * which is not stable across platforms: the same instant rendered
 * "26. 9. 21." on macOS and "2026. 9. 21." on the CI runner, and the snapshot
 * caught it. Only the field values come from Intl, so the zone conversion is
 * still the library's job.
 */
const OPTIONS = {
  timeZone: "Asia/Seoul",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  // h23, not `hour12: false`: some ICU builds render midnight as 24 otherwise.
  hourCycle: "h23",
} as const satisfies Intl.DateTimeFormatOptions;

export type TimestampLocale = "ko" | "ja" | "en";

const PARTS: Record<TimestampLocale, Intl.DateTimeFormat> = {
  ko: new Intl.DateTimeFormat("ko-KR", {
    ...OPTIONS,
    month: "2-digit",
    day: "2-digit",
  }),
  ja: new Intl.DateTimeFormat("ja-JP", {
    ...OPTIONS,
    month: "2-digit",
    day: "2-digit",
  }),
  en: new Intl.DateTimeFormat("en-US", {
    ...OPTIONS,
    month: "short",
    day: "numeric",
  }),
};

export function formatTimestamp(
  iso: string,
  locale: TimestampLocale = "ko",
): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;

  const parts = new Map(
    PARTS[locale]
      .formatToParts(parsed)
      .map((part) => [part.type, part.value] as const),
  );
  const at = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.get(type) ?? "";

  const time = `${at("hour")}:${at("minute")}`;
  switch (locale) {
    case "en":
      return `${at("month")} ${at("day")}, ${at("year")}, ${time}`;
    case "ja":
      return `${at("year")}/${at("month")}/${at("day")} ${time}`;
    default:
      return `${at("year")}. ${at("month")}. ${at("day")}. ${time}`;
  }
}

const CLOCK: Record<TimestampLocale, string> = {
  ko: "ko-KR",
  ja: "ja-JP",
  en: "en-US",
};

/**
 * A chat line's time of day: "오전 09:42". `withDate` puts the month and day
 * first, "11월 11일 오전 09:42", for a value read away from its day.
 */
export function formatClockTime(
  iso: string,
  locale: TimestampLocale = "ko",
  withDate = false,
): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat(CLOCK[locale], {
    timeZone: OPTIONS.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    ...(withDate ? { month: "long", day: "numeric" } : {}),
  }).format(parsed);
}

/*
 * A table's time column: the year left out, the clock as people say it.
 * "11월 11일 오전 09:42", "Nov 11, 9:42 AM", "11月11日 9:42". The pattern is
 * assembled by hand like formatTimestamp's, for the same reason.
 */
const TABLE_PARTS: Record<TimestampLocale, Intl.DateTimeFormat> = {
  ko: new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h12",
  }),
  ja: new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }),
  en: new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
  }),
};

export function formatTableDateTime(
  iso: string,
  locale: TimestampLocale = "ko",
): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const parts = new Map(
    TABLE_PARTS[locale]
      .formatToParts(parsed)
      .map((part) => [part.type, part.value] as const),
  );
  const at = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.get(type) ?? "";
  const time = `${at("hour")}:${at("minute")}`;
  switch (locale) {
    case "en":
      return `${at("month")} ${at("day")}, ${time} ${at("dayPeriod").toUpperCase()}`;
    case "ja":
      return `${at("month")}月${at("day")}日 ${time}`;
    default:
      return `${at("month")}월 ${at("day")}일 ${at("dayPeriod")} ${time}`;
  }
}

const DURATION_WORDS: Record<
  TimestampLocale,
  {
    readonly under: string;
    readonly minutes: (m: number) => string;
    readonly hours: (h: number, m: number) => string;
  }
> = {
  ko: {
    under: "1분 미만",
    minutes: (m) => `${m}분`,
    hours: (h, m) => (m === 0 ? `${h}시간` : `${h}시간 ${m}분`),
  },
  en: {
    under: "<1 min",
    minutes: (m) => `${m} min`,
    hours: (h, m) => (m === 0 ? `${h} h` : `${h} h ${m} min`),
  },
  ja: {
    under: "1分未満",
    minutes: (m) => `${m}分`,
    hours: (h, m) => (m === 0 ? `${h}時間` : `${h}時間${m}分`),
  },
};

/**
 * How long something took between the two times, in whole minutes: "18분",
 * "1시간 5분", "1분 미만". Null when either end is not a time or `to` comes
 * first.
 */
export function formatDuration(
  ms: number,
  locale: TimestampLocale = "ko",
): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  const words = DURATION_WORDS[locale];
  if (minutes < 1) return words.under;
  if (minutes < 60) return words.minutes(minutes);
  return words.hours(Math.floor(minutes / 60), minutes % 60);
}
