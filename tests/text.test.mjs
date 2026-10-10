import test from 'node:test';
import assert from 'node:assert/strict';
import {graphemes, displayWidth, clipText, wrapText, sanitizePaste, editBuffer} from '../dist/text.js';

test('Unicode is measured and edited by graphemes, not UTF-16 units', () => {
  const text = '中👨‍👩‍👧‍👦e\u0301🇨🇳👍🏽';
  assert.deepEqual(graphemes(text), ['中', '👨‍👩‍👧‍👦', 'e\u0301', '🇨🇳', '👍🏽']);
  assert.equal(displayWidth(text), 9);
  assert.deepEqual(editBuffer({value: text, cursor: 2}, 'backspace'), {value: '中e\u0301🇨🇳👍🏽', cursor: 1});
  assert.deepEqual(editBuffer({value: text, cursor: 3}, 'delete'), {value: '中👨‍👩‍👧‍👦e\u0301👍🏽', cursor: 3});
});

test('column clipping blanks partial CJK and complex emoji on both edges', () => {
  assert.equal(clipText('中A文', 1, 3), ' A ');
  assert.equal(clipText('👨‍👩‍👧‍👦a', 1, 2), ' a');
  assert.equal(clipText('a👨‍👩‍👧‍👦', 0, 2), 'a ');
  assert.equal(clipText('e\u0301中', 0, 2), 'e\u0301 ');
  assert.equal(clipText('中', 0, 0), '');
  assert.equal(clipText('中', 5, 2), '');
  for (let start = 0; start < 12; start++) {
    for (let width = 0; width < 12; width++) {
      assert.ok(displayWidth(clipText('a中👨‍👩‍👧‍👦e\u0301🇨🇳Z', start, width)) <= width);
    }
  }
});

test('wrapping keeps words when possible and preserves spaces and graphemes', () => {
  const source = 'hello  world中文👨‍👩‍👧‍👦 e\u0301 abcdefghijklmnop';
  const lines = wrapText(source, 7);
  assert.equal(lines.join(''), source);
  assert.ok(lines.every(line => displayWidth(line) <= 7));
  assert.ok(lines.some(line => line.startsWith('world')));
  assert.deepEqual(wrapText('甲\n\n乙', 8), ['甲', '', '乙']);
  assert.deepEqual(wrapText('', 8), ['']);
  assert.deepEqual(wrapText('中文', 1), ['中', '文']);
});

test('long words and multilingual text wrap and edit without truncation', () => {
  const word = 'a'.repeat(20_000);
  const suffix = '中文👩‍💻e\u0301 العربية日本語한국어'.repeat(200);
  const text = `${word} ${suffix}`;
  const lines = wrapText(text, 32);
  assert.equal(lines.join(''), text);
  assert.ok(lines.every(line => displayWidth(line) <= 32));
  const state = editBuffer({value: '前后', cursor: 1}, 'insert', text);
  assert.equal(state.value, `前${text}后`);
  assert.equal(state.cursor, graphemes(text).length + 1);
  assert.equal(editBuffer(state, 'delete').value, `前${text}`);
  assert.equal(clipText(text, 19_997, 8), 'aaa 中文');
});

test('paste strips terminal sequences and controls without damaging Unicode', () => {
  const source = '\x1b[31m红色\x1b[0m\r\nA\tB\x00\x07\x7f👩‍💻e\u0301';
  assert.equal(sanitizePaste(source), '红色 A B👩‍💻e\u0301');
  assert.equal(sanitizePaste('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'), 'link');
});

test('successive input chunks and combining insertions never overwrite earlier text', () => {
  let state = {value: '', cursor: 0};
  for (const chunk of ['日本', '語', '中文', '输入']) state = editBuffer(state, 'insert', chunk);
  assert.deepEqual(state, {value: '日本語中文输入', cursor: 7});
  assert.deepEqual(editBuffer({value: 'e', cursor: 1}, 'insert', '\u0301'), {value: 'e\u0301', cursor: 1});
  assert.deepEqual(editBuffer({value: '👩', cursor: 1}, 'insert', '\u200d💻'), {value: '👩‍💻', cursor: 1});
  assert.deepEqual(editBuffer({value: '中末', cursor: 1}, 'insert', '多字符\n'), {value: '中多字符 末', cursor: 5});
});

test('editing movement and deletion respect boundaries', () => {
  const state = {value: 'a中👍🏽', cursor: 2};
  assert.deepEqual(editBuffer(state, 'left'), {value: state.value, cursor: 1});
  assert.deepEqual(editBuffer(state, 'right'), {value: state.value, cursor: 3});
  assert.deepEqual(editBuffer(state, 'home'), {value: state.value, cursor: 0});
  assert.deepEqual(editBuffer(state, 'end'), {value: state.value, cursor: 3});
  assert.deepEqual(editBuffer(state, 'clear'), {value: '', cursor: 0});
  assert.deepEqual(editBuffer({value: '', cursor: 0}, 'backspace'), {value: '', cursor: 0});
  assert.deepEqual(editBuffer({value: 'a', cursor: 99}, 'right'), {value: 'a', cursor: 1});
  assert.deepEqual(editBuffer({value: 'a', cursor: -1}, 'delete'), {value: '', cursor: 0});
});
