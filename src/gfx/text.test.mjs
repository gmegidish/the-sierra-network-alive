import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapText } from './text.js';

/** A font where every character is 4 pixels wide. */
const FOUR_PIXEL_FONT = { glyphs: new Proxy({}, { get: () => ({ width: 4 }) }), lineHeight: 8 };

test('a button label that fits keeps its padding spaces, so " OK " stays centred', () => {
  assert.deepEqual(wrapText(FOUR_PIXEL_FONT, ' OK ', 192), [' OK ']);
});

test('text wider than the box still wraps at spaces', () => {
  assert.deepEqual(wrapText(FOUR_PIXEL_FONT, 'aaaa bbbb', 20), ['aaaa', 'bbbb']);
});
