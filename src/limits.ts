/**
 * The nets that keep a busy afternoon from taking the host down.
 *
 * 🔴 WHY THESE EXIST, AND WHY NOW. This container shares a **1 GB** droplet with nine other sites, under a
 * **288 MB** memory cap. Everything in this file is one of the ways a public demo like this one fails —
 * and the list of what was already guarded is as important as the list of what was not:
 *
 *   · **a paste is bounded** — `MIN_CHARS` 200 to `MAX_CHARS` 400,000 (`indexer.ts`), and the request
 *     body is capped at `BODY_LIMIT` 900,000 characters and a PDF upload at `FILE_LIMIT` 12 MB;
 *   · **indexing is bounded twice** — `MAX_CONCURRENT_INDEX` documents may embed at once and each
 *     client may start `INDEX_PER_HOUR` in an hour;
 *   · **asking is bounded per client** — `ASK_PER_HOUR` 240;
 *   · **every document expires** — `DOC_TTL_HOURS` 24, swept by `purgeExpired`;
 *   · **the model call has a timeout** — `AbortSignal.timeout` on the provider request, so a hung
 *     upstream fails instead of holding a socket for ever.
 *
 *   ✗ **an ANSWER had no concurrency cap.** Indexing had one and asking did not, and the answer path
 *     just got much longer: a question that asks for a list now reads the whole document, which
 *     measured **7–17 seconds** on a 12,350-character resume against 2–5 seconds for a search question.
 *     Six people clicking at once would hold six long model calls, six sockets and six response buffers
 *     on the same small box. `MAX_CONCURRENT_ASK` is that cap.
 *   ✗ **the STORE had no ceiling.** 40 documents an hour of up to 400,000 characters each, kept for 24
 *     hours, is a lot of text and a lot of vectors for a 24 GB disk shared with everything else.
 *     `MAX_STORE_MB` refuses new work once the database is past a budget, and says when the space comes
 *     back.
 *   ✗ **a client's hour was counted in DOCUMENTS, not in characters.** Forty maximum-size pastes is
 *     16 million characters — the same allowance as forty one-line notes. `INDEX_CHARS_PER_HOUR` counts
 *     what actually costs: the text.
 *   ✗ **Node's heap had no ceiling inside its own container.** Without one, a big paste makes Node grow
 *     until the cgroup kills the process, and the container restarts mid-index. `--max-old-space-size`
 *     (set in the compose file, not here) makes it collect hard instead.
 *
 * **Every number is an environment override with a default, so the droplet can be tuned without a
 * release** — and every decision below is a pure function, so the arithmetic is tested rather than
 * trusted.
 */

/** A whole number from the environment, with a floor of one and a fallback when it is nonsense. */
function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * How many answers may be in flight at once.
 *
 * Three, because each one is a remote model call of 2–20 seconds and this host has 314 MB free at rest:
 * two long answers and one short one is the point where the box is busy but still answering. The fourth
 * caller is told the truth — *"the machine is busy"* — instead of being queued behind a wait it cannot
 * see.
 */
export const MAX_CONCURRENT_ASK = envInt('MAX_CONCURRENT_ASK', 3);

/** How many characters one client may index in an hour. 600,000 is one and a half maximum pastes. */
export const INDEX_CHARS_PER_HOUR = envInt('INDEX_CHARS_PER_HOUR', 600_000);

/**
 * How large the store may grow before indexing is refused, in megabytes of database file.
 *
 * 150 MB is a sixth of the free disk on the droplet and far more than a demo needs: at rest the whole
 * database for five documents and 67 notes is under a megabyte. The refusal names the expiry, because
 * the space does come back on its own.
 */
export const MAX_STORE_MB = envInt('MAX_STORE_MB', 150);

/** A budget of characters, and when it refills. */
export interface CharBudget {
  used: number;
  resetAt: number;
}

/**
 * Spend `chars` from an hourly budget, and say whether there was room.
 *
 * A pure function so the arithmetic can be tested without a server: the caller keeps the budget per
 * client, this decides. **The budget refills on a clock, not on idleness** — a caller who spends nothing
 * gets a fresh allowance an hour after their window opened, whatever they did in between.
 */
export function takeChars(
  budget: CharBudget | undefined,
  chars: number,
  now: number,
  perHour: number = INDEX_CHARS_PER_HOUR
): { allowed: boolean; budget: CharBudget; retryInMs: number } {
  if (!budget || budget.resetAt <= now) {
    // 🔴 A PASTE THAT CAN NEVER FIT IS NOT CHARGED FOR. A fresh window is opened so the caller has a
    // clock, but `used` stays at zero: this request was refused, so it must not also spend the
    // allowance the NEXT one needs. (Found by `a paste larger than the whole hour is refused rather
    // than half-charged` — the first version charged the whole hour for a refusal.)
    if (chars > perHour) {
      return { allowed: false, budget: { used: 0, resetAt: now + 3_600_000 }, retryInMs: 3_600_000 };
    }
    return { allowed: true, budget: { used: chars, resetAt: now + 3_600_000 }, retryInMs: 0 };
  }
  if (budget.used + chars > perHour) {
    return { allowed: false, budget, retryInMs: Math.max(0, budget.resetAt - now) };
  }
  return { allowed: true, budget: { used: budget.used + chars, resetAt: budget.resetAt }, retryInMs: 0 };
}

/** True when the store is past its budget — checked before indexing, never during. */
export function storeIsFull(bytes: number, maxMb: number = MAX_STORE_MB): boolean {
  return bytes >= maxMb * 1024 * 1024;
}

/** Bytes as the sentence a reader sees, so "how full is it" is never a raw number of bytes. */
export function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Minutes until a budget refills, for the message a refused caller reads. */
export function minutesUntil(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}
