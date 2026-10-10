import type {AppConfig} from './types.js';

export const actions = [
  ['child', '添加子节点', ['a']], ['sibling', '添加同级节点', ['o']],
  ['edit', '编辑节点', []], ['parent', '选择父节点', ['h']],
  ['child-select', '展开并选择子节点', ['l']], ['up', '上一个可见节点', ['k']],
  ['down', '下一个可见节点', ['j']], ['fold', '折叠 / 展开', []],
  ['delete', '删除分支', ['Delete', 'Backspace']], ['undo', '撤销', []], ['redo', '重做', []],
  ['save', '保存', ['Ctrl+s']], ['save-as', '另存为', []], ['quit', '退出', []],
  ['help', '帮助', []], ['page-up', '向上翻页', []], ['page-down', '向下翻页', []],
  ['search', '搜索全部节点', ['Ctrl+f']], ['copy', '复制分支', []], ['paste', '粘贴为子分支', []],
  ['move', '移动分支到…', []], ['move-up', '分支上移', []], ['move-down', '分支下移', []],
  ['pan-left', '向左平移', ['Shift+Left']], ['pan-right', '向右平移', ['Shift+Right']],
  ['pan-up', '向上平移', ['Shift+Up']], ['pan-down', '向下平移', ['Shift+Down']],
  ['root', '回到根节点并居中', ['Home']], ['settings', '设置', []], ['library', '打开文件浏览器', []],
  ['import', '导入 Markdown', []], ['export', '导出 Markdown', []], ['new', '新建脑图', []],
] as const;

export function resolveAction(key: string, config: AppConfig): string | undefined {
  if (key === 'F1' || key === '？') return 'help';
  if (key === '/' || key === ':' || key === '：') return 'command';
  if (key === 'Ctrl+c' || key === 'Ctrl+d') return 'quit';
  for (const [id] of actions) if (config.keys[id] && config.keys[id] === key) return id;
  return actions.find(([, , aliases]) => (aliases as readonly string[]).includes(key))?.[0];
}

/** Only advertise keys that still resolve to this action after customization. */
export function actionShortcuts(action: string, config: AppConfig): string[] {
  const aliases = actions.find(([id]) => id === action)?.[2] ?? [];
  return [...new Set([config.keys[action] || '', ...aliases])]
    .filter(key => key !== '' && resolveAction(key, config) === action);
}

export function displayKey(key: string): string {
  return key === 'Space' ? '空格' : key;
}

export function helpLines(config: AppConfig, browser = false): string[] {
  const directoryHelp = [
    '快捷键（浏览模式） · 目录树与脑图文件',
    'Tab 切换目录树 / 脑图区；窄窗口切换页签。',
    '↑↓ 选择；PageUp/PageDown 翻页；Home/End 到首尾。',
    '目录树：→ 展开，空格展开/收起，← 收起或选择父目录。',
    '.. 上级目录：Enter / → 上行；树根 ← 跳出到上一层。',
    'Enter 激活所选目录；[当前] 标记右侧脑图所属位置。',
    '脑图区：Enter / → 打开文件并进入编辑。',
    'Backspace 浏览当前目录的上级，到文件系统根停止。',
    'n 在当前目录新建并编辑。',
    'f 筛选已加载目录与当前脑图；Enter 保留；Esc 清除。',
    '筛选时保留匹配目录的祖先；清除筛选后可收起分支。',
    '. 显示隐藏条目；Ctrl-R 刷新；o 输入路径。',
    'r 查看恢复；/ 命令；q 退出；Esc 返回原脑图。',
    '展开才读取下一层，不递归搜索未展开的文件夹。',
    '',
  ];
  return [
    ...(browser ? directoryHelp : []),
    '快捷键（浏览模式）', ...actions.map(([id,label]) => `${actionShortcuts(id,config).map(displayKey).join(' / ') || '命令入口'}  ·  ${label}`),
    '', '固定入口：/、:、中文： 打开命令菜单；F1 / 中文？ 帮助',
    '命令菜单：输入英文或中文筛选，↑↓ 选择，Tab 补齐，Enter 执行或填写参数。',
    '节点搜索：默认 f / Ctrl+f；搜索全部节点，Enter 定位。',
    '方向键保持树关系：左到父节点，右到子节点。',
    'Shift+方向键或默认 H/J/K/L 平移（左/下/上/右）；g/Home 回根居中。',
    '文字编辑：左右 / Home / End，退格 / Delete，Ctrl-U 清空。',
    'Enter 确认，Esc 取消；粘贴只插入文字。',
    ...(!browser ? ['', ...directoryHelp] : []),
    '', '命令', ...commandDescriptions.map(([name, description]) => `${name}  ${description}`),
    '', '脑图：节点数量、层级和文字长度不设固定上限。',
    'Markdown：标题与嵌套列表，自动识别缩进；多根或无根时补总节点。',
    '恢复快照在编辑后 1 秒写入；原文件仍需按保存。',
  ];
}

export interface CommandSuggestion {
  /** Canonical command text, without the menu's / prefix. */
  value: string;
  /** Usage shown in the menu, including required or optional arguments. */
  label: string;
  description: string;
  /** Selecting this item fills the input; it must not execute yet. */
  requiresArgs: boolean;
}

interface CommandDefinition extends CommandSuggestion {aliases?: readonly string[]}

// Commands with their own parser cases live here. Other executable commands come
// directly from the action registry below, so help and completion cannot omit them.
const commandDefinitions: readonly CommandDefinition[] = [
  {value:'help',label:'help',description:'帮助',requiresArgs:false},
  {value:'settings',label:'settings',description:'设置面板',requiresArgs:false},
  {value:'config',label:'config',description:'查看配置',requiresArgs:false},
  {value:'keys',label:'keys',description:'查看快捷键',requiresArgs:false},
  {value:'set ',label:'set KEY VALUE',description:'修改设置，需要配置项和新值',requiresArgs:true},
  {value:'set save-dir ',label:'set save-dir PATH',description:'设置默认保存目录',requiresArgs:true},
  {value:'set node-width ',label:'set node-width NUMBER',description:'设置节点文字宽度，8–80 列',requiresArgs:true},
  {value:'set layout ',label:'set layout right|bilateral',description:'设置向右或双侧布局',requiresArgs:true},
  {value:'bind ',label:'bind ACTION KEY',description:'修改主快捷键，需要动作和按键',requiresArgs:true},
  {value:'reset',label:'reset [KEY|keys]',description:'恢复默认设置',requiresArgs:false},
  {value:'write',label:'write [PATH]',description:'保存脑图；简写 w',requiresArgs:false,aliases:['w']},
  {value:'new',label:'new',description:'新建脑图',requiresArgs:false},
  {value:'open',label:'open [PATH]',description:'打开文件或目录浏览器',requiresArgs:false},
  {value:'search',label:'search [TEXT]',description:'搜索全部节点',requiresArgs:false},
  {value:'layout ',label:'layout right|bilateral',description:'切换布局，需要指定方向',requiresArgs:true},
  {value:'layout right',label:'layout right',description:'切换到向右布局',requiresArgs:false},
  {value:'layout bilateral',label:'layout bilateral',description:'切换到双侧布局',requiresArgs:false},
  {value:'import',label:'import [PATH]',description:'导入 Markdown',requiresArgs:false},
  {value:'export',label:'export [PATH]',description:'导出 Markdown',requiresArgs:false},
  {value:'recover',label:'recover',description:'查看恢复快照',requiresArgs:false},
  {value:'quit',label:'quit',description:'退出；简写 q',requiresArgs:false,aliases:['q']},
];
const definedNames = new Set(commandDefinitions.map(item => item.value.trim().split(/\s/u)[0]!));
const commandCatalog: readonly CommandDefinition[] = [
  ...commandDefinitions,
  ...actions.filter(([id]) => !definedNames.has(id)).map(([id, description]) => ({
    value:id, label:id, description, requiresArgs:false,
  })),
];
const commandNames = new Set(commandCatalog.flatMap(item => [item.value.trim().split(/\s/u)[0]!, ...(item.aliases ?? [])]));

export const commandDescriptions: ReadonlyArray<readonly [string, string]> = commandCatalog.map(item => [item.label, item.description]);

function matchRank(text: string, query: string): number {
  const candidate = text.trim().toLowerCase();
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 1;
  if (candidate.includes(query)) return 2;
  let index = 0;
  const characters = Array.from(query);
  for (const character of candidate) if (character === characters[index]) index++;
  return index === characters.length ? 3 : Number.POSITIVE_INFINITY;
}

/** Stable fuzzy menu search; arbitrary arguments are never guessed or replaced. */
export function commandSuggestions(value: string): CommandSuggestion[] {
  const query = value.trimStart().toLowerCase();
  const filter = query.trimEnd();
  const commandWithArguments = /^(\S+)\s/u.exec(query);
  const structured = commandWithArguments && commandNames.has(commandWithArguments[1]!);
  return commandCatalog.map((item, index) => {
    const rank = !filter ? 0 : structured
      // Only registered, incomplete command prefixes are safe to fill once a
      // command name is followed by whitespace. Completed parameters stay raw.
      ? item.value.toLowerCase().startsWith(query) && item.value.toLowerCase() !== query ? 0 : Number.POSITIVE_INFINITY
      : Math.min(...[item.value, item.label, item.description, ...(item.aliases ?? [])].map(text => matchRank(text, filter)));
    return {item, index, rank};
  }).filter(candidate => Number.isFinite(candidate.rank))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({item}) => ({value:item.value, label:item.label, description:item.description, requiresArgs:item.requiresArgs}));
}

/** Literal quoting only. Never evaluate shell interpolation or launch commands. */
export function parseCommand(input: string): string[] {
  const result: string[] = []; let word = '', quote = '', started = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote === "'") { if (c === "'") quote = ''; else word += c; started = true; continue; }
    // Preserve native Windows path separators, but allow escaped spaces/quotes/backslashes.
    if (c === '\\' && i + 1 < input.length && /[\s'"\\]/u.test(input[i+1]!)) {
      word += input[++i]; started = true; continue;
    }
    if (quote === '"') { if (c === '"') quote = ''; else word += c; started = true; continue; }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (/\s/u.test(c)) { if (started) result.push(word); word = ''; started = false; continue; }
    word += c; started = true;
  }
  if (quote) throw new Error('引号未闭合。');
  if (started) result.push(word);
  return result;
}

export function completeCommand(value: string): string[] {
  return commandSuggestions(value).map(item => item.value);
}
