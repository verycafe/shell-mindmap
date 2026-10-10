import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {listRecoveries, removeRecovery, writeRecovery} from '../dist/recovery.js';
import {applicationDirectory, fingerprint, saveMap} from '../dist/storage.js';

let fixture;
const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
const nodes = [{id: 'root', text: '恢复中文 🧠', depth: 0, folded: false}, {id: 'child', text: '未保存节点', depth: 1, folded: true}];
before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-recovery-'));
  process.env.HOME = fixture;
  process.env.USERPROFILE = fixture;
});
after(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  fs.rmSync(fixture, {recursive: true, force: true});
});

test('reading recovery list does not create directories', () => {
  assert.deepEqual(listRecoveries(), []);
  assert.equal(fs.existsSync(applicationDirectory()), false);
});

test('independent sessions preserve exact model and original file fingerprint', () => {
  const file = path.join(fixture, '中文 空格.mm');
  saveMap(file, nodes);
  const originalFingerprint = fingerprint(file);
  writeRecovery({sessionId: 'session_one', nodes, file, baseFingerprint: originalFingerprint});
  writeRecovery({sessionId: 'session_two', nodes: [{...nodes[0], text: '另一会话'}]});
  const records = listRecoveries();
  assert.equal(records.length, 2);
  const first = records.find(record => record.sessionId === 'session_one');
  assert.deepEqual(first.nodes, nodes);
  assert.equal(first.file, file);
  assert.equal(first.baseFingerprint, originalFingerprint);
  assert.ok(Number.isFinite(Date.parse(first.updatedAt)));
  assert.equal(fingerprint(file), originalFingerprint);
});

test('snapshot updates are atomic and corrupt siblings do not hide valid recovery data', () => {
  const directory = path.join(applicationDirectory(), '.app', 'recovery');
  fs.writeFileSync(path.join(directory, 'broken.json'), '{truncated');
  fs.writeFileSync(path.join(directory, 'invalid.json'), JSON.stringify({sessionId: 'invalid', nodes: [], updatedAt: new Date().toISOString()}));
  fs.writeFileSync(path.join(directory, 'mismatch.json'), JSON.stringify({...listRecoveries()[0], sessionId: 'another'}));
  writeRecovery({sessionId: 'session_one', nodes: [{...nodes[0], text: '更新'}]});
  assert.equal(listRecoveries().length, 2);
  assert.equal(listRecoveries().find(record => record.sessionId === 'session_one').nodes[0].text, '更新');
});

test('recovery storage stays in the public application directory across workspaces', () => {
  const previous = process.cwd();
  const first = path.join(fixture, 'workspace-one');
  const second = path.join(fixture, 'workspace-two');
  fs.mkdirSync(first); fs.mkdirSync(second);
  try {
    process.chdir(first);
    writeRecovery({sessionId: 'workspace_session', nodes, file: 'relative.mm'});
    process.chdir(second);
    const recovered = listRecoveries().find(record => record.sessionId === 'workspace_session');
    assert.equal(recovered.file, path.join(fs.realpathSync(first), 'relative.mm'));
    assert.deepEqual(recovered.nodes, nodes);
    assert.equal(fs.existsSync(path.join(first, '.app')), false);
    assert.equal(fs.existsSync(path.join(second, '.app')), false);
    assert.equal(fs.existsSync(path.join(applicationDirectory(), '.app', 'recovery', 'workspace_session.json')), true);
    removeRecovery('workspace_session');
  } finally {process.chdir(previous);}
});

test('an unnamed map retains its chosen save directory when recovered from another workspace', () => {
  const previous = process.cwd();
  const first = path.join(fixture, 'workspace-one');
  const second = path.join(fixture, 'workspace-two');
  const chosen = path.join(first, '中文 项目');
  fs.mkdirSync(chosen);
  try {
    process.chdir(first);
    writeRecovery({sessionId: 'chosen_directory', nodes, saveDirectory: './中文 项目'});
    const expectedDirectory = path.join(fs.realpathSync(first), '中文 项目');
    process.chdir(second);
    let recovered = listRecoveries().find(record => record.sessionId === 'chosen_directory');
    assert.equal(recovered.file, undefined);
    assert.equal(recovered.saveDirectory, expectedDirectory);
    assert.deepEqual(recovered.nodes, nodes);
    // Losing access to the destination must not hide otherwise recoverable text.
    fs.rmdirSync(chosen);
    recovered = listRecoveries().find(record => record.sessionId === 'chosen_directory');
    assert.equal(recovered.saveDirectory, expectedDirectory);
    assert.deepEqual(recovered.nodes, nodes);
    assert.equal(fs.existsSync(chosen), false);
    removeRecovery('chosen_directory');
  } finally {process.chdir(previous);}
});

test('invalid save-directory metadata is skipped while snapshots without it remain compatible', () => {
  const directory = path.join(applicationDirectory(), '.app', 'recovery');
  const invalid = ['', 'relative/folder', '~', 42, null, path.join(fixture, 'bad\nname')];
  for (const [index, saveDirectory] of invalid.entries()) {
    const sessionId = 'bad_directory_' + index;
    fs.writeFileSync(path.join(directory, sessionId + '.json'), JSON.stringify({sessionId, nodes, saveDirectory, updatedAt: new Date().toISOString()}));
  }
  const records = listRecoveries();
  assert.deepEqual(records.map(record => record.sessionId).sort(), ['session_one', 'session_two']);
  assert.equal(records.find(record => record.sessionId === 'session_two').saveDirectory, undefined);
  for (const saveDirectory of ['', 42, null, 'bad\nname']) {
    assert.throws(() => writeRecovery({sessionId: 'invalid_write_directory', nodes, saveDirectory}));
  }
  assert.equal(fs.existsSync(path.join(directory, 'invalid_write_directory.json')), false);
});

test('invalid or traversing session IDs and invalid fingerprints cannot write', () => {
  for (const sessionId of ['../outside', '', 'one/two', '..', 'x'.repeat(101)]) assert.throws(() => writeRecovery({sessionId, nodes}), /会话 ID/);
  assert.throws(() => writeRecovery({sessionId: 'bad_hash', nodes, baseFingerprint: 'not-a-hash'}), /指纹/);
  assert.throws(() => writeRecovery({sessionId: 'bad_nodes', nodes: []}));
  assert.equal(fs.existsSync(path.join(applicationDirectory(), '.app', 'outside.json')), false);
});

test('failed recovery update leaves last good snapshot intact', () => {
  const file = path.join(applicationDirectory(), '.app', 'recovery', 'session_one.json');
  const original = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => {throw new Error('recovery rename failed');};
    assert.throws(() => writeRecovery({sessionId: 'session_one', nodes}), /rename failed/);
  } finally {fs.renameSync = rename;}
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('discard removes only the selected session and is idempotent', () => {
  removeRecovery('session_one');
  removeRecovery('session_one');
  assert.deepEqual(listRecoveries().map(record => record.sessionId), ['session_two']);
  assert.throws(() => removeRecovery('../outside'), /会话 ID/);
});
