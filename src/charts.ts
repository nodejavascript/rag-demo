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

/** The column that holds everything with no month written. */
export const UNDATED = 'undated';

export interface MentionMonths {
  /**
   * The x-axis: the months the document covers, and `undated` last when some of what is
   * mentioned sits in an entry that writes no month at all.
   */
  months: string[];
  series: { name: string; kind: 'person' | 'place' | 'amount'; counts: number[] }[];
}

/**
 * Who and what appears WHEN — the mentions of the whole document laid out over its months.
 *
 * 🔴 **COUNTED HERE, AT INDEX TIME, BY THE SAME CODE THAT PRODUCED THE TALLY.** A second
 * implementation of "how often is Grimsby mentioned" is a second chance for the two numbers
 * on the same page to disagree, and a reader has no way to tell which of them is wrong. So
 * this is built from the notes the indexer already extracted and stored with the document,
 * and the page only shades the cells.
 *
 * A cell counts **the notes in that month that mention it** — one per note, not one per
 * word — which is the same unit as the composition chart, so the two never contradict each
 * other. 🔴 A mention attached to an entry with no month goes in the `undated` column rather
 * than being dropped or given a month it was never written in.
 */
export function buildMentionMonths(
  chunks: { entryIndex: number; people: string[]; places: string[]; amounts: string[] }[],
  months: string[],
  entries: { month: string | null }[],
  top: { value: string; kind: 'person' | 'place' | 'amount' }[]
): MentionMonths {
  if (top.length === 0 || chunks.length === 0) return { months: [], series: [] };

  const column = new Map<string, number>(months.map((month, at) => [month, at]));
  const undatedAt = months.length;
  const counts = top.map(() => new Array<number>(months.length + 1).fill(0));

  for (const chunk of chunks) {
    const month = entries[chunk.entryIndex]?.month ?? null;
    const at = month !== null && column.has(month) ? (column.get(month) as number) : undatedAt;
    top.forEach((mention, row) => {
      const named =
        mention.kind === 'person'
          ? chunk.people
          : mention.kind === 'place'
            ? chunk.places
            : chunk.amounts;
      if (named.some((value) => value.toLowerCase() === mention.value.toLowerCase())) {
        const target = counts[row];
        if (target) target[at] = (target[at] ?? 0) + 1;
      }
    });
  }

  // The undated column is only in the axis when something actually landed in it.
  const usedUndated = counts.some((row) => (row[undatedAt] ?? 0) > 0);
  return {
    months: usedUndated ? [...months, UNDATED] : [...months],
    series: top.map((mention, row) => ({
      name: mention.value,
      kind: mention.kind,
      counts: (counts[row] ?? []).slice(0, usedUndated ? months.length + 1 : months.length),
    })),
  };
}

/** How many rows the grid keeps: the things that recur, and as many as a chart can show. */
export const GRID_ROWS = { people: 3, places: 3, amounts: 2 } as const;

/**
 * The grid's rows, taken from the tally that is printed beside it.
 *
 * The chart and the tally must never disagree — a reader sees both at once — so the rows are
 * derived from the same list the tally was counted from, never re-extracted from the text.
 */
export function gridRows(mentions: {
  people: readonly { value: string }[];
  places: readonly { value: string }[];
  amounts: readonly { value: string }[];
}): { value: string; kind: 'person' | 'place' | 'amount' }[] {
  return [
    ...mentions.people.slice(0, GRID_ROWS.people).map((m) => ({ value: m.value, kind: 'person' as const })),
    ...mentions.places.slice(0, GRID_ROWS.places).map((m) => ({ value: m.value, kind: 'place' as const })),
    ...mentions.amounts.slice(0, GRID_ROWS.amounts).map((m) => ({ value: m.value, kind: 'amount' as const })),
  ];
}

/**
 * The whole mention grid for a document, from the notes, the months and the tally it has.
 *
 * 🔴 ONE IMPLEMENTATION, CALLED FROM TWO PLACES ON PURPOSE. The indexer calls it when a document
 * is first read; the store calls it to fill in a document that was indexed before this chart
 * existed. That second call is not tidiness — it is the fix for a fault measured on the live
 * demo on 20 September 2026: the built-in diary came back `reused: true` from an index written by
 * the older build, `mentions.byMonth` was simply absent from the record, and the heat map
 * therefore hid itself. The feature existed, the code was right, and no visitor could ever have
 * seen it. Had the store grown its own second copy of this logic, the two could have disagreed
 * about the same document — so it does not: it calls this.
 */
export function mentionGrid(
  chunks: Parameters<typeof buildMentionMonths>[0],
  stats: { perMonth: MonthPoint[]; firstDate: string | null; lastDate: string | null },
  entries: Parameters<typeof buildMentionMonths>[2],
  mentions: {
    people: readonly { value: string }[];
    places: readonly { value: string }[];
    amounts: readonly { value: string }[];
  }
): MentionMonths | undefined {
  const grid = buildMentionMonths(
    chunks,
    continuousMonths(stats.perMonth, stats.firstDate, stats.lastDate).map((point) => point.month),
    entries,
    gridRows(mentions)
  );
  // 🔴 NOTHING TO GRID IS `undefined`, NOT AN EMPTY GRID. The indexer stores this value and the
  // store fills it in for older records; if one wrote `{months: [], series: []}` and the other
  // wrote nothing, the same document would have two different shapes depending only on which
  // build read it — and a test on the fresh path would pass while the backfilled path disagreed.
  // Caught by exactly that test, on the first run.
  return grid.series.length === 0 ? undefined : grid;
}

/** One stage of the search, and how many notes were still in play. */
export interface FunnelStage {
  label: string;
  notes: number;
  /** What happened at this stage, in the reader's words. */
  note: string;
}

/**
 * How the document became the handful of notes the model was shown.
 *
 * ⚠️ **THIS IS A FUNNEL OF WHAT WAS MEASURED, NOT A MODEL OF THE SEARCH.** Each number comes
 * from a stage that counted itself while it ran; nothing is inferred. When a stage did not
 * run — there is no reranker configured; the refusal was decided before any note was chosen
 * — the stage is not drawn at all rather than drawn with a zero in it, because a zero and a
 * stage that never happened look the same on a chart and mean opposite things.
 */
export function buildFunnel(stages: {
  notes: number;
  ranked?: number;
  reranked?: number;
  shown: number;
  silent?: boolean;
}): FunnelStage[] {
  const out: FunnelStage[] = [
    { label: 'in the document', notes: stages.notes, note: 'every note the indexer made' },
  ];
  if (stages.silent) {
    out.push({
      label: 'matched the question',
      notes: 0,
      note: 'nothing came close enough, so no model was called',
    });
    return out;
  }
  if (stages.ranked !== undefined) {
    out.push({
      label: 'ranked by both searches',
      notes: stages.ranked,
      note: 'the keyword search and the meaning search, fused by rank',
    });
  }
  if (stages.reranked !== undefined) {
    out.push({
      label: 'weighed by the reranker',
      notes: stages.reranked,
      note: 'read again, slowly, by a cross-encoder',
    });
  }
  out.push({ label: 'shown to the model', notes: stages.shown, note: 'what the answer was written from' });
  return out;
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
