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

/**
 * The timeline the server built from the document's own entries.
 *
 * 🔴 A RESUME IS NOT A DIARY, AND THE PAGE NEVER HAS TO KNOW WHICH IT IS HOLDING. A role states a
 * period and gets a bar whose width IS that period; a diary entry states one day and gets a tick.
 * `pointsOnly` and `hasPeriods` exist only so the caption can describe what is actually there.
 */
interface Spans {
  spans: {
    label: string;
    from: string;
    to: string;
    openEnded: boolean;
    point: boolean;
    lane: number;
  }[];
  from: string;
  to: string;
  lanes: number;
  pointsOnly: boolean;
  hasPeriods: boolean;
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
/* ------------------------------------------------- while a question is answered */

/** A stage of answering, as the server reported it — with real milliseconds. */
interface AskStage {
  stage: 'search' | 'notes' | 'model';
  /** Milliseconds since the question was asked, when this was reported. */
  ms: number;
  /** How long the stage took. Absent while it is still running. */
  tookMs?: number;
  found?: number;
  kept?: number;
  silent?: boolean;
}

const ASK_STAGE_WORDS: Record<string, string> = {
  search: 'Searched the notes',
  notes: 'Chose what to read',
  model: 'The model wrote the answer',
};

interface AnswerTimings {
  retrieveMs: number;
  rerankMs: number;
  modelMs: number;
  totalMs: number;
}

/**
 * A chart of how the answer was built: one row per stage that actually ran.
 *
 * 🔴 TWO THIRDS OF THIS IS MEASURED AND ONE THIRD HONESTLY IS NOT. George, 20 Sep 2026: *"when i
 * ask a question, is there some sort of progress chart that can be applied?"* The searches and the
 * choosing are real, finished stages with real milliseconds on them. The model call is a single
 * request with **nothing inside it to count**, so its row is drawn against the clock and says
 * *"still running"* — a growing bar is the only true thing available, and pretending to know how
 * far through the model is would be the one thing this page must never do.
 *
 * A row appears only once its stage has been reported, so the chart grows as the work does.
 */
/**
 * The rows to draw: a stage announced before it ran is a placeholder, and the report carrying its
 * measurement replaces it rather than joining it.
 *
 * 🔴 WHY THIS EXISTS. The model call is reported twice — once when it starts, so its bar can grow
 * against the clock, and once when it returns, with its real time. Drawing both left a FINISHED
 * chart with a row still saying *"still running"* and still growing, on a question that had already
 * been answered: George's screenshot on 20 Sep 2026 showed four rows where three stages ran.
 */
function askRows(stages: AskStage[]): AskStage[] {
  const rows: AskStage[] = [];
  for (const stage of stages) {
    const open = rows.findIndex((row) => row.stage === stage.stage && row.tookMs === undefined);
    if (stage.tookMs !== undefined && open >= 0) rows[open] = stage;
    else rows.push(stage);
  }
  return rows;
}

function drawAskStages(canvas: HTMLCanvasElement, stages: AskStage[], nowMs: number): void {
  const surface = fit(canvas);
  if (!surface) return;
  const { ctx, w, h } = surface;

  const pad = { top: 12, right: 12, bottom: 20, left: 8 };
  const plotW = Math.max(20, w - pad.left - pad.right);
  const rows = Math.max(1, stages.length);
  // What the reader can count, said out loud on the element — a canvas cannot be asked.
  canvas.dataset.rows = String(stages.length);
  const axisY = h - pad.bottom;
  const rowH = Math.min(30, Math.max(11, (axisY - pad.top - 4) / rows));

  // The x scale is milliseconds, and it stretches as the slowest stage grows: a search of 40 ms
  // beside a model call of four seconds must not crush the search to nothing.
  const ends = stages.map((stage) => (stage.tookMs === undefined ? nowMs : stage.ms));
  const span = Math.max(120, ...ends, nowMs);
  const x = (ms: number): number => pad.left + (ms / span) * plotW;

  ctx.strokeStyle = '#1b434b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, axisY + 0.5);
  ctx.lineTo(pad.left + plotW, axisY + 0.5);
  ctx.stroke();

  ctx.font = '10.5px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#7ba1a8';
  ctx.fillText(`${(span / 1000).toFixed(1)} s`, pad.left + plotW - 30, axisY + 14);
  ctx.fillText('0', pad.left, axisY + 14);

  stages.forEach((stage, at) => {
    const colour = COLOURS[at % COLOURS.length] as string;
    const startedAt = stage.tookMs === undefined ? stage.ms : stage.ms - stage.tookMs;
    const endedAt = stage.tookMs === undefined ? nowMs : stage.ms;
    const y = pad.top + at * rowH;
    const barH = Math.max(6, rowH - 8);
    const from = x(startedAt);
    const width = Math.max(2, x(endedAt) - from);

    const gradient = ctx.createLinearGradient(from, 0, from + width, 0);
    gradient.addColorStop(0, colour);
    gradient.addColorStop(1, `${colour}55`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(from, y + 1, width, barH, Math.min(4, barH / 2));
    ctx.fill();

    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const word = ASK_STAGE_WORDS[stage.stage] ?? stage.stage;
    const timing =
      stage.tookMs === undefined
        ? `${((nowMs - startedAt) / 1000).toFixed(1)} s, still running`
        : `${stage.tookMs} ms`;
    const room = plotW - (from + width) - 6;
    const inside = ctx.measureText(timing).width <= width - 12;

    // 🔴 ONE LINE PER ROW, AND NEVER INTO THE ROW BELOW. A small finished stage — the 183 ms search
    // beside a 3-second model call — is far too narrow to hold its own timing, and an earlier
    // version wrote that timing on a second line *underneath the row*, which put it inside the row
    // BELOW: George's screenshot of the live chart on 20 Sep 2026 showed **183 ms** printed across
    // **Chose what to read**. The timing is in the caption above the chart anyway, so leaving it off
    // a bar that cannot hold it loses nothing and stops two rows from writing over each other.
    const together = `${word} \u00b7 ${timing}`;
    if (inside) {
      ctx.fillStyle = '#04221f';
      // 🔴 A BAR THAT CARRIES ITS OWN TIMING STILL HAS TO SAY WHAT IT MEASURED. The longest bar runs
      // to the right edge of the plot, so its name can never go beside it — it goes inside, with the
      // number, provided the pair fits. Measured on the live chart 20 Sep 2026: the model's row drew
      // **2789 ms** and nothing else, and a number with no noun is not a chart.
      if (ctx.measureText(together).width <= width - 12) {
        ctx.fillText(together, from + 6, y + rowH / 2);
      } else {
        ctx.fillText(shortenToFit(ctx, timing, Math.max(24, width - 12)), from + 6, y + rowH / 2);
        if (room > ctx.measureText(word).width + 8) {
          ctx.fillStyle = '#7ba1a8';
          ctx.fillText(word, from + width + 5, y + rowH / 2);
        }
      }
    } else {
      ctx.fillStyle = '#b2d3d8';
      ctx.fillText(
        shortenToFit(ctx, word, Math.max(24, room)),
        from + width + 5,
        y + rowH / 2
      );
    }
    ctx.textBaseline = 'alphabetic';
  });
}

/**
 * The timeline: the width of a bar IS the period the entry states.
 *
 * 🔴 WHAT THIS REPLACED, AND WHY. The old chart counted entries into month buckets — one column per
 * month — so a resume read as three lonely months (`July 2021`, `March 2018`, `January 2017`),
 * every bar the same width, and the width meant nothing. George, 20 Sep 2026, on his own resume:
 * *"can you make the width of the bar equal to the start and end for this timeline?? … or, i mean
 * this is for a resume, i suppose i should assume it will not always be a resume."*
 *
 * So it is a time axis: x is real time, a bar runs from what an entry states as its start to what it
 * states as its end, and an entry that states one day — a diary — is a tick at that day. **One chart,
 * both documents, and no mode switch**, because the document is never asked what kind it is.
 */
function drawSpans(canvas: HTMLCanvasElement, spans: Spans): void {
  const surface = fit(canvas);
  if (!surface) return;
  const { ctx, w, h } = surface;

  const pad = { top: 14, right: 10, bottom: 24, left: 10 };
  const plotW = Math.max(20, w - pad.left - pad.right);

  if (spans.spans.length === 0) {
    ctx.fillStyle = '#6f9aa1';
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('Nothing in this document can be placed on a timeline.', pad.left, h / 2);
    return;
  }

  const axisFrom = monthIndex(spans.from);
  const axisTo = monthIndex(spans.to);
  const axisLength = Math.max(1, axisTo - axisFrom);
  const x = (month: string): number => {
    const at = monthIndex(month);
    return pad.left + ((at - axisFrom) / axisLength) * plotW;
  };

  const rows = Math.max(1, spans.lanes);
  const axisY = h - pad.bottom;
  const rowH = Math.min(30, Math.max(9, (axisY - pad.top - 6) / rows));

  // The axis itself, so the reader can see that x is time and where the years fall.
  ctx.strokeStyle = '#1b434b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, axisY + 0.5);
  ctx.lineTo(pad.left + plotW, axisY + 0.5);
  ctx.stroke();

  // 🔴 YEAR LINES, NOT MONTH COLUMNS. A 195-month axis has 195 columns; what a reader can actually
  // use is where the years are. One line per January inside the span, labelled with the year.
  const firstYear = Math.ceil(Number(spans.from.slice(0, 4)));
  const lastYear = Number(spans.to.slice(0, 4));
  const years = lastYear - firstYear + 1;
  const yearStep = Math.max(1, Math.ceil(years / Math.max(1, Math.floor(plotW / 54))));
  ctx.font = '10.5px ui-sans-serif, system-ui, sans-serif';
  for (let year = firstYear; year <= lastYear; year += yearStep) {
    const at = `${year}-01`;
    if (at < spans.from) continue;
    const lineX = x(at);
    ctx.strokeStyle = '#12323a';
    ctx.beginPath();
    ctx.moveTo(lineX, pad.top - 4);
    ctx.lineTo(lineX, axisY);
    ctx.stroke();
    ctx.fillStyle = '#7ba1a8';
    ctx.textAlign = 'center';
    ctx.fillText(String(year), lineX, axisY + 14);
    ctx.textAlign = 'left';
  }

  for (const span of spans.spans) {
    const colour = COLOURS[span.lane % COLOURS.length] as string;
    const startX = x(span.from);
    const endX = x(span.to);
    const y = pad.top + span.lane * rowH;
    const barH = Math.max(6, rowH - 8);

    if (span.point) {
      // A day has no length, so it is drawn where it is and no wider than it can be defended:
      // one month of the axis, and never more than a couple of pixels.
      const tick = Math.max(2, Math.min(4, plotW / (axisLength + 1)));
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.roundRect(startX - tick / 2, y + 1, tick, barH, 1.5);
      ctx.fill();
      continue;
    }

    // +1 month, because a period that runs `January 2017 to February 2018` includes February.
    const width = Math.max(3, endX - startX + plotW / (axisLength + 1));
    const gradient = ctx.createLinearGradient(startX, 0, startX + width, 0);
    gradient.addColorStop(0, colour);
    gradient.addColorStop(1, `${colour}55`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(startX, y + 1, width, barH, Math.min(4, barH / 2));
    ctx.fill();
    // 🔴 THE EDGE IS STROKED IN THE SOLID COLOUR, AND THAT IS NOT DECORATION. The fill fades to
    // about a third at its right end, so the bar's own right edge is the one place its width
    // cannot be measured — and the width is the entire claim this chart makes. A solid 1px edge
    // makes the bar's start and end exact, which is what the end-to-end test reads off the pixels.
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.stroke();

    // 🔴 THE LABEL GOES INSIDE THE BAR WHEN IT FITS, BESIDE IT WHEN THERE IS ROOM, AND SHORTENED
    // INSIDE IT WHEN THERE IS NEITHER. The first version only chose between the first two, and the
    // longest period is usually the one that ENDS AT THE RIGHT EDGE — so its label was drawn past
    // the canvas and vanished. Seen on the resume: `Senior Software Engineer, First Canadian Title`
    // was 250px in a 231px bar starting at x 209 of a 450px canvas, so it was laid out at x 450 and
    // nothing was painted at all. A bar with no label is worse than a shortened one.
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const label = span.openEnded ? `${span.label} — still running` : span.label;
    const fitsInside = ctx.measureText(label).width <= width - 12;
    const roomBeside = startX + width + 6 + ctx.measureText(label).width < pad.left + plotW;
    if (fitsInside || !roomBeside) {
      ctx.fillStyle = '#04221f';
      ctx.fillText(shortenToFit(ctx, label, Math.max(24, width - 12)), startX + 6, y + rowH / 2);
    } else {
      ctx.fillStyle = '#b2d3d8';
      ctx.fillText(label, startX + width + 5, y + rowH / 2);
    }
    ctx.textBaseline = 'alphabetic';
  }
}

/** `YYYY-MM` as a month number, so a position on the axis is real time and not a bucket index. */
function monthIndex(month: string): number {
  const [year, part] = month.split('-').map((value) => Number(value));
  if (!year || !part) return 0;
  return year * 12 + (part - 1);
}

function fit(canvas: HTMLCanvasElement): Canvas | null {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 320;
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
 * The one font every row label is measured and drawn with. Measuring and drawing must agree. */
const LABEL_FONT = '11.5px ui-sans-serif, system-ui, sans-serif';

/**
 * Every canvas repaints when the page's layout changes.
 *
 * 🔴 THIS IS NOT A NICETY — IT IS HALF THE FIX FOR "STRETCHED". A canvas is measured as it is
 * drawn, because `fit()` reads `clientWidth` — and **a canvas inside a hidden section has no
 * layout at all**, so the measurement fell back to 320 and the bitmap was drawn 320 wide. The page
 * then scaled that bitmap to the full column. Measured on the live site, 20 Sep 2026: the heat map
 * was stretched **2.56×** and the timeline **1.41×**. Revealing the section before drawing fixes
 * the order of events; this fixes everything else — a window resize, a font arriving late, a panel
 * opening — and nothing repainted on a resize before, so every chart kept whatever width the
 * window happened to have when the answer arrived.
 *
 * A canvas that is currently hidden is skipped rather than repainted: `clientWidth` is 0 there, and
 * repainting would only re-apply the 320 fallback to a chart nobody can see. It repaints when it
 * comes back, because that is itself a layout change.
 */
const painters = new Map<HTMLCanvasElement, () => void>();

/** Draw a canvas now, and again whenever the layout moves under it. */
function painting(canvas: HTMLCanvasElement, paint: () => void): void {
  painters.set(canvas, paint);
  paint();
}

function repaintAll(): void {
  for (const [canvas, paint] of painters) if (canvas.clientWidth > 0) paint();
}

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => repaintAll()).observe(document.documentElement);
} else {
  addEventListener('resize', repaintAll);
}

/**
 * A label cut to the width it is actually allowed, and only then with an ellipsis.
 *
 * The old code shortened by a fixed character count, which is a guess about a width: sixteen
 * characters of `WWW` is a different number of pixels from sixteen of `iii`. This measures.
 */
function shortenToFit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}\u2026`).width > width) cut = cut.slice(0, -1);
  return `${cut}\u2026`;
}

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

  // 🔴 THE LABEL COLUMN IS MEASURED, NOT GUESSED — AND IT IS NO LONGER CLIPPED AT 17
  // CHARACTERS. George, 20 Sep 2026: *"the chart cuts off the text. maybe make that max
  // width"*. Two faults, and both had to go: the scores canvas was drawing itself at 320 CSS
  // pixels inside a box several times wider (a canvas with no CSS width has the 300-pixel
  // default, so `fit()` measured that and everything was squeezed), and `drawRows` then hard-
  // truncated every label to 16 characters plus an ellipsis regardless of the room available.
  // So a heading like `Full-Stack Software Engineer` arrived as `Full-Stack Softw…` on a
  // canvas with hundreds of pixels to spare. The widest label now decides the column, up to a
  // share of the width, and a label is only shortened when it genuinely cannot fit.
  ctx.textBaseline = 'middle';
  ctx.font = LABEL_FONT;
  const widest = data.reduce((most, row) => Math.max(most, ctx.measureText(row.label).width), 0);
  const labelCap = Math.max(72, w * 0.46);
  const labelW = Math.min(Math.max(64, widest + 6), labelCap);
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
    ctx.font = LABEL_FONT;
    ctx.fillText(shortenToFit(ctx, row.label, labelW), 0, y + rowH / 2);

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
  painting(el.spine, () => drawSpine(el.spine, spine));
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

  // The label column is measured here too, for the same reason as `drawRows`: this hard-
  // truncated a name at 18 characters whatever room the canvas had.
  ctx.font = LABEL_FONT;
  const widest = grid.series.reduce((most, row) => Math.max(most, ctx.measureText(row.name).width), 0);
  const labelW = Math.min(Math.max(70, widest + 8), Math.max(84, w * 0.34));
  const pad = { top: 6, bottom: 20 };
  const plotW = Math.max(20, w - labelW - 6);
  const rowH = Math.min(22, Math.max(11, (h - pad.top - pad.bottom) / rows));
  const cellW = plotW / cols;
  const max = Math.max(1, ...grid.series.flatMap((row) => row.counts));

  grid.series.forEach((row, at) => {
    const y = pad.top + at * rowH;
    ctx.fillStyle = '#b2d3d8';
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'middle';
    ctx.fillText(shortenToFit(ctx, row.name, labelW), 0, y + rowH / 2);

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
    'so a brighter cell means more notes in that month mention it. The counts are of notes, ' +
    'not of words — and they are counted in code, never by the model.';
  painting(el.heat, () => drawHeat(el.heat, grid));
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

  // Measured rather than guessed, and no longer cut at 24 characters regardless of the room.
  ctx.font = LABEL_FONT;
  const widest = stages.reduce((most, stage) => Math.max(most, ctx.measureText(stage.label).width), 0);
  const labelW = Math.min(Math.max(96, widest + 8), Math.max(110, w * 0.42));
  const valueW = 46;
  const plotW = Math.max(20, w - labelW - valueW - 8);
  const rowH = Math.min(27, Math.max(15, (h - 8) / stages.length));
  const max = Math.max(...stages.map((stage) => stage.notes), 1);

  stages.forEach((stage, at) => {
    const y = 4 + at * rowH;
    const barH = Math.max(7, rowH - 9);
    const barW = stage.notes === 0 ? 2 : Math.max(3, (stage.notes / max) * plotW);

    ctx.fillStyle = '#b2d3d8';
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'middle';
    ctx.fillText(shortenToFit(ctx, stage.label, labelW), 0, y + rowH / 2);

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
  painting(el.funnel, () => drawFunnel(el.funnel, stages));
}

/* ------------------------------------------------------------------ state */

let current: DocumentView | null = null;
/** The span timeline for the document on screen, kept so a resize can redraw the same data. */
let currentSpans: Spans | null = null;

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
  askProgress: $('ask-progress'),
  askProgressTitle: $('ask-progress-title'),
  askProgressNote: $('ask-progress-note'),
  askChart: $<HTMLCanvasElement>('ask-chart'),
  indexProgress: $('index-progress'),
  indexProgressTitle: $('index-progress-title'),
  indexProgressNote: $('index-progress-note'),
  indexChart: $<HTMLCanvasElement>('index-chart'),
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

/** `2026-03` in words, for a caption — never a date, because no day is being claimed. */
function monthWords(month: string): string {
  const [year, part] = month.split('-').map((value) => Number(value));
  if (!year || !part) return month;
  return `${MONTH_WORDS[part - 1] ?? part} ${year}`;
}

const MONTH_WORDS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * How long the timeline actually runs, in words — the figure the Span card shows.
 *
 * Measured over the span axis rather than over the months that happen to hold an entry: a career
 * with three roles covers years, and `3 months` beside a nine-year timeline is a number
 * contradicting the chart it sits above.
 */
function spanPhrase(spans: Spans | undefined, stats: DocumentView['stats']): string {
  if (!spans || spans.spans.length === 0) {
    return stats.months > 0 ? plural(stats.months, 'month') : '—';
  }
  const months = Math.round(
    (Number(spans.to.slice(0, 4)) * 12 + Number(spans.to.slice(5, 7))) -
      (Number(spans.from.slice(0, 4)) * 12 + Number(spans.from.slice(5, 7))) +
      1
  );
  if (months < 24) return plural(months, 'month');
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest === 0 ? plural(years, 'year') : `${plural(years, 'year')} ${plural(rest, 'month')}`;
}

function spanNote(spans: Spans | undefined, stats: DocumentView['stats']): string {
  if (!spans || spans.spans.length === 0) return stats.firstDate ?? 'no complete dates';
  return `from ${monthWords(spans.from)}`;
}

function renderShape(document: DocumentView, timeline: { month: string; entries: number }[] | undefined, spans: Spans | undefined): void {
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
    // The span is what the timeline UNDER the cards actually shows, so it is measured over the
    // same axis: a resume runs for years even though only three of its months hold an entry.
    // 🔴 It used to report the count of months containing an entry, which for a career read
    // `3 months` beside a nine-year timeline — a figure contradicting the chart next to it.
    card('Span', spanPhrase(spans, stats), spanNote(spans, stats)),
  ].join('');

  // 🔴 THE TIMELINE IS DRAWN FROM THE PERIODS, NOT FROM MONTH BUCKETS. See `drawSpans` for why:
  // a resume states periods and a diary states days, and one chart draws both without being told
  // which it has. The month counts are still needed — they are how the caption can say how much of
  // the span holds NOTHING, which is the one thing a bar chart cannot show.
  const quiet = (timeline && timeline.length > 0 ? timeline : stats.perMonth).filter(
    (point) => point.entries === 0
  ).length;
  currentSpans = spans ?? null;
  if (spans && spans.spans.length > 0) {
    painting(el.timeline, () => drawSpans(el.timeline, spans));
    const periods = spans.spans.filter((span) => !span.point).length;
    const points = spans.spans.length - periods;
    // 🔴 SENTENCES, JOINED WITH SPACES — NOT CONCATENATED FRAGMENTS. The first version built the
    // caption from pieces and joined them with an empty string, so it read *"12 periods and 1
    // single datebetween June 1994 and September 2026"* on the live page. Seen in a screenshot,
    // fixed, and the shape of this list is what stops it coming back.
    const parts: string[] = [];
    const between = `between ${monthWords(spans.from)} and ${monthWords(spans.to)}`;
    parts.push(
      !spans.hasPeriods
        ? `${plural(spans.spans.length, 'entry', 'entries')} ${between}, each one a single date.`
        : points > 0
          ? // Only mentioned when there IS one: `3 periods and 0 single dates` is a sentence nobody
            // wants to read, and the live run printed exactly that before this line existed.
            `${plural(periods, 'period')} and ${plural(points, 'single date')} ${between}.`
          : `${plural(periods, 'period')} ${between}.`
    );
    parts.push(
      spans.hasPeriods
        ? 'Each bar runs from the start an entry states to the end it states, so its width is the time that entry covers.'
        : 'Each mark is one entry, at its own date.'
    );
    if (spans.spans.some((span) => span.openEnded)) {
      parts.push(
        'A period written as still running is drawn to the last thing the document dates, because that is as far as this document can say.'
      );
    }
    if (quiet > 0) {
      parts.push(
        `${plural(quiet, 'month')} in that span hold nothing at all, which is why the bars have gaps rather than being moved together.`
      );
    }
    parts.push(
      stats.monthPrecision > 0
        ? `${plural(stats.monthPrecision, 'entry', 'entries')} wrote a month and a year but no day, so it sits on the month and no particular day is claimed.`
        : 'Counted in code, over the whole document.'
    );
    el.timelineNote.textContent = parts.join(' ');
  } else {
    el.timelineNote.textContent =
      'Nothing in this document can be placed on a timeline — no entry writes a month and a year together.';
  }

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
  painting(el.composition, () => drawRows(el.composition, rows));
}

el.indexButton.addEventListener('click', () => void indexNow());

/* ------------------------------------------------------- while it is reading */

/** One measured point: how many notes were embedded, and how long that took. */
interface ProgressPoint {
  seconds: number;
  done: number;
}

const STAGE_WORDS: Record<string, string> = {
  reading: 'Splitting it into entries and finding its dates…',
  embedding: 'Embedding every note so it can be searched by meaning…',
  saving: 'Saving the index…',
};

/**
 * The chart that runs while the document is being read.
 *
 * 🔴 IT PLOTS MEASUREMENTS, NOT A CLOCK. George, 20 Sep 2026: *"can we show a chart while its
 * indexing?"* The points come from the server as batches of notes are actually embedded, so the
 * line is a record of what happened: a slow batch is a flat stretch, and a stall stops moving
 * altogether. A bar that filled on a timer would look the same and would be a lie — it would also
 * keep filling through exactly the failure worth noticing.
 *
 * The dashed line is the total, which is known before the first batch is sent — the note count is
 * settled by the splitter, so the chart has a real denominator rather than a guessed one.
 */
function drawProgress(canvas: HTMLCanvasElement, points: ProgressPoint[], total: number): void {
  const surface = fit(canvas);
  if (!surface) return;
  const { ctx, w, h } = surface;

  const padL = 38;
  const padR = 12;
  const padT = 10;
  const padB = 18;
  const plotW = Math.max(10, w - padL - padR);
  const plotH = Math.max(10, h - padT - padB);

  // The axis fits the run it measured. A floor of 0.4 s was wrong in the other direction: a
  // document whose notes go in as one batch finished in 0.1 s and was drawn as a line crushed
  // against the left edge, which reads as a chart that failed rather than a fast read.
  const span = Math.max(0.05, points.length > 0 ? (points[points.length - 1] as ProgressPoint).seconds : 0.05);
  const maxY = Math.max(1, total);
  const x = (seconds: number): number => padL + (seconds / span) * plotW;
  const y = (done: number): number => padT + plotH - (done / maxY) * plotH;

  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';

  // The floor and the ceiling of the little box the line lives in.
  ctx.strokeStyle = '#123037';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT + plotH + 0.5);
  ctx.lineTo(padL + plotW, padT + plotH + 0.5);
  ctx.stroke();

  ctx.fillStyle = '#6f9aa1';
  ctx.fillText(String(total), 4, y(total));
  ctx.fillText('0', 4, y(0));
  ctx.fillText('notes', 4, padT + plotH + 12);
  ctx.fillText(`${span.toFixed(1)}s`, padL + plotW - 18, padT + plotH + 12);

  // The total, as a target rather than a promise.
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#1b434b';
  ctx.beginPath();
  ctx.moveTo(padL, y(maxY));
  ctx.lineTo(padL + plotW, y(maxY));
  ctx.stroke();
  ctx.setLineDash([]);

  if (points.length === 0) return;

  ctx.strokeStyle = '#5eead4';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  points.forEach((point, at) => {
    const px = x(point.seconds);
    const py = y(point.done);
    if (at === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // The last point, so a chart that has stopped moving looks stopped rather than finished.
  const last = points[points.length - 1] as ProgressPoint;
  ctx.fillStyle = '#5eead4';
  ctx.beginPath();
  ctx.arc(x(last.seconds), y(last.done), 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.textBaseline = 'alphabetic';
}

/**
 * Read a response that arrives as a series of JSON lines.
 *
 * 🔴 ONE READER, TWO CALLERS — the index and the question. The house rule is that a second
 * implementation of the same thing is a second chance for the two to disagree, and this one has
 * already earned its place once: a line that will not parse is reported in terms of what it actually
 * is, because a proxy or an edge error page answers with HTML and a bare `response.json()` would
 * turn that into a parser complaint instead of naming what happened.
 *
 * `onEvent` is called for every line with a `type`, and the `result` line is returned.
 */
async function readJsonLines(
  response: Response,
  onEvent: (event: { type?: string; error?: string } & Record<string, unknown>) => void
): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error(`The server answered ${response.status} with no body.`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: Record<string, unknown> | null = null;
  let failure: string | null = null;

  const handle = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let event: { type?: string; error?: string } & Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      throw new Error(
        /^\s*<(!doctype|html)/i.test(trimmed)
          ? `The server answered with a web page instead of the API, so something in front of it answered: ${trimmed.slice(0, 100)}`
          : `The server sent a line this page cannot read: ${trimmed.slice(0, 100)}`
      );
    }
    if (event.type === 'result') result = event;
    else if (event.type === 'error') failure = event.error ?? 'That did not work.';
    else onEvent(event);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handle(line);
  }
  if (buffer.trim().length > 0) handle(buffer);

  if (failure) throw new Error(failure);
  if (!result) throw new Error('The server sent no result.');
  return result;
}

/**
 * Read an index that arrives as a series of JSON lines.
 *
 * 🔴 THE DOOR IS THE SAME ONE EVERY OTHER CALL USES. A missing endpoint, a proxy or an edge error
 * page all answer with something that is not JSON, and a bare `response.json()` would turn that
 * into a parser complaint instead of naming what happened — so a line that will not parse is
 * reported in terms of what it actually is.
 */
async function readIndexStream(
  response: Response,
  onProgress: (progress: { stage: string; done: number; total: number; ms: number }) => void
): Promise<Record<string, unknown>> {
  return readJsonLines(response, (event) => {
    if (event.type === 'progress') {
      onProgress(event as unknown as { stage: string; done: number; total: number; ms: number });
    }
  });
}

async function indexNow(): Promise<void> {
  clear(el.indexError);
  el.indexButton.disabled = true;
  el.indexButton.innerHTML = '<span class="spinner"></span>Indexing';

  const points: ProgressPoint[] = [];
  let total = 0;
  let note = STAGE_WORDS.reading as string;
  el.indexStat.textContent = note;
  el.indexProgressTitle.textContent = 'Reading it';
  el.indexProgressNote.textContent = note;
  el.indexChart.hidden = false;
  el.indexProgress.hidden = false;

  try {
    const response = await fetch('./api/index/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: el.paste.value }),
    });
    if (!response.ok) throw new Error(`The server answered ${response.status} before it started.`);

    const body = (await readIndexStream(response, (progress) => {
      if (progress.stage === 'embedding') {
        // 🔴 ONLY THE EMBEDDING STAGE SETS THE TOTAL, AND THAT WAS A REAL BUG FOR A MINUTE. The
        // other two stages report `1` of `1` — they are single steps — so taking the total from
        // whatever arrived last left the chart scaled to 1 while plotting 8 notes, and the axis
        // read `0` to `1` over a line that had gone off the top. The note count is settled by the
        // splitter, and only this stage knows it.
        total = progress.total;
        points.push({ seconds: progress.ms / 1000, done: progress.done });
      }
      note =
        progress.stage === 'embedding'
          ? `Embedding note ${progress.done} of ${progress.total}…`
          : (STAGE_WORDS[progress.stage] ?? 'Working…');
      el.indexStat.textContent = note;
      el.indexProgressNote.textContent = `${note} ${(progress.ms / 1000).toFixed(1)} s so far.`;
      // The box is already on screen, so `fit()` can measure it before anything is drawn.
      painting(el.indexChart, () => drawProgress(el.indexChart, points, Math.max(total, 1)));
    })) as {
      document?: DocumentView;
      reused?: boolean;
      warnings?: string[];
      error?: string;
      kindLabel?: string;
      suggestions?: string[];
      timeline?: { month: string; entries: number }[];
      spans?: Spans;
    };

    if (!body.document) throw new Error(body.error ?? 'The server sent no index.');

    current = body.document;
    // 🔴 THE SECTION IS REVEALED BEFORE ANYTHING IS DRAWN INTO IT. A canvas in a hidden section
    // has no layout, so `fit()` measured the 320-pixel fallback, drew a 320-wide bitmap, and the
    // page stretched it across the full column — 2.56× on the heat map. The order was the bug.
    // Step 2 is the READING — the panel that came back — so it appears when there is something to
    // show, not when enough text has been typed.
    el.step2.hidden = false;
    renderShape(body.document, body.timeline, body.spans);
    useSuggestions(body.kindLabel, body.suggestions);

    el.indexStat.textContent = body.reused
      ? 'This exact text was already indexed, so the existing index was reused.'
      : `Done in ${(body.document.stats.embeddingMs / 1000).toFixed(1)} s.`;

    // 🔴 THE CHART STAYS. It used to be hidden the moment the run finished — and on a short
    // document the whole read takes under a second, so what George asked to see appeared for less
    // time than it takes to look at it. It is kept as the record of the run instead: how the
    // notes went in, and how long each stage took. It sits in step 1, above the results, so it
    // costs the reader nothing who has moved on to the answer.
    el.indexProgressTitle.textContent = 'How it read it';
    el.indexProgressNote.textContent = body.reused
      ? 'Nothing to do — this exact text was already indexed.'
      : `${plural(body.document.stats.chunks, 'note')} embedded in ${(body.document.stats.embeddingMs / 1000).toFixed(1)} s. One line per batch, as it happened.`;
    // 🔴 A CHART WITH NOTHING ON IT IS NOT A CHART. On the reused path no batch is ever sent, so
    // there are no points and the axes would draw an empty box reading `0` to `1` — which looks
    // like a measurement that failed. The canvas goes; the sentence stays.
    el.indexChart.hidden = points.length === 0;

    el.shapeWarnings.innerHTML = (body.warnings ?? [])
      .map((warning) => `<div class="warn-box">${esc(warning)}</div>`)
      .join('');

    el.step3.hidden = false;
    el.step4.hidden = false;
    renderTtl(body.document);

    // 🔴 NO JUMP. This used to scroll the page down to step 3 the moment indexing finished —
    // George, 20 Sep 2026: *"after it indexes it jumps to the bottom, remove that"*. The reader
    // has just pressed a button and is looking at the chart that started moving; taking the page
    // away from them is the page deciding what to read next. The question box is focused without
    // scrolling, so it is ready to type in for anyone who does want to move on.
    el.question.focus({ preventScroll: true });
  } catch (error) {
    showError(el.indexError, error instanceof Error ? error.message : 'Indexing failed.');
    el.indexStat.textContent = '';
  } finally {
    // 🔴 THE CHART IS NOT HIDDEN HERE, AND THAT IS THE POINT. It is the record of how far the work
    // got — which is the first thing anyone wants to know when something stops, and the one thing
    // a spinner cannot tell them — and on a short document the whole run is over in well under a
    // second, so hiding it on success meant hiding it before it could be read.
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

  // 🔴 THE CHART IS SHOWN BEFORE THE FIRST BYTE COMES BACK, because the wait is the point of it.
  const stages: AskStage[] = [];
  let ticker = 0;
  el.askProgressTitle.textContent = 'Answering';
  el.askProgressNote.textContent = 'Searching the notes by meaning and by word.';
  el.askChart.hidden = false;
  el.askProgress.hidden = false;
  const paint = (): void => {
    drawAskStages(el.askChart, askRows(stages), performance.now() - startedAt);
  };
  paint();

  try {
    const response = await fetch('./api/ask/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: current.id, question: el.question.value.trim() }),
    });
    if (!response.ok) throw new Error(`The server answered ${response.status} before it started.`);

    const body = (await readJsonLines(response, (event) => {
      if (event.type !== 'progress') return;
      stages.push(event as unknown as AskStage);
      const running = stages[stages.length - 1] as AskStage;
      el.askProgressNote.textContent = askStageWords(stages, running);
      paint();
      // The running stage has no measurement inside it, so its bar grows against the clock and its
      // caption counts up — the only true things available while a model is writing.
      if (running.tookMs === undefined && ticker === 0) {
        ticker = window.setInterval(paint, 100);
      }
      if (running.tookMs !== undefined && ticker !== 0) {
        window.clearInterval(ticker);
        ticker = 0;
      }
    })) as unknown as Answer & { error?: string };

    if (ticker !== 0) window.clearInterval(ticker);
    ticker = 0;
    renderAnswer(body);
    markAnswered(performance.now() - startedAt);

    // 🔴 THE CHART STAYS, RENAMED. It is the record of how the answer was built — 40 ms of search
    // and four seconds of model is worth being able to look at afterwards, and on a fast answer it
    // would otherwise be gone before it was read. Same as the index chart.
    el.askProgressTitle.textContent = 'How the answer was built';
    const timings = (body as { timings?: AnswerTimings }).timings;
    el.askProgressNote.textContent = timings
      ? `Searched in ${timings.retrieveMs} ms, and the model took ${(timings.modelMs / 1000).toFixed(1)} s. ` +
        `The whole question took ${(timings.totalMs / 1000).toFixed(1)} s.`
      : 'Done.';
    drawAskStages(el.askChart, askRows(stages), Math.max(...stages.map((stage) => stage.ms), 1));
  } catch (error) {
    if (ticker !== 0) window.clearInterval(ticker);
    ticker = 0;
    showError(el.askError, error instanceof Error ? error.message : 'The question failed.');
  } finally {
    el.askButton.disabled = false;
    el.askButton.textContent = 'Ask';
  }
}

/**
 * What to say while the answer is being built — the stage, in words, with its numbers.
 *
 * A finished stage gets its measured time; the model gets the clock and the words *"still running"*,
 * because that is all that is true until it returns.
 */
function askStageWords(stages: AskStage[], running: AskStage): string {
  const search = stages.find((stage) => stage.stage === 'search');
  const found = search?.found ?? 0;
  const kept = search?.kept ?? 0;
  if (running.stage === 'search') return 'Searching the notes by meaning and by word.';
  if (running.stage === 'notes') {
    if (running.silent) {
      return 'Nothing in the document matched closely enough, so no model was called.';
    }
    return found > 0
      ? `Found ${plural(found, 'note')} and kept ${kept} of them. Reading them now.`
      : 'Chose the notes to read.';
  }
  if (running.stage === 'model') {
    const startedAt = running.ms;
    return running.tookMs === undefined
      ? `The model is writing the answer — ${((performance.now() - startedAt) / 1000).toFixed(1)} s so far.`
      : `The model took ${(running.tookMs / 1000).toFixed(1)} s.`;
  }
  return 'Working.';
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

  // 🔴 THE THIRD BOX. George, 20 Sep 2026: *"The dates it rests on and Places can we add one
  // more box, then space them out in one row max width"*. Dates and places are only there when
  // the answer happens to rest on them, so a question about the weather gave two boxes with a
  // gap where the third belonged. **The notes themselves are always there** — an answer with no
  // notes is a refusal — so this box always has something true in it, and it is the next thing a
  // reader wants after the dates: which notes, exactly, this came from.
  if (sources.length > 0) {
    boxes.push(
      detailBox(
        'The notes it used',
        `<div class="chips">${sources
          .map((source) => `<span class="chip">${esc(source.label)}</span>`)
          .join('')}</div>`
      )
    );
  }

  boxes.push(
    `<div class="detail wide">
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
  if (scores) painting(scores, () => drawScores(scores, sources));

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
      if (currentSpans) painting(el.timeline, () => drawSpans(el.timeline, currentSpans as Spans));
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
      // 🔴 `provider` IS THE SHAPE OF THE API, NOT THE COMPANY BEHIND THE MODEL. It read
      // `model: @cf/meta/llama-3.1-8b-instruct-fp8 for answers, @cf/baai/bge-m3 for search ·
      // openai` — which tells a reader that OpenAI answers the questions, and it does not: those
      // are Cloudflare Workers AI models behind an OpenAI-shaped endpoint. Two of the three
      // words are factual and the third invited a wrong conclusion, on a page whose whole claim
      // is that it says exactly what it is. Labelled, the same string is true.
      where.innerHTML =
        `<div class="statline">Answers come from <b>${esc(body.chatModel ?? '?')}</b>, ` +
        `search uses <b>${esc(body.embedModel ?? '?')}</b> · API: <b>${esc(body.provider ?? '?')}</b>` +
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
