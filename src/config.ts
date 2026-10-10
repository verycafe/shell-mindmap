import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import type {AppConfig} from './types.js';
import {applicationDirectory, expandPath, fingerprint, writeTextAtomic} from './storage.js';

const originalKeys: Record<string, string> = {
  child: 'Tab', sibling: 'Enter', edit: 'e', parent: 'Left', 'child-select': 'Right', up: 'Up', down: 'Down',
  fold: 'Space', delete: 'd', undo: 'u', redo: 'r', save: 's', 'save-as': 'S', quit: 'q', help: '?',
  'page-up': 'PageUp', 'page-down': 'PageDown',
};
const additionalKeys: Record<string, string> = {
  search: 'f', copy: 'c', paste: 'p', move: 'm', 'move-up': '[', 'move-down': ']', root: 'g',
  settings: ',', library: 'O', import: 'I', export: 'E', new: 'N',
  'pan-left': 'H', 'pan-right': 'L', 'pan-up': 'K', 'pan-down': 'J',
};
const defaults = {...originalKeys, ...additionalKeys};
const controlCharacters = /[\x00-\x1f\x7f]/u;

export function defaultConfig(): AppConfig {
  return {version: 2, saveDir: '', nodeWidth: 32, layout: 'right', keys: {...defaults}};
}

export function configPath(): string {
  return process.env.MM_CONFIG_FILE ? expandPath(process.env.MM_CONFIG_FILE) : path.join(applicationDirectory(), '.app', 'config.json');
}

function oldConfigPath(): string {
  return path.join(process.env.XDG_CONFIG_HOME ? expandPath(process.env.XDG_CONFIG_HOME) : path.join(os.homedir(), '.config'), 'mm', 'config');
}

function bindingValue(action: string, value: string, allowLegacySlash = false): string {
  if (!Object.hasOwn(defaults, action)) throw new Error('未知配置项：key.' + action);
  if (value === '' || (allowLegacySlash && value === '/')) return value;
  if (['/', ':', '：', '？'].includes(value)) throw new Error('/、:、中文：和中文？是固定入口，不能重新分配');
  if (value === 'F1' && action !== 'help') throw new Error('F1 是固定帮助入口，只能用于 key.help');
  const named = ['Tab', 'Enter', 'Left', 'Right', 'Up', 'Down', 'Space', 'Delete', 'PageUp', 'PageDown', 'F1',
    'Shift+Left', 'Shift+Right', 'Shift+Up', 'Shift+Down', 'Ctrl+f'];
  if (!named.includes(value) && (Array.from(value).length !== 1 || /[\s\p{C}]/u.test(value))) {
    throw new Error('key.' + action + ' 需要单个可见字符或命名按键；可用空值取消主键');
  }
  return value;
}

function checkBindings(keys: Record<string, string>): void {
  const seen = new Map<string, string>();
  for (const [action, value] of Object.entries(keys)) {
    if (!value) continue;
    if (seen.has(value)) throw new Error('快捷键冲突：key.' + action + ' 与 key.' + seen.get(value) + ' 都使用 ' + value + '；请先改绑其中一个');
    seen.set(value, action);
  }
}

function assignValue(config: AppConfig, key: string, value: string, verifyDirectory: boolean, allowLegacySlash = false): void {
  if (controlCharacters.test(value)) throw new Error('配置 ' + key + ' 不能包含 Tab、换行或控制字符');
  if (key === 'save-dir') {
    const directory = value ? expandPath(value) : '';
    if (verifyDirectory && directory) {
      if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error('save-dir 必须是现存且可写的目录');
      try {fs.accessSync(directory, fs.constants.W_OK);} catch {throw new Error('save-dir 必须是现存且可写的目录');}
    }
    config.saveDir = directory;
  } else if (key === 'node-width') {
    if (!/^\d{1,2}$/u.test(value) || Number(value) < 8 || Number(value) > 80) throw new Error('node-width 必须是 8–80 之间的整数');
    config.nodeWidth = Number(value);
  } else if (key === 'layout') {
    if (value !== 'right' && value !== 'bilateral') throw new Error('layout 必须为 right 或 bilateral');
    config.layout = value;
  } else if (key.startsWith('key.')) {
    const action = key.slice(4);
    config.keys[action] = bindingValue(action, value, allowLegacySlash);
  } else {throw new Error('未知配置项：' + key);}
}

function disableConflictingAdditions(keys: Record<string, string>, supplied: Set<string>): void {
  const assigned = new Set(Object.entries(keys).filter(([action, binding]) => supplied.has(action) && binding).map(([, binding]) => binding));
  // Existing user bindings take precedence over newly introduced defaults.
  for (const action of Object.keys(additionalKeys)) {
    if (supplied.has(action)) continue;
    if (assigned.has(keys[action]!)) keys[action] = '';
    else if (keys[action]) assigned.add(keys[action]!);
  }
}

function migrateSlashBindings(keys: Record<string, string>): void {
  const legacySearch = keys.search === '/';
  for (const action of Object.keys(keys)) {
    if (keys[action] === '/') keys[action] = '';
  }
  // Preserve the user's existing f binding instead of taking it for search.
  if (legacySearch && !Object.values(keys).includes('f')) keys.search = 'f';
}

function parseLegacy(text: string): AppConfig {
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== 'MM-CONFIG-1') throw new Error('配置文件格式错误：需要 MM-CONFIG-1 文件头或受支持的 JSON');
  const candidate = defaultConfig();
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const fields = lines[index]!.split('\t');
    const key = fields[0]!;
    if (fields.length !== 2 || seen.has(key)) throw new Error('配置第 ' + (index + 2) + ' 行格式错误或重复定义：' + key);
    if (key === 'layout' || (key.startsWith('key.') && key !== 'key.search' && !Object.hasOwn(originalKeys, key.slice(4)))) throw new Error('旧配置包含未知配置项：' + key);
    assignValue(candidate, key, fields[1]!, false, true);
    seen.add(key);
  }
  migrateSlashBindings(candidate.keys);
  const supplied = new Set([...Object.keys(originalKeys), ...[...seen].filter(key => key.startsWith('key.')).map(key => key.slice(4))]);
  disableConflictingAdditions(candidate.keys, supplied);
  checkBindings(candidate.keys);
  return candidate;
}

function parseJson(value: unknown, allowLegacySlash = false): AppConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是带版本号的 JSON 对象');
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 && raw.version !== 2) throw new Error('不支持的配置版本；需要 version: 1 或 2');
  const fields = ['version', 'saveDir', 'nodeWidth', 'layout', 'keys'];
  if (Object.keys(raw).some(key => !fields.includes(key))) throw new Error('配置包含未知字段');
  if (typeof raw.saveDir !== 'string' || typeof raw.nodeWidth !== 'number' || !Number.isInteger(raw.nodeWidth) || typeof raw.layout !== 'string') throw new Error('配置 saveDir、nodeWidth 或 layout 类型无效');
  if (!raw.keys || typeof raw.keys !== 'object' || Array.isArray(raw.keys)) throw new Error('配置 keys 必须是对象');
  const candidate = defaultConfig();
  assignValue(candidate, 'save-dir', raw.saveDir, false);
  assignValue(candidate, 'node-width', String(raw.nodeWidth), false);
  assignValue(candidate, 'layout', raw.layout, false);
  const supplied = new Set<string>();
  for (const [action, binding] of Object.entries(raw.keys)) {
    if (typeof binding !== 'string') throw new Error('key.' + action + ' 必须是字符串');
    assignValue(candidate, 'key.' + action, binding, false, allowLegacySlash);
    supplied.add(action);
  }
  for (const action of Object.keys(originalKeys)) {
    if (!supplied.has(action)) throw new Error('配置缺少主键：key.' + action);
  }
  if (allowLegacySlash) migrateSlashBindings(candidate.keys);
  disableConflictingAdditions(candidate.keys, supplied);
  checkBindings(candidate.keys);
  // Only v1 used the application directory as its implicit map library.
  // In v2 the same explicit path is a deliberate user override and stays intact.
  if (raw.version === 1 && candidate.saveDir === applicationDirectory()) candidate.saveDir = '';
  return candidate;
}

function parseText(text: string): AppConfig {
  return text.startsWith('MM-CONFIG-1') ? parseLegacy(text) : parseJson(JSON.parse(text), true);
}

function requiresMigration(text: string): boolean {
  if (text.startsWith('MM-CONFIG-1')) return true;
  const config = JSON.parse(text) as {version: number; keys: Record<string, string>};
  return config.version === 1 || Object.values(config.keys).includes('/');
}

function backup(file: string): void {
  fs.copyFileSync(file, file + '.backup-' + new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID(), fs.constants.COPYFILE_EXCL);
}

/** Read-only by default; application startup explicitly opts into legacy migration. */
export function loadConfig({migrate = false}: {migrate?: boolean} = {}): AppConfig {
  const target = configPath();
  const targetFingerprint = fingerprint(target);
  const source = targetFingerprint !== undefined ? target : process.env.MM_CONFIG_FILE ? undefined : oldConfigPath();
  if (!source) return defaultConfig();
  const sourceFingerprint = source === target ? targetFingerprint : fingerprint(source);
  if (sourceFingerprint === undefined) return defaultConfig();
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(fs.readFileSync(source));
    const candidate = parseText(text);
    if (migrate && (source !== target || requiresMigration(text))) {
      fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
      if (fingerprint(source) !== sourceFingerprint) throw new Error('配置在迁移期间被修改；请重试');
      if (source === target) backup(source);
      writeTextAtomic(target, JSON.stringify(candidate, null, 2) + '\n', {expectedFingerprint: source === target ? sourceFingerprint : undefined});
    }
    return candidate;
  } catch (error) {
    throw new Error('无法读取配置 ' + source + '：' + (error as Error).message + '。可使用 SMM config reset 恢复默认设置（原文件会备份）。');
  }
}

export function saveConfig(config: AppConfig): void {
  const candidate = parseJson(config);
  const file = configPath();
  const previous = fingerprint(file);
  if (previous !== undefined) {
    const text = fs.readFileSync(file, 'utf8');
    let needsBackup = false;
    try {parseText(text); needsBackup = requiresMigration(text);} catch {needsBackup = true;}
    if (needsBackup) backup(file);
  }
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  writeTextAtomic(file, JSON.stringify(candidate, null, 2) + '\n', {expectedFingerprint: previous});
}

export function setConfig(config: AppConfig, key: string, value: string): AppConfig {
  const candidate = {...config, keys: {...config.keys}};
  assignValue(candidate, key, value, true);
  checkBindings(candidate.keys);
  return candidate;
}

export function resetConfig(config: AppConfig, key?: string): AppConfig {
  if (!key) return defaultConfig();
  if (key === 'keys') return {...config, keys: {...defaults}};
  const entries = configEntries(defaultConfig());
  if (!Object.hasOwn(entries, key)) throw new Error('未知配置项：' + key);
  const candidate = {...config, keys: {...config.keys}};
  assignValue(candidate, key, entries[key]!, false);
  checkBindings(candidate.keys);
  return candidate;
}

export function configEntries(config: AppConfig): Record<string, string> {
  return {
    'save-dir': config.saveDir, 'node-width': String(config.nodeWidth), layout: config.layout,
    ...Object.fromEntries(Object.entries(config.keys).map(([action, binding]) => ['key.' + action, binding])),
  };
}
