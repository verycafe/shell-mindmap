import type {LayoutMode, MindmapNode} from './types.js';
import {displayWidth, graphemes, wrapText} from './text.js';

export interface PlacedNode {
  id: string; x: number; y: number; width: number; height: number; lines: string[];
}
export interface Layout {
  nodes: PlacedNode[];
  edges: Array<{x: number; y: number; char: string}>;
  /** Bounds include all cells; maxX/maxY are exclusive. */
  minX: number; maxX: number; minY: number; maxY: number;
}
export type Tone = 'node' | 'selected' | 'edge';
export interface RenderSpan {text: string; tone: Tone}

interface Branch {
  source: MindmapNode;
  parent?: Branch;
  children: Branch[];
  depth: number;
  side: 1 | -1;
  visible: boolean;
  span: number;
  bandTop: number;
  placed: PlacedNode;
}

const GAP = 6;
const ROW_GAP = 1;
const groupHeight = (branches: Branch[]): number => branches.length
  ? branches.reduce((height, node) => height + node.span, 0) + ROW_GAP * (branches.length - 1)
  : 0;
const middle = (node: PlacedNode): number => node.y + Math.floor((node.height - 1) / 2);

/** Pure layout of preorder nodes. Hidden descendants still retain their root branch side. */
export function layoutMap(nodes: MindmapNode[], options: {nodeWidth: number; mode: LayoutMode}): Layout {
  const empty: Layout = {nodes: [], edges: [], minX: 0, maxX: 0, minY: 0, maxY: 0};
  if (!nodes.length) return empty;
  const all: Branch[] = [];
  const roots: Branch[] = [];
  const stack: Branch[] = [];
  for (const source of nodes) {
    while (stack.length && stack.at(-1)!.source.depth >= source.depth) stack.pop();
    const parent = stack.at(-1);
    const side = parent
      ? parent.parent ? parent.side : options.mode === 'bilateral' && parent.children.length % 2 === 1 ? -1 : 1
      : 1;
    const branch: Branch = {
      source, parent, children: [], depth: parent ? parent.depth + 1 : 0, side,
      visible: !parent || (parent.visible && !parent.source.folded), span: 0, bandTop: 0,
      placed: {id: source.id, x: 0, y: 0, width: 1, height: 1, lines: []},
    };
    if (parent) parent.children.push(branch);
    else roots.push(branch);
    stack.push(branch);
    all.push(branch);
  }

  const visible = all.filter(branch => branch.visible);
  const widths = {right: [] as number[], left: [] as number[]};
  let rootWidth = 1;
  for (const branch of visible) {
    const suffix = branch.source.folded && branch.children.length ? ' [+]' : '';
    const lines = wrapText(branch.source.text + suffix, options.nodeWidth);
    let width = 1;
    for (const line of lines) width = Math.max(width, displayWidth(line));
    Object.assign(branch.placed, {lines, width, height: lines.length});
    if (!branch.parent) rootWidth = Math.max(rootWidth, width);
    const levels = branch.side === 1 ? widths.right : widths.left;
    levels[branch.depth] = Math.max(levels[branch.depth] ?? 0, width);
  }

  const rightX = [0, rootWidth + GAP];
  const leftRight = [0, -GAP];
  for (let depth = 2; depth < Math.max(widths.right.length, widths.left.length); depth++) {
    rightX[depth] = rightX[depth - 1]! + (widths.right[depth - 1] ?? 1) + GAP;
    leftRight[depth] = leftRight[depth - 1]! - (widths.left[depth - 1] ?? 1) - GAP;
  }

  for (let index = visible.length - 1; index >= 0; index--) {
    const branch = visible[index]!;
    const children = branch.children.filter(child => child.visible);
    branch.span = !branch.parent && options.mode === 'bilateral'
      ? Math.max(branch.placed.height, groupHeight(children.filter(child => child.side === 1)), groupHeight(children.filter(child => child.side === -1)))
      : Math.max(branch.placed.height, groupHeight(children));
  }

  let nextRootTop = 0;
  for (const branch of visible) {
    const placed = branch.placed;
    if (!branch.parent) {
      branch.bandTop = nextRootTop;
      nextRootTop += branch.span + ROW_GAP * 2;
    }
    placed.x = !branch.parent ? 0 : branch.side === 1 ? rightX[branch.depth]! : leftRight[branch.depth]! - placed.width;
    placed.y = branch.bandTop + Math.floor((branch.span - placed.height) / 2);
    const children = branch.children.filter(child => child.visible);
    const groups = !branch.parent && options.mode === 'bilateral'
      ? [children.filter(child => child.side === 1), children.filter(child => child.side === -1)]
      : [children];
    for (const group of groups) {
      let top = branch.bandTop + Math.floor((branch.span - groupHeight(group)) / 2);
      for (const child of group) {
        child.bandTop = top;
        top += child.span + ROW_GAP;
      }
    }
  }

  const masks = new Map<string, {x: number; y: number; mask: number}>();
  const N = 1, E = 2, S = 4, W = 8;
  const mark = (x: number, y: number, mask: number): void => {
    const key = `${x},${y}`;
    const existing = masks.get(key);
    if (existing) existing.mask |= mask;
    else masks.set(key, {x, y, mask});
  };
  const segment = (x1: number, y1: number, x2: number, y2: number): void => {
    const dx = Math.sign(x2 - x1), dy = Math.sign(y2 - y1);
    const forward = dx > 0 ? E : dx < 0 ? W : dy > 0 ? S : N;
    const backward = dx > 0 ? W : dx < 0 ? E : dy > 0 ? N : S;
    let x = x1, y = y1;
    while (x !== x2 || y !== y2) {
      mark(x, y, forward);
      x += dx; y += dy;
      mark(x, y, backward);
    }
  };
  // Shared trunks are drawn once, avoiding quadratic redraw of tall sibling sets.
  const groups = new Map<string, Branch[]>();
  for (const child of visible) {
    if (!child.parent) continue;
    const key = `${child.parent.source.id}:${child.side}`;
    const group = groups.get(key);
    if (group) group.push(child); else groups.set(key, [child]);
  }
  for (const children of groups.values()) {
    const first = children[0]!;
    const parent = first.parent!.placed;
    const node = first.placed;
    const right = first.side === 1;
    const start = right ? parent.x + parent.width : parent.x - 1;
    const trunk = right ? node.x - 3 : node.x + node.width + 2;
    const parentY = middle(parent);
    mark(start, parentY, right ? W : E);
    segment(start, parentY, trunk, parentY);
    let top = parentY, bottom = parentY;
    for (const child of children) {
      const center = middle(child.placed);
      top = Math.min(top, center);
      bottom = Math.max(bottom, center);
    }
    segment(trunk, top, trunk, bottom);
    for (const child of children) {
      const childY = middle(child.placed);
      const end = right ? child.placed.x - 1 : child.placed.x + child.placed.width;
      segment(trunk, childY, end, childY);
      mark(end, childY, right ? E : W);
    }
  }
  const chars: Record<number, string> = {
    [N]: '│', [E]: '─', [S]: '│', [W]: '─', [N | S]: '│', [E | W]: '─',
    [N | E]: '└', [E | S]: '┌', [S | W]: '┐', [W | N]: '┘',
    [N | E | S]: '├', [E | S | W]: '┬', [S | W | N]: '┤', [W | N | E]: '┴',
    [N | E | S | W]: '┼',
  };
  const placed = visible.map(branch => branch.placed);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const node of placed) {
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x + node.width);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return {
    nodes: placed,
    edges: Array.from(masks.values(), edge => ({x: edge.x, y: edge.y, char: chars[edge.mask] ?? '─'})),
    minX, maxX, minY, maxY,
  };
}

const dimension = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

/** Render only viewport cells. Adjacent same-tone cells become compact React Text spans. */
export function renderViewport(layout: Layout, view: {x: number; y: number; width: number; height: number; selected: string}): RenderSpan[][] {
  const width = dimension(view.width), height = dimension(view.height);
  const x = Math.trunc(view.x), y = Math.trunc(view.y);
  const rows: RenderSpan[][] = Array.from({length: height}, () => Array.from({length: width}, () => ({text: ' ', tone: 'node'})));
  for (const edge of layout.edges) {
    const row = edge.y - y, column = edge.x - x;
    if (row >= 0 && row < height && column >= 0 && column < width) rows[row]![column] = {text: edge.char, tone: 'edge'};
  }
  for (const node of layout.nodes) {
    if (node.x >= x + width || node.x + node.width <= x || node.y >= y + height || node.y + node.height <= y) continue;
    const tone: Tone = node.id === view.selected ? 'selected' : 'node';
    const firstLine = Math.max(0, y - node.y), lastLine = Math.min(node.height, y + height - node.y);
    for (let offset = firstLine; offset < lastLine; offset++) {
      const rowIndex = node.y + offset - y;
      const row = rows[rowIndex]!;
      for (let column = Math.max(node.x - x, 0); column < Math.min(node.x + node.width - x, width); column++) row[column] = {text: ' ', tone};
      let column = node.x - x;
      for (const glyph of graphemes(node.lines[offset] ?? '')) {
        const size = displayWidth(glyph);
        if (!size) continue;
        if (column >= width) break;
        if (column >= 0 && column + size <= width) {
          row[column] = {text: glyph, tone};
          for (let extra = 1; extra < size; extra++) row[column + extra] = {text: '', tone};
        }
        column += size;
      }
    }
  }
  return rows.map(row => {
    const spans: RenderSpan[] = [];
    for (const cell of row) {
      const last = spans.at(-1);
      if (last?.tone === cell.tone) last.text += cell.text;
      else spans.push({...cell});
    }
    return spans;
  });
}

export function followSelection(layout: Layout, id: string, view: {x: number; y: number}, width: number, height: number): {x: number; y: number} {
  const node = layout.nodes.find(candidate => candidate.id === id);
  const w = dimension(width), h = dimension(height);
  if (!node || !w || !h) return {...view};
  let {x, y} = view;
  const mx = w >= 8 ? 2 : 0, my = h >= 4 ? 1 : 0;
  if (node.width > w - 2 * mx) x = node.x - mx;
  else if (node.x < x + mx) x = node.x - mx;
  else if (node.x + node.width > x + w - mx) x = node.x + node.width - w + mx;
  if (node.height > h - 2 * my) y = middle(node) - Math.floor(h / 2);
  else if (node.y < y + my) y = node.y - my;
  else if (node.y + node.height > y + h - my) y = node.y + node.height - h + my;
  return {x: Math.trunc(x), y: Math.trunc(y)};
}
