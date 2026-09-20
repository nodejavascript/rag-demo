/**
 * The two shapes the page draws that the document does not already hand over.
 *
 * 🔴 **BOTH ARE COMPUTED HERE, ON THE SERVER, AND THE PAGE ONLY DRAWS THEM.** That is the
 * rule this app is built on — every number a reader sees was counted by the program, never
 * by the model and never by the page. It is also why these two live in a module with tests
 * rather than inside the browser script: a count written twice is a count that can disagree
 * with itself, and the reader would have no way to tell which of the two was wrong.
 */

export interface MonthPoint {
  /** `YYYY-MM`. */
  month: string;
  entries: number;
}

export interface SpineItem {
  label: string;
  date: string | null;
  /** True when the answer was written from this entry. */
  cited: boolean;
  /** How many entries this cell stands for — always 1 in `entry` mode. */
  entries: number;
}

export interface Spine {
  /** `entry` when there is one cell per entry, `month` when the document is too long. */
  mode: 'entry' | 'month';
  items: SpineItem[];
  /** How many entries the document has, so the page can say what is not shown. */
  total: number;
}

/** `YYYY-MM` from anything the document writes a date as, or null. */
function monthOf(value: string | null | undefined): string | null {
  const hit = /^(\d{4})-(\d{2})/.exec(value ?? '');
  return hit ? `${hit[1]}-${hit[2]}` : null;
}

/**
 * Every month from the first to the last, **including the ones with nothing in them.**
 *
 * 🔴 THIS IS A REPAIR, NOT A FEATURE. `stats.perMonth` holds only the months that HAVE
 * entries, and the chart drew them side by side — so a diary with three entries in March
 * and one in November drew as **two adjacent bars**, and a reader saw a document written
 * continuously when the truth was nine months of silence between the two. **A missing month
 * is information**, and a chart is not allowed to hide it by closing the gap.
 *
 * The span comes from the document's own first and last date, so the axis is the document's
 * own claim about itself. A run with no dates at all returns an empty series rather than a
 * single invented point.
 */
export function continuousMonths(
  perMonth: MonthPoint[],
  first: string | null,
  last: string | null
): MonthPoint[] {
  if (perMonth.length === 0) return [];

  const counts = new Map(perMonth.map((point) => [point.month, point.entries]));
  const start = monthOf(first) ?? perMonth[0]!.month;
  const end = monthOf(last) ?? perMonth[perMonth.length - 1]!.month;

  const startHit = /^(\d{4})-(\d{2})$/.exec(start);
  const endHit = /^(\d{4})-(\d{2})$/.exec(end);
  if (!startHit || !endHit) return [...perMonth];

  let year = Number(startHit[1]);
  let month = Number(startHit[2]);
  const endYear = Number(endHit[1]);
  const endMonth = Number(endHit[2]);

  const out: MonthPoint[] = [];
  // A hundred years is a guard against a mis-read date turning this into a loop that never
  // ends in a browser tab. Nothing this app is for spans a century.
  for (let guard = 0; guard < 1200; guard += 1) {
    if (year > endYear || (year === endYear && month > endMonth)) break;
    const key = `${year}-${String(month).padStart(2, '0')}`;
    out.push({ month: key, entries: counts.get(key) ?? 0 });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return out.length > 0 ? out : [...perMonth];
}

/** How many months of the span hold nothing — the number the caption needs. */
export function emptyMonths(series: MonthPoint[]): number {
  return series.filter((point) => point.entries === 0).length;
}

export interface SpineEntry {
  index: number;
  label: string;
  date: string | null;
  month: string | null;
}

/**
 * The whole document as one row of cells, with the entries the answer rests on marked.
 *
 * **This answers the question nothing else on the page answers: did that answer come from
 * one corner of the document, or from all over it?** A reader who sees eight bright cells
 * spread across the row knows the answer was assembled from here and there, and one who
 * sees eight together knows it came from one passage. Both are worth knowing before
 * trusting the wording.
 *
 * 🔴 **A LONG DOCUMENT IS DRAWN BY MONTH, NOT BY ENTRY, AND SAYS SO.** One cell per entry
 * is the honest picture, but a 400,000-character document can hold thousands of entries and
 * a chart with four thousand cells in it is a smear. Past the limit the cells become
 * **consecutive runs of the document** — a month each where there is a month, and the
 * undated run where there is not — so no entry is dropped and the totals still add up.
 * `mode` says which of the two the reader is looking at.
 */
export function buildSpine(entries: SpineEntry[], citedIndexes: Iterable<number>, limit = 400): Spine {
  const cited = new Set(citedIndexes);

  if (entries.length <= limit) {
    return {
      mode: 'entry',
      total: entries.length,
      items: entries.map((entry) => ({
        label: entry.label,
        date: entry.date,
        cited: cited.has(entry.index),
        entries: 1,
      })),
    };
  }

  const items: SpineItem[] = [];
  for (const entry of entries) {
    const key = entry.month ?? 'undated';
    const last = items[items.length - 1];
    const sameRun = last !== undefined && (last.label === key || (last.label === 'undated' && key === 'undated'));
    if (sameRun) {
      last.entries += 1;
      last.cited = last.cited || cited.has(entry.index);
      continue;
    }
    items.push({ label: key, date: entry.date, cited: cited.has(entry.index), entries: 1 });
  }

  return { mode: 'month', total: entries.length, items };
}
