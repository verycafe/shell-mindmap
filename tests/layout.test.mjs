import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutMap, renderViewport, followSelection} from '../dist/layout.js';
import {displayWidth} from '../dist/text.js';

const node = (id, depth, text = id, folded = false) => ({id, depth, text, folded});
const position = (layout, id) => layout.nodes.find(candidate => candidate.id === id);
const plain = rows => rows.map(row => row.map(span => span.text).join(''));
const fixture = () => [
  node('root', 0, '项目脑图'),
  node('a', 1, '第一个长分支 展示多行文字'), node('a1', 2, '任务一'), node('a2', 2, '任务二'),
  node('b', 1, '第二分支'), node('b1', 2, '左边子节点'),
  node('c', 1, '第三分支'), node('d', 1, '第四分支'),
];

function assertNoOverlap(layout) {
  const cells = new Set();
  for (const placed of layout.nodes) {
    assert.equal(placed.height, placed.lines.length);
    assert.ok(placed.width >= Math.max(...placed.lines.map(displayWidth)));
    for (let y = placed.y; y < placed.y + placed.height; y++) {
      for (let x = placed.x; x < placed.x + placed.width; x++) {
        const key = `${x},${y}`;
        assert.ok(!cells.has(key), `node overlap at ${key}`);
        cells.add(key);
      }
    }
  }
  const edgeCells = new Set();
  for (const edge of layout.edges) {
    const key = `${edge.x},${edge.y}`;
    assert.ok(!cells.has(key), `edge crosses node at ${key}`);
    assert.ok(!edgeCells.has(key), `duplicate edge at ${key}`);
    edgeCells.add(key);
    assert.equal(displayWidth(edge.char), 1);
  }
}

test('right layout reserves multiline blocks and connects each middle row', () => {
  const layout = layoutMap(fixture(), {nodeWidth: 8, mode: 'right'});
  assertNoOverlap(layout);
  assert.ok(position(layout, 'a').height > 1);
  assert.ok(layout.nodes.every(item => item.x >= 0));
  for (const child of layout.nodes.slice(1)) {
    const y = child.y + Math.floor((child.height - 1) / 2);
    assert.ok(layout.edges.some(edge => edge.x === child.x - 1 && edge.y === y), `${child.id} middle-row connection`);
  }
  assert.equal(layout.minX, 0);
  assert.equal(layout.maxX, Math.max(...layout.nodes.map(item => item.x + item.width)));
});

test('bilateral root branches alternate right/left and keep side through folds/text changes', () => {
  const source = fixture();
  const before = layoutMap(source, {nodeWidth: 12, mode: 'bilateral'});
  const after = layoutMap(source.map(item => item.id === 'a' ? {...item, text: '短', folded: true} : item), {nodeWidth: 12, mode: 'bilateral'});
  for (const id of ['a', 'a1', 'a2', 'c']) assert.ok(position(before, id).x > 0, id);
  for (const id of ['b', 'b1', 'd']) assert.ok(position(before, id).x < 0, id);
  for (const id of ['a', 'b', 'b1', 'c', 'd']) assert.equal(Math.sign(position(before, id).x), Math.sign(position(after, id).x));
  assert.equal(position(after, 'a1'), undefined);
  assert.equal(position(after, 'a2'), undefined);
  assert.match(position(after, 'a').lines.join(''), /\[\+\]/u);
  assertNoOverlap(before);
  assertNoOverlap(after);
  for (const id of ['b', 'b1', 'd']) {
    const child = position(before, id);
    const y = child.y + Math.floor((child.height - 1) / 2);
    assert.ok(before.edges.some(edge => edge.x === child.x + child.width && edge.y === y));
  }
});

test('folded roots hide descendants, empty maps and multiple roots are safe', () => {
  assert.deepEqual(layoutMap([], {nodeWidth: 10, mode: 'right'}), {nodes: [], edges: [], minX: 0, maxX: 0, minY: 0, maxY: 0});
  const folded = layoutMap(fixture().map(item => item.id === 'root' ? {...item, folded: true} : item), {nodeWidth: 10, mode: 'bilateral'});
  assert.equal(folded.nodes.length, 1);
  assert.equal(folded.edges.length, 0);
  const forest = layoutMap([...fixture(), node('other', 0), node('other-child', 1)], {nodeWidth: 10, mode: 'bilateral'});
  assertNoOverlap(forest);
  assert.ok(position(forest, 'other').y > position(forest, 'root').y);
});

test('500 nodes and a 500-level chain lay out without recursion or collisions', () => {
  const source = [node('root', 0)];
  for (let index = 1; index < 500; index++) source.push(node(String(index), index % 5 === 1 ? 1 : 2, `中文任务${index}👩‍💻`));
  for (const mode of ['right', 'bilateral']) {
    const layout = layoutMap(source, {nodeWidth: 10, mode});
    assert.equal(layout.nodes.length, 500);
    assertNoOverlap(layout);
    const view = renderViewport(layout, {x: -5, y: 100, width: 37, height: 12, selected: '10'});
    assert.equal(view.length, 12);
    assert.ok(plain(view).every(line => displayWidth(line) === 37));
  }
  const chain = layoutMap(Array.from({length: 500}, (_, index) => node(String(index), index)), {nodeWidth: 8, mode: 'right'});
  assert.equal(chain.nodes.length, 500);
  assertNoOverlap(chain);
});

test('viewport clips wide characters to spaces and produces exact terminal dimensions', () => {
  const layout = {nodes: [{id: 'one', x: 0, y: 0, width: 5, height: 1, lines: ['中A文']}], edges: [], minX: 0, maxX: 5, minY: 0, maxY: 1};
  const view = renderViewport(layout, {x: 1, y: 0, width: 3, height: 2, selected: 'one'});
  assert.deepEqual(plain(view), [' A ', '   ']);
  assert.equal(view[0][0].tone, 'selected');
  assert.deepEqual(plain(renderViewport(layout, {x: 3, y: 0, width: 2, height: 1, selected: ''})), ['文']);
  assert.deepEqual(renderViewport(layout, {x: 0, y: 0, width: 0, height: 1, selected: ''}), [[]]);
  for (let x = -3; x < 9; x++) {
    for (let width = 1; width < 8; width++) {
      assert.equal(displayWidth(plain(renderViewport(layout, {x, y: 0, width, height: 1, selected: 'one'}))[0]), width);
    }
  }
});

test('selection follow brings both left and right branches into view and retains stable views', () => {
  const layout = layoutMap(fixture(), {nodeWidth: 8, mode: 'bilateral'});
  for (const id of ['a1', 'b1', 'd']) {
    const view = followSelection(layout, id, {x: 100, y: 100}, 30, 10);
    const selected = position(layout, id);
    assert.ok(selected.x >= view.x && selected.x + selected.width <= view.x + 30);
    assert.ok(selected.y >= view.y && selected.y + selected.height <= view.y + 10);
    assert.deepEqual(followSelection(layout, id, view, 30, 10), view);
  }
  assert.deepEqual(followSelection(layout, 'missing', {x: -7, y: 8}, 30, 10), {x: -7, y: 8});
  const narrow = followSelection(layout, 'root', {x: 100, y: 100}, 1, 1);
  assert.ok(Number.isInteger(narrow.x) && Number.isInteger(narrow.y));
});
