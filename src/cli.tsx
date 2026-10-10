import React from 'react';
import fs from 'node:fs';
import {render} from 'ink';
import {App} from './app.js';
import {createMap} from './model.js';
import {importMarkdown,exportMarkdown} from './markdown.js';
import {configEntries,configPath,defaultConfig,loadConfig,resetConfig,saveConfig,setConfig} from './config.js';
import {ensureApplicationDirectory,expandPath,listMaps,readMap,saveMap,writeTextAtomic,resolveSaveDirectory} from './storage.js';
import {actions} from './actions.js';

const HELP=`Shell Mindmap · 终端脑图

SMM                                  浏览当前目录的子文件夹和脑图
SMM [--] 文件.mm                      直接打开脑图；文件不存在时新建
SMM list                             列出当前工作目录的脑图
SMM import INPUT.md -o OUTPUT.mm      导入 Markdown 大纲
SMM export INPUT.mm -o OUTPUT.md      导出 Markdown 大纲
SMM config [list|get KEY|path]         查看设置
SMM config set KEY VALUE              修改设置
SMM config reset [KEY]                恢复默认设置；配置损坏时也可用
SMM keys [list|bind ACTION KEY|reset [ACTION]]
SMM help / --help / --version

Tab 子节点 · Enter 同级 · e 编辑 · 方向键选择 · 空格折叠
s 保存 · S 另存为 · u/r 撤销/重做 · ?/？/F1 帮助 · / 命令
f / Ctrl+f 搜索 · c/p 复制/粘贴分支 · m 移动 · O 文件浏览 · , 设置
Shift＋方向键或 H/J/K/L 平移视口 · g/Home 回根并居中
/ 菜单按命令名或中文说明模糊筛选；↑↓ 选择、Tab 补齐、Enter 确认。
空节点输入框也可键入 /；Esc 返回，// 输入字面斜杠。: 入口继续兼容。

不带文件名启动时始终从当前目录浏览，可进入子文件夹或新建脑图。
左侧目录树、右侧当前目录脑图；不足 80 列时 Tab 切换页签。
目录树 → 展开、← 收起，Enter 激活目录；脑图区 Enter 打开。
树顶“.. 上级目录”按 Enter／→ 上行；选中树根按 ← 可跳出启动目录。
目录首页 n 新建、f 筛选、o 输入路径、Backspace 上级、r 恢复。
旧命令 mm 保留为兼容别名；新安装和日常使用推荐 SMM。
在文件浏览器中新建时，默认保存在当前浏览目录。
直接编辑时默认保存到启动目录，显式 save-dir 设置可覆盖。
公共配置与恢复快照：用户主目录/Shell Mindmap/.app（自动创建）。
默认向右布局；SMM config set layout bilateral 切换双侧。
设置 save-dir 可指定固定保存目录；SMM config reset save-dir 恢复启动目录。
相对输入路径基于启动目录；已打开文件的普通保存写回原路径。
O 打开文件浏览器，从当前文件所在目录或上次浏览位置继续。
Markdown：一个 # 根标题与嵌套无序列表，每层缩进 2 空格。
转换不会覆盖已有文件。文件名与子命令重名时使用 SMM -- 文件名。
需要 Node.js 22+ 和支持 ANSI/UTF-8 的终端。`;

function usage(condition:boolean,message:string):asserts condition {if(!condition)throw new Error(message);}

export async function main(args:string[]):Promise<void> {
  if(['help','--help','-h'].includes(args[0]||'')){usage(args.length===1,'用法：SMM help');console.log(HELP);return;}
  if(args[0]==='--version'){usage(args.length===1,'用法：SMM --version');const {version}=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {version:string};console.log(`shell-mindmap ${version}`);return;}
  if(args[0]==='config'){
    const op=args[1]||'list';
    if(op==='path'){usage(args.length===2,'用法：SMM config path');console.log(configPath());return;}
    if(op==='reset'&&args.length===2){saveConfig(defaultConfig());console.log('已恢复默认配置。原文件若已损坏，会另存备份。');return;}
    const config=loadConfig();
    if(op==='list'){usage(args.length<=2,'用法：SMM config list');for(const [k,v]of Object.entries(configEntries(config)))console.log(`${k}=${v}`);return;}
    if(op==='get'){usage(args.length===3,'用法：SMM config get KEY');const entries=configEntries(config);usage(Object.hasOwn(entries,args[2]!),`未知配置项：${args[2]}`);console.log(entries[args[2]!]);return;}
    if(op==='set'){usage(args.length===4,'用法：SMM config set KEY VALUE');saveConfig(setConfig(config,args[2]!,args[3]!));console.log(`已保存：${args[2]} = ${args[3]}`);return;}
    if(op==='reset'){usage(args.length===3,'用法：SMM config reset [KEY]');saveConfig(resetConfig(config,args[2]));console.log(`已恢复默认设置：${args[2]}`);return;}
    throw new Error('未知配置命令；使用 SMM help 查看说明。');
  }
  if(args[0]==='keys'){
    const config=loadConfig(),op=args[1]||'list';
    if(op==='list'){usage(args.length<=2,'用法：SMM keys list');for(const [id,label] of actions)console.log(`${id.padEnd(16)} ${(config.keys[id]||'未绑定').padEnd(10)} ${label}`);console.log('固定入口：F1 / 中文？ 帮助；/、:、中文： 命令菜单。');return;}
    if(op==='bind'){usage(args.length===4,'用法：SMM keys bind ACTION KEY');saveConfig(setConfig(config,'key.'+args[2],args[3]!));console.log('快捷键已保存。');return;}
    if(op==='reset'){usage(args.length===2||args.length===3,'用法：SMM keys reset [ACTION]');saveConfig(resetConfig(config,args[2]?'key.'+args[2]:'keys'));console.log('已恢复默认快捷键。');return;}
    throw new Error('未知快捷键命令；使用 SMM help 查看说明。');
  }
  if(args[0]==='list'){
    usage(args.length===1,'用法：SMM list');const directory=resolveSaveDirectory(loadConfig()),maps=listMaps(directory);
    for(const map of maps)console.log(map.file);
    if(!maps.length)console.log(`脑图库为空：${directory}`);return;
  }
  if(args[0]==='import'||args[0]==='export'){
    usage(args.length===4&&(args[2]==='-o'||args[2]==='--output'),`用法：SMM ${args[0]} INPUT -o OUTPUT`);
    const input=expandPath(args[1]!),output=expandPath(args[3]!);
    if(args[0]==='import'){
      const source=new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(input));
      saveMap(output,importMarkdown(source));
    }else writeTextAtomic(output,exportMarkdown(readMap(input).nodes));
    console.log(`已${args[0]==='import'?'导入':'导出'}：${output}`);return;
  }
  const filenames=args[0]==='--'?args.slice(1):args;
  usage(filenames.length<=1&&!(args[0]!=='--'&&filenames[0]?.startsWith('-')),'用法：SMM [--] [文件.mm]；帮助：SMM help');
  usage(Boolean(process.stdin.isTTY&&process.stdout.isTTY),'需要交互终端。查看说明使用 SMM help，文件转换可用 SMM import / export。');
  usage(process.env.TERM!=='dumb','需要支持 ANSI 和 UTF-8 的终端。');
  const config=loadConfig({migrate:true});
  let widthOverride:number|undefined;
  if(process.env.MM_NODE_WIDTH!==undefined){
    usage(/^\d{1,2}$/u.test(process.env.MM_NODE_WIDTH)&&Number(process.env.MM_NODE_WIDTH)>=8&&Number(process.env.MM_NODE_WIDTH)<=80,'MM_NODE_WIDTH 必须是 8–80 的整数。');
    widthOverride=Number(process.env.MM_NODE_WIDTH);
  }
  const file=filenames[0]?expandPath(filenames[0]):undefined;
  const existing=file&&fs.existsSync(file)?readMap(file):undefined;
  ensureApplicationDirectory();
  const instance=render(<App nodes={existing?.nodes||createMap()} config={config} file={file} fingerprint={existing?.fingerprint} fresh={!existing} widthOverride={widthOverride} browseDirectory={file?undefined:process.cwd()}/>,{
    alternateScreen:true,exitOnCtrlC:false,patchConsole:false,kittyKeyboard:{mode:'disabled'},
  });
  try{await instance.waitUntilExit();}finally{instance.cleanup();}
}
