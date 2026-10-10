import {randomUUID} from 'node:crypto';
import {validateNodes} from './model.js';
import type {MindmapNode} from './types.js';

function isPunctuation(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

function escapeLabel(text: string): string {
  return [...text].map(character => isPunctuation(character) ? `\\${character}` : character).join('')
    .replace(/^ +| +$/g, spaces => '&#32;'.repeat(spaces.length));
}

function decodeLabel(text: string): string {
  let decoded = '';
  const named: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0'};
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (character === '\\' && index + 1 < text.length && isPunctuation(text[index + 1]!)) {
      decoded += text[++index];
    } else if (character === '&') {
      const entity = /^&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp);/.exec(text.slice(index));
      if (!entity) {
        decoded += character;
        continue;
      }
      const name = entity[1]!;
      if (name.startsWith('#')) {
        const code = /^#[xX]/.test(name) ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
          throw new Error('无效的字符实体');
        }
        decoded += String.fromCodePoint(code);
      } else {
        decoded += named[name];
      }
      index += entity[0].length - 1;
    } else {
      decoded += character;
    }
  }
  return decoded;
}

export function exportMarkdown(nodes: MindmapNode[]): string {
  validateNodes(nodes);
  return `${nodes.map((node, index) => index === 0
    ? `# ${escapeLabel(node.text)}`
    : `${'  '.repeat(node.depth - 1)}- ${escapeLabel(node.text)}`).join('\n')}\n`;
}

export function importMarkdown(text: string): MindmapNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const nodes: MindmapNode[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === '' || /^ *$/.test(line)) continue;
    try {
      let depth = 0;
      let label = '';
      if (nodes.length === 0) {
        if (!line.startsWith('# ')) throw new Error('脑图必须以一个 # 根节点标题开始');
        label = line.slice(2);
      } else {
        if (line.startsWith('# ')) throw new Error('只能有一个 # 根节点标题');
        const item = /^( *)([-+*]) (.*)$/u.exec(line);
        if (!item) throw new Error('仅支持单行无序列表节点；不支持正文、其他标题、表格或代码块');
        if (item[1]!.length % 2 !== 0) throw new Error('子节点必须按每级 2 个空格缩进');
        depth = item[1]!.length / 2 + 1;
        label = item[3]!;
      }
      const node = {id: randomUUID(), text: decodeLabel(label), depth, folded: false};
      const candidate = [...nodes, node];
      validateNodes(candidate);
      nodes.push(node);
    } catch (error) {
      throw new Error(`Markdown 第 ${index + 1} 行：${(error as Error).message}`);
    }
  }
  if (!nodes.length) throw new Error('Markdown 第 1 行：缺少 # 根节点标题');
  return nodes;
}
