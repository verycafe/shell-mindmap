import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {listDirectory, createBrowser, browserParent, browserTreeRows, browserFiles, navigateBrowser, expandBrowser, collapseBrowser, refreshBrowser, filterBrowser, moveBrowserSelection} from '../dist/browser.js';
import {browserLines,browserLocation} from '../dist/browser-view.js';
import {displayWidth} from '../dist/text.js';

function directory(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'smm-browser-'));
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  return folder;
}

function map(folder, name, modified = 1_000) {
  const file = path.join(folder, name);
  // Listing must not decode or parse map contents, even when a file is corrupt.
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe]));
  fs.utimesSync(file, modified, modified);
  return file;
}

test('directory listing returns immediate folders before recent maps with natural name ordering', t => {
  const folder = directory(t);
  for (const name of ['folder10', 'folder2', '工作 笔记']) fs.mkdirSync(path.join(folder, name));
  map(path.join(folder, '工作 笔记'), 'nested.mm', 9_000);
  map(folder, 'older.mm', 1_000);
  map(folder, 'map10.mm', 2_000);
  map(folder, 'map2.mm', 2_000);
  const latest = map(folder, '中文 🧠.MM', 3_000);
  fs.writeFileSync(path.join(folder, 'readme.md'), '# title');
  fs.writeFileSync(path.join(folder, 'map.mm.bak'), 'backup');
  const entries = listDirectory(folder);
  assert.deepEqual(entries.filter(entry => entry.kind === 'directory').map(entry => entry.name), ['folder2', 'folder10', '工作 笔记']);
  assert.deepEqual(entries.filter(entry => entry.kind === 'file').map(entry => entry.name), ['中文 🧠.MM', 'map2.mm', 'map10.mm', 'older.mm']);
  assert.deepEqual(entries.map(entry => entry.kind), ['directory', 'directory', 'directory', 'file', 'file', 'file', 'file']);
  assert.equal(entries[3].file, latest);
  assert.equal(entries[3].modified, new Date(3_000_000).toISOString());
  assert.equal(entries.some(entry => entry.name === 'nested.mm'), false);
});

test('hidden entries appear only with showHidden, including hidden directories', t => {
  const folder = directory(t);
  fs.mkdirSync(path.join(folder, '.private'));
  fs.mkdirSync(path.join(folder, 'visible'));
  map(folder, '.draft.mm');
  map(folder, 'visible.mm');
  fs.writeFileSync(path.join(folder, '.notes.md'), 'not a map');
  assert.deepEqual(listDirectory(folder).map(entry => entry.name), ['visible', 'visible.mm']);
  assert.deepEqual(listDirectory(folder, true).map(entry => entry.name), ['.private', 'visible', '.draft.mm', 'visible.mm']);
});

test('relative directory paths and home paths are expanded without changing the process directory', t => {
  const folder = directory(t);
  fs.mkdirSync(path.join(folder, '中文 空格'));
  map(path.join(folder, '中文 空格'), 'brain.mm');
  const cwd = process.cwd();
  assert.equal(listDirectory(path.relative(cwd, path.join(folder, '中文 空格')))[0].file, path.join(folder, '中文 空格', 'brain.mm'));
  assert.equal(process.cwd(), cwd);
  assert.deepEqual(listDirectory('~'), listDirectory(os.homedir()));
});

test('empty folders return no entries while missing directories and file paths report errors', t => {
  const folder = directory(t);
  assert.deepEqual(listDirectory(folder), []);
  assert.throws(() => listDirectory(path.join(folder, 'missing')), error => error.code === 'ENOENT' && error.message.includes('目录不存在'));
  const file = map(folder, 'file.mm');
  assert.throws(() => listDirectory(file), error => error.code === 'INVALID_PATH' && error.message.includes('目录'));
  assert.throws(() => listDirectory(''), error => error.code === 'INVALID_PATH');
  assert.throws(() => listDirectory('one\ntwo'), error => error.code === 'INVALID_PATH');
});

test('filesystem roots are accepted without introducing synthetic parent entries', () => {
  const root = path.parse(process.cwd()).root;
  const entries = listDirectory(root);
  assert.equal(entries.some(entry => entry.name === '..' || entry.name === '.'), false);
  assert.ok(entries.every(entry => path.dirname(entry.file) === root));
  const state = createBrowser(root);
  assert.equal(browserParent(state), undefined);
  assert.equal(browserTreeRows(state).some(row => row.kind === 'parent'), false);
  assert.equal(moveBrowserSelection({...state, focus: 'directories'}, 'first').selectedDirectory, root);
});

test('symbolic links are omitted and symbolic-link browser paths are rejected', t => {
  const folder = directory(t);
  fs.mkdirSync(path.join(folder, 'real'));
  const file = map(folder, 'real.mm');
  try {
    fs.symlinkSync(file, path.join(folder, 'linked.mm'));
    fs.symlinkSync(path.join(folder, 'real'), path.join(folder, 'linked-folder'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('Windows symlink permission unavailable');
    throw error;
  }
  assert.deepEqual(listDirectory(folder).map(entry => entry.name), ['real', 'real.mm']);
  assert.throws(() => listDirectory(path.join(folder, 'linked-folder')), error => error.code === 'INVALID_PATH');
});

test('entries removed during listing are skipped but stat permission errors propagate', t => {
  const folder = directory(t);
  const gone = map(folder, 'gone.mm');
  const kept = map(folder, 'kept.mm');
  const lstat = fs.lstatSync;
  try {
    fs.lstatSync = (target, ...options) => {
      if (target === gone) throw Object.assign(new Error('vanished'), {code: 'ENOENT'});
      return lstat(target, ...options);
    };
    assert.deepEqual(listDirectory(folder).map(entry => entry.file), [kept]);
    fs.lstatSync = (target, ...options) => {
      if (target === gone) throw Object.assign(new Error('stat denied'), {code: 'EACCES'});
      return lstat(target, ...options);
    };
    assert.throws(() => listDirectory(folder), error => error.code === 'EACCES' && error.message === 'stat denied');
  } finally {fs.lstatSync = lstat;}
});

test('unrelated system files are not statted while candidate metadata errors remain visible', t => {
  const folder = directory(t);
  const systemFile = path.join(folder, 'DumpStack.log.tmp');
  fs.writeFileSync(systemFile, 'system file');
  const child = path.join(folder, 'notes');
  fs.mkdirSync(child);
  const file = map(folder, 'visible.MM');
  const lstat = fs.lstatSync;
  const reads = [];
  let failing = systemFile;
  try {
    fs.lstatSync = (target, ...options) => {
      reads.push(target);
      if (target === failing) throw Object.assign(new Error('invalid metadata'), {code: 'EINVAL'});
      return lstat(target, ...options);
    };
    assert.deepEqual(listDirectory(folder).map(entry => entry.file), [child, file]);
    assert.equal(reads.includes(systemFile), false);
    for (const candidate of [child, file, folder]) {
      failing = candidate;
      assert.throws(() => listDirectory(folder), error => error.code === 'EINVAL');
    }
  } finally {fs.lstatSync = lstat;}
});

test('directory read errors are not disguised as an empty directory', t => {
  const folder = directory(t);
  const readdir = fs.readdirSync;
  try {
    fs.readdirSync = (target, ...options) => {
      if (target === folder) throw Object.assign(new Error('read denied'), {code: 'EACCES'});
      return readdir(target, ...options);
    };
    assert.throws(() => listDirectory(folder), error => error.code === 'EACCES' && error.message === 'read denied');
  } finally {fs.readdirSync = readdir;}
});

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props.children);
}

test('100 directories do not trigger recursive reads or displace the separate maps pane', t => {
  const folder = directory(t);
  for (let i = 0; i < 100; i++) fs.mkdirSync(path.join(folder, 'folder' + i));
  fs.mkdirSync(path.join(folder, 'folder0', 'unopened'));
  const file = map(folder, '研究计划.mm');
  const reads = [];
  const read = fs.readdirSync;
  let state;
  try {
    fs.readdirSync = (target, ...options) => {reads.push(target); return read(target, ...options);};
    state = createBrowser(folder);
  } finally {fs.readdirSync = read;}
  assert.deepEqual(reads, [folder]);
  assert.deepEqual(Object.keys(state.entries), [folder]);
  assert.equal(state.focus, 'files');
  assert.equal(browserTreeRows(state).length, 102);
  assert.equal(browserFiles(state)[0].file, file);
  const lines = browserLines(state, 100, 10).map(textOf);
  assert.equal(lines.length, 10);
  assert.ok(lines[1].includes('研究计划.mm'));
  state = moveBrowserSelection({...state, focus: 'directories'}, 'last');
  assert.equal(path.basename(state.selectedDirectory), 'folder99');
  const scrolled = browserLines(state, 100, 10).map(textOf);
  assert.ok(scrolled[8].includes('folder99'));
  assert.ok(scrolled[1].includes('研究计划.mm'));
  assert.match(scrolled[9], /102.*脑图 1–1 \/ 1/u);
});

test('the parent entry leaves the launch anchor without scanning parents or changing the initial selection', t => {
  const parent = directory(t);
  const folder = path.join(parent, '一级');
  const child = path.join(folder, '二级');
  fs.mkdirSync(child, {recursive: true});
  fs.mkdirSync(path.join(parent, '其他目录'));
  map(parent, '上级脑图.mm');
  const read = fs.readdirSync;
  const reads = [];
  let state;
  try {
    fs.readdirSync = (target, ...options) => {reads.push(target); return read(target, ...options);};
    state = createBrowser(folder);
    assert.equal(state.selectedDirectory, folder);
    assert.equal(browserParent(state), parent);
    const rows = browserTreeRows(state);
    assert.deepEqual(rows.map(row => row.kind), ['parent', 'directory', 'directory']);
    assert.equal(rows[0].file, parent);
    assert.equal(rows[0].name, path.basename(parent));
    assert.equal(rows[0].current, false);
    assert.equal(rows[1].current, true);
    assert.deepEqual(reads, [folder]);
    state = navigateBrowser(state, child);
    assert.equal(browserParent(state), parent);
    assert.equal(browserTreeRows(state)[0].file, parent);
    state = moveBrowserSelection({...state, focus: 'directories'}, 'first');
    assert.equal(state.selectedDirectory, parent);
    state = navigateBrowser(state, state.selectedDirectory);
    assert.equal(state.root, parent);
    assert.equal(state.directory, parent);
    assert.equal(browserFiles(state)[0].name, '上级脑图.mm');
    assert.deepEqual(reads, [folder, child, parent]);
    assert.deepEqual(Object.keys(state.entries), [parent]);
  } finally {fs.readdirSync = read;}
  const lines = browserLines(createBrowser(folder), 100, 10).map(textOf);
  assert.ok(lines.some(line => line.includes('.. 上级目录')));
});

test('filtering retains the parent escape entry without treating it as a name match or reading it', t => {
  const parent = directory(t);
  const folder = path.join(parent, 'workspace');
  fs.mkdirSync(folder);
  map(folder, path.basename(parent) + '.mm');
  const original = createBrowser(folder);
  const read = fs.readdirSync;
  try {
    fs.readdirSync = () => {throw new Error('parent filtering and expansion must not read directories');};
    const filtered = filterBrowser({...original, focus: 'directories'}, path.basename(parent));
    assert.equal(filtered.focus, 'files');
    assert.equal(filtered.selectedDirectory, folder);
    assert.deepEqual(browserTreeRows(filtered).map(row => row.file), [parent, folder]);
    const selectedParent = moveBrowserSelection({...filtered, focus: 'directories'}, 'first');
    assert.equal(selectedParent.selectedDirectory, parent);
    const cleared = filterBrowser(selectedParent, '');
    assert.equal(cleared.selectedDirectory, parent);
    assert.deepEqual(cleared.expanded, original.expanded);
    assert.throws(() => expandBrowser(cleared, parent), error => error.code === 'INVALID_PATH');
    assert.throws(() => collapseBrowser(cleared, parent), error => error.code === 'INVALID_PATH');
    assert.equal(filterBrowser(original, 'no-matches').selectedDirectory, folder);
  } finally {fs.readdirSync = read;}
  const selectedParent = moveBrowserSelection({...original, focus: 'directories'}, 'first');
  assert.equal(refreshBrowser(selectedParent).selectedDirectory, parent);
});

test('tree expand, navigate and collapse preserve hierarchy, anchor and the open directory independently', t => {
  const folder = directory(t);
  const child = path.join(folder, '一级');
  const grandchild = path.join(child, '二级');
  fs.mkdirSync(grandchild, {recursive: true});
  fs.mkdirSync(path.join(child, '末项'));
  map(grandchild, '二级脑图.mm');
  const original = createBrowser(folder);
  let state = expandBrowser(original, child);
  assert.deepEqual(Object.keys(original.entries), [folder]);
  assert.deepEqual(Object.keys(state.entries), [folder, child]);
  assert.equal(state.directory, folder);
  const row = browserTreeRows(state).find(row => row.file === grandchild);
  assert.equal(row.depth, 2);
  assert.match(row.prefix, /[├└]─ /u);
  state = navigateBrowser(state, grandchild);
  assert.equal(state.root, folder);
  assert.equal(state.directory, grandchild);
  assert.equal(state.selectedDirectory, grandchild);
  assert.equal(state.focus, 'files');
  assert.ok(browserTreeRows(state).find(row => row.file === grandchild).current);
  const closed = collapseBrowser(state, child);
  assert.equal(closed.directory, grandchild);
  assert.equal(closed.selectedDirectory, child);
  assert.equal(browserTreeRows(closed).some(row => row.file === grandchild), false);
  assert.equal(browserFiles(closed)[0].name, '二级脑图.mm');
  assert.equal(expandBrowser(closed, child).directory, grandchild);
  const parent = navigateBrowser(state, path.dirname(folder));
  assert.equal(parent.root, path.dirname(folder));
  assert.equal(parent.directory, path.dirname(folder));
});

test('filtering loaded branches retains ancestor context without reading additional folders', t => {
  const folder = directory(t);
  const child = path.join(folder, 'parent');
  fs.mkdirSync(path.join(child, 'Target 中文'), {recursive: true});
  fs.mkdirSync(path.join(folder, 'unloaded'));
  map(folder, 'TARGET 计划.mm');
  map(folder, 'other.mm');
  const state = collapseBrowser(expandBrowser(createBrowser(folder), child), child);
  const read = fs.readdirSync;
  let filtered;
  try {
    fs.readdirSync = () => {throw new Error('filter must not read directories');};
    filtered = filterBrowser(state, 'target');
    assert.deepEqual(browserTreeRows(filtered).map(row => row.name), [path.basename(path.dirname(folder)), path.basename(folder), 'parent', 'Target 中文']);
  } finally {fs.readdirSync = read;}
  assert.equal(browserFiles(filtered).length, 1);
  assert.equal(browserFiles(filtered)[0].name, 'TARGET 计划.mm');
  assert.deepEqual(browserTreeRows(filterBrowser(state, 'not found')).map(row => row.file), [path.dirname(folder), folder]);
  assert.equal(browserFiles(filterBrowser(state, 'not found')).length, 0);
  assert.equal(browserFiles(filterBrowser(filtered, '')).length, 2);
});

test('selection bounds and pane selection remain independent', t => {
  const folder = directory(t);
  fs.mkdirSync(path.join(folder, 'child'));
  for (const name of ['one.mm', 'two.mm', 'three.mm']) map(folder, name);
  const state = createBrowser(folder);
  const bottom = moveBrowserSelection(state, 'last');
  assert.equal(bottom.fileIndex, 2);
  assert.equal(bottom.selectedDirectory, folder);
  assert.equal(moveBrowserSelection(bottom, 100).fileIndex, 2);
  assert.equal(moveBrowserSelection(bottom, -100).fileIndex, 0);
  const directoryBottom = moveBrowserSelection({...bottom, focus: 'directories'}, 'last');
  assert.equal(directoryBottom.selectedDirectory, path.join(folder, 'child'));
  assert.equal(directoryBottom.fileIndex, 2);
  assert.equal(moveBrowserSelection(directoryBottom, 'first').selectedDirectory, path.dirname(folder));
});

test('failed navigation or expansion leaves the source state untouched', t => {
  const folder = directory(t);
  const child = path.join(folder, 'child');
  fs.mkdirSync(child);
  const state = createBrowser(folder);
  const before = JSON.stringify(state);
  fs.rmdirSync(child);
  assert.throws(() => navigateBrowser(state, child), error => error.code === 'ENOENT');
  assert.throws(() => expandBrowser(state, child), error => error.code === 'ENOENT');
  assert.throws(() => expandBrowser(state, path.dirname(folder)), error => error.code === 'INVALID_PATH');
  assert.equal(JSON.stringify(state), before);
  assert.equal(browserTreeRows(refreshBrowser(state)).length, 2);
});

test('refresh updates visible branches and hidden entries while retaining the location of an active hidden directory', t => {
  const folder = directory(t);
  const hidden = path.join(folder, '.private');
  fs.mkdirSync(hidden);
  map(hidden, '秘密.mm');
  map(folder, '.draft.mm');
  let state = refreshBrowser(createBrowser(folder), true);
  assert.equal(browserFiles(state)[0].name, '.draft.mm');
  state = navigateBrowser(state, hidden);
  state = refreshBrowser(state, false);
  assert.equal(state.directory, hidden);
  assert.equal(browserFiles(state)[0].name, '秘密.mm');
  assert.equal(browserTreeRows(state).find(row => row.file === hidden).current, true);
  fs.mkdirSync(path.join(hidden, 'new'));
  assert.equal(browserTreeRows(state).some(row => row.name === 'new'), false);
  const refreshed = refreshBrowser(state);
  assert.equal(browserTreeRows(refreshed).some(row => row.name === 'new'), true);
});

test('rendering respects exact height, display columns and sanitized Unicode names at every pane size', t => {
  const folder = directory(t);
  const child = path.join(folder, '研究🧠 子目录');
  fs.mkdirSync(child);
  map(folder, '长长长长长长长长👩‍💻计划.mm');
  // POSIX file names may contain line breaks and terminal controls.
  if (process.platform !== 'win32') map(folder, 'test\n\x1b[31mfile.mm');
  let state = createBrowser(folder);
  for (const width of [48, 77, 78, 80, 120]) {
    for (const height of [0, 1, 2, 3, 12]) {
      const lines = browserLines(state, width, height).map(textOf);
      assert.equal(lines.length, height);
      for (const line of lines) {
        assert.equal(displayWidth(line), width);
        assert.doesNotMatch(line, /[\n\r\x1b]/u);
      }
    }
  }
  const files = browserLines(state, 48, 8).map(textOf).join('\n');
  assert.match(files, /Tab 切换/u);
  assert.match(files, /计划.mm/u);
  state = {...state, focus: 'directories'};
  assert.match(browserLines(state, 48, 8).map(textOf).join('\n'), /研究🧠 子目录/u);
  assert.match(browserLines(state, 48, 8).map(textOf).join('\n'), /\[当前\]/u);
});

test('directory filtering selects a real matching directory rather than its retained ancestors', t => {
  const folder = directory(t);
  const parent = path.join(folder, 'context-parent');
  const first = path.join(parent, '匹配1');
  const second = path.join(parent, '匹配2');
  fs.mkdirSync(first, {recursive: true});
  fs.mkdirSync(second);
  map(folder, 'visible.mm');
  const original = collapseBrowser(expandBrowser(createBrowser(folder), parent), parent);
  assert.equal(original.focus, 'files');
  let state = filterBrowser(original, '匹配');
  assert.equal(state.focus, 'directories');
  assert.equal(state.selectedDirectory, first);
  assert.deepEqual(browserTreeRows(state).map(row => row.file), [path.dirname(folder), folder, parent, first, second]);
  state = {...state, selectedDirectory: second};
  assert.equal(filterBrowser(state, '匹配').selectedDirectory, second);
  assert.equal(filterBrowser(state, '匹配1').selectedDirectory, first);
  const cleared = filterBrowser(state, '');
  assert.equal(cleared.focus, 'directories');
  assert.equal(cleared.selectedDirectory, second);
  assert.ok(browserTreeRows(cleared).some(row => row.file === second));
  assert.equal(cleared.directory, folder);
});

test('filtering switches away from an empty pane and preserves matching file selection by identity', t => {
  const folder = directory(t);
  fs.mkdirSync(path.join(folder, 'shared-folder'));
  map(folder, 'a-file.mm');
  map(folder, 'shared-one.mm');
  const second = map(folder, 'shared-two.mm');
  let state = createBrowser(folder);
  state.fileIndex = browserFiles(state).findIndex(entry => entry.file === second);
  state = filterBrowser(state, 'shared');
  assert.equal(state.focus, 'files');
  assert.equal(browserFiles(state)[state.fileIndex].file, second);
  state = filterBrowser({...state, focus: 'directories'}, 'shared');
  assert.equal(state.focus, 'directories');
  state = filterBrowser(state, 'shared-');
  assert.equal(state.focus, 'directories');
  state = filterBrowser(state, 'shared-t');
  assert.equal(state.focus, 'files');
  assert.equal(browserFiles(state)[state.fileIndex].file, second);
  state = filterBrowser(state, '');
  assert.equal(state.focus, 'files');
  assert.equal(browserFiles(state)[state.fileIndex].file, second);
});

test('expanding a directory in a long tree leaves its children visible below the selection', t => {
  const folder = directory(t);
  for (let i = 0; i < 100; i++) fs.mkdirSync(path.join(folder, 'folder' + i));
  const selected = path.join(folder, 'folder49');
  fs.mkdirSync(path.join(selected, 'Nested'));
  let state = createBrowser(folder);
  state = expandBrowser({...state, selectedDirectory: selected, focus: 'directories'}, selected);
  for (const width of [48, 100]) {
    const lines = browserLines(state, width, 10).map(textOf);
    const parentRow = lines.findIndex(line => line.includes('folder49'));
    const childRow = lines.findIndex(line => line.includes('Nested'));
    assert.ok(parentRow >= 1 && parentRow < 8);
    assert.ok(childRow > parentRow && childRow < 9);
    assert.ok(lines[parentRow].includes('›'));
  }
});

test('long browser paths retain the current folder and the active filter at narrow widths', () => {
  const directory = '/很长的目录/'.repeat(20) + 'Folder29';
  for (const width of [46, 78, 98]) {
    const plain = browserLocation(directory, '', width);
    assert.ok(plain.startsWith('…'));
    assert.ok(plain.endsWith('Folder29'));
    const filtered = browserLocation(directory, 'UnloadedNeedle', width);
    assert.ok(filtered.includes('筛选：UnloadedNeedle'));
    assert.ok(filtered.endsWith('Folder29'));
    assert.ok(displayWidth(plain) <= width);
    assert.ok(displayWidth(filtered) <= width);
    assert.ok(displayWidth(browserLocation(directory, '长筛选🧠'.repeat(30), width)) <= width);
  }
});
