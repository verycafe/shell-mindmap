import fs from 'node:fs';
import path from 'node:path';
import {applicationDirectory, expandPath, fingerprint, writeTextAtomic} from './storage.js';
import {parseMM, serializeMM} from './model.js';
import type {MindmapNode} from './types.js';

export interface Recovery {
  sessionId: string;
  nodes: MindmapNode[];
  file?: string;
  saveDirectory?: string;
  baseFingerprint?: string;
  updatedAt: string;
}

function recoveryDirectory(): string {return path.join(applicationDirectory(), '.app', 'recovery');}

function recoveryFile(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(sessionId)) throw new Error('恢复会话 ID 无效');
  return path.join(recoveryDirectory(), sessionId + '.json');
}

export function writeRecovery(input: Omit<Recovery, 'updatedAt'>): void {
  const file = recoveryFile(input.sessionId);
  // Validate the persisted model before writing and retain IDs for in-session selection.
  parseMM(serializeMM(input.nodes));
  if (input.baseFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(input.baseFingerprint)) throw new Error('恢复文件指纹无效');
  if (input.saveDirectory !== undefined && typeof input.saveDirectory !== 'string') throw new Error('恢复保存目录无效');
  const snapshot: Recovery = {
    ...input,
    file: input.file ? expandPath(input.file) : undefined,
    saveDirectory: input.saveDirectory === undefined ? undefined : expandPath(input.saveDirectory),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(recoveryDirectory(), {recursive: true, mode: 0o700});
  writeTextAtomic(file, JSON.stringify(snapshot, null, 2) + '\n', {expectedFingerprint: fingerprint(file)});
}

export function listRecoveries(): Recovery[] {
  const directory = recoveryDirectory();
  if (!fs.existsSync(directory)) return [];
  const found: Recovery[] = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const file = path.join(directory, entry.name);
      fingerprint(file);
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Recovery;
      if (!value || typeof value !== 'object' || typeof value.sessionId !== 'string' || recoveryFile(value.sessionId) !== file) continue;
      if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) continue;
      if (value.file !== undefined && (typeof value.file !== 'string' || expandPath(value.file) !== value.file)) continue;
      if (value.saveDirectory !== undefined && (typeof value.saveDirectory !== 'string' || !path.isAbsolute(value.saveDirectory) || expandPath(value.saveDirectory) !== value.saveDirectory)) continue;
      if (value.baseFingerprint !== undefined && (typeof value.baseFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.baseFingerprint))) continue;
      parseMM(serializeMM(value.nodes));
      const ids = new Set(value.nodes.map(node => node.id));
      if (ids.size !== value.nodes.length || value.nodes.some(node => typeof node.id !== 'string' || !node.id)) continue;
      found.push(value);
    } catch {
      // A truncated or obsolete snapshot must not hide other recoverable sessions.
    }
  }
  return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function removeRecovery(sessionId: string): void {
  const file = recoveryFile(sessionId);
  if (fingerprint(file) !== undefined) fs.unlinkSync(file);
}
