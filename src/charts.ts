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
 *
 * 🔴 AND THE ROWS ARE SORTED BY HOW MUCH THE DOCUMENT MENTIONS THEM, HIGHEST FIRST. George,
 * 22 September 2026: *"Who and what appears when could sort my the value highest on top"*. They
 * used to keep the tally's own grouping — every person, then every place, then every amount — so
 * the chart's order was an artefact of which kind each thing happened to be, and a reader looking
 * for the thing that dominates the document had to find it. The tally already ranks each kind by
 * count; this ranks the eight rows against each other.
 *
 * ⚠ **IT CHANGES A STORED FIELD, SO `PIPELINE_VERSION` WENT UP WITH IT (6 → 7).** The grid is
 * built at index time and kept on the record, so without the bump a returning reader would be
 * served the old order from the index cache and the fix would look like it had not shipped.
 */
export function gridRows(mentions: {
  people: readonly { value: string; count: number }[];
  places: readonly { value: string; count: number }[];
  amounts: readonly { value: string; count: number }[];
}): { value: string; kind: 'person' | 'place' | 'amount' }[] {
  return [
    ...mentions.people.slice(0, GRID_ROWS.people).map((m) => ({ value: m.value, count: m.count, kind: 'person' as const })),
    ...mentions.places.slice(0, GRID_ROWS.places).map((m) => ({ value: m.value, count: m.count, kind: 'place' as const })),
    ...mentions.amounts.slice(0, GRID_ROWS.amounts).map((m) => ({ value: m.value, count: m.count, kind: 'amount' as const })),
  ]
    .sort((a, b) => b.count - a.count)
    .map(({ value, kind }) => ({ value, kind }));
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
    people: readonly { value: string; count: number }[];
    places: readonly { value: string; count: number }[];
    amounts: readonly { value: string; count: number }[];
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

/* -------------------------------------------------------------- the timeline */

/**
 * One thing the document places in time: a bar, or a tick.
 *
 * 🔴 **THE WIDTH OF THE BAR IS THE PERIOD THE ENTRY STATES.** George, 20 September 2026, on his own
 * resume: *"can you make the width of the bar equal to the start and end for this timeline?? … or,
 * i mean this is for a resume, i suppose i should assume it will not always be a resume."*
 *
 * He was right on both counts. The chart counted entries into month buckets, so a career read as
 * three lonely months — `July 2021`, `March 2018`, `January 2017` — and the width of a bar meant
 * nothing at all. A resume states PERIODS; a diary states DAYS; the same chart has to draw both
 * without being told which it is looking at, and this is that: `from` and `to` come from what the
 * entry says, and a single date is simply a period with no length.
 */
export interface Span {
  label: string;
  /** `YYYY-MM` — what the entry states as its start. */
  from: string;
  /** `YYYY-MM` — what it states as its end, or the same month when it states one date. */
  to: string;
  /** True when the period was written as still running (`to Present`), so `to` is a convention. */
  openEnded: boolean;
  /** True when the entry states one date and no period — a point, drawn as a tick. */
  point: boolean;
  /** The row it is drawn on, so two bars that overlap in time can never sit on top of each other. */
  lane: number;
}

export interface Spans {
  /** In the document's own order, so a reader can follow it. */
  spans: Span[];
  /** The axis, `YYYY-MM`: the earliest start to the latest end. */
  from: string;
  to: string;
  /** How many rows the drawing needs. */
  lanes: number;
  /** True when nothing in the document states a period — a diary, where every entry is a day. */
  pointsOnly: boolean;
  /** True when something states a period. */
  hasPeriods: boolean;
}

/** A month as a number, so a bar's width can be its real length rather than a slot count. */
function monthNumber(month: string): number | null {
  const [year, part] = month.split('-').map((piece) => Number(piece));
  if (!year || !part) return null;
  return year * 12 + (part - 1);
}

/**
 * The timeline: what the document places in time, and for how long.
 *
 * Pure, and testable without a browser, because the interesting part is not the drawing — it is the
 * promise that a bar's length IS the period the entry states, and that two overlapping periods are
 * never drawn through each other.
 *
 * **The `to` of an open-ended period is the axis end**, not today: the chart is about the document,
 * and a bar that ran past everything else in it would be claiming something the document never
 * said. The page says so in words.
 */
export function buildSpans(
  entries: {
    label: string;
    month: string | null;
    endMonth?: string | null;
    openEnded?: boolean;
  }[]
): Spans {
  const dated = entries.filter((entry) => entry.month !== null && monthNumber(entry.month) !== null);
  const empty: Spans = { spans: [], from: '', to: '', lanes: 0, pointsOnly: true, hasPeriods: false };
  if (dated.length === 0) return empty;

  // The axis is the longest range anything states: every start, and every stated end.
  let lowest = Infinity;
  let highest = -Infinity;
  for (const entry of dated) {
    const start = monthNumber(entry.month as string) as number;
    lowest = Math.min(lowest, start);
    highest = Math.max(highest, start);
    const end = entry.endMonth ? monthNumber(entry.endMonth) : null;
    if (end !== null) highest = Math.max(highest, end);
  }
  // An open-ended period runs to the end of the document's own timeline — which is the `highest`
  // already, because everything else in the document ended there.
  const spans: Span[] = dated.map((entry) => {
    const from = entry.month as string;
    const stated = entry.endMonth ?? null;
    const to = stated && (monthNumber(stated) as number) >= (monthNumber(from) as number) ? stated : from;
    return {
      label: entry.label,
      from,
      to,
      // `?? null` matters: an entry that simply has no `endMonth` key must not read as a stated end
      // of `undefined`. Caught by the open-ended test, which failed on exactly that.
      openEnded: stated === null && entry.openEnded === true,
      point: to === from,
      lane: 0,
    };
  });

  // 🔴 A PERIOD WRITTEN AS STILL RUNNING RUNS TO THE END OF THE AXIS — the last thing THIS DOCUMENT
  // dates, never today. It cannot be done earlier, because the axis is not known until every start
  // and every stated end has been looked at.
  const axisEnd = spans.reduce((latest, span) => (span.to > latest ? span.to : latest), spans[0]?.to ?? '');
  for (const span of spans) {
    if (span.openEnded && axisEnd > span.to) {
      span.to = axisEnd;
      span.point = false;
    }
  }

  // 🔴 ONE ROW PER OVERLAPPING PERIOD. Greedy, in the document's order: a bar goes on the first row
  // whose last bar has already finished. Two bars drawn through each other would say the document
  // did two things at once, which is a claim this app must never make by accident.
  const periods = spans.filter((span) => !span.point);
  const rows: number[] = [];
  for (const span of periods) {
    const start = monthNumber(span.from) as number;
    const end = monthNumber(span.to) as number;
    let lane = rows.findIndex((lastEnd) => lastEnd < start);
    if (lane === -1) {
      rows.push(end);
      lane = rows.length - 1;
    } else {
      rows[lane] = end;
    }
    span.lane = lane;
  }

  // Points share one row of their own, under the bars: a day has no length, so two of them cannot
  // overlap, and giving each its own row would turn nine diary entries into nine empty rows.
  const pointLane = periods.length;
  for (const span of spans) if (span.point) span.lane = pointLane;

  const months = spans.filter((span) => !span.point);
  return {
    spans,
    from: spans.reduce((earliest, span) => (span.from < earliest ? span.from : earliest), spans[0]?.from ?? ''),
    to: spans.reduce((latest, span) => (span.to > latest ? span.to : latest), spans[0]?.to ?? ''),
    // 🔴 THE NUMBER OF ROWS USED, NOT THE NUMBER OF PERIODS. It read `periods.length`, so two
    // periods that do NOT overlap — a tidy career, which fits on one row — reported two rows and
    // the drawing left an empty band under the chart. The other test caught it.
    lanes: spans.reduce((most, span) => Math.max(most, span.lane + 1), 1),
    pointsOnly: periods.length === 0,
    hasPeriods: periods.length > 0,
  };
}

/** How many months the axis covers, inclusive — the denominator of every bar's width. */
export function axisMonths(spans: Spans): number {
  const from = monthNumber(spans.from);
  const to = monthNumber(spans.to);
  if (from === null || to === null) return 0;
  return Math.max(1, to - from + 1);
}

/**
 * THE DOCUMENT, NOTE BY NOTE — one cell per note, its width its share of the text.
 *
 * 🔴 WHY THIS CHART EXISTS, AND WHY IT WAS THE ONE MISSING. Every other chart here answers a question
 * about the document's CONTENT: when its entries happened, who and what they mention, what the answer
 * rested on. None of them shows the thing the whole program is built out of — the notes — and on
 * 22 Sep 2026 that gap covered two faults in one afternoon. A statement of accounts came out as **one
 * note of about 1,300 characters**, so the search had no granularity and the document was refused its
 * own date range; and on a resume a question the page itself offers was answered from eight of twenty
 * notes and read as complete. Both are one glance at this chart: a single cell the width of the panel,
 * or a row of twenty cells. The reader can now see the shape of the reading they paid for.
 *
 * The numbers are counted here, in code, over the notes as stored — never by the model — and the
 * caption is built here too, so the sentence under the chart and the chart cannot disagree about the
 * same document.
 */
export interface NoteMapCell {
  label: string;
  words: number;
  chars: number;
  /** The share of the document's characters this note holds, 0–1. */
  share: number;
}

export interface NoteMap {
  cells: NoteMapCell[];
  /** How many notes the document was cut into. */
  total: number;
  /** The longest note's share of the document, 0–1. */
  longest: number;
  /** The whole document in words, counted by the program. */
  words: number;
  /**
   * True when one note holds more than half of a document that has more than one — a document that was
   * not really cut up. Measured: a statement of accounts was exactly this, and everything downstream of
   * it was worse for it.
   */
  dominated: boolean;
  /** The sentence under the chart, built from these counts. */
  caption: string;
}

export function buildNoteMap(chunks: { label: string; text: string; words: number }[]): NoteMap {
  const chars = chunks.map((chunk) => chunk.text.length);
  const totalChars = chars.reduce((sum, value) => sum + value, 0);
  const words = chunks.reduce((sum, chunk) => sum + chunk.words, 0);
  const cells: NoteMapCell[] = chunks.map((chunk, at) => ({
    label: chunk.label,
    words: chunk.words,
    chars: chars[at] as number,
    share: totalChars === 0 ? 0 : (chars[at] as number) / totalChars,
  }));
  const longest = cells.reduce((most, cell) => Math.max(most, cell.share), 0);
  const percent = Math.round(longest * 100);

  const caption =
    cells.length === 0
      ? 'No notes were made from this document.'
      : cells.length === 1
        ? `One note, holding all ${words.toLocaleString()} words — searched as one thing, so nothing inside it can be found on its own.`
        : `${cells.length} notes, in the document's own order, each one's width its length. ` +
          (percent > 50
            ? `The longest holds ${percent}% of the document, so most of it is searched as one thing.`
            : `The longest holds ${percent}% of it.`);

  return {
    cells,
    total: cells.length,
    longest,
    words,
    dominated: cells.length > 1 && longest > 0.5,
    caption,
  };
}
