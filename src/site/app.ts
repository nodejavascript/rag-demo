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
  mentions: { places: Mention[]; people: Mention[]; amounts: Mention[] };
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

interface Answer {
  question: string;
  raw: string;
  prose: string;
  mode: 'grounded' | 'refused';
  sources: Source[];
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

function clear(where: HTMLElement): void {
  where.innerHTML = '';
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

const COLOURS = ['#a78bfa', '#7c5cff', '#60a5fa', '#34d399', '#fbbf24', '#fb7185', '#f472b6', '#38bdf8'];

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
    ctx.fillStyle = '#6c6489';
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
      ctx.fillStyle = '#edeaf8';
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(point.value), x + barW / 2, y - 5);
      ctx.textAlign = 'left';
    }
  });

  // Axis labels, at most one in every 34 pixels of width.
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 34))));
  ctx.fillStyle = '#8f87ad';
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
    ctx.fillStyle = '#6c6489';
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

    ctx.fillStyle = '#c3bcdd';
    ctx.font = '11.5px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const label = row.label.length > 17 ? `${row.label.slice(0, 16)}\u2026` : row.label;
    ctx.fillText(label, 0, y + rowH / 2);

    ctx.fillStyle = '#221939';
    ctx.beginPath();
    ctx.roundRect(labelW, y + 3, plotW, barH, barH / 2);
    ctx.fill();

    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.roundRect(labelW, y + 3, barW, barH, barH / 2);
    ctx.fill();

    ctx.fillStyle = '#edeaf8';
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

/* ------------------------------------------------------------------ state */

let current: DocumentView | null = null;

const el = {
  paste: $<HTMLTextAreaElement>('paste'),
  year: $<HTMLInputElement>('year'),
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
};

/* ------------------------------------------------------------------ step 1 */

function updatePasteStat(): void {
  const text = el.paste.value;
  el.step2.hidden = text.trim().length < 200;
  if (text.trim().length === 0) {
    el.pasteStat.textContent = 'Nothing pasted yet.';
    return;
  }
  const words = (text.match(/[\p{L}\p{N}'\u2019-]+/gu) ?? []).length;
  const lines = text.split('\n').length;
  el.pasteStat.innerHTML =
    `<b>${text.length.toLocaleString()}</b> characters · <b>${words.toLocaleString()}</b> words · ` +
    `<b>${lines.toLocaleString()}</b> lines` +
    (text.trim().length < 200 ? ' · <b>too short to index yet</b>' : ' · ready to index');
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
      const body = (await response.json()) as { text?: string; error?: string };
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

$('clear').addEventListener('click', () => {
  el.paste.value = '';
  updatePasteStat();
  current = null;
  el.step2.hidden = true;
  el.step3.hidden = true;
  el.step4.hidden = true;
  el.shape.hidden = true;
});

/* ------------------------------------------------------------------ step 2 */

function card(key: string, value: string, unit: string): string {
  return `<div class="card"><div class="k">${esc(key)}</div><div class="v">${esc(value)}</div><div class="u">${esc(unit)}</div></div>`;
}

function renderShape(document: DocumentView): void {
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

  const perMonth = stats.perMonth.map((point) => ({ label: point.month.slice(2), value: point.entries }));
  drawColumns(el.timeline, perMonth);
  el.timelineNote.textContent =
    perMonth.length > 0
      ? `Entries per month across ${plural(perMonth.length, 'month')}` +
        (stats.firstDate ? `, from ${stats.firstDate} to ${stats.lastDate}` : '') +
        (stats.monthPrecision > 0
          ? `. ${plural(stats.monthPrecision, 'entry', 'entries')} wrote a month and a year but no day, so it sits on the month and no particular day is claimed.`
          : '. Counted by the program, over the whole document.')
      : 'Nothing in this document can be placed on a timeline — no entry writes a month and a year together.';

  void renderComposition(document);
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
    const year = el.year.value.trim();
    const response = await fetch('./api/index', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: el.paste.value, year: year ? Number(year) : null }),
    });
    const body = (await response.json()) as {
      document?: DocumentView;
      reused?: boolean;
      warnings?: string[];
      error?: string;
    };
    if (!response.ok || !body.document) throw new Error(body.error ?? `The server answered ${response.status}.`);

    current = body.document;
    renderShape(body.document);

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
    el.indexButton.disabled = false;
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
    const body = (await response.json()) as { deleted?: boolean };
    el.deleteStat.textContent = body.deleted
      ? 'Deleted — the entries, the notes, the embeddings and the text are all gone.'
      : 'It had already gone.';
    current = null;
    el.step3.hidden = true;
    el.shape.hidden = true;
    el.paste.value = '';
    updatePasteStat();
  } catch {
    el.deleteStat.textContent = 'The delete did not go through. Try again.';
  } finally {
    el.deleteButton.disabled = false;
  }
}

/* ------------------------------------------------------------------ step 3 */

const SUGGESTIONS = [
  'What is this document about?',
  'What happened first, and what happened last?',
  'Which month was busiest?',
  'Where do the events take place?',
  'Who is mentioned most?',
];

function renderSuggestions(): void {
  el.suggestions.innerHTML = SUGGESTIONS.map(
    (text, at) => `<button type="button" class="ghost" data-q="${esc(text)}" data-at="${at}">${esc(text)}</button>`
  ).join('');
  for (const button of el.suggestions.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      el.question.value = (button as HTMLButtonElement).dataset.q ?? '';
      void askNow();
    });
  }
}
renderSuggestions();

el.askButton.addEventListener('click', () => void askNow());
el.question.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void askNow();
});

async function askNow(): Promise<void> {
  if (!current || !el.question.value.trim()) {
    el.question.focus();
    return;
  }
  clear(el.askError);
  el.askButton.disabled = true;
  el.askButton.innerHTML = '<span class="spinner"></span>Reading';

  try {
    const response = await fetch('./api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: current.id, question: el.question.value.trim() }),
    });
    const body = (await response.json()) as Answer & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `The server answered ${response.status}.`);
    renderAnswer(body);
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

function renderAnswer(answer: Answer): void {
  el.answerWrap.hidden = false;
  el.answerQ.innerHTML = `<b>You asked:</b> ${esc(answer.question)}`;

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
      <p style="margin:0 0 8px;font-size:12.5px;color:#8f87ad">${
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
    const body = (await response.json()) as {
      ok?: boolean;
      model?: string;
      provider?: string;
      chatModel?: string;
      embedModel?: string;
    };
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
