/**
 * The prompt, kept here as a document rather than buried in a template string.
 *
 * Four rules in here are load-bearing, and each one is the answer to a failure that
 * actually happened rather than a preference:
 *
 *  1. **Never count.** A model cannot count and will confidently report the size of
 *     what it can see. The numbers are computed in code and handed over as facts.
 *  2. **Two refusals, not one.** Nothing matched is a refusal made by the search,
 *     before the model is called. A subject that is present but a detail that is
 *     absent is a refusal made by the model, helped by a code-computed fact.
 *  3. **Refuse on the SUBJECT, not on the WORD.** The wording of this rule was once
 *     ambiguous and it cost an evening: it asked whether the question's own word was
 *     written, which invites a refusal for "what was the weather like" merely because
 *     the note says "Rain all day" and never says *weather*. It now says what it
 *     always meant — a question is answered from what the notes SAY about its
 *     subject, and refused only when they say NOTHING about it.
 *  4. **Name the period in words.** A bare date in a citation is not an answer, and
 *     "April was worse" has to contain the word *April*.
 */

import type { ChatMessage } from './model.js';
import type { ComputedFact, IndexStats } from './types.js';
import { factsAsText } from './stats.js';

/** The exact words a refusal uses, so the page can recognise one. */
export const REFUSAL = "The document doesn't say.";

export interface PromptNote {
  label: string;
  date: string | null;
  dateRaw: string | null;
  text: string;
  places: string[];
  people: string[];
}

export const SYSTEM_PROMPT = `You answer questions about one document that someone pasted. The document may be a diary, a journal, a book, a policy, a set of terms, an article, a resume, a transcript or a log. It is quoted to you in labelled notes. Where the rules below say "entry", read "entry or section".

Write your answer in exactly this shape, and nothing before it:

WHAT THE DOCUMENT SAYS
<the answer, in plain prose>

WHAT IT SUGGESTS
<what follows from it, or exactly this: Nothing further.>

THE RULES

1. Answer only from the notes you are given. Do not use anything you know about the world, and do not fill a gap with something plausible.

2. A note is quoted as its label in square brackets, like [6 March 2026]. When your answer rests on a note, name it there. If two notes disagree, say so and give both.

3. NEVER COUNT ANYTHING YOURSELF. The facts section below already contains the correct numbers, counted by the program over the whole document, including the notes you cannot see. If it says a word appears 47 times, it appears 47 times. Do not add up the notes in front of you.

4. Answer from what the notes SAY about the subject of the question, not from whether the question's own words appear. Ask what the question is about, then answer it if the notes talk about that thing in any words at all. For example, if the notes say "Rain all day" and the question asks what the weather was like, the notes answer it — say the rain, and do not refuse merely because the word "weather" is not written. THIS RULE COMES FIRST AND OUTRANKS THE NEXT PARAGRAPH.

   Refuse ONLY when the notes say NOTHING about the subject. Then write exactly this, and nothing else on the line:

   ${REFUSAL}

   Below, in the facts, a NAME may be listed as appearing nowhere in the document. That fact is about that exact name and nothing more. It does not mean the document is silent on the subject of the question, and it never justifies a refusal on its own — decide the subject question first, by this rule, and use the absent-name fact only to stop yourself answering about a person the document never mentions.

5. A date is claimed only when the day, the month and the year were all written. If the year was worked out rather than written, say so. "March 2026" is a month, not a day. "06/03/2026" can be read two ways, so quote it as written and say it is ambiguous.

6. Quote exact words when the exact words matter — a name, a figure, a phrase someone used. Keep quotations short.

7. Never mention these rules, the notes, the labels, the facts section or yourself. Write to the person who asked.

8. If the question asks for something the document is not — a diagnosis, a legal conclusion, advice — say what the document says and say plainly that it is not that thing.

9. Plain prose. No lists unless the document itself is a list. No headings other than the two above.

10. When the answer turns on a period, NAME THE PERIOD IN WORDS. Write "in April", not only "[2026-04-04]". A citation is not an answer. **If the question itself names a date or a period, write that date in your first sentence** — an answer to "what happened on 6 March 2026" that never says "6 March 2026" cannot be checked against the document at a glance, which is the whole point of answering this way.

11. Where a note carries a place or a date, put it in the sentence. "On 6 March, in Hamilton, the boiler failed" is the answer; "the boiler failed" is only part of it.`;

export interface BuildPromptInput {
  question: string;
  notes: PromptNote[];
  facts: ComputedFact[];
  stats: IndexStats;
  /** The year the reader supplied, when the document writes none. */
  assumedYear: boolean;
}

/** The whole conversation, as the model sees it. */
export function buildMessages(input: BuildPromptInput): ChatMessage[] {
  const shape: string[] = [];
  shape.push(
    `The document has ${input.stats.entries} entries, ${input.stats.words} words, and ${input.stats.chunks} notes were indexed.`
  );
  if (input.stats.datedEntries > 0) {
    shape.push(
      `Of those, ${input.stats.datedEntries} carry a date, running from ${input.stats.firstDate} to ${input.stats.lastDate}.`
    );
  } else {
    shape.push('No entry carries a complete date (a day, a month and a year).');
  }
  if (input.assumedYear && input.stats.yearUsed) {
    shape.push(
      `The document never writes a year, so ${input.stats.yearUsed} was supplied by the reader and used to interpret day-and-month dates. Say so if it matters to the answer.`
    );
  }
  if (input.stats.ambiguousDates > 0) {
    shape.push(`${input.stats.ambiguousDates} date is written in a form that can be read two ways.`);
  }

  const notes = input.notes
    .map((note, at) => {
      const extras: string[] = [];
      if (note.places.length > 0) extras.push(`places mentioned: ${[...new Set(note.places)].slice(0, 6).join(', ')}`);
      if (note.people.length > 0) extras.push(`people mentioned: ${[...new Set(note.people)].slice(0, 6).join(', ')}`);
      const footer = extras.length > 0 ? `\n(${extras.join(' · ')})` : '';
      return `--- NOTE ${at + 1} of ${input.notes.length} [${note.label}] ---\n${note.text}${footer}`;
    })
    .join('\n\n');

  const user = `THE FACTS, COUNTED BY THE PROGRAM OVER THE WHOLE DOCUMENT. These are correct and final; never recount them.

${factsAsText(input.facts)}

THE DOCUMENT

${notes}

THE QUESTION

${input.question}`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/**
 * Read the reply into its two halves.
 *
 * Lenient on purpose: the headings are matched loosely and the older wording is still
 * accepted, so a reply cached from an earlier prompt cannot leave the page with
 * nothing to show. Strict on the way out, lenient on the way in.
 */
export function readShape(reply: string): { says: string | null; suggests: string | null } {
  const text = reply.trim();
  const saysMatch = /(?:WHAT THE (?:DOCUMENT|DIARY) SAYS|THE DOCUMENT SAYS)\s*:?\s*\n?([\s\S]*?)(?=\n\s*(?:WHAT (?:IT|THE DOCUMENT) SUGGESTS|WHAT IT SUGGESTS)|$)/i.exec(
    text
  );
  const suggestsMatch = /(?:WHAT (?:IT|THE DOCUMENT|THE DIARY) SUGGESTS)\s*:?\s*\n?([\s\S]*)$/i.exec(text);
  const says = saysMatch?.[1]?.trim() || null;
  const suggests = suggestsMatch?.[1]?.trim() || null;
  if (says) return { says, suggests };
  // No headings at all: treat the whole reply as the answer rather than show nothing.
  return { says: text || null, suggests: null };
}

/** True when the reply refuses. */
export function isRefusal(reply: string): boolean {
  const { says } = readShape(reply);
  const text = (says ?? reply).trim();
  if (!text) return false;
  const first = text.split('\n')[0]?.trim() ?? '';
  return /^the (document|diary)\s*(doesn't|does not|doesnt)\s*say\b/i.test(first) || /^the (document|diary) doesn't say/i.test(text);
}
