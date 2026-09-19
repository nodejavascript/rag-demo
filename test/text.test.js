/**
 * Turning a paste into plain text, and the heading rule that protects a document of
 * short standalone lines from being shredded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  blocks,
  containsProse,
  decodeEntities,
  endsInPunctuation,
  extractImages,
  guessTitle,
  looksLikeHeadingCandidate,
  normaliseWhitespace,
  prepare,
} from '../dist/text.js';

test('entities are decoded, including numeric ones', () => {
  assert.equal(decodeEntities('a &amp; b &mdash; c &#233;'), 'a & b \u2014 c \u00e9');
});

test('a page becomes prose and its tags go', () => {
  const html =
    '<html><head><style>p{color:red}</style></head><body><h1>Title</h1><p>One.</p><p>Two.</p></body></html>';
  const prepared = prepare(html);
  assert.equal(prepared.fromHtml, true);
  assert.match(prepared.text, /One\./);
  assert.match(prepared.text, /Two\./);
  assert.doesNotMatch(prepared.text, /color:red/);
  assert.doesNotMatch(prepared.text, /<p>/);
});

test('markdown and HTML images are lifted out, and a marker stays', () => {
  const text = 'Before ![a caption](https://example.org/a.jpg) after\n\n<img src="/b.png" alt="B">';
  const images = extractImages(text, 'https://example.org/page');
  assert.deepEqual(
    images.map((image) => image.url),
    ['https://example.org/a.jpg', 'https://example.org/b.png']
  );
  assert.equal(images[0]?.caption, 'a caption');
  assert.equal(images[1]?.caption, 'B');
});

test('a bare image URL counts, and a normal link does not', () => {
  const images = extractImages('see https://example.org/cat.png and https://example.org/page');
  assert.deepEqual(
    images.map((image) => image.url),
    ['https://example.org/cat.png']
  );
});

test('relative image paths resolve against the page they came from', () => {
  const [image] = extractImages('<img src="pics/x.jpg">', 'https://example.org/a/b/');
  assert.equal(image?.url, 'https://example.org/a/b/pics/x.jpg');
});

test('blank-line runs are collapsed without destroying paragraphs', () => {
  assert.equal(normaliseWhitespace('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(normaliseWhitespace('a   \nb'), 'a\nb');
});

test('the heading rule is the fragment rule', () => {
  // A heading must be followed by a line that ends a sentence.
  assert.equal(looksLikeHeadingCandidate('EXPERIENCE'), true);
  assert.equal(endsInPunctuation('Led the migration.'), true);
  assert.equal(endsInPunctuation('Senior Engineer'), false);
  assert.equal(containsProse('Alpha\nBravo'), false);
  assert.equal(containsProse('Alpha\nBravo went home.'), true);
});

test('a line that ends in punctuation is never a heading', () => {
  assert.equal(looksLikeHeadingCandidate('This is a sentence.'), false);
  assert.equal(looksLikeHeadingCandidate('Is it?'), false);
});

test('a title is taken from the first real line', () => {
  assert.equal(guessTitle('# My Diary\n\nSomething.'), 'My Diary');
  assert.equal(guessTitle('\n\nCold again. It rained.'), 'Cold again. It rained.');
  assert.equal(guessTitle(''), 'Untitled document');
});

test('blocks are split on blank lines and keep their offsets', () => {
  const text = 'one\n\ntwo\n\nthree';
  const parts = blocks(text);
  assert.deepEqual(
    parts.map((part) => part.text),
    ['one', 'two', 'three']
  );
  assert.equal(text.slice(parts[1].start, parts[1].end), 'two');
});
