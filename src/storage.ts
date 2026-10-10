import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {parseMM, serializeMM} from './model.js';
import type {AppConfig, MindmapNode} from './types.js';

export class StorageError extends Error {
  constructor(message: string, public readonly code: 'EXISTS' | 'CONFLICT' | 'INVALID_PATH') {
    super(message);
    this.name = 'StorageError';
  }
}

export interface SaveOptions {
  expectedFingerprint?: string;
  overwrite?: boolean;
}
export interface SavedFile {file: string; fingerprint: string}

export function applicationDirectory(): string {return path.join(os.homedir(), 'Shell Mindmap');}

export function expandPath(input: string, base = process.cwd()): string {
  if (!input || /[\x00-\x1f\x7f]/u.test(input)) throw new StorageError('文件路径不能为空或包含控制字符', 'INVALID_PATH');
  const expanded = input === '~' ? os.homedir() : /^~[\\/]/u.test(input) ? path.join(os.homedir(), input.slice(2)) : input;
  return path.resolve(base, expanded);
}

export function resolveSaveDirectory(config: Pick<AppConfig, 'saveDir'>, workspace = process.cwd()): string {
  return config.saveDir ? expandPath(config.saveDir, workspace) : path.resolve(workspace);
}

export function ensureApplicationDirectory(): string {
  const directory = applicationDirectory();
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  if (!fs.statSync(directory).isDirectory()) throw new StorageError('应用公共路径不是目录', 'INVALID_PATH');
  return directory;
}

function targetStat(file: string): fs.Stats | undefined {
  let stat: fs.Stats;
  try {stat = fs.lstatSync(file);} catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new StorageError('拒绝使用符号链接、目录或特殊文件：' + file, 'INVALID_PATH');
  return stat;
}

function readRegular(file: string): Buffer {
  const initial = targetStat(file);
  if (!initial) throw Object.assign(new Error('文件不存在：' + file), {code: 'ENOENT'});
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const current = fs.fstatSync(descriptor);
    if (!current.isFile() || initial.dev !== current.dev || initial.ino !== current.ino) {
      throw new StorageError('读取期间文件已被替换，请重试', 'CONFLICT');
    }
    const buffer = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
      throw new StorageError('读取期间文件已修改，请重试', 'CONFLICT');
    }
    return buffer;
  } finally {fs.closeSync(descriptor);}
}

function hash(content: string | Buffer): string {return createHash('sha256').update(content).digest('hex');}

export function fingerprint(input: string): string | undefined {
  const file = expandPath(input);
  if (!targetStat(file)) return undefined;
  return hash(readRegular(file));
}

export function readMap(input: string): {nodes: MindmapNode[]; file: string; fingerprint: string} {
  const file = expandPath(input);
  const content = readRegular(file);
  // The fatal decoder refuses damaged UTF-8 instead of silently changing node text.
  const text = new TextDecoder('utf-8', {fatal: true}).decode(content);
  return {nodes: parseMM(text), file, fingerprint: hash(content)};
}

export function writeTextAtomic(input: string, content: string, options: SaveOptions = {}): SavedFile {
  const file = expandPath(input);
  const directory = path.dirname(file);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new StorageError('保存目录不存在：' + directory, 'INVALID_PATH');
  }
  const initial = fingerprint(file);
  if (!options.overwrite && options.expectedFingerprint !== undefined && initial !== options.expectedFingerprint) {
    throw new StorageError('文件已被外部修改或删除；请重新打开、另存为，或确认覆盖', 'CONFLICT');
  }
  if (initial !== undefined && options.expectedFingerprint === undefined && !options.overwrite) {
    throw new StorageError('目标文件已存在；需要确认覆盖：' + file, 'EXISTS');
  }
  const temporary = path.join(directory, '.mm-' + randomUUID() + '.tmp');
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (fingerprint(file) !== initial) throw new StorageError('保存期间目标文件已修改；原文件未覆盖', 'CONFLICT');
    if (initial === undefined) {
      // An exclusive link prevents a concurrent creator being overwritten by rename.
      try {fs.linkSync(temporary, file);} catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StorageError('目标文件刚刚被创建；原文件未覆盖', 'CONFLICT');
        throw error;
      }
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, file);
    }
    return {file, fingerprint: hash(content)};
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {fs.unlinkSync(temporary);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  }
}

export function saveMap(input: string, nodes: MindmapNode[], options: SaveOptions = {}): SavedFile {
  return writeTextAtomic(input, serializeMM(nodes), options);
}

export function listMaps(input = process.cwd()): Array<{name: string; file: string; modified: string}> {
  const directory = expandPath(input);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, {withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.mm'))
    .flatMap(entry => {
      const file = path.join(directory, entry.name);
      try {
        const stat = targetStat(file);
        return stat ? [{name: entry.name, file, modified: stat.mtime.toISOString()}] : [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    }).sort((a, b) => b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name));
}

export function suggestFilename(title: string): string {
  let name = title.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/[. ]+$/u, '');
  name = Array.from(name).slice(0, 60).join('').replace(/[. ]+$/u, '');
  if (!name || /^\.+$/u.test(name)) name = '未命名脑图';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)) name = '_' + name;
  return name.toLowerCase().endsWith('.mm') ? name : name + '.mm';
}
