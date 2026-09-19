/**
 * The words a question uses, mapped to the words a document uses.
 *
 * 🔴 WHY THIS EXISTS — and it exists because of a real answer that was wrong, and then a
 * real answer that was refused.
 *
 * The app was asked **"Where did he go to school?"** about a resume whose only mention of
 * the subject is a section reading **EDUCATION**. The question shares no content word with
 * the document. The note holding the answer therefore did not reach the eight notes shown
 * to the model — and the model, shown no education note, refused. **The refusal was
 * correct; the retrieval was wrong.**
 *
 * The same fault produced a wrong answer in the other direction. Asked **"Who does he work
 * for now?"**, the app offered the model an entry whose dates read `01/2000 - 08/2026` and
 * never showed it the entry reading `09/2026 - Present` — the one that answers the
 * question — so the model named an employer whose contract had ended.
 *
 * **A document is entitled to its own words; a question is not asked in them.** This is a
 * declared, finite list of the substitutions that matter for the documents this app is
 * built for — a diary, a resume, a report, minutes, terms. It is used **ONLY to widen the
 * lexical (word) search**, never the embedding: widening the embedding would move the
 * meaning, and the refusal floor is a measurement of meaning, so moving it would make the
 * floor a lie.
 *
 * ⚠️ **What adding a term here can and cannot do.** It can offer the model one more note to
 * read. It can never make the model say something a note does not say. That is the whole
 * safety argument, and it is why this list is allowed to be a list of guesses.
 */

interface IntentRule {
  /** The words a question uses. */
  match: RegExp;
  /** The words the document may use instead. Searched in ADDITION, never instead. */
  terms: string[];
  /** Why this substitution is here, so the next reader does not delete it. */
  because: string;
}

const RULES: IntentRule[] = [
  {
    match: /\b(?:school|schooling|study|studies|studied|educat\w*|degree|diploma|graduat\w*|alma mater|university|college)\b/i,
    terms: ['education', 'college', 'university', 'school', 'degree', 'diploma', 'studies'],
    because:
      'a resume heads this subject EDUCATION and names an institution, so the word "school" can appear nowhere in the document that answers it',
  },
  {
    match: /\b(?:now|current\w*|present\w*|today|these days|at the moment|still)\b/i,
    terms: ['present', 'current', 'ongoing', 'date'],
    because:
      'a resume writes a continuing role as "Present", and "now" appears in no document — without this the current entry is not offered at all',
  },
  {
    match: /\b(?:job|jobs|employ\w*|work\w*|career|position|role)\b/i,
    terms: ['experience', 'employment', 'career', 'consultant', 'developer', 'manager', 'engineer'],
    because:
      'a resume heads this subject PROFESSIONAL EXPERIENCE and names roles; the word "job" is usually absent',
  },
  {
    match: /\b(?:live[sd]?|living|reside[sd]?|residence|home|address|located|location|based|move[sd]?)\b/i,
    terms: ['address', 'residence', 'living', 'based', 'located', 'city'],
    because: 'a place is written next to a person, not next to the word "live"',
  },
  {
    match: /\b(?:born|birth\w*|birthday|age)\b/i,
    terms: ['born', 'birth', 'date of birth'],
    because: 'a date of birth is written once, in a line that does not use the question word',
  },
  {
    match: /\b(?:marri\w*|spouse|husband|wife|partner|separat\w*|divorc\w*)\b/i,
    terms: ['married', 'marriage', 'spouse', 'husband', 'wife', 'separated', 'separation', 'divorce'],
    because: 'a diary says "we separated"; the question says "divorce"',
  },
  {
    match: /\b(?:paid|pay|cost\w*|price|amount|salary|wage|fee|bill|spent|spend)\b/i,
    terms: ['paid', 'cost', 'price', 'fee', 'total', 'deposit', 'balance'],
    because: 'an amount is written next to a thing, not next to the word "amount"',
  },
  {
    match: /\b(?:contact\w*|reach|email|phone|telephone|call)\b/i,
    terms: ['email', 'phone', 'telephone', 'mobile', 'address'],
    because: 'the details are written as values, and the question names the kind of value',
  },
];

/**
 * Extra terms to search for, given a question. Empty when the question uses no word this
 * list knows about, which is the common case and costs nothing.
 */
export function expandQuery(question: string): string[] {
  const extra: string[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    if (!rule.match.test(question)) continue;
    for (const term of rule.terms) {
      const clean = term.toLowerCase();
      if (seen.has(clean)) continue;
      seen.add(clean);
      extra.push(clean);
    }
  }
  return extra;
}

/** The rules, for the page to show and for a test to enumerate. */
export function intentRules(): { because: string; terms: string[] }[] {
  return RULES.map((rule) => ({ because: rule.because, terms: [...rule.terms] }));
}
