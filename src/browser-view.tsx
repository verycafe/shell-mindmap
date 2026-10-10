import React from 'react';
import {Text} from 'ink';
import {browserFiles, browserTreeRows, type BrowserState, type BrowserTreeRow, type BrowserEntry} from './browser.js';
import {clipText, displayWidth, sanitizePaste} from './text.js';

const fit = (text: string, width: number): string => {
  const clipped = clipText(sanitizePaste(text), 0, Math.max(0, width));
  return clipped + ' '.repeat(Math.max(0, width - displayWidth(clipped)));
};

function tail(text: string, width: number): string {
  const safe = sanitizePaste(text);
  if (displayWidth(safe) <= width) return safe;
  if (width < 2) return clipText(safe, 0, width);
  return '…' + clipText(safe, displayWidth(safe) - width + 1, width - 1);
}

/** Give the filter and current directory their own space even for long workspace paths. */
export function browserLocation(directory: string, query: string, width: number): string {
  if (!query) return tail(directory, width);
  const pathSpace = Math.min(width, Math.max(12, Math.floor(width * 0.35)));
  const filterSpace = Math.max(0, width - pathSpace - 3);
  const filter = sanitizePaste('筛选：' + query);
  const label = displayWidth(filter) > filterSpace
    ? clipText(filter, 0, Math.max(0, filterSpace - 1)) + '…'
    : filter;
  return label + ' · ' + tail(directory, Math.max(0, width - displayWidth(label) - 3));
}

function windowStart(index: number, count: number, capacity: number): number {
  return Math.max(0, Math.min(Math.max(0, index - capacity + 1), Math.max(0, count - capacity)));
}

function range(start: number, count: number, capacity: number): string {
  return count ? `${start + 1}–${Math.min(count, start + capacity)} / ${count}` : '0 / 0';
}

function treeLabel(row: BrowserTreeRow, state: BrowserState, width: number): string {
  const active = state.focus === 'directories' && state.selectedDirectory === row.file;
  if (row.kind === 'parent') {
    const label = `${active ? '›' : ' '} .. 上级目录 · `;
    return fit(label + tail(row.name, Math.max(0, width - displayWidth(label))), width);
  }
  const children = state.entries[row.file]?.some(entry => entry.kind === 'directory');
  const arrow = row.expanded ? '▾' : children === false ? '·' : '▸';
  const suffix = row.current ? ' [当前]' : '';
  const reserved = 2 + 2 + displayWidth(suffix);
  // Keep the node name readable even at depths greater than the pane width.
  const prefixWidth = Math.max(0, Math.min(displayWidth(row.prefix), Math.floor((width - reserved) / 2)));
  const prefix = tail(row.prefix, prefixWidth);
  const nameWidth = Math.max(1, width - reserved - displayWidth(prefix));
  return fit(`${active ? '›' : ' '} ${prefix}${arrow} ${tail(row.name, nameWidth)}${suffix}`, width);
}

function fileLabel(file: BrowserEntry, active: boolean, width: number): string {
  const date = width >= 40 && file.modified ? file.modified.slice(0, 10) : '';
  const nameWidth = Math.max(0, width - 2 - (date ? 12 : 0));
  return fit(`${active ? '›' : ' '} ${fit(file.name, nameWidth)}${date ? '  ' + date : ''}`, width);
}

function content(text: string, active = false, current = false): React.ReactNode {
  return <Text color={active ? 'black' : current ? 'cyan' : undefined} backgroundColor={active ? 'cyan' : undefined} bold={current} wrap="truncate">{text}</Text>;
}

/** Pure fixed-height browser renderer. Each pane follows its own selection independently. */
export function browserLines(state: BrowserState, width: number, height: number): React.ReactNode[] {
  const count = Math.max(0, Math.floor(height));
  if (!count) return [];
  const columns = Math.max(1, Math.floor(width));
  const tree = browserTreeRows(state);
  const files = browserFiles(state);
  const treeIndex = Math.max(0, tree.findIndex(row => row.file === state.selectedDirectory));
  const capacity = Math.max(0, count - 2);
  // Keep room below a selected directory so expanding it immediately reveals
  // its children. File lists retain their independent edge-following scroll.
  const treeStart = Math.max(0, Math.min(treeIndex - Math.floor(Math.max(0, capacity - 1) / 2), Math.max(0, tree.length - capacity)));
  const fileStart = windowStart(state.fileIndex, files.length, capacity);
  const empty = state.query.trim() ? '没有匹配的脑图' : '此目录还没有脑图 · n 新建';
  if (columns < 78) {
    const dirs = state.focus === 'directories';
    const lines: React.ReactNode[] = [<Text color="cyan" bold wrap="truncate">{fit(`${dirs ? '›' : ' '}目录树 ${tree.length}  ${dirs ? ' ' : '›'}脑图 ${files.length} · Tab 切换`, columns)}</Text>];
    for (let i = 0; i < capacity; i++) {
      const row = tree[treeStart + i];
      const file = files[fileStart + i];
      if (dirs) lines.push(content(row ? treeLabel(row, state, columns) : fit('', columns), !!row && row.file === state.selectedDirectory, row?.current));
      else lines.push(content(file ? fileLabel(file, fileStart + i === state.fileIndex, columns) : fit(i === 0 ? empty : '', columns), !!file && fileStart + i === state.fileIndex));
    }
    if (count > 1) lines.push(<Text wrap="truncate">{fit(dirs ? `目录 ${range(treeStart, tree.length, capacity)} · [当前] 为右侧脑图位置` : `脑图 ${range(fileStart, files.length, capacity)} · Tab 查看目录树`, columns)}</Text>);
    return lines.slice(0, count);
  }
  const treeWidth = Math.max(27, Math.min(42, Math.floor(columns * 0.35)));
  const fileWidth = columns - treeWidth - 3;
  const lines: React.ReactNode[] = [<Text wrap="truncate"><Text bold color={state.focus === 'directories' ? 'cyan' : undefined}>{fit('目录树 · [当前] 位置', treeWidth)}</Text><Text dimColor>{' │ '}</Text><Text bold color={state.focus === 'files' ? 'cyan' : undefined}>{fit(`脑图 · ${files.length}   最近修改 ↓`, fileWidth)}</Text></Text>];
  for (let i = 0; i < capacity; i++) {
    const row = tree[treeStart + i];
    const file = files[fileStart + i];
    const directoryActive = state.focus === 'directories' && !!row && row.file === state.selectedDirectory;
    const fileActive = state.focus === 'files' && !!file && fileStart + i === state.fileIndex;
    lines.push(<Text wrap="truncate">{content(row ? treeLabel(row, state, treeWidth) : fit('', treeWidth), directoryActive, row?.current)}<Text dimColor>{' │ '}</Text>{content(file ? fileLabel(file, fileActive, fileWidth) : fit(i === 0 ? empty : '', fileWidth), fileActive)}</Text>);
  }
  if (count > 1) lines.push(<Text wrap="truncate">{fit(`目录 ${range(treeStart, tree.length, capacity)}`, treeWidth)}<Text dimColor>{' │ '}</Text>{fit(`脑图 ${range(fileStart, files.length, capacity)}`, fileWidth)}</Text>);
  return lines.slice(0, count);
}
