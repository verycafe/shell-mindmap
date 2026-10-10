import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const replay = events => {
  const result = spawnSync(process.execPath, ['tests/terminal-screen.mjs'], {
    input: JSON.stringify({columns: 80, rows: 24, events}), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const event = value => ({data: Buffer.from(value).toString('base64')});
const byteEvents = value => Array.from(Buffer.from(value), byte => event([byte]));

test('PTY replay preserves UTF-8 across arbitrary read boundaries and resizes', () => {
  const before = '\x1b[?1049h\x1b[H› 中文目录 👩‍💻 e\u0301\r\n├─ ▸ 子文件夹';
  const after = '\x1b[H\x1b[2J› 选中脑图.mm 🙂\r\n└─ 子级👨‍👩‍👧‍👦';
  const resize = {columns: 48, rows: 12};
  const whole = replay([event(before), resize, event(after)]);
  const fragmented = replay([...byteEvents(before), resize, ...byteEvents(after)]);
  assert.deepEqual(fragmented, whole);
  assert.equal(whole.buffer, 'alternate');
  assert.match(whole.lines[0], /^› 选中脑图\.mm 🙂/u);
  assert.match(whole.lines[1], /^└─ 子级👨‍👩‍👧‍👦/u);
});

test('PTY replay retains pending UTF-8 bytes over a resize event', () => {
  const prefix = '\x1b[?1049h\x1b[H';
  const text = Buffer.from('› 中文 👩‍💻');
  const resize = {columns: 48, rows: 12};
  const whole = replay([event(prefix), resize, event(text)]);
  const split = replay([event(prefix), event(text.subarray(0, 2)), resize, event(text.subarray(2))]);
  assert.deepEqual(split, whole);
  assert.match(split.lines[0], /^› 中文 👩‍💻/u);
});
