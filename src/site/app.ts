/**
 * The page.
 *
 * No framework and no chart library, for the same reason the server has no
 * dependencies: a canvas and a few hundred lines beat a bundle that has to be kept
 * up to date. Every chart here draws what the SERVER counted — the page never
 * computes a statistic of its own, because a second implementation of a count is a
 * second chance for the two to disagree, and the reader would have no way to tell
 * which was wrong.
 *
 * The layout is three steps down the page: paste it, index it, ask it. Each stage
 * reveals the next only when it has something to show, so the page never asks for a
 * question about a document that is not there yet.
 */

/* ------------------------------------------------------------------ types */

interface Mention {
  value: string;
  count: number;
  entries: number[];
}

interface ImageRef {
  url: string | null;
  caption: string | null;
  entryIndex: number;
}

interface IndexStats {
  characters: number;
  words: number;
  entries: number;
  datedEntries: number;
  monthPrecision: number;
  inferredYears: number;
  ambiguousDates: number;
  chunks: number;
  firstDate: string | null;
  lastDate: string | null;
  months: number;
  perMonth: { month: string; entries: number }[];
  assumedYear: boolean;
  yearUsed: number | null;
  embeddingMs: number;
}

interface DocumentView {
  id: string;
  title: string;
  characters: number;
  words: number;
  createdAt: string;
  expiresAt: string | null;
  stats: IndexStats;
  mentions: { places: Mention[]; people: Mention[]; amounts: Mention[]; byMonth?: MentionMonths };
  imageCount: number;
}

interface AnswerDetails {
  dates: { date: string | null; dateRaw: string | null; label: string; inferred: boolean }[];
  places: Mention[];
  people: Mention[];
  amounts: Mention[];
  images: ImageRef[];
  first: string | null;
  last: string | null;
}

interface Source {
  label: string;
  date: string | null;
  dateRaw: string | null;
  text: string;
  vector: number;
  lexical: number;
  fused: number;
  rerank: number | null;
  both: boolean;
}

interface Spine {
  mode: 'entry' | 'month';
  items: { label: string; date: string | null; cited: boolean; entries: number }[];
  total: number;
}

interface Answer {
  question: string;
  raw: string;
  prose: string;
  mode: 'grounded' | 'refused';
  sources: Source[];
  /** The document as a row of cells, with the entries the answer used marked. */
  spine?: Spine;
  /** How the document became the notes the model was shown, stage by stage. */
  funnel?: { label: string; notes: number; note: string }[];
  /** What the document does NOT say — counted in code, never generated. See `gaps.ts`. */
  gaps: {
    absent: string[];
    absentTotal: number;
    presentCount: number;
    once: { value: string; kind: string }[];
  };
  /** Where it disagrees with itself — also counted in code. See `conflicts.ts`. */
  conflicts: {
    outOfOrder: { at: number; label: string; date: string; previousDate: string; previousLabel: string }[];
    spelledTwoWays: { a: string; b: string; kind: string }[];
    ambiguous: { label: string; raw: string }[];
  };
  details: AnswerDetails;
  computed: { kind: string; term?: string; value: number | string; first?: string | null; last?: string | null; entries?: number }[];
  timings: { retrieveMs: number; rerankMs: number; modelMs: number; totalMs: number };
  warnings: string[];
}

/* ------------------------------------------------------------------ helpers */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  );
}

function plural(n: number, one: string, many?: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : (many ?? `${one}s`)}`;
}

function showError(where: HTMLElement, message: string): void {
  where.innerHTML = `<div class="err-box">${esc(message)}</div>`;
}

/**
 * Read a response as JSON — and say something useful when it is not JSON.
 *
 * 🔴 THIS EXISTS BECAUSE GEORGE SAW `Unexpected token '<', "<!DOCTYPE "... is not valid
 * JSON` AND NOTHING ELSE. He had pasted his resume and pressed Index; the server had a
 * clear, specific sentence ready about the credential being refused, and none of it
 * reached him. **A bare `response.json()` trusts the other end to be the API**, and the
 * moment anything in front of it answers instead — a proxy, an edge error page, a
 * maintenance notice — the reader gets a JavaScript parser complaint in place of the
 * explanation that was written for them.
 *
 * So the body is read as TEXT first and parsed deliberately. Anything that is not JSON is
 * reported as what it is: an answer from something that is not the API, named by its
 * status and its content type, with a plain sentence about what to do. The reader is never
 * shown a parse error again, and the front of the body is included because seeing
 * `<!DOCTYPE html>` in the message is what makes the cause obvious in a screenshot.
 */
async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const kind = (response.headers.get('content-type') ?? 'no content type').split(';')[0];
    const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
    throw new Error(
      `The server answered ${response.status} with ${kind} instead of the API's JSON` +
        (looksLikeHtml ? ' — that is a web page, so something in front of the app answered instead of the app' : '') +
        `. ${text.slice(0, 120).replace(/\s+/g, ' ').trim()}`
    );
  }
}

function clear(where: HTMLElement): void {
  where.innerHTML = '';
}

/**
 * A short notice that fades, for news that arrives as the thing it describes goes away.
 *
 * Deleting a document puts the page back to its home state, which removes the panel that
 * would otherwise report the delete — so the report has to float free of the layout. It is
 * announced as well as shown, because a fade is not a notification.
 */
let toastTimer: number | undefined;
function showToast(message: string): void {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('on');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('on'), 6000);
}

/** The chapter-and-verse references the model wrote, picked out of the prose. */
function markCitations(prose: string): string {
  return esc(prose).replace(/\[([^\]\n]{1,60})\]/g, '<span class="cite">$1</span>');
}

/* ------------------------------------------------------------------ charts */

interface Canvas {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

/** Size the backing store to the device pixel ratio, so lines are not furry. */
function fit(canvas: HTMLCanvasElement): Canvas | null {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 320;
  const h = Number(canvas.getAttribute('height') ?? 190);
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/*
 * Chart colours.
 *
 * These are written out rather than read from the stylesheet because a canvas cannot use
 * a CSS variable — so they are the one place the palette is duplicated, and the one place
 * a theme change can be left half-done. Kept in the teal family as of the teal theme:
 * the first two are the accent and the strong accent, and the rest are the supporting
 * hues that have to stay distinguishable from them.
 */
const COLOURS = ['#5eead4', '#14b8a6', '#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#f472b6', '#22d3ee'];

/**
 * Bars standing up: one column per month, the tallest scaled to the box.
 *
 * Labels are skipped rather than overlapped when there is not room — a chart whose
 * axis cannot be read is worse than one with fewer ticks on it.
 */
function drawColumns(canvas: HTMLCanvasElement, data: { label: string; value: number }[]): void {
  const surface = fit(canvas);
  if (!surface) return;
  const { ctx, w, h } = surface;
  const pad = { top: 16, right: 8, bottom: 26, left: 8 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  if (data.length === 0) {
    ctx.fillStyle = '#6f9aa1';
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('No dates were found, so there is nothing to plot.', pad.left, h / 2);
    return;
  }

  const max = Math.max(...data.map((d) => d.value), 1);
  const gap = data.length > 26 ? 2 : 6;
  const slot = plotW / data.length;
  const barW = Math.max(2, slot - gap);

  data.forEach((point, at) => {
    const x = pad.left + at * slot + gap / 2;

    // 🔴 A MONTH WITH NOTHING IN IT IS NOT A SHORT BAR. `perMonth` now arrives with the empty
    // months filled in, and drawing `Math.max(2, 0)` would give silence the same 2-pixel
    // stub as a real but tiny month — the two would be indistinguishable on the chart, which
    // is the opposite of the reason the gap was filled in. So a zero is drawn as a single
    // muted tick on the baseline: unmistakably "nothing here".
    if (point.value === 0) {
      ctx.fillStyle = '#2b4a52';
      ctx.fillRect(x, pad.top + plotH - 1, Math.max(1, barW), 1);
      return;
    }

    const barH = Math.max(2, (point.value / max) * plotH);
    const y = pad.top + plotH - barH;
    const colour = COLOURS[at % COLOURS.length] as string;
    const gradient = ctx.createLinearGradient(0, y, 0, y + barH);
    gradient.addColorStop(0, colour);
    gradient.addColorStop(1, `${colour}44`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, Math.min(3, barW / 2));
    ctx.fill();

    if (point.value === max && barW > 12) {
      ctx.fillStyle = '#e6f6f8';
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(point.value), x + barW / 2, y - 5);
      ctx.textAlign = 'left';
    }
  });

  // Axis labels, at most one in every 34 pixels of width.
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 34))));
  ctx.fillStyle = '#7ba1a8';
  ctx.font = '10.5px ui-sans-serif, system-ui, sans-serif';
  data.forEach((point, at) => {
    if (at % every !== 0 && at !== data.length - 1) return;
    const x = pad.left + at * slot + slot / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillText(point.label, x, h - 8);
    ctx.restore();
  });
}

/** Bars lying down: a label, a bar, and the count at the end of it. */
function drawRows(
  canvas: HTMLCanvasElement,
  data: { label: string; value: number }[],
  options: { colour?: string; decimals?: (value: number) => string } = {}
): void {
  const surface = fit(canvas);
  if (!surface) return;
  const { ctx, w, h } = surface;

  if (data.length === 0) {
    ctx.fillStyle = '#6f9aa1';
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('Nothing found to show here.', 4, h / 2);
    return;
  }

  const labelW = Math.min(112, Math.max(64, w * 0.31));
  const valueW = 44;
  const plotW = Math.max(20, w - labelW - valueW - 8);
  const rowH = Math.min(24, Math.max(13, (h - 6) / data.length));
  const max = Math.max(...data.map((d) => d.value), 1);

  data.forEach((row, at) => {
    const y = 3 + at * rowH;
    const barH = Math.max(6, rowH - 6);
    const barW = Math.max(2, (row.value / max) * plotW);
    const colour = options.colour ?? (COLOURS[at % COLOURS.length] as string);

    ctx.fillStyle = '#b2d3d8';
    ctx.font = '11.5px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const label = row.label.length > 17 ? `${row.label.slice(0, 16)}\u2026` : row.label;
    ctx.fillText(label, 0, y + rowH / 2);

    ctx.fillStyle = '#112d33';
    ctx.beginPath();
    ctx.roundRect(labelW, y + 3, plotW, barH, barH / 2);
    ctx.fill();

    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.roundRect(labelW, y + 3, barW, barH, barH / 2);
    ctx.fill();

    ctx.fillStyle = '#e6f6f8';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(options.decimals ? options.decimals(row.value) : String(row.value), labelW + plotW + 6, y + rowH / 2);
  });
  ctx.textBaseline = 'alphabetic';
}

/** How much of the model's window each note took, drawn under the sources. */
function drawScores(canvas: HTMLCanvasElement, sources: Source[]): void {
  const useRerank = sources.some((source) => source.rerank !== null);
  const data = sources.map((source) => ({
    label: source.label,
    value: useRerank
      ? Math.max(0, Math.min(1, source.rerank ?? 0))
      : Math.max(0, Math.min(1, source.vector)),
  }));
  drawRows(canvas, data, { decimals: (value) => value.toFixed(2) });
}

/**
 * The whole document as one row of cells, with the entries the answer used lit up.
 *
 * 🔴 **THIS IS THE ONE CHART THAT ANSWERS "WHERE DID THAT COME FROM?".** Everything else on
 * this page describes the document; this describes the ANSWER — whether it was assembled
 * from one passage or from eight places across a year. Drawn flat on purpose: one row, two
 * states, and a caption that says the number. An axis would invite a reading it does not
 * have.
 */
function drawSpine(canvas: HTMLCanvasElement, spine: Spine): void {
  const surface = fit(canvas);
  if (!surface) return;
  const { ctx, w, h } = surface;

  const items = spine.items;
  if (items.length === 0) {
    ctx.fillStyle = '#6f9aa1';
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('There are no entries to draw.', 2, h / 2);
    return;
  }

  const total = items.reduce((sum, item) => sum + item.entries, 0) || items.length;
  const pad = { left: 2, right: 2, top: 8, bottom: 20 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const gap = items.length > 140 ? 0 : 1.5;

  let x = pad.left;
  for (const item of items) {
    const span = (item.entries / total) * plotW;
    // A cited cell is full height and bright; an uncited one is a low, quiet block. The
    // height difference is what makes the pattern readable at a glance on a wide row.
    const barH = item.cited ? plotH : plotH * 0.42;
    ctx.fillStyle = item.cited ? '#5eead4' : '#1d3b42';
    ctx.beginPath();
    ctx.roundRect(x, pad.top + (plotH - barH), Math.max(1, span - gap), barH, 2);
    ctx.fill();
    x += span;
  }

  // Only the ends are labelled. Labelling every cell would be unreadable and the caption
  // already says what the cells are.
  ctx.fillStyle = '#7ba1a8';
  ctx.font = '10.5px ui-sans-serif, system-ui, sans-serif';
  const first = items[0];
  const last = items[items.length - 1];
  if (first) ctx.fillText((first.date ?? first.label).slice(0, 22), pad.left, h - 6);
  if (last) {
    ctx.save();
    ctx.textAlign = 'right';
    ctx.fillText((last.date ?? last.label).slice(0, 22), w - pad.right, h - 6);
    ctx.restore();
  }
}

/** The caption the spine needs, because a chart of two colours has to say what they mean. */
function renderSpine(spine: Spine | undefined): void {
  if (!spine || spine.items.length === 0) {
    el.spineBox.hidden = true;
    return;
  }
  el.spineBox.hidden = false;
  const used = spine.items.filter((item) => item.cited).reduce((sum, item) => sum + item.entries, 0);
  el.spineNote.textContent =
    spine.mode === 'entry'
      ? `The answer was written from ${used} of the ${plural(spine.total, 'entry', 'entries')} in this ` +
        'document. Each cell is one entry, in the order it was written; the bright ones are the entries it rests on.'
      : `This document is long, so each cell is a span of entries rather than one — ` +
        `${plural(spine.items.length, 'span')} covering ${spine.total.toLocaleString()} entries. ` +
        `The bright ones hold the ${used} entries the answer rests on.`;
  drawSpine(el.spine, spine);
}

/**
 * Who and what appears when — the document's mentions laid out over its own months.
 *
 * A heat map rather than a line chart, deliberately: these are counts of NOTES, they are
 * small integers, and eight rows of them cross each other constantly. Shading says "more
 * here" without pretending that the space between two cells means anything.
 */
function drawHeat(canvas: HTMLCanvasElement, grid: MentionMonths): void {
  const surface = fit(canvas);
  if (!surface) return;
  const { ctx, w, h } = surface;
  const rows = grid.series.length;
  const cols = grid.months.length;
  if (rows === 0 || cols === 0) return;

  const labelW = Math.min(118, Math.max(70, w * 0.3));
  const pad = { top: 6, bottom: 20 };
  const plotW = Math.max(20, w - labelW - 6);
  const rowH = Math.min(22, Math.max(11, (h - pad.top - pad.bottom) / rows));
  const cellW = plotW / cols;
  const max = Math.max(1, ...grid.series.flatMap((row) => row.counts));

  grid.series.forEach((row, at) => {
    const y = pad.top + at * rowH;
    ctx.fillStyle = '#b2d3d8';
    ctx.font = '11.5px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(row.name.length > 18 ? `${row.name.slice(0, 17)}\u2026` : row.name, 0, y + rowH / 2);

    row.counts.forEach((count, col) => {
      const x = labelW + col * cellW;
      const shade = count === 0 ? 0 : 0.16 + 0.84 * (count / max);
      ctx.fillStyle = count === 0 ? '#12262c' : `rgba(94, 234, 212, ${shade.toFixed(3)})`;
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 1.5, Math.max(2, cellW - 2), Math.max(4, rowH - 3), 3);
      ctx.fill();
      if (count > 0 && cellW > 24) {
        ctx.fillStyle = shade > 0.6 ? '#04221f' : '#9fd8d0';
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(count), x + cellW / 2, y + rowH / 2);
        ctx.textAlign = 'left';
      }
    });
  });
  ctx.textBaseline = 'alphabetic';

  const every = Math.max(1, Math.ceil(cols / Math.max(1, Math.floor(plotW / 34))));
  ctx.fillStyle = '#7ba1a8';
  ctx.font = '10.5px ui-sans-serif, system-ui, sans-serif';
  grid.months.forEach((month, at) => {
    if (at % every !== 0 && at !== cols - 1) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillText(month === 'undated' ? 'no month' : month.slice(2), labelW + at * cellW + cellW / 2, h - 5);
    ctx.restore();
  });
}

/** The caption the heat map needs: what a row is, what a column is, what the shading is. */
function renderHeat(grid: MentionMonths | undefined): void {
  if (!grid || grid.series.length === 0 || grid.months.length === 0) {
    el.heatBox.hidden = true;
    return;
  }
  el.heatBox.hidden = false;
  el.heatNote.textContent =
    'Each row is one of the things this document mentions most and each column is a month, ' +
    'so a brighter cell means more notes in that month mention it. Only the notes are counted, ' +
    'never the words, and never by the model.';
  drawHeat(el.heat, grid);
}

/**
 * How the document became the notes the model was shown.
 *
 * The bars narrow because the search does, and the number beside each is the count the stage
 * itself reported. A stage that never ran is not in the list at all — a reranker that was
 * never configured must not appear as a stage that found nothing.
 */
function drawFunnel(canvas: HTMLCanvasElement, stages: { label: string; notes: number }[]): void {
  const surface = fit(canvas);
  if (!surface) return;
  const { ctx, w, h } = surface;

  const labelW = Math.min(158, Math.max(96, w * 0.34));
  const valueW = 46;
  const plotW = Math.max(20, w - labelW - valueW - 8);
  const rowH = Math.min(27, Math.max(15, (h - 8) / stages.length));
  const max = Math.max(...stages.map((stage) => stage.notes), 1);

  stages.forEach((stage, at) => {
    const y = 4 + at * rowH;
    const barH = Math.max(7, rowH - 9);
    const barW = stage.notes === 0 ? 2 : Math.max(3, (stage.notes / max) * plotW);

    ctx.fillStyle = '#b2d3d8';
    ctx.font = '11.5px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(stage.label.length > 24 ? `${stage.label.slice(0, 23)}\u2026` : stage.label, 0, y + rowH / 2);

    ctx.fillStyle = '#112d33';
    ctx.beginPath();
    ctx.roundRect(labelW, y + 4, plotW, barH, barH / 2);
    ctx.fill();

    // The colour fades down the funnel, so the narrowing is legible even in the last bar.
    const alpha = 1 - (at / Math.max(1, stages.length - 1)) * 0.55;
    ctx.fillStyle = `rgba(94, 234, 212, ${alpha.toFixed(2)})`;
    ctx.beginPath();
    ctx.roundRect(labelW, y + 4, barW, barH, barH / 2);
    ctx.fill();

    ctx.fillStyle = '#e6f6f8';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(String(stage.notes), labelW + plotW + 6, y + rowH / 2);
  });
  ctx.textBaseline = 'alphabetic';
}

/** The funnel, or nothing at all when there is only one stage to draw. */
function renderFunnel(stages: Answer['funnel']): void {
  if (!stages || stages.length < 2) {
    el.funnelBox.hidden = true;
    return;
  }
  el.funnelBox.hidden = false;
  drawFunnel(el.funnel, stages);
}

/* ------------------------------------------------------------------ state */

let current: DocumentView | null = null;

/** Who and what the document mentions, laid out over its own months. */
interface MentionMonths {
  months: string[];
  series: { name: string; kind: 'person' | 'place' | 'amount'; counts: number[] }[];
}/**
 * The questions offered under the box.
 *
 * 🔴 **THEY FOLLOW THE DOCUMENT, AND THEY DID NOT BEFORE.** The five that stood here were
 * written for a diary, and offering *"Which month was busiest?"* to somebody who has just
 * pasted a resume tells them the tool has not read what they gave it — George, 20 Sep 2026:
 * *"in ask it something, if it detects a resume, can you create better questions, like what
 * are the skills?"* The server works out what the document is and sends the questions with
 * the index; the list below is only what is shown before anything has been indexed.
 *
 * The kind is a guess, and it is shown as one: the label above the buttons names what the
 * document was taken for, so a wrong guess is visible rather than silent. Every question,
 * whichever set it came from, is answered by the same pipeline and refused the same way.
 */
const BEFORE_INDEXING = [
  'What is this document about?',
  'What happened first, and what happened last?',
  'Which month was busiest?',
  'Where do the events take place?',
  'Who is mentioned most?',
];

let suggestions: string[] = [...BEFORE_INDEXING];

const el = {
  paste: $<HTMLTextAreaElement>('paste'),
  pasteStat: $('paste-stat'),
  step2: $('step-2'),
  step3: $('step-3'),
  step4: $('step-4'),
  indexButton: $<HTMLButtonElement>('index'),
  indexStat: $('index-stat'),
  indexHint: $('index-hint'),
  indexError: $('index-error'),
  shape: $('shape'),
  shapeTitle: $('shape-title'),
  shapeCards: $('shape-cards'),
  shapeWarnings: $('shape-warnings'),
  timeline: $<HTMLCanvasElement>('timeline'),
  timelineNote: $('timeline-note'),
  composition: $<HTMLCanvasElement>('composition'),
  question: $<HTMLInputElement>('question'),
  askButton: $<HTMLButtonElement>('ask'),
  askError: $('ask-error'),
  suggestions: $('suggestions'),
  suggestHint: $('suggestions-hint'),
  spineBox: $('spine-box'),
  spine: $<HTMLCanvasElement>('spine'),
  spineNote: $('spine-note'),
  heat: $<HTMLCanvasElement>('heat'),
  heatNote: $('heat-note'),
  heatBox: $('heat-box'),
  funnelBox: $('funnel-box'),
  funnel: $<HTMLCanvasElement>('funnel'),
  funnelNote: $('funnel-note'),
  answerWrap: $('answer-wrap'),
  answer: $('answer'),
  answerQ: $('answer-q'),
  answerProse: $('answer-prose'),
  answerTimings: $('answer-timings'),
  answerWarnings: $('answer-warnings'),
  answerDetails: $('answer-details'),
  sourcesWrap: $('sources-wrap'),
  sourcesSummary: $('sources-summary'),
  sources: $('sources'),
  deleteButton: $<HTMLButtonElement>('delete'),
  deleteStat: $('delete-stat'),
  ttlLine: $('ttl-line'),
  gaps: $('gaps'),
  gapsBody: $('gaps-body'),
  conflicts: $('conflicts'),
  conflictsBody: $('conflicts-body'),
};

/* ------------------------------------------------------------------ step 1 */

/** The shortest document the server will index. Kept in step with `MIN_CHARS`. */
const MIN_CHARS = 200;

function updatePasteStat(): void {
  const text = el.paste.value;
  const length = text.trim().length;

  // 🔴 THE BUTTON IS GATED HERE, AND IT USED TO BE GATED BY A SECTION APPEARING. The button
  // lived in step 2, and step 2 was itself revealed only once 200 characters had been
  // pasted — so the length rule was enforced by a button the reader could not see, which is
  // not an explanation. It now sits beside the box it acts on and is simply **disabled until
  // there is enough to index**, with the line underneath saying so in words.
  el.indexButton.disabled = length < MIN_CHARS;

  if (length === 0) {
    el.pasteStat.textContent = 'Nothing pasted yet.';
    return;
  }
  const words = (text.match(/[\p{L}\p{N}'\u2019-]+/gu) ?? []).length;
  const lines = text.split('\n').length;
  el.pasteStat.innerHTML =
    `<b>${text.length.toLocaleString()}</b> characters · <b>${words.toLocaleString()}</b> words · ` +
    `<b>${lines.toLocaleString()}</b> lines` +
    (length < MIN_CHARS ? ' · <b>too short to index yet</b>' : ' · ready to index');
}

el.paste.addEventListener('input', updatePasteStat);

el.paste.addEventListener('dragover', (event) => {
  event.preventDefault();
  el.paste.classList.add('drop');
});
el.paste.addEventListener('dragleave', () => el.paste.classList.remove('drop'));
el.paste.addEventListener('drop', (event) => {
  event.preventDefault();
  el.paste.classList.remove('drop');
  const file = event.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});

$('pick-file').addEventListener('click', () => $<HTMLInputElement>('file').click());
$<HTMLInputElement>('file').addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) void loadFile(file);
});

/**
 * Read a dropped or chosen file into the box.
 *
 * A PDF is not text, so it goes to the server, which runs it through `pdftotext` and
 * sends the words back — the file itself is never written to disk. Everything else is
 * read in the browser, which is faster and keeps the file on the machine.
 */
async function loadFile(file: File): Promise<void> {
  const looksPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  el.pasteStat.innerHTML = `<b>${esc(file.name)}</b> — reading it…`;
  try {
    if (looksPdf) {
      const response = await fetch('./api/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/pdf' },
        body: file,
      });
      const body = await readJson<{ text?: string; error?: string }>(response);
      if (!response.ok || !body.text) throw new Error(body.error ?? `The server answered ${response.status}.`);
      el.paste.value = body.text;
    } else {
      el.paste.value = await file.text();
    }
    updatePasteStat();
  } catch (error) {
    el.pasteStat.innerHTML = '';
    showError(el.indexError, error instanceof Error ? error.message : 'That file could not be read.');
  }
}

$('clear').addEventListener('click', () => resetToHome());

/**
 * Put the page back exactly as it arrived.
 *
 * 🔴 `delete` used to hide step 3, hide the shape panel, empty the paste box and stop
 * there — which left **step 4, the panel that carries the delete button, still on the
 * screen**, under an otherwise empty page. So the reader deleted their document and the
 * page kept offering to delete it. `clear` had its own, slightly different list, and the
 * two had already drifted apart.
 *
 * One function, called by both, is the fix: there is no second list to forget to update.
 * It hides every step that only exists once a document exists, empties every string a
 * later paste could resurrect, re-enables every button a request may have disabled, and
 * returns the scroll position to the top — because "look like the home page again"
 * includes where the page is looking.
 */
function resetToHome(): void {
  current = null;
  suggestions = [...BEFORE_INDEXING];
  if (el.suggestHint) el.suggestHint.textContent = '';
  if (el.suggestions) renderSuggestions();
  if (el.spineBox) el.spineBox.hidden = true;
  if (el.heatBox) el.heatBox.hidden = true;
  if (el.funnelBox) el.funnelBox.hidden = true;

  // The steps that only exist while a document does.
  el.step2.hidden = true;
  el.step3.hidden = true;
  el.step4.hidden = true;
  el.shape.hidden = true;
  el.answerWrap.hidden = true;
  el.sourcesWrap.hidden = true;
  el.gaps.hidden = true;
  el.conflicts.hidden = true;

  // The input side.
  el.paste.value = '';
  el.question.value = '';
  const file = document.querySelector<HTMLInputElement>('#file');
  if (file) file.value = '';
  el.pasteStat.textContent = 'Nothing pasted yet.';

  // Everything a later paste or question would otherwise inherit.
  for (const node of [
    el.indexStat,
    el.indexError,
    el.askError,
    el.shapeTitle,
    el.shapeCards,
    el.shapeWarnings,
    el.timelineNote,
    el.answerQ,
    el.answerProse,
    el.answerTimings,
    el.answerWarnings,
    el.answerDetails,
    el.sourcesSummary,
    el.sources,
    el.suggestions,
    el.gapsBody,
    el.conflictsBody,
    el.ttlLine,
    el.deleteStat,
  ]) {
    node.innerHTML = '';
  }
  el.answer.classList.remove('refused');

  // Any button a request in flight may have disabled, or relabelled with a spinner.
  // The index button goes back to *unavailable*, because the box it acts on is empty again.
  el.indexButton.disabled = true;
  el.indexButton.textContent = 'Index it';
  el.askButton.disabled = false;
  el.askButton.textContent = 'Ask';
  el.deleteButton.disabled = false;

  // 🔴 INSTANT, not smooth, and not the page's own `scroll-behavior: smooth`.
  //
  // The document collapses to a short page the moment this runs, so a smooth scroll is
  // animation over content that has already vanished — and it leaves the reader (and a
  // test) looking at a position that is still moving. `scroll-behavior: smooth` in the
  // stylesheet applies to `behavior: 'auto'` too, so 'instant' is the only value that
  // actually means now.
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* ------------------------------------------------------------------ step 2 */

function card(key: string, value: string, unit: string): string {
  return `<div class="card"><div class="k">${esc(key)}</div><div class="v">${esc(value)}</div><div class="u">${esc(unit)}</div></div>`;
}

function renderShape(document: DocumentView, timeline?: { month: string; entries: number }[]): void {
  const stats = document.stats;
  el.shape.hidden = false;
  el.shapeTitle.innerHTML =
    `<b>${esc(document.title)}</b> — indexed in <b>${plural(Math.round(stats.embeddingMs), 'millisecond')}</b>`;

  el.shapeCards.innerHTML = [
    card('Entries', stats.entries.toLocaleString(), 'blocks of the document'),
    card('Notes', stats.chunks.toLocaleString(), 'what gets searched'),
    card('Words', stats.words.toLocaleString(), `${stats.characters.toLocaleString()} characters`),
    card(
      'Full dates',
      `${stats.datedEntries.toLocaleString()}`,
      stats.datedEntries === 1 ? 'entry with a day, month and year' : 'entries with a day, month and year'
    ),
    card(
      'Placeable',
      `${(stats.datedEntries + stats.monthPrecision).toLocaleString()}`,
      stats.monthPrecision > 0 ? `on the timeline, ${stats.monthPrecision} by month only` : 'on the timeline'
    ),
    card('Span', stats.months > 0 ? plural(stats.months, 'month') : '—', stats.firstDate ?? 'no complete dates'),
  ].join('');

  const series = (timeline && timeline.length > 0 ? timeline : stats.perMonth).map((point) => ({
    label: point.month.slice(2),
    value: point.entries,
  }));
  drawColumns(el.timeline, series);
  const quiet = series.filter((point) => point.value === 0).length;
  el.timelineNote.textContent =
    series.length > 0
      ? `Entries per month across ${plural(series.length, 'month')}` +
        (stats.firstDate ? `, from ${stats.firstDate} to ${stats.lastDate}` : '') +
        (quiet > 0
          ? `. ${plural(quiet, 'month')} in that span hold nothing at all, and are drawn as flat marks rather than left out.`
          : '.') +
        (stats.monthPrecision > 0
          ? ` ${plural(stats.monthPrecision, 'entry', 'entries')} wrote a month and a year but no day, so it sits on the month and no particular day is claimed.`
          : ' Counted by the program, over the whole document.')
      : 'Nothing in this document can be placed on a timeline — no entry writes a month and a year together.';

  void renderComposition(document);
  renderHeat(document.mentions.byMonth);
}

/**
 * What the document is about: the places, people and amounts it mentions most.
 *
 * Drawn from the document the server sent back, never from the page's own reading of
 * the text — every number on this page was counted by the program, and the page only
 * draws them.
 */
function renderComposition(document: DocumentView): void {
  const mentions = document.mentions;
  const rows: { label: string; value: number }[] = [];
  for (const mention of mentions.places.slice(0, 4)) rows.push({ label: mention.value, value: mention.count });
  for (const mention of mentions.people.slice(0, 3)) rows.push({ label: mention.value, value: mention.count });
  for (const mention of mentions.amounts.slice(0, 2)) rows.push({ label: mention.value, value: mention.count });
  drawRows(el.composition, rows);
}

el.indexButton.addEventListener('click', () => void indexNow());

async function indexNow(): Promise<void> {
  clear(el.indexError);
  el.indexButton.disabled = true;
  el.indexButton.innerHTML = '<span class="spinner"></span>Indexing';
  el.indexStat.textContent = 'Splitting it up, finding its dates, and embedding every note…';

  try {
    const response = await fetch('./api/index', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: el.paste.value }),
    });
    const body = await readJson<{
      document?: DocumentView;
      reused?: boolean;
      warnings?: string[];
      error?: string;
      kindLabel?: string;
      suggestions?: string[];
      timeline?: { month: string; entries: number }[];
    }>(response);
    if (!response.ok || !body.document) throw new Error(body.error ?? `The server answered ${response.status}.`);

    current = body.document;
    renderShape(body.document, body.timeline);
    useSuggestions(body.kindLabel, body.suggestions);
    // Step 2 is the READING — the panel that came back — so it appears when there is
    // something to show, not when enough text has been typed.
    el.step2.hidden = false;

    el.indexStat.textContent = body.reused
      ? 'This exact text was already indexed, so the existing index was reused.'
      : `Done in ${(body.document.stats.embeddingMs / 1000).toFixed(1)} s.`;

    el.shapeWarnings.innerHTML = (body.warnings ?? [])
      .map((warning) => `<div class="warn-box">${esc(warning)}</div>`)
      .join('');

    el.step3.hidden = false;
    el.step4.hidden = false;
    renderTtl(body.document);

    el.question.focus();
    el.step3.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    showError(el.indexError, error instanceof Error ? error.message : 'Indexing failed.');
    el.indexStat.textContent = '';
  } finally {
    // Not simply re-enabled: the length rule still applies, so a failed index leaves the button
    // exactly as available as it was before it was pressed.
    el.indexButton.disabled = el.paste.value.trim().length < MIN_CHARS;
    el.indexButton.textContent = 'Index it';
  }
}

function renderTtl(document: DocumentView): void {
  if (!document.expiresAt) {
    el.ttlLine.textContent = 'This document is kept until it is deleted.';
    return;
  }
  const when = new Date(document.expiresAt);
  const hours = Math.max(0, (when.getTime() - Date.now()) / 3600_000);
  el.ttlLine.innerHTML =
    `It is deleted automatically at <b>${when.toLocaleString()}</b> — about ` +
    `<b>${hours < 1 ? 'under an hour' : plural(Math.round(hours), 'hour')}</b> from now. ` +
    `You do not have to do anything, and you can end it early with the button.`;
}

el.deleteButton.addEventListener('click', () => void deleteNow());

async function deleteNow(): Promise<void> {
  if (!current) return;
  el.deleteButton.disabled = true;
  try {
    const response = await fetch(`./api/document/${current.id}`, { method: 'DELETE' });
    const body = await readJson<{ deleted?: boolean }>(response);
    // 🔴 THE REPORT IS TAKEN OFF THE PANEL BEFORE THE PANEL IS PUT AWAY.
    //
    // The reset hides step 4, which is the panel the reader is standing in and the panel
    // this message used to be written into — writing it there first and resetting after
    // would erase it, and the reader would see the page go blank with no word about
    // whether the delete worked. So the outcome is held, the page is put back, and the
    // outcome is then shown in the floating notice.
    const deleted = body.deleted === true;
    resetToHome();
    showToast(
      deleted
        ? 'Deleted. The entries, the notes, the embeddings and the text are all gone.'
        : 'It had already gone — there was nothing left to delete.'
    );
  } catch {
    el.deleteStat.textContent = 'The delete did not go through. Try again.';
  } finally {
    el.deleteButton.disabled = false;
  }
}

/* ------------------------------------------------------------------ step 3 */

function renderSuggestions(): void {
  el.suggestions.innerHTML = suggestions.map(
    (text, at) => `<button type="button" class="ghost" data-q="${esc(text)}" data-at="${at}">${esc(text)}</button>`
  ).join('');
  for (const button of el.suggestions.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      el.question.value = (button as HTMLButtonElement).dataset.q ?? '';
      void askNow();
    });
  }
}

/** Take the server's reading of what was just indexed, and show its questions. */
function useSuggestions(kindLabel: string | undefined, next: string[] | undefined): void {
  if (next && next.length > 0) suggestions = next;
  // 🔴 WHAT THE DOCUMENT WAS TAKEN FOR IS THE FIRST THING IN THE LINE, AND IT IS MARKED.
  // The guess is the one thing on this page the reader did not author, so it is the one
  // thing that has to be visible enough to be disagreed with — plain grey text between two
  // sentences is a guess nobody notices, and a guess nobody notices is a guess nobody can
  // correct. George, 20 Sep 2026: "make what it looks like highlighted".
  el.suggestHint.innerHTML = kindLabel
    ? `This looks like <b class="kind-badge">${esc(kindLabel)}</b> — try one of these:`
    : '';
  renderSuggestions();
}

renderSuggestions();

el.askButton.addEventListener('click', () => void askNow());
el.question.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void askNow();
});

/**
 * The one conversion this site has, sent once.
 *
 * A visitor pastes a document, waits for it to be read, then asks something and gets an
 * answer grounded in it — that is the whole errand, so that is the conversion rather
 * than a page load or a button press. Fired on the FIRST successful answer only; a
 * visitor asking nine questions is one person who got what they came for, not nine.
 *
 * 🔴 THE OPTIONAL CHAIN IS THE GATE, NOT A CONVENIENCE. `ragTrack` is created by
 * `consent.ts` and only after a visitor says yes — so on a page with no consent this
 * line does nothing at all, because there is no function to call. **The question the
 * visitor asked is never part of the payload**; only that a question was answered, and
 * how long it took.
 */
let answeredOnce = false;
function markAnswered(durationMs: number): void {
  if (answeredOnce) return;
  answeredOnce = true;
  window.ragTrack?.('generate_lead', {
    page_path: location.pathname,
    // The number of characters the document holds, rounded to the nearest hundred — a
    // size band, not the text. Enough to say whether people bring a paragraph or a
    // book, and nothing that could reconstruct what they brought.
    document_size_band: current ? Math.round(current.stats.characters / 100) * 100 : 0,
    answer_ms: Math.round(durationMs),
  });
}

async function askNow(): Promise<void> {
  if (!current || !el.question.value.trim()) {
    el.question.focus();
    return;
  }
  clear(el.askError);
  el.askButton.disabled = true;
  el.askButton.innerHTML = '<span class="spinner"></span>Reading';
  const startedAt = performance.now();

  try {
    const response = await fetch('./api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: current.id, question: el.question.value.trim() }),
    });
    const body = await readJson<Answer & { error?: string }>(response);
    if (!response.ok) throw new Error(body.error ?? `The server answered ${response.status}.`);
    renderAnswer(body);
    markAnswered(performance.now() - startedAt);
  } catch (error) {
    showError(el.askError, error instanceof Error ? error.message : 'The question failed.');
  } finally {
    el.askButton.disabled = false;
    el.askButton.textContent = 'Ask';
  }
}

function chips(items: Mention[], unit = ''): string {
  if (items.length === 0) return '<span class="chip">none found</span>';
  return items
    .map((item) => `<span class="chip"><b>${esc(item.value)}</b>${unit ? ` · ${item.count}${unit}` : ''}</span>`)
    .join('');
}

function detailBox(title: string, inner: string): string {
  return `<div class="detail"><h4>${esc(title)}</h4>${inner}</div>`;
}

/**
 * What the document does not say.
 *
 * 🔴 **EVERY WORD OF THIS IS COUNTED IN CODE, AND THE PANEL SAYS SO.** It is the one part
 * of the answer block that is not the model's, which is exactly why it can be trusted — and
 * exactly why it must be visibly distinct from the answer above it. It is also why the
 * wording is careful: a missing word is **not** a missing answer. A resume answers "where
 * did he go to school?" without ever containing the word *school*, because it heads that
 * section EDUCATION. So the claim made here is only ever about vocabulary, said in those
 * terms, with the absences named.
 *
 * Nothing to report hides the panel rather than showing an empty one: a section that says
 * "nothing" under every answer is noise, and noise is what a reader learns to skip.
 */
function renderGaps(gaps: Answer['gaps']): void {
  const parts: string[] = [];

  if (gaps.absentTotal > 0) {
    const shown = gaps.absent.map((word) => `<span class="term">${esc(word)}</span>`).join(' ');
    const more = gaps.absentTotal > gaps.absent.length ? ` and <b>${gaps.absentTotal - gaps.absent.length}</b> more` : '';
    const sentence =
      gaps.absentTotal === 1
        ? `That word does not appear anywhere in the document.`
        : `None of those words appears anywhere in the document.`;
    parts.push(`<p>Your question uses ${shown}${more}. ${sentence}</p>`);
    parts.push(
      `<p>A missing word is not a missing answer — the document may simply use a different ` +
        `one. The answer above is what it actually says.</p>`
    );
  } else if (gaps.presentCount > 0) {
    parts.push('<p>Every word your question uses appears somewhere in the document.</p>');
  }

  if (gaps.once.length > 0) {
    const chips = gaps.once
      .map((item) => `<span class="once"><b>${esc(item.value)}</b> · said once, as a ${esc(item.kind)}</span>`)
      .join('');
    parts.push(
      `<p>Mentioned exactly once in the whole document, so the easiest things to miss:</p>` +
        `<div class="once-list">${chips}</div>`
    );
  }

  el.gapsBody.innerHTML = parts.join('');
  el.gaps.hidden = parts.length === 0;
}

/**
 * Where the document disagrees with itself.
 *
 * Three checks only, and each is arithmetic over what the parser extracted — see
 * `conflicts.ts` for why the list is that short. The wording keeps every claim at the level
 * of what was actually proved: a name is reported as **written two ways**, which is a fact
 * about spelling, and never as the same person, which would be an interpretation.
 *
 * Hidden when there is nothing to report, for the same reason as the other panel — a section
 * that says "nothing" under every answer is a section people learn to skip.
 */
function renderConflicts(conflicts: Answer['conflicts']): void {
  const parts: string[] = [];

  if (conflicts.outOfOrder.length > 0) {
    const rows = conflicts.outOfOrder
      .map(
        (item) =>
          `<li><b>${esc(item.label)}</b> (${esc(item.date)}) comes after ` +
          `<b>${esc(item.previousLabel)}</b> (${esc(item.previousDate)}) — the dates run backwards.</li>`
      )
      .join('');
    parts.push(
      `<p>These entries are out of date order, in the document's own order. Usually a missing ` +
        `page, a block pasted in the wrong place, or a mistyped year:</p><ul>${rows}</ul>`
    );
  }

  if (conflicts.spelledTwoWays.length > 0) {
    const rows = conflicts.spelledTwoWays
      .map(
        (pair) =>
          `<li><span class="term">${esc(pair.a)}</span> and <span class="term">${esc(pair.b)}</span> ` +
          `— a ${esc(pair.kind)}, written two ways</li>`
      )
      .join('');
    parts.push(
      `<p>Written two ways. This is a fact about the spelling, not a claim that they are the ` +
        `same thing — but a search for one of them will not find the other:</p><ul>${rows}</ul>`
    );
  }

  if (conflicts.ambiguous.length > 0) {
    const rows = conflicts.ambiguous
      .map((item) => `<li><b>${esc(item.raw)}</b> — ${esc(item.label)}</li>`)
      .join('');
    parts.push(
      `<p>Written so the day and the month could each be the other, so no date is claimed for ` +
        `these and they are left off the timeline:</p><ul>${rows}</ul>`
    );
  }

  el.conflictsBody.innerHTML = parts.join('');
  el.conflicts.hidden = parts.length === 0;
}

function renderAnswer(answer: Answer): void {
  el.answerWrap.hidden = false;
  el.answerQ.innerHTML = `<b>You asked:</b> ${esc(answer.question)}`;
  renderGaps(answer.gaps);
  renderConflicts(answer.conflicts);
  // Drawn for a refusal as well as an answer: a refusal is exactly the case where seeing
  // that NOTHING was used is worth the space.
  renderSpine(answer.spine);
  renderFunnel(answer.funnel);

  if (answer.mode === 'refused') {
    el.answer.classList.add('refused');
    el.answerProse.textContent =
      'The document does not say. Nothing in it matched this question closely enough to answer from, so no model was called — that refusal is a fact about the document, worked out in milliseconds.';
  } else {
    el.answer.classList.remove('refused');
    el.answerProse.innerHTML = markCitations(answer.prose);
  }

  el.answerTimings.innerHTML = [
    `<span>search <b>${answer.timings.retrieveMs} ms</b></span>`,
    answer.timings.rerankMs > 0 ? `<span>rerank <b>${answer.timings.rerankMs} ms</b></span>` : '',
    `<span>model <b>${(answer.timings.modelMs / 1000).toFixed(1)} s</b></span>`,
    `<span>total <b>${(answer.timings.totalMs / 1000).toFixed(1)} s</b></span>`,
    `<span>notes <b>${answer.sources.length}</b></span>`,
  ]
    .filter(Boolean)
    .join('');

  el.answerWarnings.innerHTML = answer.warnings
    .map((warning) => `<div class="warn-box">${esc(warning)}</div>`)
    .join('');

  renderDetails(answer.details, answer.sources);

  el.sourcesSummary.textContent = `The ${plural(answer.sources.length, 'note')} this came from`;
  el.sources.innerHTML = answer.sources
    .map(
      (source) => `<li>
        <span class="lbl">[${esc(source.label)}]</span>
        ${source.both ? '<span class="chip">found both ways</span>' : ''}
        ${source.rerank !== null ? `<span class="chip">rerank ${source.rerank.toFixed(2)}</span>` : ''}
        <div class="txt">${esc(source.text.slice(0, 900))}${source.text.length > 900 ? '\u2026' : ''}</div>
        <div class="meter"><i style="width:${Math.round(Math.max(0, Math.min(1, source.vector)) * 100)}%"></i></div>
      </li>`
    )
    .join('');
}

function renderDetails(details: AnswerDetails, sources: Source[]): void {
  const boxes: string[] = [];

  if (details.dates.length > 0) {
    boxes.push(
      detailBox(
        'The dates it rests on',
        `<div class="chips">${details.dates
          .map(
            (date) =>
              `<span class="chip date${date.inferred ? ' inferred' : ''}">${esc(date.date ?? date.dateRaw ?? date.label)}</span>`
          )
          .join('')}</div>`
      )
    );
  }

  if (details.places.length > 0) boxes.push(detailBox('Places', `<div class="chips">${chips(details.places)}</div>`));
  if (details.people.length > 0) boxes.push(detailBox('People', `<div class="chips">${chips(details.people)}</div>`));
  if (details.amounts.length > 0)
    boxes.push(detailBox('Amounts', `<div class="chips">${chips(details.amounts)}</div>`));

  if (details.images.length > 0) {
    boxes.push(
      detailBox(
        'Pictures in the document',
        `<div class="thumbs" data-thumbs>${details.images
          .map((image) =>
            image.url
              ? `<figure class="thumb" style="margin:0"><img src="${esc(image.url)}" alt="${esc(image.caption ?? 'an image from the document')}" loading="lazy" referrerpolicy="no-referrer" />${
                  image.caption ? `<figcaption>${esc(image.caption)}</figcaption>` : ''
                }</figure>`
              : `<figure class="thumb" style="margin:0"><figcaption>${esc(image.caption ?? 'an image')}</figcaption></figure>`
          )
          .join('')}</div>`
      )
    );
  }

  boxes.push(
    `<div class="detail" style="grid-column:1/-1">
      <h4>How well each note matched</h4>
      <p style="margin:0 0 8px;font-size:12.5px;color:#7ba1a8">${
        sources.some((s) => s.rerank !== null)
          ? 'Scored by the reranker, which reads the question and the note together.'
          : 'Cosine similarity — how close the meaning of the note is to the question.'
      }</p>
      <canvas id="scores" height="${Math.max(60, sources.length * 22)}"></canvas>
    </div>`
  );

  el.answerDetails.innerHTML = boxes.join('');
  const scores = document.getElementById('scores') as HTMLCanvasElement | null;
  if (scores) drawScores(scores, sources);

  // A picture the document points at may no longer be there, and the document may
  // point at a placeholder. Drop the ones that will not load, and drop the whole card
  // if none of them will — an empty panel with a heading reads as a fault in the tool
  // rather than as a broken link in the document.
  for (const image of el.answerDetails.querySelectorAll<HTMLImageElement>('.thumbs img')) {
    image.addEventListener('error', () => {
      image.closest('figure')?.remove();
      const box = el.answerDetails.querySelector('[data-thumbs]');
      if (box && box.children.length === 0) box.closest('.detail')?.remove();
    });
  }
}

/* ------------------------------------------------------------------ charts redraw */

let redraw = 0;
window.addEventListener('resize', () => {
  window.clearTimeout(redraw);
  redraw = window.setTimeout(() => {
    if (current) {
      drawColumns(el.timeline, current.stats.perMonth.map((p) => ({ label: p.month.slice(2), value: p.entries })));
      renderComposition(current);
    }
  }, 180);
});

/* ------------------------------------------------------------------ boot */

/**
 * Say plainly whether the model works, on arrival.
 *
 * Without this the first sign of a missing model is an error after a question has been
 * typed, which reads as the tool being broken rather than as a setting being wrong. The
 * banner reports what the server said about itself and never guesses at a cause.
 */
async function reportHealth(): Promise<void> {
  const where = document.getElementById('health');
  if (!where) return;
  try {
    const response = await fetch('./healthz');
    const body = await readJson<{
      ok?: boolean;
      model?: string;
      provider?: string;
      chatModel?: string;
      embedModel?: string;
    }>(response);
    if (response.ok && body.ok) {
      where.innerHTML =
        `<div class="statline">model: <b>${esc(body.chatModel ?? '?')}</b> for answers, ` +
        `<b>${esc(body.embedModel ?? '?')}</b> for search · <b>${esc(body.provider ?? '?')}</b>` +
        `</div>`;
      return;
    }
    where.innerHTML =
      `<div class="warn-box"><b>The model is not answering yet.</b> ` +
      `The page will index a document, but a question cannot be answered until a model is reachable. ` +
      `The server said: <code>${esc(body.model ?? 'no detail')}</code>.` +
      (body.provider === 'openai'
        ? ' On a hosted provider this usually means inference is not enabled on the account, or the key has not been set.'
        : ' Start it with <code>docker compose up -d ollama</code>, or point MODEL_BASE_URL at a hosted provider.') +
      `</div>`;
  } catch {
    where.innerHTML = '<div class="warn-box">The server did not report whether the model is up.</div>';
  }
}

updatePasteStat();
void reportHealth();
