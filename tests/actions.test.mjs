import {test} from 'node:test';
import assert from 'node:assert/strict';
import {actions,parseCommand,resolveAction,actionShortcuts,displayKey,commandSuggestions,completeCommand,helpLines,commandDescriptions} from '../dist/actions.js';
import {defaultConfig,setConfig} from '../dist/config.js';
import {F1Observer,keyName} from '../dist/input.js';
import {initialDocument,commit,travel} from '../dist/history.js';
import {createMap,addChild,toggleFold,editNode} from '../dist/model.js';
import {sanitizePaste} from '../dist/text.js';

test('command input is literal, including shell metacharacters and Windows paths',()=>{
  assert.deepEqual(parseCommand('set save-dir "C:\\Users\\名字\\Shell Mindmap"'),['set','save-dir','C:\\Users\\名字\\Shell Mindmap']);
  assert.deepEqual(parseCommand('write "$(touch hacked).mm"'),['write','$(touch hacked).mm']);
  assert.deepEqual(parseCommand("set save-dir '~/Shell Mindmap'"),['set','save-dir','~/Shell Mindmap']);
  assert.deepEqual(parseCommand('bind search ""'),['bind','search','']);
  assert.deepEqual(parseCommand('write some\\ file.mm'),['write','some file.mm']);
  assert.throws(()=>parseCommand('write "oops'),/引号/);
});
test('configured keys take priority over aliases and fixed help stays available',()=>{
  const config=defaultConfig();config.keys.help='a';
  assert.equal(resolveAction('a',config),'help');assert.equal(resolveAction('F1',config),'help');
  assert.equal(resolveAction('？',config),'help');assert.equal(resolveAction('：',config),'command');
  assert.equal(resolveAction('Ctrl+s',config),'save');
  assert.ok(helpLines(config).includes('a  ·  帮助'));
  assert.deepEqual(completeCommand('layout b'),['layout bilateral']);
});
test('slash is a fixed command-menu entry and Ctrl+f remains a search alias',()=>{
  const config=defaultConfig();config.keys.search='f';
  for(const key of ['/',':','：'])assert.equal(resolveAction(key,config),'command');
  assert.equal(resolveAction('f',config),'search');
  assert.equal(resolveAction('Ctrl+f',config),'search');
  assert.equal(resolveAction('/',{...config,keys:{...config.keys,edit:'/'}}),'command');
  assert.equal(resolveAction('Ctrl+f',{...config,keys:{...config.keys,search:''}}),'search');
  const help=helpLines(config).join('\n');
  assert.match(help,/命令菜单.*英文或中文.*↑↓.*Tab.*Enter/);
  assert.match(help,/默认 f \/ Ctrl\+f/);
});
test('fold and delete accept named keys and only advertise effective custom bindings',()=>{
  const config=defaultConfig();
  assert.equal(resolveAction(keyName(' ',{}),config),'fold');
  for(const key of [{delete:true},{backspace:true}])assert.equal(resolveAction(keyName('',key),config),'delete');
  assert.deepEqual(actionShortcuts('fold',config).map(displayKey),['空格']);
  assert.deepEqual(actionShortcuts('delete',config),['d','Delete','Backspace']);
  assert.ok(helpLines(config).includes('d / Delete / Backspace  ·  删除分支'));
  const moved=setConfig(config,'key.fold','z');
  assert.equal(resolveAction('Space',moved),undefined);
  assert.deepEqual(actionShortcuts('fold',moved),['z']);
  const unbound=setConfig(moved,'key.fold','');
  assert.deepEqual(actionShortcuts('fold',unbound),[]);
  assert.ok(helpLines(unbound).includes('命令入口  ·  折叠 / 展开'));
  const reassigned=setConfig(setConfig(setConfig(config,'key.delete',''),'key.edit','Delete'),'key.copy','Backspace');
  assert.equal(resolveAction('Delete',reassigned),'edit');
  assert.equal(resolveAction('Backspace',reassigned),'copy');
  assert.deepEqual(actionShortcuts('delete',reassigned),[]);
  assert.deepEqual(actionShortcuts('delete',setConfig(config,'key.delete','')),['Delete','Backspace']);
});
test('command menu derives every executable action, usage and completion from one catalog',()=>{
  const suggestions=commandSuggestions('');
  assert.equal(new Set(suggestions.map(item=>item.value)).size,suggestions.length);
  for(const [action] of actions){
    assert.ok(suggestions.some(item=>item.value===action),action+' is missing from the menu');
  }
  for(const command of ['config','keys','set ','bind ','reset','write','open','layout ','recover']){
    assert.ok(suggestions.some(item=>item.value===command),command+' is missing from the menu');
  }
  assert.deepEqual(commandDescriptions,suggestions.map(item=>[item.label,item.description]));
  assert.deepEqual(completeCommand(''),suggestions.map(item=>item.value));
  assert.ok(suggestions.every(item=>Object.keys(item).sort().join(',')==='description,label,requiresArgs,value'));
  assert.ok(suggestions.every(item=>!item.value.startsWith('/')));
  assert.equal(suggestions.some(item=>item.value==='w'||item.value==='q'),false);
  suggestions[0].value='changed';
  assert.equal(commandSuggestions('')[0].value,'help');
});
test('command search is case insensitive and supports Chinese substrings and subsequences',()=>{
  assert.equal(commandSuggestions('SeArCh')[0].value,'search');
  assert.equal(commandSuggestions('W')[0].value,'write');
  assert.equal(commandSuggestions('Q')[0].value,'quit');
  assert.deepEqual(commandSuggestions('向左').map(item=>item.value),['pan-left']);
  assert.deepEqual(commandSuggestions('搜点').map(item=>item.value),['search']);
  assert.deepEqual(commandSuggestions('添子').map(item=>item.value),['child']);
  assert.deepEqual(commandSuggestions('PNLF').map(item=>item.value),['pan-left']);
  assert.deepEqual(commandSuggestions('这条指令绝不存在'),[]);
  assert.deepEqual(commandSuggestions('xyzzynothing'),[]);
});
test('exact commands and prefixes rank before substrings with deterministic ties',()=>{
  assert.deepEqual(commandSuggestions('layout').map(item=>item.value),[
    'layout ','layout right','layout bilateral','set layout ',
  ]);
  assert.deepEqual(commandSuggestions('pan-').map(item=>item.value),['pan-left','pan-right','pan-up','pan-down']);
  assert.deepEqual(commandSuggestions('  PAN-  '),commandSuggestions('pan-'));
  assert.equal(commandSuggestions('save')[0].value,'save');
  assert.deepEqual(commandSuggestions('设置').map(item=>item.value),[
    'settings','set save-dir ','set node-width ','set layout ','set ','reset',
  ]);
});
test('required arguments are only filled while layout presets can execute immediately',()=>{
  const all=commandSuggestions('');
  for(const value of ['set ','set save-dir ','set node-width ','set layout ','bind ','layout ']){
    const item=all.find(candidate=>candidate.value===value);
    assert.equal(item?.requiresArgs,true,value);
    assert.ok(item.label.length>value.trim().length,value+' usage should describe its parameters');
  }
  for(const value of ['layout right','layout bilateral','write','open','search','reset','import','export']){
    assert.equal(all.find(item=>item.value===value)?.requiresArgs,false,value);
  }
  assert.deepEqual(commandSuggestions('layout ').map(item=>item.value),['layout right','layout bilateral']);
  assert.deepEqual(commandSuggestions('layout b').map(item=>item.value),['layout bilateral']);
  assert.deepEqual(commandSuggestions('set node-w').map(item=>item.value),['set node-width ']);
  assert.deepEqual(commandSuggestions('set save-dir').map(item=>item.value),['set save-dir ']);
});
test('argument-bearing input is preserved instead of being guessed or rewritten',()=>{
  for(const value of [
    'write ', 'write "/tmp/a b.mm"', 'write "unterminated', 'w ~/project.mm',
    'open C:\\Users\\名字\\project.mm', 'search 保存', 'set node-width 24',
    'set save-dir ', 'set save-dir "/tmp/a b"', 'bind search ""', 'layout right',
    'layout bilateral', 'layout unknown', 'reset keys', 'quit now',
  ]){
    assert.deepEqual(commandSuggestions(value),[],value);
    assert.deepEqual(completeCommand(value),[],value);
  }
  assert.deepEqual(parseCommand('write "/tmp/a b.mm"'),['write','/tmp/a b.mm']);
});
test('pan primary keys and shifted arrow aliases resolve through the action registry',()=>{
  const config=defaultConfig();
  for(const [action,primary,alias] of [
    ['pan-left','H','Shift+Left'],['pan-right','L','Shift+Right'],
    ['pan-up','K','Shift+Up'],['pan-down','J','Shift+Down'],
  ]){
    assert.equal(resolveAction(primary,config),action);
    assert.equal(resolveAction(alias,config),action);
    assert.equal(resolveAction(alias,setConfig(config,`key.${action}`,'')),action);
  }
  assert.equal(resolveAction('h',config),'parent');
  assert.equal(resolveAction('j',config),'down');
  assert.equal(resolveAction('k',config),'up');
  assert.equal(resolveAction('l',config),'child-select');
  assert.equal(resolveAction('g',config),'root');
  assert.equal(resolveAction('Home',config),'root');
  assert.equal(resolveAction('Shift+Left',setConfig(config,'key.edit','Shift+Left')),'edit');
});
test('all pan commands appear in completion and help with recenter guidance',()=>{
  const commands=['pan-left','pan-right','pan-up','pan-down'];
  assert.deepEqual(completeCommand('pan-'),commands);
  for(const command of commands){
    assert.deepEqual(completeCommand(command),[command]);
    assert.ok(commandDescriptions.some(([name])=>name===command));
  }
  const help=helpLines(defaultConfig()).join('\n');
  assert.match(help,/Shift\+方向键.*H\/J\/K\/L.*平移/);
  assert.match(help,/g\/Home.*居中/);
});
test('F1 observer tolerates split sequences and ignores pasted F1 bytes',()=>{
  const observer=new F1Observer();assert.equal(observer.push('\x1b'),0);assert.equal(observer.push('O'),0);assert.equal(observer.push('P'),1);
  assert.equal(observer.push('x\x1b[11~y'),1);assert.equal(observer.push('\x1b[200~\x1bOP\x1b[11~'),0);
  assert.equal(observer.push('\x1b[20'),0);assert.equal(observer.push('1~\x1b[P'),1);
  assert.equal(sanitizePaste('中文\x1bOP\x1b[11~\x1b[[A内容'),'中文内容');
});
test('each content transaction has one undo step; folding alone stays clean',()=>{
  let state=initialDocument(createMap('root'));const root=state.selected;
  state=commit(state,addChild(state.nodes,root,'branch'));
  state={...state,dirty:false,selected:root};
  state=commit(state,toggleFold(state.nodes,root),false);
  assert.equal(state.dirty,false);assert.equal(state.undo.length,1);
  state=commit(state,editNode(state.nodes,root,'new root'));
  state=travel(state,'undo');assert.equal(state.nodes[0].text,'root');assert.equal(state.dirty,true);
  state=travel(state,'redo');assert.equal(state.nodes[0].text,'new root');
  for(let i=0;i<40;i++)state=commit(state,editNode(state.nodes,root,'r'+i));
  assert.equal(state.undo.length,30);
});
