/**
 * The guards that keep a busy afternoon from taking the host down.
 *
 * 🔴 WHAT THESE TESTS ARE FOR, AND WHAT THEY ARE NOT. `limits.ts` holds three decisions, and every one
 * of them is a piece of arithmetic that a later reader will want to "tidy": a budget that refills on a
 * clock, a boundary that is `>=` rather than `>`, a per-client budget that must not leak between
 * clients. **So the arithmetic is asserted here, where a change that looks harmless goes red.** The
 * wiring — that the server actually calls these, and refuses with a 503 or a 429 — is measured against
 * a running server in `test/pipeline.test.js` and by hand against the preview, because a unit test that
 * mocked the server would prove only that the mock was called.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INDEX_CHARS_PER_HOUR,
  MAX_CONCURRENT_ASK,
  MAX_STORE_MB,
  mb,
  minutesUntil,
  storeIsFull,
  takeChars,
} from '../dist/limits.js';

const HOUR = 3_600_000;

test('a client with no budget gets a fresh hour, and is charged for what it spent', () => {
  const spent = takeChars(undefined, 5_000, 1_000_000);
  assert.equal(spent.allowed, true);
  assert.equal(spent.budget.used, 5_000);
  assert.equal(spent.budget.resetAt, 1_000_000 + HOUR);
  assert.equal(spent.retryInMs, 0);
});

test('spending inside the hour adds up rather than starting again each time', () => {
  let budget = takeChars(undefined, 100_000, 0).budget;
  budget = takeChars(budget, 100_000, 1_000).budget;
  const third = takeChars(budget, 100_000, 2_000);
  assert.equal(third.allowed, true);
  assert.equal(third.budget.used, 300_000);
  // Still the FIRST window's clock — a client cannot extend its hour by keeping busy.
  assert.equal(third.budget.resetAt, HOUR);
});

test('the last paste that fits is allowed and the next one is not', () => {
  const budget = takeChars(undefined, INDEX_CHARS_PER_HOUR - 10, 0).budget;
  const justFits = takeChars(budget, 10, 1_000);
  assert.equal(justFits.allowed, true, 'the paste that lands exactly on the budget must be allowed');
  const over = takeChars(justFits.budget, 1, 2_000);
  assert.equal(over.allowed, false);
  assert.ok(over.retryInMs > 0, 'a refusal must say when to come back');
});

test('a refusal reports the time left in THIS window, not a fresh hour', () => {
  const budget = takeChars(undefined, INDEX_CHARS_PER_HOUR, 0).budget;
  // Half way through the window the caller is told half an hour, not sixty minutes.
  const refused = takeChars(budget, 1, HOUR / 2);
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryInMs, HOUR / 2);
  assert.equal(minutesUntil(refused.retryInMs), 30);
});

test('the window refills on the clock even for a client that spent nothing since', () => {
  const budget = takeChars(undefined, INDEX_CHARS_PER_HOUR, 0).budget;
  const refused = takeChars(budget, 1, 1);
  assert.equal(refused.allowed, false);
  const fresh = takeChars(budget, INDEX_CHARS_PER_HOUR, HOUR);
  assert.equal(fresh.allowed, true, 'an hour later the allowance is whole again');
  assert.equal(fresh.budget.used, INDEX_CHARS_PER_HOUR);
});

test('a paste larger than the whole hour is refused rather than half-charged', () => {
  const spent = takeChars(undefined, INDEX_CHARS_PER_HOUR + 1, 0);
  assert.equal(spent.allowed, false);
  assert.equal(spent.budget.used, 0, 'nothing is charged for a paste that never happened');
  // And it says an hour, because no window of this size will ever fit it — not "try again soon".
  assert.equal(minutesUntil(spent.retryInMs), 60);
  // The allowance the NEXT paste needs is intact: the refusal spent nothing.
  const next = takeChars(spent.budget, 1_000, 1);
  assert.equal(next.allowed, true);
});

test('each client has its own budget', () => {
  const a = takeChars(undefined, INDEX_CHARS_PER_HOUR, 0).budget;
  const aRefused = takeChars(a, 1, 1);
  assert.equal(aRefused.allowed, false);
  // A different client starts from nothing, which is the whole point of keying by address.
  const b = takeChars(undefined, INDEX_CHARS_PER_HOUR, 1);
  assert.equal(b.allowed, true);
});

test('the store is full at the boundary, not past it', () => {
  assert.equal(storeIsFull(MAX_STORE_MB * 1024 * 1024 - 1), false);
  assert.equal(storeIsFull(MAX_STORE_MB * 1024 * 1024), true, 'exactly at the budget is full');
  assert.equal(storeIsFull(MAX_STORE_MB * 1024 * 1024 + 1), true);
  assert.equal(storeIsFull(0), false, 'an empty store is never full');
});

test('the size a reader is shown is megabytes, to one decimal', () => {
  assert.equal(mb(0), '0.0 MB');
  assert.equal(mb(1024 * 1024), '1.0 MB');
  assert.equal(mb(1_572_864), '1.5 MB');
});

test('minutes to wait is never zero and never a fraction', () => {
  assert.equal(minutesUntil(1), 1, 'nothing has ever freed up in no time at all');
  assert.equal(minutesUntil(60_000), 1);
  assert.equal(minutesUntil(60_001), 2);
});

test('the three ceilings are positive whole numbers, whatever the environment says', () => {
  // These come from the environment with a floor of one, so a nonsense value cannot disable a net.
  assert.ok(Number.isInteger(MAX_CONCURRENT_ASK) && MAX_CONCURRENT_ASK >= 1);
  assert.ok(Number.isInteger(INDEX_CHARS_PER_HOUR) && INDEX_CHARS_PER_HOUR >= 1);
  assert.ok(Number.isInteger(MAX_STORE_MB) && MAX_STORE_MB >= 1);
});
