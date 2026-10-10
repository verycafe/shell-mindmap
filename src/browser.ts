import fs from 'node:fs';
import path from 'node:path';
import {expandPath, StorageError} from './storage.js';

export interface BrowserEntry {
  kind: 'directory' | 'file';
  name: string;
  file: string;
  modified?: string;
}

const names = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});

/** Read one directory without opening maps, so damaged maps remain discoverable. */
export function listDirectory(input: string, showHidden = false): BrowserEntry[] {
  const directory = expandPath(input);
  let directoryStat: fs.Stats;
  try {directoryStat = fs.lstatSync(directory);} catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw Object.assign(new Error('目录不存在：' + directory), {code: 'ENOENT'});
    }
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new StorageError('浏览路径不是普通目录（不支持符号链接）：' + directory, 'INVALID_PATH');
  }
  const entries: BrowserEntry[] = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const name = entry.name;
    if (!showHidden && name.startsWith('.')) continue;
    // Unrelated Windows system files may reject lstat (for example DumpStack.log.tmp).
    // Read metadata only for entries that can appear in the browser.
    if (!entry.isDirectory() && !(entry.isFile() && name.toLowerCase().endsWith('.mm'))) continue;
    const file = path.join(directory, name);
    let stat: fs.Stats;
    try {stat = fs.lstatSync(file);} catch (error) {
      // The browser can safely omit a child removed after the directory read.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) entries.push({kind: 'directory', name, file});
    else if (stat.isFile() && name.toLowerCase().endsWith('.mm')) {
      entries.push({kind: 'file', name, file, modified: stat.mtime.toISOString()});
    }
  }
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    if (a.kind === 'file' && b.kind === 'file') {
      const modified = Date.parse(b.modified!) - Date.parse(a.modified!);
      if (modified) return modified;
    }
    return names.compare(a.name, b.name) || a.name.localeCompare(b.name);
  });
}

export interface BrowserState {
  root: string;
  directory: string;
  expanded: string[];
  entries: Record<string, BrowserEntry[]>;
  selectedDirectory: string;
  fileIndex: number;
  focus: 'directories' | 'files';
  query: string;
  showHidden: boolean;
}

export interface BrowserTreeRow {
  kind: 'parent' | 'directory';
  file: string;
  name: string;
  depth: number;
  prefix: string;
  expanded: boolean;
  current: boolean;
}

const within = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

const matches = (name: string, query: string): boolean => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

/** Moving above the tree anchor is navigation, not expansion of a tree branch. */
export function browserParent(state: BrowserState): string | undefined {
  const parent = path.dirname(state.root);
  return parent === state.root ? undefined : parent;
}

function ancestry(root: string, directory: string): string[] {
  const result = [directory];
  while (result[0] !== root) result.unshift(path.dirname(result[0]));
  return result;
}

function normalizeSelection(state: BrowserState): BrowserState {
  const rows = browserTreeRows(state);
  const selectedDirectory = rows.some(row => row.file === state.selectedDirectory)
    ? state.selectedDirectory
    : rows.find(row => row.current)?.file ?? state.root;
  return {...state, selectedDirectory, fileIndex: Math.max(0, Math.min(state.fileIndex, browserFiles(state).length - 1))};
}

/** The anchor remains stable while traversing its descendants; no child directories are scanned here. */
export function createBrowser(input: string, showHidden = false): BrowserState {
  const directory = expandPath(input);
  const entries = listDirectory(directory, showHidden);
  return {
    root: directory, directory, expanded: [directory], entries: {[directory]: entries},
    selectedDirectory: directory, fileIndex: 0, focus: entries.some(entry => entry.kind === 'file') ? 'files' : 'directories',
    query: '', showHidden,
  };
}

export function browserFiles(state: BrowserState): BrowserEntry[] {
  return (state.entries[state.directory] ?? []).filter(entry => entry.kind === 'file' && matches(entry.name, state.query));
}

function childDirectories(state: BrowserState, directory: string): BrowserEntry[] {
  const children = (state.entries[directory] ?? []).filter(entry => entry.kind === 'directory');
  // Toggling hidden files must not erase the location of an already open hidden folder.
  if (directory !== state.directory && within(directory, state.directory)) {
    const next = path.join(directory, path.relative(directory, state.directory).split(path.sep)[0]);
    if (!children.some(entry => entry.file === next)) children.push({kind: 'directory', file: next, name: path.basename(next)});
  }
  return children.sort((a, b) => names.compare(a.name, b.name) || a.name.localeCompare(b.name));
}

/** Filter only loaded tree branches. Retain ancestors to communicate hierarchy without scanning the disk. */
export function browserTreeRows(state: BrowserState): BrowserTreeRow[] {
  const filtered = state.query.trim() !== '';
  const keep = new Set<string>([state.root]);
  if (filtered) {
    for (const entries of Object.values(state.entries)) {
      for (const entry of entries) {
        if (entry.kind === 'directory' && matches(entry.name, state.query) && within(state.root, entry.file)) {
          for (const ancestor of ancestry(state.root, entry.file)) keep.add(ancestor);
        }
      }
    }
  }
  const result: BrowserTreeRow[] = [];
  const parent = browserParent(state);
  if (parent) result.push({kind: 'parent', file: parent, name: path.basename(parent) || parent, depth: 0, prefix: '', expanded: false, current: false});
  const visit = (file: string, depth: number, prefix: string, stems: string): void => {
    const children = childDirectories(state, file).filter(entry => !filtered || keep.has(entry.file));
    const expanded = filtered ? children.length > 0 : state.expanded.includes(file);
    result.push({kind: 'directory', file, name: path.basename(file) || file, depth, prefix, expanded, current: file === state.directory});
    if (!expanded) return;
    children.forEach((child, index) => {
      const last = index === children.length - 1;
      visit(child.file, depth + 1, stems + (last ? '└─ ' : '├─ '), stems + (last ? '   ' : '│  '));
    });
  };
  visit(state.root, 0, '', '');
  return result;
}

export function navigateBrowser(state: BrowserState, input: string): BrowserState {
  const directory = expandPath(input);
  if (!within(state.root, directory)) return createBrowser(directory, state.showHidden);
  const entries = {...state.entries};
  const expanded = new Set(state.expanded);
  for (const ancestor of ancestry(state.root, directory)) {
    // Refresh the actual destination; the rest of the tree stays stable until explicitly refreshed.
    if (!entries[ancestor] || ancestor === directory) entries[ancestor] = listDirectory(ancestor, state.showHidden);
    expanded.add(ancestor);
  }
  const next = {...state, directory, entries, expanded: [...expanded], selectedDirectory: directory, fileIndex: 0, query: ''};
  return {...next, focus: browserFiles(next).length ? 'files' : 'directories'};
}

export function expandBrowser(state: BrowserState, input: string): BrowserState {
  const file = expandPath(input);
  if (!within(state.root, file)) throw new StorageError('目录不在当前目录树内：' + file, 'INVALID_PATH');
  const entries = {...state.entries};
  const expanded = new Set(state.expanded);
  for (const ancestor of ancestry(state.root, file)) {
    if (!entries[ancestor]) entries[ancestor] = listDirectory(ancestor, state.showHidden);
    expanded.add(ancestor);
  }
  return normalizeSelection({...state, entries, expanded: [...expanded]});
}

export function collapseBrowser(state: BrowserState, input: string): BrowserState {
  const file = expandPath(input);
  if (!within(state.root, file)) throw new StorageError('目录不在当前目录树内：' + file, 'INVALID_PATH');
  return normalizeSelection({
    ...state,
    expanded: state.expanded.filter(entry => entry !== file),
    selectedDirectory: within(file, state.selectedDirectory) ? file : state.selectedDirectory,
  });
}

/** Read only the anchor, visible expanded directories and the active path, never all descendants. */
export function refreshBrowser(state: BrowserState, showHidden = state.showHidden): BrowserState {
  const entries: Record<string, BrowserEntry[]> = {};
  const active = ancestry(state.root, state.directory);
  const pending = new Set([state.root, ...active, ...state.expanded]);
  const ordered = [...pending].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  const retained: string[] = [];
  for (const directory of ordered) {
    const parent = path.dirname(directory);
    const reachable = directory === state.root || active.includes(directory) || entries[parent]?.some(entry => entry.file === directory && entry.kind === 'directory');
    if (!reachable) continue;
    try {entries[directory] = listDirectory(directory, showHidden);} catch (error) {
      if (!active.includes(directory) && ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    if (state.expanded.includes(directory)) retained.push(directory);
  }
  return normalizeSelection({...state, entries, expanded: retained, showHidden});
}

export function filterBrowser(state: BrowserState, query: string): BrowserState {
  const selectedFile = browserFiles(state)[state.fileIndex]?.file;
  let next = {...state, query};
  const files = browserFiles(next);
  next.fileIndex = Math.max(0, files.findIndex(entry => entry.file === selectedFile));
  if (!query.trim()) {
    // Filtering can reveal a cached descendant of a collapsed branch. Keep that
    // selection visible when clearing the filter, without doing any disk reads.
    if (within(state.root, state.selectedDirectory)) {
      next.expanded = [...new Set([...state.expanded, ...ancestry(state.root, state.selectedDirectory).slice(0, -1)])];
    }
    return normalizeSelection(next);
  }
  const matchingDirectories = browserTreeRows(next).filter(row => row.kind === 'directory' && matches(row.name, query));
  if (!matchingDirectories.some(row => row.file === state.selectedDirectory)) {
    next.selectedDirectory = matchingDirectories[0]?.file ?? state.selectedDirectory;
  }
  // Retained ancestors provide context, but do not count as matches for choosing a pane.
  if (next.focus === 'files' && !files.length && matchingDirectories.length) next.focus = 'directories';
  else if (next.focus === 'directories' && !matchingDirectories.length && files.length) next.focus = 'files';
  return normalizeSelection(next);
}

export function moveBrowserSelection(state: BrowserState, offset: number | 'first' | 'last'): BrowserState {
  const rows = browserTreeRows(state);
  const files = browserFiles(state);
  const length = state.focus === 'directories' ? rows.length : files.length;
  const current = state.focus === 'directories' ? rows.findIndex(row => row.file === state.selectedDirectory) : state.fileIndex;
  const index = offset === 'first' ? 0 : offset === 'last' ? length - 1 : current + offset;
  const next = Math.max(0, Math.min(index, length - 1));
  return state.focus === 'directories' ? {...state, selectedDirectory: rows[next]?.file ?? state.root} : {...state, fileIndex: next};
}
