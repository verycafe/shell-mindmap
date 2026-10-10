import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMap, validateNodes, parseMM, serializeMM, visibleNodes, parentId,
  addChild, addSibling, editNode, removeBranch, toggleFold, moveBranch,
  reorderBranch, copyBranch, pasteBranch, revealNode, searchNodes,
} from '../dist/model.js';

const fixture = () => [
  {id: 'root', text: '中心', depth: 0, folded: false},
  {id: 'a', text: '产品 Alpha', depth: 1, folded: true},
  {id: 'a1', text: '隐藏需求', depth: 2, folded: false},
  {id: 'a2', text: '测试', depth: 2, folded: false},
  {id: 'b', text: '研发', depth: 1, folded: false},
  {id: 'b1', text: '数据库', depth: 2, folded: false},
  {id: 'c', text: '发布', depth: 1, folded: false},
];
const ids = nodes => nodes.map(node => node.id);
const content = nodes => nodes.map(({id, ...rest}) => rest);
const frozen = nodes => Object.freeze(nodes.map(node => Object.freeze({...node})));

test('native format round trips all text, fold flags, CRLF and missing final newline', () => {
  const text = 'MM-ZSH-1\n0\t0\t中心 🚀\n1\t1\t  $(echo x) \\ " &#32;  \n2\t0\t隐藏中文\n';
  assert.equal(serializeMM(parseMM(text)), text);
  assert.equal(serializeMM(parseMM(text.trimEnd())), text.trimEnd() + '\n');
  assert.equal(serializeMM(parseMM(text.replaceAll('\n', '\r\n'))), text);
  assert.equal(new Set(ids(parseMM(text))).size, 3);
});

test('native format rejects malformed fields, tree shapes and terminal controls', () => {
  const invalid = [
    '', 'wrong\n0\t0\troot', 'MM-ZSH-1', 'MM-ZSH-1\n',
    'MM-ZSH-1\n0\t0\troot\n\n', 'MM-ZSH-1\n0\t0\troot\n0\t0\tsecond',
    'MM-ZSH-1\n1\t0\troot', 'MM-ZSH-1\n0\t0\troot\n2\t0\tjump',
    'MM-ZSH-1\n0\t2\troot', 'MM-ZSH-1\n-1\t0\troot',
    'MM-ZSH-1\n0\t0\troot\textra', 'MM-ZSH-1\n0\t0\t \t ',
    'MM-ZSH-1\n0\t0\troot\x1b[2J', 'MM-ZSH-1\n0\t0\troot\u0085',
    'MM-ZSH-1\n0\t0\troot\n999999999999999999\t0\tchild',
    'MM-ZSH-1\n0\t0\troot\na[$(echo x)]\t0\tchild',
  ];
  for (const text of invalid) assert.throws(() => parseMM(text), undefined, text);
});

test('node limits count Unicode code points and permit the exact documented boundaries', () => {
  assert.equal([...createMap('🚀'.repeat(300))[0].text].length, 300);
  assert.throws(() => createMap('🚀'.repeat(301)), /300/);
  assert.throws(() => createMap(' \u3000 '), /不能为空/);
  for (const text of ['a\nb', 'a\tb', 'a\x00b']) assert.throws(() => createMap(text), /控制字符/);
  const deep = Array.from({length: 24}, (_, depth) => ({id: String(depth), text: '节点', depth, folded: false}));
  validateNodes(deep);
  assert.throws(() => addChild(deep, '23', '超深'), /24/);
  const wide = Array.from({length: 500}, (_, index) => ({id: String(index), text: '节点', depth: index ? 1 : 0, folded: false}));
  validateNodes(wide);
  assert.throws(() => addChild(wide, '0', '超量'), /500/);
  assert.throws(() => pasteBranch(wide, '0', createMap('复制')), /500/);
});

test('validation rejects duplicate IDs, non-boolean folds and invalid numeric depths', () => {
  assert.throws(() => validateNodes([{id: '', text: 'x', depth: 0, folded: false}]), /标识/);
  for (const patch of [{depth: 0.5}, {depth: -1}, {depth: NaN}, {folded: 1}]) {
    assert.throws(() => validateNodes([{...createMap()[0], ...patch}]));
  }
  const nodes = fixture();
  nodes[1].id = nodes[0].id;
  assert.throws(() => validateNodes(nodes), /重复/);
});

test('child and sibling insertion respect complete subtrees and reveal their parent', () => {
  const nodes = frozen(fixture());
  const child = addChild(nodes, 'a', '新需求');
  assert.deepEqual(child.nodes.map(node => node.text), ['中心', '产品 Alpha', '隐藏需求', '测试', '新需求', '研发', '数据库', '发布']);
  assert.equal(child.nodes[4].depth, 2);
  assert.equal(child.selected, child.nodes[4].id);
  assert.equal(child.nodes[1].folded, false);
  const sibling = addSibling(nodes, 'a', '新分支');
  assert.equal(sibling.nodes[4].text, '新分支');
  assert.equal(sibling.nodes[4].depth, 1);
  assert.throws(() => addSibling(nodes, 'root', '第二根'), /根节点/);
  assert.equal(nodes[1].folded, true);
});

test('edit, delete and fold return independent snapshots suitable for one-step undo', () => {
  const nodes = frozen(fixture());
  const before = serializeMM(nodes);
  const edited = editNode(nodes, 'a', '新名称');
  assert.equal(edited.nodes[1].text, '新名称');
  assert.equal(edited.selected, 'a');
  const removed = removeBranch(nodes, 'a');
  assert.deepEqual(ids(removed.nodes), ['root', 'b', 'b1', 'c']);
  assert.equal(removed.selected, 'root');
  assert.throws(() => removeBranch(nodes, 'root'), /根节点/);
  assert.equal(toggleFold(nodes, 'a').nodes[1].folded, false);
  assert.equal(serializeMM(nodes), before);
  assert.throws(() => editNode(nodes, 'missing', 'x'), /找不到/);
});

test('visible navigation hides all descendants and search reveals ancestors only', () => {
  const nodes = fixture();
  assert.deepEqual(ids(visibleNodes(nodes)), ['root', 'a', 'b', 'b1', 'c']);
  assert.equal(parentId(nodes, 'a2'), 'a');
  assert.equal(parentId(nodes, 'b'), 'root');
  assert.equal(parentId(nodes, 'root'), undefined);
  assert.equal(parentId(nodes, 'missing'), undefined);
  nodes[0].folded = true;
  nodes[4].folded = true;
  const revealed = revealNode(frozen(nodes), 'a1');
  assert.equal(revealed[0].folded, false);
  assert.equal(revealed[1].folded, false);
  assert.equal(revealed[4].folded, true);
  assert.deepEqual(ids(searchNodes(nodes, '隐藏')), ['a1']);
  assert.deepEqual(ids(searchNodes(nodes, ' alpha ')), ['a']);
  assert.deepEqual(searchNodes(nodes, '  '), []);
});

test('branch movement preserves IDs, order and relative depths in both index directions', () => {
  const nodes = frozen(fixture());
  const moved = moveBranch(nodes, 'a', 'b');
  assert.deepEqual(ids(moved.nodes), ['root', 'b', 'b1', 'a', 'a1', 'a2', 'c']);
  assert.deepEqual(moved.nodes.map(node => node.depth), [0, 1, 2, 2, 3, 3, 1]);
  assert.equal(moved.selected, 'a');
  const back = moveBranch(moved.nodes, 'a', 'root');
  assert.deepEqual(ids(back.nodes), ['root', 'b', 'b1', 'c', 'a', 'a1', 'a2']);
  assert.deepEqual(back.nodes.slice(-3).map(node => node.depth), [1, 2, 2]);
  const earlier = moveBranch(nodes, 'b', 'a');
  assert.deepEqual(ids(earlier.nodes), ['root', 'a', 'a1', 'a2', 'b', 'b1', 'c']);
  assert.equal(earlier.nodes[1].folded, false);
  for (const target of ['a', 'a1', 'a2']) assert.throws(() => moveBranch(nodes, 'a', target), /自身或其子节点/);
  assert.throws(() => moveBranch(nodes, 'root', 'b'), /根节点/);
  assert.deepEqual(ids(nodes), ['root', 'a', 'a1', 'a2', 'b', 'b1', 'c']);
});

test('sibling reordering moves complete subtrees and stops at sibling boundaries', () => {
  const nodes = frozen(fixture());
  const down = reorderBranch(nodes, 'a', 1);
  assert.deepEqual(ids(down.nodes), ['root', 'b', 'b1', 'a', 'a1', 'a2', 'c']);
  assert.deepEqual(ids(reorderBranch(down.nodes, 'a', -1).nodes), ids(nodes));
  assert.deepEqual(ids(reorderBranch(nodes, 'a2', -1).nodes), ['root', 'a', 'a2', 'a1', 'b', 'b1', 'c']);
  assert.deepEqual(ids(reorderBranch(nodes, 'a', -1).nodes), ids(nodes));
  assert.deepEqual(ids(reorderBranch(nodes, 'a2', 1).nodes), ids(nodes));
  assert.throws(() => reorderBranch(nodes, 'root', 1), /根节点/);
});

test('clipboard is detached, rebased and reusable with new IDs for every paste', () => {
  const nodes = frozen(fixture());
  const clipboard = frozen(copyBranch(nodes, 'a'));
  assert.deepEqual(clipboard.map(node => node.depth), [0, 1, 1]);
  const first = pasteBranch(nodes, 'b', clipboard);
  const second = pasteBranch(first.nodes, 'b', clipboard);
  assert.equal(second.nodes.length, nodes.length + 6);
  assert.equal(new Set(ids(second.nodes)).size, second.nodes.length);
  const copied = second.nodes.filter(node => !ids(nodes).includes(node.id));
  assert.deepEqual(copied.map(node => node.text), ['产品 Alpha', '隐藏需求', '测试', '产品 Alpha', '隐藏需求', '测试']);
  assert.deepEqual(copied.map(node => node.depth), [2, 3, 3, 2, 3, 3]);
  assert.equal(copied[0].folded, true);
  assert.equal(first.selected, copied[0].id);
  assert.equal(second.selected, copied[3].id);
  assert.deepEqual(ids(clipboard), ['a', 'a1', 'a2']);
  assert.throws(() => pasteBranch(nodes, 'b', []), /1–500/);
});

test('rejected deep move and paste preserve both input and clipboard', () => {
  const nodes = Array.from({length: 24}, (_, depth) => ({id: String(depth), text: '节点', depth, folded: false}));
  nodes.push({id: 'sibling', text: '另一分支', depth: 1, folded: false});
  const before = serializeMM(nodes);
  assert.throws(() => moveBranch(frozen(nodes), 'sibling', '23'), /24/);
  const clipboard = frozen(createMap('待粘贴'));
  assert.throws(() => pasteBranch(frozen(nodes), '23', clipboard), /24/);
  assert.equal(serializeMM(nodes), before);
  assert.equal(clipboard[0].depth, 0);
});

test('many successive branch operations retain valid serializable trees and immutable snapshots', () => {
  let nodes = createMap('随机结构');
  let seed = 9127;
  const random = max => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
  for (let index = 0; index < 45; index++) {
    const parents = nodes.filter(node => node.depth < 8);
    nodes = addChild(nodes, parents[random(parents.length)].id, `节点 ${index}`).nodes;
  }
  for (let iteration = 0; iteration < 120; iteration++) {
    const snapshot = frozen(nodes);
    const before = serializeMM(snapshot);
    const source = nodes[1 + random(nodes.length - 1)];
    if (iteration % 2) {
      nodes = reorderBranch(snapshot, source.id, random(2) ? 1 : -1).nodes;
    } else {
      try { nodes = moveBranch(snapshot, source.id, nodes[random(nodes.length)].id).nodes; }
      catch (error) { assert.match(error.message, /自身或其子节点|24/); }
    }
    assert.equal(serializeMM(snapshot), before);
    validateNodes(nodes);
    assert.deepEqual(content(parseMM(serializeMM(nodes))), content(nodes));
  }
});
