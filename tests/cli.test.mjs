import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readMap} from '../dist/storage.js';

const executable = fileURLToPath(new URL('../bin/SMM.js', import.meta.url));
const compatibilityExecutable = fileURLToPath(new URL('../bin/mm.js', import.meta.url));
const packageMetadata = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const packageVersion = packageMetadata.version;
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cli-'));
  const workspace = path.join(home, '工作目录');
  fs.mkdirSync(workspace);
  const config = path.join(home, '配置', 'settings.json');
  const env = {...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), MM_CONFIG_FILE: config, NO_COLOR: '1'};
  delete env.MM_NODE_WIDTH;
  delete env.FORCE_COLOR;
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const run = (args, options = {}) => {
    const result = spawnSync(process.execPath, [executable, ...args], {cwd: workspace, env, encoding: 'utf8', timeout: 10000, ...options});
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, 'CLI did not finish normally: ' + result.stderr);
    return result;
  };
  const success = args => {const result = run(args); assert.equal(result.status, 0, result.stderr); return result.stdout;};
  const failure = args => {const result = run(args); assert.equal(result.status, 2, result.stdout); return result.stderr;};
  const writeConfig = value => {fs.mkdirSync(path.dirname(config), {recursive: true}); fs.writeFileSync(config, value);};
  return {home, workspace, config, env, run, success, failure, writeConfig};
}

test('CLI help, version and config path work despite corrupt config and never create a library', t => {
  const {home, config, success, writeConfig} = setup(t);
  writeConfig('{corrupt');
  for (const alias of ['help', '--help', '-h']) assert.match(success([alias]), /Shell Mindmap/);
  assert.equal(success(['--version']).trim(), `shell-mindmap ${packageVersion}`);
  assert.equal(success(['config', 'path']).trim(), config);
  assert.equal(fs.readFileSync(config, 'utf8'), '{corrupt');
  assert.equal(fs.existsSync(path.join(home, 'Shell Mindmap')), false);
});

test('SMM is the primary executable and mm remains a working compatibility alias', t => {
  const {env, workspace, success, failure} = setup(t);
  assert.deepEqual(packageMetadata.bin, {SMM: 'bin/SMM.js', mm: 'bin/mm.js'});
  const help = success(['help']);
  assert.match(help, /SMM\s+浏览当前目录的子文件夹和脑图/u);
  assert.match(help, /SMM \[--\] 文件\.mm/u);
  assert.match(help, /旧命令 mm 保留为兼容别名/u);
  assert.match(failure(['--unknown']), /^SMM: 用法：SMM/u);
  for (const args of [['help'], ['--version']]) {
    const result = spawnSync(process.execPath, [compatibilityExecutable, ...args], {cwd: workspace, env, encoding: 'utf8', timeout: 10000});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, success(args));
  }
});

test('CLI read-only config and keys do not write default settings or create directories', t => {
  const {home, config, success} = setup(t);
  assert.match(success(['config']), /node-width=32/);
  assert.match(success(['config', 'list']), /layout=right/);
  assert.equal(success(['config', 'get', 'save-dir']), '\n');
  assert.match(success(['keys']), /child\s+Tab/u);
  assert.match(success(['keys', 'list']), /search\s+f\s/u);
  assert.match(success(['keys', 'list']), /delete\s+d \/ Delete \/ Backspace\s+删除分支/u);
  assert.equal(fs.existsSync(config), false);
  assert.equal(fs.existsSync(path.join(home, 'Shell Mindmap')), false);
});

test('CLI settings and key bindings persist, reject conflicts without changes, and reset correctly', t => {
  const {config, success, failure} = setup(t);
  success(['config', 'set', 'node-width', '48']);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).version, 2);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).saveDir, '');
  success(['config', 'set', 'layout', 'bilateral']);
  success(['keys', 'bind', 'edit', '编']);
  assert.equal(success(['config', 'get', 'node-width']).trim(), '48');
  assert.equal(success(['config', 'get', 'layout']).trim(), 'bilateral');
  assert.equal(success(['config', 'get', 'key.edit']).trim(), '编');
  const original = fs.readFileSync(config, 'utf8');
  assert.match(failure(['keys', 'bind', 'child', '编']), /冲突/);
  assert.match(failure(['config', 'set', 'node-width', '81']), /8–80/);
  assert.match(failure(['config', 'get', 'unknown']), /未知/);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  success(['keys', 'reset', 'edit']);
  assert.equal(success(['config', 'get', 'key.edit']).trim(), 'e');
  success(['keys', 'bind', 'copy', '']);
  assert.equal(success(['config', 'get', 'key.copy']).trim(), '');
  success(['keys', 'reset']);
  assert.equal(success(['config', 'get', 'key.copy']).trim(), 'c');
  assert.equal(success(['config', 'get', 'node-width']).trim(), '48');
  success(['config', 'reset', 'node-width']);
  assert.equal(success(['config', 'get', 'node-width']).trim(), '32');
});

test('CLI corrupt config reset preserves a backup and restores working settings', t => {
  const {config, success, failure, writeConfig} = setup(t);
  writeConfig('{bad JSON');
  assert.match(failure(['config']), /SMM config reset/);
  assert.equal(fs.readFileSync(config, 'utf8'), '{bad JSON');
  success(['config', 'reset']);
  assert.equal(success(['config', 'get', 'layout']).trim(), 'right');
  const backup = fs.readdirSync(path.dirname(config)).find(name => name.startsWith('settings.json.backup-'));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(path.dirname(config), backup), 'utf8'), '{bad JSON');
});

test('CLI reads legacy config without migration until an explicit settings write', t => {
  const {home, config, success, writeConfig} = setup(t);
  const legacy = 'MM-CONFIG-1\nnode-width\t40\nkey.edit\tc\nsave-dir\t';
  writeConfig(legacy);
  assert.equal(success(['config', 'get', 'node-width']).trim(), '40');
  assert.equal(success(['config', 'get', 'key.copy']).trim(), '');
  assert.match(success(['keys']), /edit\s+c/u);
  assert.equal(fs.readFileSync(config, 'utf8'), legacy);
  assert.equal(fs.readdirSync(path.dirname(config)).length, 1);
  assert.equal(fs.existsSync(path.join(home, 'Shell Mindmap')), false);
  success(['config', 'set', 'layout', 'bilateral']);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).nodeWidth, 40);
  const backup = fs.readdirSync(path.dirname(config)).find(name => name.includes('.backup-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(config), backup), 'utf8'), legacy);
});

test('CLI XDG fallback stays read-only and environment override takes precedence', t => {
  const {home, env, run} = setup(t);
  const legacy = path.join(env.XDG_CONFIG_HOME, 'mm', 'config');
  fs.mkdirSync(path.dirname(legacy), {recursive: true});
  fs.writeFileSync(legacy, 'MM-CONFIG-1\nnode-width\t52');
  const withoutOverride = {...env};
  delete withoutOverride.MM_CONFIG_FILE;
  const inherited = run(['config', 'get', 'node-width'], {env: withoutOverride});
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.equal(inherited.stdout.trim(), '52');
  assert.equal(fs.existsSync(path.join(home, 'Shell Mindmap')), false);
  const explicitMissing = run(['config', 'get', 'node-width']);
  assert.equal(explicitMissing.status, 0, explicitMissing.stderr);
  assert.equal(explicitMissing.stdout.trim(), '32');
});

test('CLI uses cwd for relative paths and lists only maps in the selected Unicode library', t => {
  const {home, success, run} = setup(t);
  const library = path.join(home, '脑图 library');
  fs.mkdirSync(library);
  const result = run(['config', 'set', 'save-dir', '.'], {cwd: library});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(success(['config', 'get', 'save-dir']).trim(), fs.realpathSync(library));
  fs.writeFileSync(path.join(library, '一 个.mm'), 'MM-ZSH-1\n0\t0\t一\n');
  fs.writeFileSync(path.join(library, '二.MM'), 'MM-ZSH-1\n0\t0\t二\n');
  fs.writeFileSync(path.join(library, 'ignore.txt'), 'not a map');
  fs.mkdirSync(path.join(library, 'ignore.mm'));
  const output = success(['list']);
  assert.match(output, /一 个\.mm/);
  assert.match(output, /二\.MM/);
  assert.doesNotMatch(output, /ignore/);
  assert.equal(fs.existsSync(path.join(home, 'Shell Mindmap')), false);
});

test('CLI default lists follow cwd across launches and explicit custom directories persist until reset', t => {
  const {home, workspace, config, success, run} = setup(t);
  const second = path.join(home, '第二 项目');
  const custom = path.join(home, '自定义目录');
  const historical = path.join(home, 'Shell Mindmap');
  for (const directory of [second, custom, historical]) fs.mkdirSync(directory);
  const firstFile = path.join(workspace, 'first.mm');
  const secondFile = path.join(second, 'second.mm');
  const customFile = path.join(custom, 'custom.mm');
  const historicalFile = path.join(historical, 'old.mm');
  for (const file of [firstFile, secondFile, customFile, historicalFile]) fs.writeFileSync(file, 'MM-ZSH-1\n0\t0\t保留内容\n');
  const listAt = cwd => {
    const result = run(['list'], {cwd});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n').map(file => fs.realpathSync(file));
  };
  assert.equal(success(['config', 'get', 'save-dir']), '\n');
  assert.deepEqual(listAt(workspace), [fs.realpathSync(firstFile)]);
  success(['config', 'set', 'node-width', '40']);
  const persisted = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.saveDir, '');
  assert.deepEqual(listAt(second), [fs.realpathSync(secondFile)]);
  success(['config', 'set', 'save-dir', custom]);
  assert.equal(success(['config', 'get', 'save-dir']).trim(), custom);
  assert.deepEqual(listAt(workspace), [fs.realpathSync(customFile)]);
  assert.deepEqual(listAt(second), [fs.realpathSync(customFile)]);
  success(['config', 'set', 'layout', 'bilateral']);
  assert.deepEqual(listAt(second), [fs.realpathSync(customFile)]);
  success(['config', 'reset', 'save-dir']);
  assert.equal(success(['config', 'get', 'save-dir']), '\n');
  assert.deepEqual(listAt(workspace), [fs.realpathSync(firstFile)]);
  assert.deepEqual(listAt(second), [fs.realpathSync(secondFile)]);
  assert.equal(fs.readFileSync(historicalFile, 'utf8'), 'MM-ZSH-1\n0\t0\t保留内容\n');
});

test('CLI Markdown import/export works with pipes and Chinese paths, while refusing overwrites', t => {
  const {home, workspace, config, success, failure} = setup(t);
  fs.writeFileSync(path.join(workspace, '输入 大纲.md'), '# 计划 🧠\n\n- 分支一\n  - 子节点\n- 分支二\n');
  success(['import', '输入 大纲.md', '-o', '输出 脑图.mm']);
  const imported = readMap(path.join(workspace, '输出 脑图.mm')).nodes;
  assert.deepEqual(imported.map(({text, depth}) => [text, depth]), [['计划 🧠', 0], ['分支一', 1], ['子节点', 2], ['分支二', 1]]);
  success(['export', '输出 脑图.mm', '--output', '再次 导出.md']);
  success(['import', '再次 导出.md', '-o', '往返.mm']);
  assert.deepEqual(readMap(path.join(workspace, '往返.mm')).nodes.map(({id, ...node}) => node), imported.map(({id, ...node}) => node));
  const mm = fs.readFileSync(path.join(workspace, '输出 脑图.mm'), 'utf8');
  const md = fs.readFileSync(path.join(workspace, '再次 导出.md'), 'utf8');
  assert.match(failure(['import', '输入 大纲.md', '-o', '输出 脑图.mm']), /已存在/);
  assert.match(failure(['export', '输出 脑图.mm', '-o', '再次 导出.md']), /已存在/);
  assert.equal(fs.readFileSync(path.join(workspace, '输出 脑图.mm'), 'utf8'), mm);
  assert.equal(fs.readFileSync(path.join(workspace, '再次 导出.md'), 'utf8'), md);
  assert.equal(fs.existsSync(config), false);
  assert.equal(fs.existsSync(path.join(home, 'Shell Mindmap')), false);
});

test('CLI malformed imports fail without touching an existing output or creating a new one', t => {
  const {home, workspace, failure} = setup(t);
  const source = path.join(home, 'invalid.md');
  const existing = path.join(home, 'keep.mm');
  fs.writeFileSync(source, '# root\nunsupported paragraph\n');
  fs.writeFileSync(existing, 'ORIGINAL');
  assert.match(failure(['import', source, '-o', existing]), /行|内容|大纲|支持/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'ORIGINAL');
  failure(['import', source, '-o', 'missing.mm']);
  assert.equal(fs.existsSync(path.join(workspace, 'missing.mm')), false);
  fs.writeFileSync(source, Buffer.from([0xff, 0xfe]));
  failure(['import', source, '-o', 'utf8.mm']);
  assert.equal(fs.existsSync(path.join(workspace, 'utf8.mm')), false);
});

test('CLI imports rootless and multi-heading outlines beyond previous size limits without losing content', t => {
  const {workspace, success} = setup(t);
  const longLabel = '多语言 العربية हिन्दी 🚀 '.repeat(30);
  const deep = Array.from({length: 110}, (_, index) => '    '.repeat(index) + '- 深层 ' + index);
  const wide = Array.from({length: 510}, (_, index) => '- 条目 ' + index);
  const source = ['- 开头列表', '    - 子列表', '# 第一章', '- ' + longLabel, '# 第二章', '### 小节', ...deep, ...wide].join('\n');
  fs.writeFileSync(path.join(workspace, '灵活大纲.md'), source);
  success(['import', '灵活大纲.md', '-o', '完整脑图.mm']);
  const imported = readMap(path.join(workspace, '完整脑图.mm')).nodes;
  assert.deepEqual(imported.slice(0, 7).map(({text, depth}) => [text, depth]), [
    ['导入脑图', 0], ['开头列表', 1], ['子列表', 2], ['第一章', 1], [longLabel, 2], ['第二章', 1], ['小节', 2],
  ]);
  assert.equal(imported.length, 627);
  assert.equal(imported[116].depth, 112);
  assert.equal(imported[117].depth, 3);
  assert.equal(imported.at(-1).text, '条目 509');
  success(['export', '完整脑图.mm', '-o', '完整大纲.md']);
  success(['import', '完整大纲.md', '-o', '往返完整脑图.mm']);
  const roundTrip = readMap(path.join(workspace, '往返完整脑图.mm')).nodes;
  assert.deepEqual(roundTrip.map(({id, ...node}) => node), imported.map(({id, ...node}) => node));
  assert.equal(fs.readFileSync(path.join(workspace, '灵活大纲.md'), 'utf8'), source);
});

test('CLI rejects malformed invocation and interactive startup without a terminal', t => {
  const {home, failure} = setup(t);
  for (const args of [['--unknown'], ['help', 'extra'], ['--version', 'extra'], ['config', 'get'], ['config', 'set', 'node-width'], ['keys', 'bind', 'edit'], ['list', 'extra'], ['import', 'in.md'], ['export', 'in.mm', '--force', 'out.md'], ['one.mm', 'two.mm']]) {
    assert.match(failure(args), /用法|未知/);
  }
  for (const args of [[], ['file.mm'], ['--', '--literal.mm'], ['--', 'list']]) assert.match(failure(args), /交互终端/);
  assert.equal(fs.existsSync(path.join(home, 'Shell Mindmap')), false);
});
