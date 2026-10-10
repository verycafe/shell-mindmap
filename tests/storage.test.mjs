import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {applicationDirectory, ensureApplicationDirectory, expandPath, fingerprint, listMaps, readMap, resolveSaveDirectory, saveMap, suggestFilename, writeTextAtomic} from '../dist/storage.js';

let fixture;
const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
const nodes = [{id: 'root', text: '中文 brain 🧠', depth: 0, folded: false}, {id: 'one', text: '孩子', depth: 1, folded: true}];
const content = value => value.map(({id, ...node}) => node);
before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-storage-'));
  process.env.HOME = fixture;
  process.env.USERPROFILE = fixture;
});
after(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  fs.rmSync(fixture, {recursive: true, force: true});
});

test('application directory and path resolution preserve literal shell syntax and Unicode', () => {
  assert.equal(applicationDirectory(), path.join(fixture, 'Shell Mindmap'));
  assert.equal(expandPath('~'), fixture);
  assert.equal(expandPath('~/脑图 files'), path.join(fixture, '脑图 files'));
  assert.equal(expandPath('~somebody/maps', fixture), path.resolve(fixture, '~somebody/maps'));
  assert.equal(expandPath('$(touch PWNED);${HOME}`x`', fixture), path.join(fixture, '$(touch PWNED);${HOME}`x`'));
  assert.throws(() => expandPath('one\ntwo'), /路径/);
  assert.throws(() => expandPath(''), /路径/);
  assert.equal(fs.existsSync(applicationDirectory()), false);
  assert.deepEqual(listMaps(path.join(fixture, 'missing')), []);
  assert.equal(fs.existsSync(applicationDirectory()), false);
  assert.throws(() => saveMap(path.join(applicationDirectory(), 'never-created.mm'), nodes), /保存目录不存在/);
  assert.equal(fs.existsSync(applicationDirectory()), false);
  assert.equal(ensureApplicationDirectory(), applicationDirectory());
});

test('workspace defaults follow cwd without falling back to the application directory', () => {
  const previous = process.cwd();
  const first = path.join(fixture, '工作 一');
  const second = path.join(fixture, '工作 二');
  fs.mkdirSync(first); fs.mkdirSync(second);
  saveMap(path.join(first, 'first.mm'), nodes);
  saveMap(path.join(second, 'second.mm'), nodes);
  try {
    process.chdir(first);
    assert.equal(resolveSaveDirectory({saveDir: ''}), fs.realpathSync(first));
    assert.deepEqual(listMaps().map(entry => entry.name), ['first.mm']);
    process.chdir(second);
    assert.equal(resolveSaveDirectory({saveDir: ''}), fs.realpathSync(second));
    assert.deepEqual(listMaps().map(entry => entry.name), ['second.mm']);
    assert.equal(resolveSaveDirectory({saveDir: ''}, first), first);
    assert.equal(resolveSaveDirectory({saveDir: first}, second), first);
    assert.equal(resolveSaveDirectory({saveDir: applicationDirectory()}, second), applicationDirectory());
  } finally {process.chdir(previous);}
});

test('maps round trip with Chinese spaces, folding and atomic exclusive creation', () => {
  const file = path.join(applicationDirectory(), '中文 文件.mm');
  const saved = saveMap(file, nodes);
  assert.equal(saved.file, file);
  assert.equal(saved.fingerprint, fingerprint(file));
  assert.deepEqual(content(readMap(file).nodes), content(nodes));
  assert.throws(() => saveMap(file, nodes), error => error.code === 'EXISTS');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(listMaps(applicationDirectory())[0].file, file);
  assert.ok(Number.isFinite(Date.parse(listMaps(applicationDirectory())[0].modified)));
});

test('external changes and deletion reject stale saves while explicit override succeeds', () => {
  const file = path.join(fixture, 'external.mm');
  const saved = saveMap(file, nodes);
  fs.appendFileSync(file, 'external');
  const external = fs.readFileSync(file, 'utf8');
  assert.throws(() => saveMap(file, nodes, {expectedFingerprint: saved.fingerprint}), error => error.code === 'CONFLICT');
  assert.equal(fs.readFileSync(file, 'utf8'), external);
  const overridden = saveMap(file, nodes, {overwrite: true, expectedFingerprint: saved.fingerprint});
  fs.unlinkSync(file);
  assert.throws(() => saveMap(file, nodes, {expectedFingerprint: overridden.fingerprint}), error => error.code === 'CONFLICT');
  assert.equal(fs.existsSync(file), false);
});

test('failed final rename preserves the original file and cleans temporary files', () => {
  const file = path.join(fixture, 'rename.mm');
  const saved = saveMap(file, nodes);
  const original = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => {throw new Error('simulated rename failure');};
    assert.throws(() => writeTextAtomic(file, 'NEW', {expectedFingerprint: saved.fingerprint}), /simulated rename failure/);
  } finally {fs.renameSync = rename;}
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.readdirSync(fixture).some(entry => entry.startsWith('.mm-')), false);
});

test('write failure and changes during temporary write do not damage existing data', () => {
  const file = path.join(fixture, 'mid-write.mm');
  const saved = saveMap(file, nodes);
  const sync = fs.fsyncSync;
  try {
    fs.fsyncSync = () => {fs.appendFileSync(file, 'external change');};
    assert.throws(() => writeTextAtomic(file, 'NEW', {expectedFingerprint: saved.fingerprint}), error => error.code === 'CONFLICT');
    assert.match(fs.readFileSync(file, 'utf8'), /external change$/);
    fs.fsyncSync = () => {throw new Error('simulated disk full');};
    assert.throws(() => writeTextAtomic(file, 'NEW', {overwrite: true}), /disk full/);
  } finally {fs.fsyncSync = sync;}
  assert.match(fs.readFileSync(file, 'utf8'), /external change$/);
  assert.equal(fs.readdirSync(fixture).some(entry => entry.startsWith('.mm-')), false);
});

test('a concurrent first-time creator cannot be clobbered', () => {
  const file = path.join(fixture, 'create-race.md');
  const link = fs.linkSync;
  try {
    fs.linkSync = (temporary, target) => {fs.writeFileSync(target, 'other process'); return link(temporary, target);};
    assert.throws(() => writeTextAtomic(file, 'NEW'), error => error.code === 'CONFLICT');
  } finally {fs.linkSync = link;}
  assert.equal(fs.readFileSync(file, 'utf8'), 'other process');
});

test('special targets, bad parents, and invalid models are rejected before changing files', () => {
  assert.throws(() => saveMap(fixture, nodes), /目录|特殊/);
  assert.throws(() => saveMap(path.join(fixture, 'missing', 'x.mm'), nodes), /保存目录不存在/);
  const file = path.join(fixture, 'bad.mm');
  assert.throws(() => saveMap(file, []));
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, Buffer.from([0xff]));
  assert.throws(() => readMap(file), /encoded|encoding|UTF-8/);
});

test('symbolic links are refused for reading and overwriting', t => {
  const target = path.join(fixture, 'linked-target.mm');
  saveMap(target, nodes);
  const link = path.join(fixture, 'linked.mm');
  try {fs.symlinkSync(target, link);} catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('Windows symlink permission unavailable');
    throw error;
  }
  const original = fs.readFileSync(target, 'utf8');
  assert.throws(() => readMap(link), /符号链接/);
  assert.throws(() => saveMap(link, nodes, {overwrite: true}), /符号链接/);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

test('filename suggestions work on Windows and respect path component byte budgets', () => {
  assert.equal(suggestFilename('  标题 / 中文: ? test.  '), '标题 中文 test.mm');
  assert.equal(suggestFilename('CON'), '_CON.mm');
  assert.equal(suggestFilename('con.txt'), '_con.txt.mm');
  assert.equal(suggestFilename('COM¹'), '_COM¹.mm');
  assert.equal(suggestFilename('...'), '未命名脑图.mm');
  assert.equal(suggestFilename('已存在.mm'), '已存在.mm');
  assert.ok(Buffer.byteLength(suggestFilename('😀'.repeat(300))) < 255);
});
