import {randomUUID} from 'node:crypto';
import {validateNodes, validateText} from './model.js';
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
  const headings: {level: number; depth: number}[] = [];
  const listIndents: number[] = [];
  let firstIsHeading = false;
  let roots = 0;
  for (const [index, line] of lines.entries()) {
    if (/^[ \t]*$/.test(line)) continue;
    try {
      let depth: number;
      let label: string;
      const heading = /^ {0,3}(#{1,6})[ \t](.*)$/u.exec(line);
      if (heading) {
        const level = heading[1]!.length;
        while (headings.length && headings.at(-1)!.level >= level) headings.pop();
        depth = (headings.at(-1)?.depth ?? -1) + 1;
        headings.push({level, depth});
        listIndents.length = 0;
        label = heading[2]!;
        if (nodes.length === 0) firstIsHeading = true;
      } else {
        const item = /^([ \t]*)([-+*])[ \t](.*)$/u.exec(line);
        if (!item) throw new Error('仅支持 #–###### 标题和单行无序列表；不支持正文、有序列表、表格或代码块');
        let indent = 0;
        for (const character of item[1]!) indent += character === '\t' ? 4 - indent % 4 : 1;
        // Indentation is relative: each increase adds one parent, regardless of its width.
        while (listIndents.length && listIndents.at(-1)! >= indent) listIndents.pop();
        depth = (headings.at(-1)?.depth ?? -1) + 1 + listIndents.length;
        listIndents.push(indent);
        label = item[3]!;
      }
      const node = {id: randomUUID(), text: decodeLabel(label), depth, folded: false};
      validateText(node.text);
      nodes.push(node);
      if (depth === 0) roots++;
    } catch (error) {
      throw new Error(`Markdown 第 ${index + 1} 行：${(error as Error).message}`);
    }
  }
  if (!nodes.length) throw new Error('Markdown 第 1 行：缺少标题或列表节点');
  if (!firstIsHeading || roots > 1) {
    for (const node of nodes) node.depth++;
    nodes.unshift({id: randomUUID(), text: '导入脑图', depth: 0, folded: false});
  }
  validateNodes(nodes);
  return nodes;
}
