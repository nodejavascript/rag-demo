/**
 * Facts counted in code, over the WHOLE document.
 *
 * This file exists because of one measured failure: the first version of a tool like
 * this handed the model "47 of 263 entries" and it answered **"7"** — it counted the
 * eight notes it could see and reported that as the answer. A model cannot count, so
 * it must not be asked to. Every number a reader is shown is computed here, and the
 * prompt says plainly that the numbers are already right.
 *
 * The other half is the **absence** fact. "What is Cecilia's maiden name?" is a hard
 * question for retrieval, because a note that merely mentions Cecilia scores well and
 * the model will happily answer from it. Telling the model, as a fact, that the name
 * appears nowhere in the document is what stops that.
 */

import { monthLabel } from './dates.js';
import { countWords } from './chunk.js';
import { MONTH_NAMES } from './dates.js';
import type { ComputedFact, Entry } from './types.js';

/** Words that carry no subject, so counting them would be counting noise. */
const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','than','that','this','these','those','there','their','they','them',
  'is','are','was','were','be','been','being','am','do','does','did','doing','have','has','had','having',
  'i','me','my','mine','we','us','our','ours','you','your','yours','he','him','his','she','her','hers','it',
  'its','who','whom','whose','what','which','when','where','why','how','all','any','both','each','few','more',
  'most','other','some','such','no','nor','not','only','own','same','so','too','very','can','will','just','don',
  'should','now','about','into','over','after','before','between','during','under','again','further','once',
  'here','from','up','down','out','off','on','in','at','to','of','for','with','by','as','was','were','also',
  'many','much','often','long','short','did','does','tell','say','says','said','write','written','mention',
  'mentioned','document','note','notes','entry','entries','ask','question','answer','between','compare',
  'compared','worse','better','best','worst','first','last','start','end','give','show','name','names',
  'like','want','need','know','think','going','thing','things','time','times','people','person','place',
  'places','day','days','year','years','month','months','week','weeks','weather','much','anything',
]);

/** The words a question is actually about. */
export function subjectTerms(question: string, limit = 6): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of question.toLowerCase().matchAll(/[\p{L}\p{N}'\u2019-]{2,}/gu)) {
    // A possessive is the same subject as the bare word: "Cecilia's maiden name" is a
    // question about Cecilia, and leaving the `'s` on stopped the absent-fact from
    // ever matching the name it was computed for.
    const term = match[0].replace(/(?:['\u2019]s|['\u2019-]+)$/, '');
    if (term.length < 3 || STOPWORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= limit) break;
  }
  return terms;
}

/**
 * The words in the question that are written as PROPER NOUNS.
 *
 * Only these may produce an "appears nowhere" fact, and that restriction is the fix
 * for a real failure. Asked *"what was the weather like in March?"* the tool used to
 * report that **"weather" appears nowhere in the document** — true of the word, and
 * completely misleading, because an entry reads *"Rain all day"*. The model saw a
 * fact saying the word was absent, believed it, and refused a question the document
 * plainly answers. A name is different: *"Cecilia"* appearing nowhere is a fact
 * worth asserting, because a name has no synonyms and nobody describes Cecilia as
 * "the tall one" while meaning her.
 */
export function properNouns(question: string): string[] {
  const out: string[] = [];
  for (const match of question.matchAll(/\b\p{Lu}[\p{L}'\u2019.-]*/gu)) {
    // A capital at the very start is just the sentence beginning.
    if ((match.index ?? 0) === 0) continue;
    out.push(match[0].toLowerCase().replace(/['\u2019]s$/, ''));
  }
  return out;
}

function countIn(text: string, term: string): number {
  const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w{0,3}\\b`, 'gi');
  return (text.match(pattern) ?? []).length;
}

/** Which months the question is asking about, by name. */
function monthsIn(question: string): number[] {
  const lower = question.toLowerCase();
  const found: number[] = [];
  MONTH_NAMES.forEach((name, at) => {
    const short = name.slice(0, 3).toLowerCase();
    if (new RegExp(`\\b(${name.toLowerCase()}|${short})\\b`).test(lower)) found.push(at + 1);
  });
  return found;
}

/**
 * The facts that bear on this question, in the order they should be shown.
 *
 * `docText` is the whole document, not the retrieved notes — a count taken over the
 * notes would be the very mistake this file was written to prevent.
 */
export function factsFor(question: string, entries: Entry[], docText: string): ComputedFact[] {
  const out: ComputedFact[] = [];

  // The range, always. It costs nothing and it frames every other answer.
  const dated = entries.filter((entry) => entry.date !== null);
  if (dated.length > 0) {
    out.push({
      kind: 'date-range',
      value: `${dated[0]?.date} to ${dated[dated.length - 1]?.date}`,
      first: dated[0]?.date ?? null,
      last: dated[dated.length - 1]?.date ?? null,
      entries: dated.length,
    });
  }

  const proper = new Set(properNouns(question));

  for (const term of subjectTerms(question)) {
    const hits = entries.filter((entry) => new RegExp(`\\b${term}`, 'i').test(entry.text));
    const occurrences = countIn(docText, term);
    if (occurrences === 0) {
      // The fact that stops an answer being invented from a note that merely shares
      // a word with the question — asserted only for a proper noun, never for a
      // common one, so it can never overturn an answer the notes really do give.
      if (proper.has(term)) out.push({ kind: 'absent', term, value: 0 });
      continue;
    }
    out.push({
      kind: 'count',
      term,
      value: occurrences,
      entries: hits.length,
      first: hits[0]?.date ?? null,
      last: hits[hits.length - 1]?.date ?? null,
    });
  }

  // A comparison the reader asked for cannot be answered by retrieval — no model
  // sees every entry. So the comparison's raw material is counted here.
  const months = monthsIn(question);
  const compares = /\b(worse|better|best|worst|compared|versus|more|less|most|least)\b/i.test(question);
  if (months.length > 0 && (compares || months.length > 1)) {
    for (const month of months) {
      const inMonth = dated.filter((entry) => Number(entry.date?.slice(5, 7)) === month);
      const words = inMonth.reduce((sum, entry) => sum + countWords(entry.text), 0);
      const distinct = new Set<string>();
      for (const entry of inMonth) {
        for (const match of entry.text.toLowerCase().matchAll(/[\p{L}']{4,}/gu)) distinct.add(match[0]);
      }
      out.push({
        kind: 'months',
        term: MONTH_NAMES[month - 1] ?? String(month),
        value: `${inMonth.length} entries, ${words} words, ${distinct.size} distinct long words`,
        entries: inMonth.length,
      });
    }
  }

  return out;
}

/** The facts as sentences the model can read, and cannot misread as its own sums. */
export function factsAsText(facts: ComputedFact[]): string {
  if (facts.length === 0) return 'None.';
  const lines = facts.map((fact) => {
    switch (fact.kind) {
      case 'date-range':
        return `- The dated entries run from ${fact.first} to ${fact.last} (${fact.entries} dated entries).`;
      case 'count':
        return (
          `- "${fact.term}" appears ${fact.value} times, in ${fact.entries} entries` +
          (fact.first ? `, first ${fact.first} and last ${fact.last}` : '') +
          '.'
        );
      case 'absent':
        return `- "${fact.term}" appears NOWHERE in the document. Not once.`;
      case 'months':
        return `- ${fact.term}: ${fact.value}.`;
      default:
        return `- ${fact.kind}: ${String(fact.value)}`;
    }
  });
  return lines.join('\n');
}

export { monthLabel };
