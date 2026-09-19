/**
 * Dates, and refusing to guess them.
 *
 * The rule this file exists to enforce: **a date is claimed only when the day, the
 * month and the year were all written down.** Three consequences follow, and each
 * is deliberate.
 *
 *  1. `March 2026` is a month, not a date. It is recorded as `monthOnly` and never
 *     rendered as a day.
 *  2. `06/03/2026` could be the sixth of March or the third of June. It is recorded
 *     as `ambiguous` and left alone rather than resolved by a coin toss.
 *  3. A document that writes `4 March` and no year anywhere is dated by the year the
 *     READER supplies — and the flag `inferredYear` travels with the date so the
 *     page can say the year was worked out rather than written.
 */

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_PATTERN = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

export interface DateHit {
  /** The words exactly as they were written. */
  raw: string;
  /** `YYYY-MM-DD` only when day, month and year are all known. */
  date: string | null;
  year: number | null;
  month: number | null;
  day: number | null;
  /** The year came from the reader or from a neighbouring entry, not from here. */
  inferredYear: boolean;
  /** The number order could be read two ways, so no date is claimed. */
  ambiguous: boolean;
  /** A month and year were written, and no day. */
  monthOnly: boolean;
  index: number;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function build(
  raw: string,
  index: number,
  day: number | null,
  month: number | null,
  year: number | null,
  inferredYear: boolean,
  ambiguous: boolean
): DateHit | null {
  // An ambiguous hit carries no month on purpose — its whole meaning is that the two
  // numbers could each be the day, so it is still reported. Requiring a month here
  // silently dropped every one of them, which meant `06/03/2026` was not recorded as
  // ambiguous at all; it simply vanished, and the reader was told nothing about it.
  if (month === null && !ambiguous) return null;
  if (year !== null && (year < 1000 || year > 2100)) return null;
  if (day !== null && (day < 1 || day > 31)) return null;
  if (day !== null && month !== null && day > daysInMonth(year ?? 2000, month)) return null;
  const monthOnly = day === null && month !== null && year !== null;
  const complete = day !== null && month !== null && year !== null && !ambiguous;
  return {
    raw: raw.trim(),
    date: complete ? `${year}-${pad(month as number)}-${pad(day as number)}` : null,
    year,
    month,
    day,
    inferredYear: complete ? inferredYear : false,
    ambiguous,
    monthOnly,
    index,
  };
}

/**
 * Every date-shaped thing in the text, in the order it appears.
 *
 * `yearHint` is what the year falls back to when a line writes a day and a month
 * and nothing else — and when it is used, `inferredYear` is set.
 */
export function findDates(text: string, yearHint: number | null = null): DateHit[] {
  const hits: DateHit[] = [];
  /** Offsets already claimed, so two patterns cannot report the same words twice. */
  const taken: [number, number][] = [];
  const overlaps = (start: number, end: number): boolean =>
    taken.some(([a, b]) => start < b && end > a);

  const consider = (match: RegExpExecArray, hit: DateHit | null): void => {
    if (!hit) return;
    const start = match.index;
    const end = start + match[0].length;
    if (overlaps(start, end)) return;
    taken.push([start, end]);
    hits.push(hit);
  };

  const year = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) return null;
    if (raw.length === 2) return value >= 70 ? 1900 + value : 2000 + value;
    return value;
  };

  // 2026-03-06 — unambiguous by construction.
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    consider(m, build(m[0], m.index ?? 0, Number(m[3]), Number(m[2]), Number(m[1]), false, false));
  }

  // 6 March 2026 · 6th March · 06 Mar. 2026
  const dayFirst = new RegExp(
    String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_PATTERN})\.?,?\s*(\d{4})?(?!\d)`,
    'gi'
  );
  for (const m of text.matchAll(dayFirst)) {
    const month = MONTHS[(m[2] ?? '').toLowerCase()] ?? null;
    const written = year(m[3]);
    consider(m, build(m[0], m.index ?? 0, Number(m[1]), month, written ?? yearHint, written === null && yearHint !== null, false));
  }

  // March 6, 2026 · March 6th · Mar 6
  const monthFirst = new RegExp(
    String.raw`\b(${MONTH_PATTERN})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d)(?:,?\s*(\d{4}))?`,
    'gi'
  );
  for (const m of text.matchAll(monthFirst)) {
    const month = MONTHS[(m[1] ?? '').toLowerCase()] ?? null;
    const written = year(m[3]);
    consider(m, build(m[0], m.index ?? 0, Number(m[2]), month, written ?? yearHint, written === null && yearHint !== null, false));
  }

  // March 2026 — a month, never a day.
  const monthYear = new RegExp(String.raw`\b(${MONTH_PATTERN})\.?,?\s+(\d{4})\b`, 'gi');
  for (const m of text.matchAll(monthYear)) {
    const month = MONTHS[(m[1] ?? '').toLowerCase()] ?? null;
    consider(m, build(m[0], m.index ?? 0, null, month, year(m[2]), false, false));
  }

  // 6/3/2026 and 6.3.2026 — real, and genuinely ambiguous. Never resolved.
  for (const m of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/g)) {
    const first = Number(m[1]);
    const second = Number(m[2]);
    const written = year(m[3]);
    const ambiguous = first !== second && first <= 12 && second <= 12;
    if (ambiguous) {
      consider(m, build(m[0], m.index ?? 0, null, null, written, false, true));
    } else {
      const day = first > 12 ? first : second;
      const month = first > 12 ? second : first;
      consider(m, build(m[0], m.index ?? 0, day, month, written, false, false));
    }
  }

  return hits.sort((a, b) => a.index - b.index);
}

/**
 * The year a document is mostly written in.
 *
 * Four-digit numbers between 1900 and 2100 are counted and the most common wins,
 * with a tie going to the earliest. This is what dates an entry that writes only a
 * day and a month — and because it is a guess, every date it produces is marked
 * `inferredYear`.
 */
export function dominantYear(text: string): number | null {
  const counts = new Map<number, number>();
  for (const m of text.matchAll(/\b(19\d{2}|20\d{2})\b/g)) {
    const value = Number(m[1]);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: number | null = null;
  let bestCount = -1;
  for (const [value, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** The first date an entry claims, which is what labels it. */
export function entryDate(text: string, yearHint: number | null): DateHit | null {
  const hits = findDates(text, yearHint);
  const dated = hits.find((hit) => hit.date !== null);
  if (dated) return dated;
  const partial = hits.find((hit) => hit.monthOnly || hit.ambiguous);
  return partial ?? null;
}

/** `6 March 2026`, for the page, from a date and whatever was written. */
export function displayDate(date: string | null, dateRaw: string | null): string | null {
  if (date) {
    const [y, m, d] = date.split('-').map((piece) => Number(piece));
    if (y && m && d) return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
  }
  return dateRaw;
}

/** `2026-03`, the bucket the timeline chart counts into. */
export function monthKey(date: string): string {
  return date.slice(0, 7);
}

/**
 * `YYYY-MM` when a month and a year are known, even though no day was written.
 *
 * This is NOT a claim about a date and must never be shown as one. It exists so a
 * **timeline** can be drawn for a document that only ever writes months — a resume
 * says `July 2021 to September 2026`, and refusing to place those on the timeline
 * would leave the chart of a career empty. The distinction is kept all the way to the
 * page: an entry dated this way is counted at month precision, and the answer's own
 * rule ("a day, a month and a year, all written") is unchanged.
 */
export function entryMonth(text: string, yearHint: number | null): string | null {
  const hits = findDates(text, yearHint);
  const full = hits.find((hit) => hit.date !== null);
  if (full?.date) return full.date.slice(0, 7);
  const partial = hits.find((hit) => hit.month !== null && hit.year !== null);
  if (partial?.month && partial.year) return `${partial.year}-${pad(partial.month)}`;
  return null;
}

/** `March 2026`, for an axis label. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map((piece) => Number(piece));
  if (!y || !m) return month;
  return `${MONTH_NAMES[m - 1]?.slice(0, 3) ?? m} ${String(y).slice(2)}`;
}
