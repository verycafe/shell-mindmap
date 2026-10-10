import {randomUUID} from 'node:crypto';
import type {MindmapNode, Operation} from './types.js';

const MAX_NODES = 500;
const MAX_DEPTH = 23;
const MAX_TEXT = 300;

function validateText(text: string): void {
  if (typeof text !== 'string' || !text.trim()) throw new Error('节点文字不能为空');
  if ([...text].length > MAX_TEXT) throw new Error('节点文字最多 300 个字符');
  if (/\p{Cc}/u.test(text)) throw new Error('节点文字不能包含换行、Tab 或控制字符');
}

export function validateNodes(nodes: MindmapNode[]): void {
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > MAX_NODES) {
    throw new Error('脑图必须包含 1–500 个节点');
  }
  const ids = new Set<string>();
  let previousDepth = 0;
  for (const [index, node] of nodes.entries()) {
    if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id)) {
      throw new Error(`第 ${index + 1} 个节点的标识无效或重复`);
    }
    ids.add(node.id);
    if (!Number.isInteger(node.depth) || node.depth < 0 || node.depth > MAX_DEPTH ||
        (index === 0 ? node.depth !== 0 : node.depth === 0 || node.depth > previousDepth + 1)) {
      throw new Error(`第 ${index + 1} 个节点的层级无效；最多 24 层且仅允许一个根节点`);
    }
    if (typeof node.folded !== 'boolean') throw new Error(`第 ${index + 1} 个节点的折叠状态无效`);
    validateText(node.text);
    previousDepth = node.depth;
  }
}

export function createMap(text = '中心主题'): MindmapNode[] {
  validateText(text);
  return [{id: randomUUID(), text, depth: 0, folded: false}];
}

export function parseMM(text: string): MindmapNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== 'MM-ZSH-1') throw new Error('文件第 1 行：需要 MM-ZSH-1 文件头');
  if (lines.at(-1) === '') lines.pop();
  const nodes: MindmapNode[] = [];
  for (let index = 1; index < lines.length; index++) {
    const fields = /^(\d{1,2})\t([01])\t(.*)$/u.exec(lines[index]!);
    if (!fields) throw new Error(`文件第 ${index + 1} 行：需要有效的层级、折叠状态和节点文字`);
    const node = {id: randomUUID(), depth: Number(fields[1]), folded: fields[2] === '1', text: fields[3]!};
    try {
      validateText(node.text);
      if (nodes.length >= MAX_NODES) throw new Error('脑图最多 500 个节点');
      const previous = nodes.at(-1);
      if (node.depth > MAX_DEPTH || (!previous ? node.depth !== 0 : node.depth === 0 || node.depth > previous.depth + 1)) {
        throw new Error('层级无效；最多 24 层且仅允许一个根节点');
      }
    } catch (error) {
      throw new Error(`文件第 ${index + 1} 行：${(error as Error).message}`);
    }
    nodes.push(node);
  }
  validateNodes(nodes);
  return nodes;
}

export function serializeMM(nodes: MindmapNode[]): string {
  validateNodes(nodes);
  return `MM-ZSH-1\n${nodes.map(node => `${node.depth}\t${Number(node.folded)}\t${node.text}`).join('\n')}\n`;
}

function indexOf(nodes: MindmapNode[], id: string): number {
  const index = nodes.findIndex(node => node.id === id);
  if (index < 0) throw new Error('找不到指定节点');
  return index;
}

function branchEnd(nodes: MindmapNode[], index: number): number {
  let end = index + 1;
  while (end < nodes.length && nodes[end]!.depth > nodes[index]!.depth) end++;
  return end;
}

function clone(nodes: MindmapNode[]): MindmapNode[] {
  return nodes.map(node => ({...node}));
}

function result(nodes: MindmapNode[], selected: string): Operation {
  validateNodes(nodes);
  return {nodes, selected};
}

export function visibleNodes(nodes: MindmapNode[]): MindmapNode[] {
  let hiddenBelow: number | undefined;
  return nodes.filter(node => {
    if (hiddenBelow !== undefined && node.depth > hiddenBelow) return false;
    hiddenBelow = node.folded ? node.depth : undefined;
    return true;
  }).map(node => ({...node}));
}

export function parentId(nodes: MindmapNode[], id: string): string | undefined {
  const index = nodes.findIndex(node => node.id === id);
  if (index < 1) return undefined;
  for (let parent = index - 1; parent >= 0; parent--) {
    if (nodes[parent]!.depth < nodes[index]!.depth) return nodes[parent]!.id;
  }
  return undefined;
}

export function addChild(nodes: MindmapNode[], id: string, text: string): Operation {
  validateNodes(nodes);
  validateText(text);
  const index = indexOf(nodes, id);
  const next = clone(nodes);
  const node = {id: randomUUID(), text, depth: nodes[index]!.depth + 1, folded: false};
  next[index]!.folded = false;
  next.splice(branchEnd(nodes, index), 0, node);
  return result(next, node.id);
}

export function addSibling(nodes: MindmapNode[], id: string, text: string): Operation {
  validateNodes(nodes);
  validateText(text);
  const index = indexOf(nodes, id);
  if (index === 0) throw new Error('根节点不能添加同级节点；请添加子节点');
  const next = clone(nodes);
  const node = {id: randomUUID(), text, depth: nodes[index]!.depth, folded: false};
  next[indexOf(nodes, parentId(nodes, id)!)]!.folded = false;
  next.splice(branchEnd(nodes, index), 0, node);
  return result(next, node.id);
}

export function editNode(nodes: MindmapNode[], id: string, text: string): Operation {
  validateNodes(nodes);
  validateText(text);
  const next = clone(nodes);
  next[indexOf(nodes, id)]!.text = text;
  return result(next, id);
}

export function removeBranch(nodes: MindmapNode[], id: string): Operation {
  validateNodes(nodes);
  const index = indexOf(nodes, id);
  if (index === 0) throw new Error('不能删除根节点');
  const next = clone(nodes);
  next.splice(index, branchEnd(nodes, index) - index);
  return result(next, parentId(nodes, id)!);
}

export function toggleFold(nodes: MindmapNode[], id: string): Operation {
  validateNodes(nodes);
  const next = clone(nodes);
  const index = indexOf(nodes, id);
  next[index]!.folded = !next[index]!.folded;
  return result(next, id);
}

export function moveBranch(nodes: MindmapNode[], id: string, targetParentId: string): Operation {
  validateNodes(nodes);
  const sourceIndex = indexOf(nodes, id);
  if (sourceIndex === 0) throw new Error('不能移动根节点');
  const targetIndex = indexOf(nodes, targetParentId);
  const end = branchEnd(nodes, sourceIndex);
  if (targetIndex >= sourceIndex && targetIndex < end) throw new Error('不能将分支移动到自身或其子节点中');
  const depthChange = nodes[targetIndex]!.depth + 1 - nodes[sourceIndex]!.depth;
  const branch = nodes.slice(sourceIndex, end).map(node => ({...node, depth: node.depth + depthChange}));
  const next = clone(nodes);
  next.splice(sourceIndex, end - sourceIndex);
  const newTarget = indexOf(next, targetParentId);
  next[newTarget]!.folded = false;
  next.splice(branchEnd(next, newTarget), 0, ...branch);
  return result(next, id);
}

export function reorderBranch(nodes: MindmapNode[], id: string, delta: -1 | 1): Operation {
  validateNodes(nodes);
  if (delta !== -1 && delta !== 1) throw new Error('排序方向必须为上移或下移');
  const index = indexOf(nodes, id);
  if (index === 0) throw new Error('根节点不能排序');
  const parent = parentId(nodes, id);
  const siblings = nodes.filter(node => node.depth === nodes[index]!.depth && parentId(nodes, node.id) === parent);
  const siblingIndex = siblings.findIndex(node => node.id === id);
  const neighbor = siblings[siblingIndex + delta];
  if (!neighbor) return result(clone(nodes), id);
  const otherIndex = indexOf(nodes, neighbor.id);
  const end = branchEnd(nodes, index);
  const otherEnd = branchEnd(nodes, otherIndex);
  const reordered = delta < 0
    ? [...nodes.slice(0, otherIndex), ...nodes.slice(index, end), ...nodes.slice(otherIndex, index), ...nodes.slice(end)]
    : [...nodes.slice(0, index), ...nodes.slice(end, otherEnd), ...nodes.slice(index, end), ...nodes.slice(otherEnd)];
  return result(clone(reordered), id);
}

export function copyBranch(nodes: MindmapNode[], id: string): MindmapNode[] {
  validateNodes(nodes);
  const index = indexOf(nodes, id);
  return nodes.slice(index, branchEnd(nodes, index)).map(node => ({...node, depth: node.depth - nodes[index]!.depth}));
}

export function pasteBranch(nodes: MindmapNode[], targetId: string, clipboard: MindmapNode[]): Operation {
  validateNodes(nodes);
  validateNodes(clipboard);
  const index = indexOf(nodes, targetId);
  const branch = clipboard.map(node => ({...node, id: randomUUID(), depth: node.depth + nodes[index]!.depth + 1}));
  const next = clone(nodes);
  next[index]!.folded = false;
  next.splice(branchEnd(nodes, index), 0, ...branch);
  return result(next, branch[0]!.id);
}

export function revealNode(nodes: MindmapNode[], id: string): MindmapNode[] {
  validateNodes(nodes);
  let index = indexOf(nodes, id);
  let next = nodes;
  let depth = nodes[index]!.depth;
  while (index > 0) {
    index--;
    if (nodes[index]!.depth < depth) {
      if (nodes[index]!.folded) {
        if (next === nodes) next = clone(nodes);
        next[index]!.folded = false;
      }
      depth = nodes[index]!.depth;
    }
  }
  return next;
}

export function searchNodes(nodes: MindmapNode[], query: string): MindmapNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return nodes.filter(node => node.text.toLowerCase().includes(needle)).map(node => ({...node}));
}
