import test from 'node:test';
import assert from 'node:assert/strict';
import {exportMarkdown, importMarkdown} from '../dist/markdown.js';
import {createMap, parseMM, serializeMM} from '../dist/model.js';

const treeText = nodes => nodes.map(({text, depth}) => ({text, depth}));

test('canonical Markdown contains one heading and two-space nested bullets', () => {
  const nodes = parseMM('MM-ZSH-1\n0\t0\t主题\n1\t1\t分支\n2\t0\t隐藏后代\n1\t0\t第二分支\n');
  assert.equal(exportMarkdown(nodes), '# 主题\n- 分支\n  - 隐藏后代\n- 第二分支\n');
  const imported = importMarkdown(exportMarkdown(nodes));
  assert.deepEqual(treeText(imported), treeText(nodes));
  assert.ok(imported.every(node => !node.folded));
});

test('round trip preserves all ASCII punctuation, literal entities, backslashes and boundary spaces', () => {
  const punctuation = Array.from({length: 94}, (_, index) => String.fromCharCode(index + 33)).join('');
  const labels = ['  根 & <script> "quotes"  ', punctuation, '\\&amp; &#32; &#x1F680; &copy;', '* _ ` [link](https://a.b) ![x]  ', '  中文 🚀 e\u0301 👩‍👩‍👧‍👦   '];
  const nodes = labels.map((text, index) => ({id: String(index), text, depth: index ? 1 : 0, folded: false}));
  const markdown = exportMarkdown(nodes);
  assert.ok(markdown.startsWith('# &#32;&#32;'));
  assert.match(markdown, /\\<script\\>/);
  assert.deepEqual(treeText(importMarkdown(markdown)), treeText(nodes));
  assert.equal(serializeMM(importMarkdown(markdown)), serializeMM(nodes));
});

test('mixed unordered markers, blank lines and CRLF map to the same hierarchy', () => {
  const markdown = '\r\n# Root\r\n\r\n+ First\r\n  * Child\r\n    - Grandchild\r\n\r\n- Second\r\n';
  const nodes = importMarkdown(markdown);
  assert.deepEqual(nodes.map(node => node.depth), [0, 1, 2, 3, 1]);
  assert.deepEqual(nodes.map(node => node.text), ['Root', 'First', 'Child', 'Grandchild', 'Second']);
});

test('escapes are decoded once and non-markup inline text is kept literally', () => {
  const nodes = importMarkdown('# Root\n- \\&amp; &amp; &lt; &gt; &quot; &apos; &#32; &#x1F680;\n- **literal emphasis** and [literal link](url)\n- \\A \\中\n');
  assert.equal(nodes[1].text, '&amp; & < > " \'   🚀');
  assert.equal(nodes[2].text, '**literal emphasis** and [literal link](url)');
  assert.equal(nodes[3].text, '\\A \\中');
});

test('unsupported blocks and malformed structure fail with their source line', () => {
  const cases = [
    ['', 1], ['\n\n', 1], ['- Missing root', 1],
    ['# Root\n# Second root', 2], ['# Root\n## Heading', 2],
    ['# Root\nplain paragraph', 2], ['# Root\n\n| table |', 3],
    ['# Root\n```js\ncode\n```', 2], ['# Root\n1. Ordered', 2],
    ['# Root\n - Odd indent', 2], ['# Root\n  - Jump', 2],
    ['# Root\n- Child\n    - Jump', 3], ['# Root\n\t- Tab indent', 2],
    ['# Root\n- ', 2], ['#    ', 1], ['# Root\n- &#32;', 2],
    ['# Root\n- &#0;', 2], ['# Root\n- &#xD800;', 2],
    ['# Root\n- &#1114112;', 2], ['# Root\n- &#10;', 2],
    ['# Root\n- Terminal\x1b[2J', 2], ['# Root\n- One\n  continuation', 3],
  ];
  for (const [markdown, line] of cases) {
    assert.throws(() => importMarkdown(markdown), new RegExp(`第 ${line} 行`), markdown);
  }
});

test('Markdown import enforces node, depth and Unicode length limits before returning a map', () => {
  assert.equal(importMarkdown('# ' + '🚀'.repeat(300))[0].text, '🚀'.repeat(300));
  assert.throws(() => importMarkdown('# ' + '🚀'.repeat(301)), /第 1 行.*300/);
  const deep = ['# Root', ...Array.from({length: 23}, (_, index) => '  '.repeat(index) + '- 节点')].join('\n');
  assert.equal(importMarkdown(deep).length, 24);
  assert.throws(() => importMarkdown(deep + '\n' + '  '.repeat(23) + '- 超深'), /第 25 行.*24/);
  const wide = '# Root\n' + Array.from({length: 499}, (_, index) => '- 节点 ' + index).join('\n');
  assert.equal(importMarkdown(wide).length, 500);
  assert.throws(() => importMarkdown(wide + '\n- 超量'), /第 501 行.*500/);
});

test('Markdown export leaves the input snapshot and fold state unchanged', () => {
  const node = Object.freeze({...createMap('根节点')[0], folded: true});
  const nodes = Object.freeze([node]);
  assert.equal(exportMarkdown(nodes), '# 根节点\n');
  assert.equal(nodes[0].folded, true);
});
