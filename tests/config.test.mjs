import test, {after, before, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configEntries, configPath, defaultConfig, loadConfig, resetConfig, saveConfig, setConfig} from '../dist/config.js';
import {applicationDirectory, resolveSaveDirectory} from '../dist/storage.js';

let fixture;
const environment = Object.fromEntries(['HOME', 'USERPROFILE', 'MM_CONFIG_FILE', 'XDG_CONFIG_HOME'].map(key => [key, process.env[key]]));
before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-config-'));
  process.env.HOME = fixture;
  process.env.USERPROFILE = fixture;
  process.env.XDG_CONFIG_HOME = path.join(fixture, 'xdg');
});
beforeEach(() => {process.env.MM_CONFIG_FILE = path.join(fixture, 'current', 'config.json'); fs.rmSync(path.join(fixture, 'current'), {recursive: true, force: true});});
after(() => {
  for (const [key, value] of Object.entries(environment)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}
  fs.rmSync(fixture, {recursive: true, force: true});
});

test('default configuration is independent and read-only when absent', () => {
  const initial = loadConfig();
  assert.equal(initial.version, 2);
  assert.equal(initial.saveDir, '');
  assert.equal(configEntries(initial)['save-dir'], '');
  assert.equal(initial.nodeWidth, 32);
  assert.equal(initial.layout, 'right');
  assert.equal(initial.keys.child, 'Tab');
  initial.keys.child = 'x';
  assert.equal(defaultConfig().keys.child, 'Tab');
  assert.equal(fs.existsSync(configPath()), false);
  assert.equal(fs.existsSync(applicationDirectory()), false);
});

test('settings candidates validate and only explicit save persists', () => {
  const initial = defaultConfig();
  const candidate = setConfig(setConfig(initial, 'node-width', '08'), 'layout', 'bilateral');
  assert.equal(candidate.nodeWidth, 8);
  assert.equal(initial.nodeWidth, 32);
  assert.equal(candidate.layout, 'bilateral');
  assert.equal(fs.existsSync(configPath()), false);
  saveConfig(candidate);
  assert.deepEqual(loadConfig(), candidate);
  if (process.platform !== 'win32') assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
  assert.equal(configEntries(candidate)['key.save-as'], 'S');
});

test('key conflicts, reserved keys, unknown keys and malformed values are rejected', () => {
  const config = defaultConfig();
  for (const [key, value] of [['key.child', 'e'], ['key.edit', ':'], ['key.edit', '：'], ['key.edit', '？'], ['key.edit', 'F1'], ['key.edit', 'gg'], ['key.edit', '\t'], ['key.edit', '\x1b'], ['key.unknown', 'x'], ['unknown', 'value'], ['node-width', '81'], ['node-width', '7'], ['node-width', '8+1'], ['node-width', '99999999'], ['layout', 'tree']]) {
    assert.throws(() => setConfig(config, key, value), undefined, key + '=' + value);
  }
  assert.equal(setConfig(config, 'key.search', '').keys.search, '');
  assert.equal(setConfig(config, 'key.edit', '编').keys.edit, '编');
  const movedHelp = setConfig(config, 'key.help', 'F1');
  const swapped = setConfig(movedHelp, 'key.edit', '?');
  assert.throws(() => resetConfig(swapped, 'key.help'), /冲突/);
  assert.equal(resetConfig(swapped, 'keys').keys.help, '?');
  assert.equal(resetConfig(swapped, 'keys').keys.edit, 'e');
});

test('slash stays reserved while search supports f, Ctrl+f and unbound primary keys', () => {
  const initial = defaultConfig();
  assert.equal(initial.keys.search, 'f');
  for (const action of Object.keys(initial.keys)) {
    assert.throws(() => setConfig(initial, 'key.' + action, '/'), /固定入口/);
    assert.equal(setConfig(initial, 'key.' + action, '').keys[action], '');
  }
  const candidate = setConfig(initial, 'key.search', 'Ctrl+f');
  saveConfig(candidate);
  assert.deepEqual(loadConfig(), candidate);
  assert.throws(() => setConfig(candidate, 'key.edit', 'Ctrl+f'), /快捷键冲突/);
  assert.throws(() => setConfig(initial, 'key.edit', 'f'), /快捷键冲突/);
  assert.throws(() => saveConfig({...initial, keys: {...initial.keys, search: '/'}}), /固定入口/);
  assert.deepEqual(loadConfig(), candidate);
});

for (const version of [1, 2]) {
  test(`old JSON v${version} slash search reads without mutation and migrates with exact backup`, () => {
    fs.mkdirSync(path.dirname(configPath()), {recursive: true});
    const old = defaultConfig();
    old.keys.search = '/';
    const original = JSON.stringify({...old, version});
    fs.writeFileSync(configPath(), original);
    const read = loadConfig();
    assert.equal(read.keys.search, 'f');
    assert.equal(fs.readFileSync(configPath(), 'utf8'), original);
    assert.equal(fs.readdirSync(path.dirname(configPath())).length, 1);
    assert.deepEqual(loadConfig({migrate: true}), read);
    const files = fs.readdirSync(path.dirname(configPath()));
    const backup = files.find(name => name.startsWith('config.json.backup-'));
    assert.equal(fs.readFileSync(path.join(path.dirname(configPath()), backup), 'utf8'), original);
    const persisted = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    assert.equal(persisted.version, 2);
    assert.equal(persisted.keys.search, 'f');
    loadConfig({migrate: true});
    assert.deepEqual(fs.readdirSync(path.dirname(configPath())), files);
  });
}

test('slash migration preserves an existing f action and cancels other slash bindings', () => {
  fs.mkdirSync(path.dirname(configPath()), {recursive: true});
  const old = defaultConfig();
  old.keys.search = '/'; old.keys.edit = 'f'; old.keys.help = '/';
  const original = JSON.stringify(old);
  fs.writeFileSync(configPath(), original);
  const loaded = loadConfig();
  assert.equal(loaded.keys.search, '');
  assert.equal(loaded.keys.help, '');
  assert.equal(loaded.keys.edit, 'f');
  assert.equal(fs.readFileSync(configPath(), 'utf8'), original);
  saveConfig(setConfig(loaded, 'node-width', '48'));
  const backup = fs.readdirSync(path.dirname(configPath())).find(name => name.includes('.backup-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(configPath()), backup), 'utf8'), original);
  assert.equal(loadConfig().keys.help, '');
  assert.equal(loadConfig().keys.search, '');
  assert.equal(loadConfig().keys.edit, 'f');
  assert.equal(loadConfig().nodeWidth, 48);
});

test('non-slash custom search is preserved while other deprecated slash keys are cancelled', () => {
  fs.mkdirSync(path.dirname(configPath()), {recursive: true});
  const old = defaultConfig(); old.keys.search = 'F'; old.keys.help = '/';
  fs.writeFileSync(configPath(), JSON.stringify(old));
  assert.equal(loadConfig({migrate: true}).keys.search, 'F');
  assert.equal(loadConfig().keys.help, '');
});

test('legacy MM-CONFIG slash search and old primary slash bindings migrate safely', () => {
  fs.mkdirSync(path.dirname(configPath()), {recursive: true});
  const original = 'MM-CONFIG-1\nkey.search\t/\nkey.help\t/\nkey.edit\tf';
  fs.writeFileSync(configPath(), original);
  const candidate = loadConfig();
  assert.equal(candidate.keys.search, '');
  assert.equal(candidate.keys.help, '');
  assert.equal(candidate.keys.edit, 'f');
  assert.equal(fs.readFileSync(configPath(), 'utf8'), original);
  loadConfig({migrate: true});
  const backup = fs.readdirSync(path.dirname(configPath())).find(name => name.includes('.backup-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(configPath()), backup), 'utf8'), original);
  assert.equal(JSON.parse(fs.readFileSync(configPath(), 'utf8')).keys.search, '');
});

test('failed slash migration leaves the source intact and keeps its backup', () => {
  fs.mkdirSync(path.dirname(configPath()), {recursive: true});
  const old = defaultConfig(); old.keys.search = '/';
  const original = JSON.stringify(old); fs.writeFileSync(configPath(), original);
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => {throw new Error('slash migration rename failed');};
    assert.throws(() => loadConfig({migrate: true}), /slash migration rename failed/);
  } finally {fs.renameSync = rename;}
  assert.equal(fs.readFileSync(configPath(), 'utf8'), original);
  const backup = fs.readdirSync(path.dirname(configPath())).find(name => name.includes('.backup-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(configPath()), backup), 'utf8'), original);
});

test('pan keys accept shifted arrows and reject primary binding conflicts', () => {
  const initial = defaultConfig();
  let candidate = initial;
  for (const [action, alias] of [['pan-left', 'Shift+Left'], ['pan-right', 'Shift+Right'], ['pan-up', 'Shift+Up'], ['pan-down', 'Shift+Down']]) {
    candidate = setConfig(candidate, 'key.' + action, alias);
  }
  saveConfig(candidate);
  assert.deepEqual(loadConfig(), candidate);
  assert.throws(() => setConfig(initial, 'key.pan-left', 'L'), /快捷键冲突.*pan-right.*pan-left/);
  assert.throws(() => setConfig(candidate, 'key.edit', 'Shift+Left'), /快捷键冲突.*pan-left.*edit/);
  assert.throws(() => setConfig(initial, 'key.pan-left', 'Shift+PageUp'), /单个可见字符或命名按键/);
  assert.equal(initial.keys['pan-left'], 'H');
  assert.equal(initial.keys['pan-right'], 'L');
  assert.equal(initial.keys['pan-up'], 'K');
  assert.equal(initial.keys['pan-down'], 'J');
  assert.deepEqual(loadConfig(), candidate);
});

test('older v2 config keeps a custom H help binding and disables only conflicting new pan keys', () => {
  fs.mkdirSync(path.dirname(configPath()), {recursive: true});
  const older = defaultConfig();
  for (const action of ['pan-left', 'pan-right', 'pan-up', 'pan-down']) delete older.keys[action];
  older.keys.help = 'H';
  const original = JSON.stringify(older);
  fs.writeFileSync(configPath(), original);
  const loaded = loadConfig();
  assert.equal(loaded.keys.help, 'H');
  assert.equal(loaded.keys['pan-left'], '');
  assert.equal(loaded.keys['pan-right'], 'L');
  assert.equal(loaded.keys['pan-up'], 'K');
  assert.equal(loaded.keys['pan-down'], 'J');
  assert.equal(fs.readFileSync(configPath(), 'utf8'), original);
  assert.throws(() => setConfig(loaded, 'key.pan-left', 'H'), /冲突/);
  saveConfig(loaded);
  assert.deepEqual(loadConfig(), loaded);
});

test('save-dir keeps explicit Unicode paths and empty/reset means workspace without creating directories', () => {
  const directory = path.join(fixture, '脑图 files');
  fs.mkdirSync(directory);
  assert.equal(setConfig(defaultConfig(), 'save-dir', directory).saveDir, directory);
  assert.equal(setConfig(defaultConfig(), 'save-dir', '.').saveDir, process.cwd());
  assert.throws(() => setConfig(defaultConfig(), 'save-dir', path.join(fixture, 'missing')), /现存且可写/);
  assert.equal(fs.existsSync(path.join(fixture, 'missing')), false);
  assert.throws(() => setConfig(defaultConfig(), 'save-dir', '/one\ntwo'), /控制字符/);
  assert.equal(setConfig(defaultConfig(), 'save-dir', '').saveDir, '');
  assert.equal(resetConfig(setConfig(defaultConfig(), 'save-dir', directory), 'save-dir').saveDir, '');
  assert.equal(fs.existsSync(applicationDirectory()), false);
  assert.throws(() => setConfig(defaultConfig(), 'save-dir', applicationDirectory()), /现存且可写/);
  assert.equal(fs.existsSync(applicationDirectory()), false);
});

test('persisted empty save-dir resolves separately for every launch workspace', () => {
  const previous = process.cwd();
  const first = path.join(fixture, '项目 一');
  const second = path.join(fixture, '项目 二');
  fs.mkdirSync(first); fs.mkdirSync(second);
  try {
    process.chdir(first);
    saveConfig(defaultConfig());
    assert.equal(resolveSaveDirectory(loadConfig()), fs.realpathSync(first));
    process.chdir(second);
    assert.equal(loadConfig().saveDir, '');
    assert.equal(resolveSaveDirectory(loadConfig()), fs.realpathSync(second));
    assert.equal(JSON.parse(fs.readFileSync(configPath(), 'utf8')).saveDir, '');
  } finally {process.chdir(previous);}
});

test('legacy config migrates atomically, preserves old input, and disables conflicting additions', () => {
  fs.mkdirSync(path.dirname(configPath()), {recursive: true});
  const legacy = 'MM-CONFIG-1\nsave-dir\t\nnode-width\t48\nkey.edit\tc';
  fs.writeFileSync(configPath(), legacy);
  const initial = loadConfig();
  assert.equal(initial.saveDir, '');
  assert.equal(initial.nodeWidth, 48);
  assert.equal(initial.keys.edit, 'c');
  assert.equal(initial.keys.copy, '');
  assert.equal(fs.readFileSync(configPath(), 'utf8'), legacy);
  assert.deepEqual(loadConfig({migrate: true}), initial);
  assert.equal(JSON.parse(fs.readFileSync(configPath(), 'utf8')).version, 2);
  const backup = fs.readdirSync(path.dirname(configPath())).find(name => name.startsWith('config.json.backup-'));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(path.dirname(configPath()), backup), 'utf8'), legacy);
});

test('v1 default application path upgrades read-only, then migrates with an exact backup', () => {
  fs.mkdirSync(path.dirname(configPath()), {recursive: true});
  fs.mkdirSync(applicationDirectory(), {recursive: true});
  const existingMap = path.join(applicationDirectory(), '已有脑图.mm');
  fs.writeFileSync(existingMap, 'MM-ZSH-1\n0\t0\t已有内容\n');
  const old = JSON.stringify({...defaultConfig(), version: 1, saveDir: applicationDirectory(), nodeWidth: 44});
  fs.writeFileSync(configPath(), old);
  assert.equal(loadConfig().version, 2);
  assert.equal(loadConfig().saveDir, '');
  assert.equal(loadConfig().nodeWidth, 44);
  assert.equal(fs.readFileSync(configPath(), 'utf8'), old);
  assert.equal(fs.readdirSync(path.dirname(configPath())).length, 1);
  loadConfig({migrate: true});
  const migrated = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.saveDir, '');
  const files = fs.readdirSync(path.dirname(configPath()));
  const backup = files.find(name => name.startsWith('config.json.backup-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(configPath()), backup), 'utf8'), old);
  loadConfig({migrate: true});
  assert.deepEqual(fs.readdirSync(path.dirname(configPath())), files);
  assert.equal(fs.readFileSync(existingMap, 'utf8'), 'MM-ZSH-1\n0\t0\t已有内容\n');
});

test('v1 custom paths and v2 explicit application-directory overrides are preserved', () => {
  fs.mkdirSync(path.dirname(configPath()), {recursive: true});
  const custom = path.join(fixture, 'custom-missing');
  fs.writeFileSync(configPath(), JSON.stringify({...defaultConfig(), version: 1, saveDir: custom}));
  assert.equal(loadConfig({migrate: true}).saveDir, custom);
  const explicit = setConfig(defaultConfig(), 'save-dir', applicationDirectory());
  saveConfig(explicit);
  assert.equal(loadConfig({migrate: true}).saveDir, applicationDirectory());
  assert.equal(JSON.parse(fs.readFileSync(configPath(), 'utf8')).saveDir, applicationDirectory());
});

test('legacy explicit application-directory override stays explicit after migration', () => {
  fs.mkdirSync(path.dirname(configPath()), {recursive: true});
  fs.writeFileSync(configPath(), 'MM-CONFIG-1\nsave-dir\t' + applicationDirectory());
  assert.equal(loadConfig({migrate: true}).saveDir, applicationDirectory());
  assert.equal(JSON.parse(fs.readFileSync(configPath(), 'utf8')).version, 2);
});

test('XDG legacy config is read without writing, then copied to the fixed default location', () => {
  delete process.env.MM_CONFIG_FILE;
  fs.rmSync(path.join(applicationDirectory(), '.app'), {recursive: true, force: true});
  const old = path.join(process.env.XDG_CONFIG_HOME, 'mm', 'config');
  fs.mkdirSync(path.dirname(old), {recursive: true});
  fs.writeFileSync(old, 'MM-CONFIG-1\nnode-width\t44\nsave-dir\t' + path.join(fixture, 'no-longer-present'));
  assert.equal(loadConfig().nodeWidth, 44);
  assert.equal(fs.existsSync(configPath()), false);
  loadConfig({migrate: true});
  assert.equal(configPath(), path.join(applicationDirectory(), '.app', 'config.json'));
  assert.equal(fs.existsSync(old), true);
  assert.equal(loadConfig().saveDir, path.join(fixture, 'no-longer-present'));
});

test('broken config never silently overwrites and explicit reset keeps a backup', () => {
  fs.mkdirSync(path.dirname(configPath()), {recursive: true});
  fs.writeFileSync(configPath(), '{broken');
  assert.throws(() => loadConfig(), /SMM config reset/);
  assert.equal(fs.readFileSync(configPath(), 'utf8'), '{broken');
  saveConfig(resetConfig(defaultConfig()));
  assert.deepEqual(loadConfig(), defaultConfig());
  const backup = fs.readdirSync(path.dirname(configPath())).find(name => name.includes('.backup-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(configPath()), backup), 'utf8'), '{broken');
});

test('malformed legacy and JSON files are rejected as a whole', () => {
  fs.mkdirSync(path.dirname(configPath()), {recursive: true});
  for (const value of ['BAD\nnode-width\t48', 'MM-CONFIG-1\nunknown\tx', 'MM-CONFIG-1\nnode-width\t48\nnode-width\t60', 'MM-CONFIG-1\n\n', 'MM-CONFIG-1\nkey.child\te', 'MM-CONFIG-1\nnode-width\t$(touch PWNED)', JSON.stringify({...defaultConfig(), version: 3}), JSON.stringify({...defaultConfig(), surprise: true}), JSON.stringify({...defaultConfig(), keys: {child: 'Tab'}})]) {
    fs.writeFileSync(configPath(), value);
    assert.throws(() => loadConfig());
    assert.equal(fs.readFileSync(configPath(), 'utf8'), value);
  }
});

test('invalid v1 config is not partially migrated and migration failure preserves original content', () => {
  fs.mkdirSync(path.dirname(configPath()), {recursive: true});
  const invalid = JSON.stringify({...defaultConfig(), version: 1, saveDir: applicationDirectory(), nodeWidth: 999});
  fs.writeFileSync(configPath(), invalid);
  assert.throws(() => loadConfig({migrate: true}), /node-width/);
  assert.equal(fs.readFileSync(configPath(), 'utf8'), invalid);
  assert.equal(fs.readdirSync(path.dirname(configPath())).length, 1);
  const valid = JSON.stringify({...defaultConfig(), version: 1, saveDir: applicationDirectory()});
  fs.writeFileSync(configPath(), valid);
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => {throw new Error('migration rename failed');};
    assert.throws(() => loadConfig({migrate: true}), /migration rename failed/);
  } finally {fs.renameSync = rename;}
  assert.equal(fs.readFileSync(configPath(), 'utf8'), valid);
});

test('configuration is unchanged when final atomic replacement fails', () => {
  saveConfig(defaultConfig());
  const original = fs.readFileSync(configPath(), 'utf8');
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => {throw new Error('rename failed');};
    assert.throws(() => saveConfig(setConfig(defaultConfig(), 'node-width', '60')), /rename failed/);
  } finally {fs.renameSync = rename;}
  assert.equal(fs.readFileSync(configPath(), 'utf8'), original);
});
