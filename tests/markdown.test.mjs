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

test('list nesting follows relative indentation, including four-space indentation on line three', () => {
  for (const indentation of [' ', '  ', '    ', '       ', '\t']) {
    const markdown = `# Root\n- First\n${indentation}- Child\n${indentation.repeat(2)}- Grandchild\n${indentation}- Sibling\n- Second\n`;
    assert.deepEqual(treeText(importMarkdown(markdown)), [
      {text: 'Root', depth: 0}, {text: 'First', depth: 1},
      {text: 'Child', depth: 2}, {text: 'Grandchild', depth: 3},
      {text: 'Sibling', depth: 2}, {text: 'Second', depth: 1},
    ], JSON.stringify(indentation));
  }
  const mixed = '# Root\n\t- First\n\t  - Child\n\t\t- Grandchild\n      - Sibling\n    - Second\n- Third\n';
  assert.deepEqual(importMarkdown(mixed).map(node => node.depth), [0, 1, 2, 3, 2, 1, 1]);
  const intermediate = '# Root\n- First\n    - Child\n  - Sibling\n';
  assert.deepEqual(importMarkdown(intermediate).map(node => node.depth), [0, 1, 2, 2]);
});

test('headings and their lists retain relative hierarchy when heading levels skip', () => {
  const markdown = '# Root\n- Intro\n    - Detail\n### Section\n- Item\n    - Nested\n###### Subsection\n* Leaf\n## Another\n+ Last\n';
  assert.deepEqual(treeText(importMarkdown(markdown)), [
    {text: 'Root', depth: 0}, {text: 'Intro', depth: 1}, {text: 'Detail', depth: 2},
    {text: 'Section', depth: 1}, {text: 'Item', depth: 2}, {text: 'Nested', depth: 3},
    {text: 'Subsection', depth: 2}, {text: 'Leaf', depth: 3},
    {text: 'Another', depth: 1}, {text: 'Last', depth: 2},
  ]);
  assert.deepEqual(treeText(importMarkdown('## Root\n#### Child\n')), [
    {text: 'Root', depth: 0}, {text: 'Child', depth: 1},
  ]);
});

test('multiple top-level headings gain a common root without dropping or renaming source nodes', () => {
  const nodes = importMarkdown('# First\n- A\n    - B\n# Second\n## Subheading\n- C\n# First\n');
  assert.deepEqual(treeText(nodes), [
    {text: '导入脑图', depth: 0}, {text: 'First', depth: 1},
    {text: 'A', depth: 2}, {text: 'B', depth: 3},
    {text: 'Second', depth: 1}, {text: 'Subheading', depth: 2},
    {text: 'C', depth: 3}, {text: 'First', depth: 1},
  ]);
  assert.deepEqual(treeText(importMarkdown(exportMarkdown(nodes))), treeText(nodes));
});

test('lists without a root heading gain a common root, including a single item and leading lists', () => {
  assert.deepEqual(treeText(importMarkdown('- Only item')), [
    {text: '导入脑图', depth: 0}, {text: 'Only item', depth: 1},
  ]);
  const nodes = importMarkdown('\t \n  - First\n      - Child\n  - Second\n# Later heading\n- Last\n');
  assert.deepEqual(treeText(nodes), [
    {text: '导入脑图', depth: 0}, {text: 'First', depth: 1},
    {text: 'Child', depth: 2}, {text: 'Second', depth: 1},
    {text: 'Later heading', depth: 1}, {text: 'Last', depth: 2},
  ]);
  assert.deepEqual(treeText(importMarkdown(exportMarkdown(nodes))), treeText(nodes));
});

test('escapes are decoded once and non-markup inline text is kept literally', () => {
  const nodes = importMarkdown('# Root\n- \\&amp; &amp; &lt; &gt; &quot; &apos; &#32; &#x1F680;\n- **literal emphasis** and [literal link](url)\n- \\A \\中\n');
  assert.equal(nodes[1].text, '&amp; & < > " \'   🚀');
  assert.equal(nodes[2].text, '**literal emphasis** and [literal link](url)');
  assert.equal(nodes[3].text, '\\A \\中');
});

test('unsupported blocks and malformed structure fail with their source line', () => {
  const cases = [
    ['', 1], ['\n\n', 1], ['\t \n\t', 1],
    ['# Root\nplain paragraph', 2], ['# Root\n\n| table |', 3],
    ['# Root\n```js\ncode\n```', 2], ['# Root\n1. Ordered', 2],
    ['# Root\n####### Heading', 2], ['# Root\n> Quote', 2],
    ['# Root\n- ', 2], ['#    ', 1], ['# Root\n- &#32;', 2],
    ['# Root\n- &#0;', 2], ['# Root\n- &#xD800;', 2],
    ['# Root\n- &#1114112;', 2], ['# Root\n- &#10;', 2],
    ['# Root\n- Terminal\x1b[2J', 2], ['# Root\n- One\n  continuation', 3],
    ['- Valid\n\t- Invalid\ttext', 2], ['# First\n# Second\x07', 2],
    ['- Valid\n# Heading\n- &#x7F;', 3], ['- Valid\n\x1b[2J', 2],
  ];
  for (const [markdown, line] of cases) {
    assert.throws(() => importMarkdown(markdown), new RegExp(`第 ${line} 行`), markdown);
  }
});

test('Markdown import and round trips preserve more than 500 nodes, 99 levels and 300 characters', () => {
  const label = '中文 العربية हिन्दी 🚀 e\u0301 '.repeat(100);
  const deep = Array.from({length: 125}, (_, index) => '\t'.repeat(index) + '- 深层 ' + index);
  const wide = Array.from({length: 1200}, (_, index) => '- 节点 ' + index);
  const nodes = importMarkdown(['# ' + label, ...deep, ...wide].join('\n'));
  assert.equal(nodes[0].text, label);
  assert.equal(nodes.length, 1326);
  assert.equal(nodes[125].depth, 125);
  assert.equal(nodes[126].depth, 1);
  assert.equal(nodes.at(-1).text, '节点 1199');
  assert.deepEqual(treeText(importMarkdown(exportMarkdown(nodes))), treeText(nodes));
  assert.deepEqual(treeText(parseMM(serializeMM(nodes))), treeText(nodes));
  assert.throws(() => importMarkdown('# Root\n- ' + label + '\x1b[2J'), /第 2 行.*控制字符/);
});

test('Markdown export leaves the input snapshot and fold state unchanged', () => {
  const node = Object.freeze({...createMap('根节点')[0], folded: true});
  const nodes = Object.freeze([node]);
  assert.equal(exportMarkdown(nodes), '# 根节点\n');
  assert.equal(nodes[0].folded, true);
});
