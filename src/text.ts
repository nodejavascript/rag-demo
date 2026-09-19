/**
 * Turning whatever was pasted into one plain text, without losing what matters.
 *
 * Three kinds of thing arrive here: an article copied out of a page (HTML), a
 * document written in markdown, and plain prose. All three become the same plain
 * text, because everything downstream — the chunker, the dates, the search — works
 * on plain text and nothing else.
 *
 * The one thing deliberately NOT thrown away is an image reference. A picture is
 * often the detail an answer is asked for, so `![alt](url)` and `<img src>` are
 * lifted out into a list before the body is flattened, and the body keeps a small
 * marker in their place so the reader can still see where the picture sat.
 */

import type { ImageRef } from './types.js';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201d',
  ldquo: '\u201c',
  deg: '\u00b0',
  eacute: '\u00e9',
  egrave: '\u00e8',
  agrave: '\u00e0',
  ccedil: '\u00e7',
};

/** Decode the handful of entities that actually turn up, and any numeric one. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** True when the text is really a fragment of a page rather than prose. */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 4000);
  const tags = head.match(/<\/?(p|div|br|h[1-6]|li|ul|ol|table|tr|td|span|img|a|section|article)\b/gi);
  return (tags?.length ?? 0) >= 3;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp)(\?[^\s)]*)?$/i;

function absolutise(url: string, base: string | null): string {
  const clean = url.trim().replace(/^['"]|['"]$/g, '');
  if (/^(https?:|data:image\/)/i.test(clean)) return clean;
  if (clean.startsWith('//')) return `https:${clean}`;
  if (!base) return clean;
  try {
    return new URL(clean, base).href;
  } catch {
    return clean;
  }
}

/**
 * Every picture the document points at.
 *
 * A URL is required — a caption alone is not enough to render anything, and
 * inventing a search for "Figure 3" would be guessing. Bare URLs that end in an
 * image extension are accepted too, because that is how a picture pasted out of a
 * chat window arrives.
 */
export function extractImages(text: string, base: string | null = null): ImageRef[] {
  const found: { image: ImageRef; at: number }[] = [];
  const push = (url: string | null, caption: string | null, at: number): void => {
    found.push({
      image: { url, caption: caption ? decodeEntities(caption).trim() || null : null, entryIndex: -1 },
      at,
    });
  };

  // HTML <img>, whichever attribute order.
  for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const alt = /\balt\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const title = /\btitle\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const raw = src?.[2] ?? src?.[3] ?? src?.[4] ?? '';
    if (!raw) continue;
    push(absolutise(raw, base), alt?.[2] ?? alt?.[3] ?? alt?.[4] ?? title?.[2] ?? title?.[3] ?? title?.[4] ?? null, match.index ?? 0);
  }

  // Markdown ![alt](url "title")
  for (const match of text.matchAll(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g)) {
    push(absolutise(match[2] ?? '', base), match[1] || match[3] || null, match.index ?? 0);
  }

  // A bare URL that is plainly an image.
  for (const match of text.matchAll(/https?:\/\/[^\s<>()"']+/gi)) {
    const url = match[0].replace(/[.,;:]+$/, '');
    if (IMAGE_EXT.test(url)) push(url, null, match.index ?? 0);
  }

  // In the order the document writes them, and one entry per picture.
  //
  // 🔴 Both of these matter and both were wrong. Reading the three patterns in turn put
  // an HTML image before a markdown one that appeared earlier on the page, so the list
  // did not follow the document; and because the same URL is usually written twice —
  // once as markdown and once as a bare link — the same picture was reported twice.
  //
  // De-duplication is by URL, and where the same picture arrived twice the one with a
  // caption wins, because the caption is the part worth keeping. The position is the
  // first place the picture appeared.
  const ordered = found.sort((a, b) => a.at - b.at).map((entry) => entry.image);
  const byUrl = new Map<string, ImageRef>();
  const out: ImageRef[] = [];
  for (const image of ordered) {
    const key = image.url ?? `caption:${image.caption ?? ''}`;
    const existing = byUrl.get(key);
    if (existing) {
      if (!existing.caption && image.caption) existing.caption = image.caption;
      continue;
    }
    byUrl.set(key, image);
    out.push(image);
  }
  return out;
}

/** Replace picture syntax with a short marker, so the body still reads in order. */
function replaceImages(text: string): string {
  return text
    .replace(/<img\b[^>]*>/gi, ' [image] ')
    .replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (_w, alt: string) =>
      alt ? ` [image: ${alt}] ` : ' [image] '
    );
}

/** Turn a page into prose: block tags become newlines, then all tags go. */
function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = replaceImages(text);
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|figure)>/gi, '\n\n');
  text = text.replace(/<(li|tr)\b[^>]*>/gi, '\n');
  text = text.replace(/<h([1-6])\b[^>]*>/gi, '\n\n');
  text = text.replace(/<td\b[^>]*>/gi, ' \u00b7 ');
  text = text.replace(/<[^>]+>/g, ' ');
  return decodeEntities(text);
}

/** Collapse runs of blank lines and stray spaces without destroying paragraphs. */
export function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

export interface PreparedText {
  /** The plain text everything downstream reads. */
  text: string;
  /** Were the tags stripped, so the reader can be told? */
  fromHtml: boolean;
  /** Every picture the document pointed at, in document order. */
  images: ImageRef[];
}

/** The one entry point: any paste, one plain text. */
export function prepare(input: string): PreparedText {
  const raw = typeof input === 'string' ? input : '';
  const fromHtml = looksLikeHtml(raw);
  const images = extractImages(raw);
  const plain = fromHtml ? htmlToText(raw) : replaceImages(raw);
  return { text: normaliseWhitespace(plain), fromHtml, images };
}

/** A document's title: the first heading, else the first real line. */
export function guessTitle(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    const value = (heading?.[1] ?? trimmed).replace(/^\*{1,2}|\*{1,2}$/g, '').trim();
    if (value.length < 3) continue;
    return value.length > 90 ? `${value.slice(0, 87)}\u2026` : value;
  }
  return 'Untitled document';
}

/** Split into paragraphs on blank lines, keeping the offsets they sat at. */
export interface Block {
  text: string;
  start: number;
  end: number;
}

export function blocks(text: string): Block[] {
  const out: Block[] = [];
  const pattern = /\n\s*\n/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const slice = text.slice(cursor, match.index);
    if (slice.trim()) out.push({ text: slice, start: cursor, end: match.index });
    cursor = match.index + match[0].length;
  }
  const tail = text.slice(cursor);
  if (tail.trim()) out.push({ text: tail, start: cursor, end: text.length });
  return out;
}

/** One line of a block, with its absolute offset. */
export interface Line {
  text: string;
  start: number;
}

export function lines(block: Block): Line[] {
  const out: Line[] = [];
  let cursor = 0;
  for (const piece of block.text.split('\n')) {
    out.push({ text: piece, start: block.start + cursor });
    cursor += piece.length + 1;
  }
  return out;
}

/**
 * A line that could be a heading: short, unpunctuated, not a sentence.
 *
 * On its own this is only a CANDIDATE. Whether it really is one depends on what is
 * beneath it, and that judgement is made where the whole document can be seen.
 */
export function looksLikeHeadingCandidate(line: string): boolean {
  const value = line.trim();
  if (!value || value.length > 80) return false;
  if (/[.!?]$/.test(value)) return false;
  if (/^#{1,6}\s+/.test(value)) return true;
  return /^[A-Z0-9][^.!?]*:?$/.test(value) && value.split(/\s+/).length <= 10;
}

/** True when the line ends a sentence. */
export function endsInPunctuation(line: string | null): boolean {
  return line !== null && /[.!?]$/.test(line.trim());
}

/** True when a block reads as prose rather than as a list of fragments. */
export function containsProse(text: string): boolean {
  return /[.!?](\s|$)/.test(text);
}

/**
 * A heading, judged by the line beneath it.
 *
 * The rule that matters — and the one that was got wrong once already — is that **the
 * line beneath must end in `.`, `?` or `!`**. Without it a document of short
 * standalone lines (a set of terms, an agenda, a poem) is split into one entry per
 * line with empty bodies, and most of the text disappears. A paragraph ends in a full
 * stop; a fragment does not.
 */
export function isHeading(line: string, next: string | null): boolean {
  return looksLikeHeadingCandidate(line) && endsInPunctuation(next);
}

/** Strip the heading markers, so a label reads cleanly on the page. */
export function cleanHeading(line: string): string {
  return line.replace(/^#{1,6}\s+/, '').replace(/^\*\*|\*\*$/g, '').replace(/:$/, '').trim();
}
