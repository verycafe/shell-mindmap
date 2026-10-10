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

test('node text, count and depth round trip beyond the former size limits', () => {
  const text = '中文 English العربية हिन्दी e\u0301 🚀'.repeat(80);
  assert.equal(createMap(text)[0].text, text);
  const deep = Array.from({length: 130}, (_, depth) => ({id: String(depth), text: `${depth} ${text}`, depth, folded: depth % 2 === 0}));
  const child = addChild(frozen(deep), '129', text);
  assert.equal(child.nodes.at(-1).depth, 130);
  assert.deepEqual(content(parseMM(serializeMM(child.nodes))), content(child.nodes));
  const wide = Array.from({length: 700}, (_, index) => ({id: String(index), text, depth: index ? 1 : 0, folded: false}));
  const added = addChild(frozen(wide), '0', text);
  const sibling = addSibling(frozen(added.nodes), added.selected, text);
  const edited = editNode(frozen(sibling.nodes), sibling.selected, text + ' 完整结尾');
  const pasted = pasteBranch(frozen(edited.nodes), '0', createMap(text));
  assert.equal(pasted.nodes.length, 703);
  assert.equal(pasted.nodes.at(-2).text, text + ' 完整结尾');
  assert.deepEqual(content(parseMM(serializeMM(pasted.nodes))), content(pasted.nodes));
});

test('node text still rejects blank values and terminal controls', () => {
  assert.throws(() => createMap(' \u3000 '), /不能为空/);
  for (const text of ['a\nb', 'a\tb', 'a\x00b']) assert.throws(() => createMap(text), /控制字符/);
});

test('validation rejects duplicate IDs, non-boolean folds and invalid numeric depths', () => {
  assert.throws(() => validateNodes([{id: '', text: 'x', depth: 0, folded: false}]), /标识/);
  for (const patch of [{depth: 0.5}, {depth: -1}, {depth: NaN}, {depth: Infinity}, {depth: Number.MAX_SAFE_INTEGER + 1}, {folded: 1}]) {
    assert.throws(() => validateNodes([{...createMap()[0], ...patch}]));
  }
  const nodes = fixture();
  nodes[1].id = nodes[0].id;
  assert.throws(() => validateNodes(nodes), /重复/);
});

test('depth validation reports numeric errors, missing roots, multiple roots and skipped parents separately', () => {
  const root = {id: 'root', text: 'root', depth: 0, folded: false};
  const invalid = [
    [{...root, depth: Number.MAX_SAFE_INTEGER + 1}, /非负安全整数/],
    [{...root, depth: 1}, /首个节点必须是第 0 层根节点/],
  ];
  for (const [node, error] of invalid) assert.throws(() => validateNodes([node]), error);
  for (const [depth, error] of [[0, /只能有一个根节点/], [2, /不能跳过父节点/]]) {
    assert.throws(() => validateNodes([root, {...root, id: 'child', depth}]), error);
    assert.throws(() => parseMM(`MM-ZSH-1\n0\t0\troot\n${depth}\t0\tchild\n`), error);
  }
  assert.throws(() => parseMM('MM-ZSH-1\n1\t0\troot\n'), /文件第 2 行：首个节点/);
  assert.throws(() => parseMM('MM-ZSH-1\n0\t0\troot\n9007199254740992\t0\tchild\n'), /文件第 3 行：层级必须是非负安全整数/);
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
  assert.throws(() => pasteBranch(nodes, 'b', []), /至少一个节点/);
});

test('deep moves and pastes succeed while preserving their input snapshots and clipboard', () => {
  const nodes = Array.from({length: 130}, (_, depth) => ({id: String(depth), text: '节点', depth, folded: false}));
  nodes.push({id: 'sibling', text: '另一分支', depth: 1, folded: false});
  const before = serializeMM(nodes);
  const moved = moveBranch(frozen(nodes), 'sibling', '129');
  assert.equal(moved.nodes.at(-1).depth, 130);
  assert.equal(moved.nodes.at(-1).id, 'sibling');
  const clipboard = frozen(createMap('待粘贴'));
  const pasted = pasteBranch(frozen(nodes), '129', clipboard);
  assert.equal(pasted.nodes.at(-2).depth, 130);
  assert.equal(pasted.nodes.at(-2).text, '待粘贴');
  assert.equal(serializeMM(nodes), before);
  assert.equal(clipboard[0].depth, 0);
});

test('invalid branch operations preserve both input model and clipboard', () => {
  const nodes = frozen(fixture());
  const before = serializeMM(nodes);
  const clipboard = frozen([{id: 'invalid', text: '未丢失', depth: 1, folded: false}]);
  assert.throws(() => pasteBranch(nodes, 'b', clipboard), /首个节点/);
  assert.throws(() => moveBranch(nodes, 'a', 'a1'), /自身或其子节点/);
  assert.throws(() => editNode(nodes, 'a', 'bad\ntext'), /控制字符/);
  assert.equal(serializeMM(nodes), before);
  assert.deepEqual(clipboard, [{id: 'invalid', text: '未丢失', depth: 1, folded: false}]);
});

test('large branches can be moved and pasted without function argument count limits', () => {
  const descendantCount = 150_000;
  const source = [
    {id: 'root', text: 'root', depth: 0, folded: false},
    {id: 'branch', text: 'branch', depth: 1, folded: true},
    ...Array.from({length: descendantCount}, (_, index) => ({id: `leaf-${index}`, text: `leaf ${index}`, depth: 2, folded: false})),
    {id: 'target', text: 'target', depth: 1, folded: true},
  ];
  const moved = moveBranch(source, 'branch', 'target');
  assert.equal(moved.nodes.length, source.length);
  assert.deepEqual(ids(moved.nodes.slice(0, 3)), ['root', 'target', 'branch']);
  assert.deepEqual(moved.nodes.at(-1), {id: `leaf-${descendantCount - 1}`, text: `leaf ${descendantCount - 1}`, depth: 3, folded: false});
  assert.equal(moved.nodes[1].folded, false);
  assert.equal(source[1].depth, 1);
  assert.equal(source.at(-1).folded, true);
  const clipboard = copyBranch(source, 'branch');
  const destination = createMap('destination');
  const pasted = pasteBranch(destination, destination[0].id, clipboard);
  assert.equal(pasted.nodes.length, descendantCount + 2);
  assert.deepEqual(content(pasted.nodes.slice(1)), content(source.slice(1, -1)));
  assert.equal(new Set(ids(pasted.nodes)).size, pasted.nodes.length);
  assert.notEqual(pasted.nodes[1].id, clipboard[0].id);
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
      catch (error) { assert.match(error.message, /自身或其子节点/); }
    }
    assert.equal(serializeMM(snapshot), before);
    validateNodes(nodes);
    assert.deepEqual(content(parseMM(serializeMM(nodes))), content(nodes));
  }
});
