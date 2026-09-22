/**
 * What kind of document this is, and what is worth asking it.
 *
 * WHY THIS EXISTS. The page offered five example questions, and they were written for a
 * diary: *"Which month was busiest?"* is a good question about a diary and a nonsense one
 * about a resume. A reader who pastes a resume and is offered *"Who is mentioned most?"*
 * learns something false about the tool — that it has not read what they gave it.
 *
 * So the kind is detected from the document's own shape, and the questions change with it.
 *
 * 🔴 **THIS IS A HEURISTIC, AND IT IS DECLARED AS ONE.** It reads **structure** — a section
 * heading standing alone on its line, speaker labels at the start of lines, the density of
 * the words a contract uses — and never meaning. It decides **only which questions to
 * offer**. It cannot change a single answer: every question it offers goes through the same
 * pipeline as any other, is grounded in the document the same way, and is refused the same
 * way when the document is silent. A wrong guess here costs a slightly odd question; it
 * can never cost a wrong answer.
 *
 * 🔴 **NO QUESTION HERE ASKS FOR ARITHMETIC, AND THAT IS A RULE, NOT A STYLE.** The prompt
 * forbids the model to count or to add up, because it cannot reliably do either, and every
 * number the app shows is computed in code over the whole document. **A suggested question
 * asking for a total, a sum or an average would invite exactly the invention the rest of
 * this app exists to prevent** — so none of them does, and `test/kinds.test.js` fails if
 * one ever does.
 */

export type DocumentKind = 'resume' | 'job' | 'diary' | 'policy' | 'minutes' | 'transcript' | 'statement' | 'general';

export interface Described {
  kind: DocumentKind;
  /** The words the page shows the reader, so the guess is visible rather than hidden. */
  label: string;
  suggestions: string[];
}

/** The questions that suit no document in particular, and a diary as well as any. */
const GENERAL = [
  'What is this document about?',
  'What happened first, and what happened last?',
  'Which month was busiest?',
  'Where do the events take place?',
  'Who is mentioned most?',
];

/**
 * The questions each kind gets.
 *
 * A question the document cannot answer is not a mistake — it is the refusal path being
 * shown, which is half of what this tool is for. None of them asks for a count or a total.
 *
 * 🔴 **EXPORTED SO EVERY QUESTION CAN BE CLASSIFIED, AND THE CLASSIFICATION TESTED.** `scope.ts`
 * keeps the registries that say which of these ask for a LIST — the questions that must be answered
 * from the whole document rather than from the best-matching eight notes, after *"Which employers and
 * job titles are named?"* answered with four employers out of twelve. `test/scope.test.js` walks this
 * record and fails if any question here is in neither registry, so a new suggested question cannot
 * arrive unclassified.
 */
export const BY_KIND: Record<DocumentKind, string[]> = {
  resume: [
    'What skills are listed?',
    'Where has this person worked?',
    'What did they do in the most recent role?',
    'What education is listed?',
    'Which employers and job titles are named?',
  ],
  /**
   * A job posting read by the person who might take the job — or by the person hiring.
   *
   * George, 22 Sep 2026, after pasting a Senior Software Engineer posting that the page called
   * *"a document"*: *"this is a job description … can you add something so it does a better job"*.
   * The five questions he was being offered were the diary's — *"Which month was busiest?"* on a
   * posting with no dates in it — which is the exact failure `kinds.ts` exists to prevent, one kind
   * short of covering the document people paste most after a resume.
   *
   * ⚠ **FOUR OF THESE ARE LIST QUESTIONS AND THAT IS DELIBERATE.** A posting's qualifications and
   * responsibilities are spread down the page and are not all alike, so the same starved search that
   * made *"Which employers and job titles are named?"* answer with four of twelve would answer these
   * with three of nine. They are registered in `scope.ts` so they read the whole document.
   */
  job: [
    'What are the essential qualifications?',
    'What are the responsibilities?',
    'What are the performance objectives?',
    'Which technologies and tools are named?',
    'What does it say about where and how the work is done?',
  ],
  diary: [...GENERAL],
  policy: [
    'What does it say about termination?',
    'What notice is required?',
    'What does each party have to do?',
    'What does it say about payment?',
    'What does it say about liability?',
  ],
  minutes: [
    'What was decided?',
    'What action items are there?',
    'Who attended?',
    'What was discussed first?',
    'What was left unresolved?',
  ],
  transcript: [
    'Who spoke, and about what?',
    'What was agreed?',
    'What questions were asked?',
    'What was said last?',
  ],
  statement: [
    'What date range does it cover?',
    'What amounts are listed?',
    'Which payees or merchants are named?',
    'What kinds of transactions appear?',
  ],
  general: [...GENERAL],
};

const LABELS: Record<DocumentKind, string> = {
  resume: 'a resume',
  job: 'a job description',
  diary: 'a diary or a journal',
  policy: 'terms or an agreement',
  minutes: 'minutes of a meeting',
  transcript: 'a transcript',
  statement: 'a statement or a ledger',
  general: 'a document',
};

/* ------------------------------------------------------------------ the signals */

/** A resume names its sections in short lines that stand alone. */
const SECTION = /^(work\s+)?(experience|employment(\s+history)?|education|skills|technical\s+skills|summary|profile|objective|certifications?|licences?|awards|projects|publications|languages|volunteer|references)$/i;
/** At least one of these has to be present, or two stray headings are not a resume. */
const SECTION_ANCHOR = /experience|employment|education|skills|summary|profile|objective/i;

/**
 * The sections a JOB POSTING has, which are not the sections a resume has.
 *
 * 🔴 WHY THIS IS A SEPARATE PATTERN AND NOT A WORD IN THE ONE ABOVE. A resume and a job posting
 * share almost no section names: a resume says *Experience*, *Education*, *Skills*; a posting says
 * *Responsibilities*, *Requirements*, *What you'll do*. The two were being told apart by nothing,
 * which is why a posting reached the page as *"a document"*.
 */
const JOB_SECTION = /^(about (the )?(role|you|us)|the role|role overview|position summary|job (summary|description|purpose)|responsibilities|key responsibilities|duties|what you.?ll do|what you will do|performance objectives|essential qualifications|qualifications|requirements|minimum requirements|must haves?|nice to haves?|preferred qualifications|skills (and|&) experience|experience required|environment (&|and) resources|what we offer|we offer|benefits|compensation|why join us|how to apply)$/i;

/**
 * And it talks TO a candidate rather than about an employee.
 *
 * A resume describes a person in the third person — *"led a team"*, *"2019 to 2022"*. A posting
 * addresses the reader — *"you will own"*, *"the successful candidate"* — or names the machinery of
 * hiring — *"we are hiring"*, *"apply now"*, *"salary range"*.
 */
const JOB_MARKER = /\b(job description|job posting|we are (looking|seeking|hiring)|we're (looking|seeking|hiring)|the successful candidate|you will (own|lead|build|design|work|be|join)|you.?ll (own|lead|build|design|work|be|join)|the role (is|will)|this role|applicants?|apply (now|by|with|today|below)|salary range|annual salary|per annum|hourly rate|base salary|benefits package|paid time off|vacation entitlement|probationary period|notice period|permanent (position|role|full)|full[- ]time|part[- ]time|hybrid|on[- ]site|work from home|remote work|equity)\b/gi;

const SPEAKER = /^[A-Z][A-Za-z'’-]*(?:\s+[A-Z][A-Za-z'’-]*){0,3}:\s+\S/;

const MINUTES_MARKER = /\b(agenda|minutes|present|attendees|apologies|action items?|motions?|chair|resolved|carried|absent)\b/gi;

const POLICY_MARKER = /\b(shall|agreement|herein|hereto|thereof|party|parties|indemnif\w*|termination|liabilit\w*|clause|warrant\w*|governing law|obligations?)\b/gi;

const STATEMENT_MARKER = /\b(balance|transaction|debit|credit|invoice|payment received|opening balance|closing balance|statement|deposit|withdrawal)\b/gi;

const AMOUNT = /(?:[$£€]\s?\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*\.\d{2}\b)/;

/** How many DIFFERENT markers of a kind appear — repetition is not evidence. */
function distinct(text: string, pattern: RegExp): number {
  return new Set((text.match(pattern) ?? []).map((hit) => hit.toLowerCase())).size;
}

function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim());
}

/**
 * Work out what kind of document this is.
 *
 * The order is the argument: a resume is checked first because its evidence is the
 * strongest and least ambiguous, and a document that looks like a resume and also contains
 * the word "agreement" is still a resume.
 *
 * `datedEntries` comes from the index rather than being re-derived here — a diary is a
 * document whose entries carry complete dates, and that count is already computed over the
 * whole text by code that has to be right for other reasons.
 */
export function detectKind(text: string, datedEntries: number): DocumentKind {
  const sections = lines(text).filter((line) => line.length > 0 && line.length <= 40 && SECTION.test(line));
  if (sections.length >= 2 && SECTION_ANCHOR.test(sections.join(' '))) return 'resume';

  // 🔴 A JOB POSTING IS CHECKED SECOND, STRAIGHT AFTER A RESUME, AND THE ORDER IS THE ARGUMENT: the
  // two documents people paste most are a resume they are writing and a posting they are answering,
  // and a resume must keep winning, because it carries the stronger evidence (employers, dates,
  // degrees) and a posting has none of those.
  //
  // The thresholds are set so an EMPLOYMENT AGREEMENT is not mistaken for a posting. A contract has
  // *"probationary period"*, *"notice period"* and *"salary"* — three of the markers below — but it
  // has no posting sections, so two sections are required, or one section with three markers, or six
  // markers on their own. A contract reaches none of those and still falls through to `policy`.
  const jobSections = lines(text).filter((line) => line.length > 0 && line.length <= 48 && JOB_SECTION.test(line));
  const jobMarks = distinct(text, JOB_MARKER);
  if (jobSections.length >= 2 || (jobSections.length >= 1 && jobMarks >= 3) || jobMarks >= 6) return 'job';

  const speakerLines = lines(text).filter((line) => SPEAKER.test(line));
  const speakers = new Set(speakerLines.map((line) => line.split(':')[0]?.trim().toLowerCase() ?? ''));
  if (speakerLines.length >= 4 && speakers.size >= 2) return 'transcript';

  if (distinct(text, MINUTES_MARKER) >= 3) return 'minutes';

  if (distinct(text, POLICY_MARKER) >= 5) return 'policy';

  const amountLines = lines(text).filter((line) => AMOUNT.test(line)).length;
  if (distanceFromStatement(text, amountLines)) return 'statement';

  if (datedEntries >= 3) return 'diary';

  return 'general';
}

/** A statement is mostly numbers in columns, and says so in its own words. */
function distanceFromStatement(text: string, amountLines: number): boolean {
  return amountLines >= 5 && distinct(text, STATEMENT_MARKER) >= 3;
}

/** The kind, the word for it, and the questions worth offering. */
export function describeDocument(text: string, datedEntries: number): Described {
  const kind = detectKind(text, datedEntries);
  return { kind, label: LABELS[kind], suggestions: [...BY_KIND[kind]] };
}

export const ALL_SUGGESTIONS = BY_KIND;
