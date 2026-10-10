import React, {useEffect,useMemo,useRef,useState} from 'react';
import {Box,Text,useApp,useCursor,useInput,usePaste,useStdin,useWindowSize} from 'ink';
import {randomUUID} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import type {AppConfig,MindmapNode,Operation} from './types.js';
import * as model from './model.js';
import {importMarkdown,exportMarkdown} from './markdown.js';
import {commit,initialDocument,travel,type DocumentState} from './history.js';
import {layoutMap,renderViewport,followSelection} from './layout.js';
import {clipText,displayWidth,graphemes,editBuffer,sanitizePaste,wrapText} from './text.js';
import {InputField,inputViewport,type InputKind} from './input-field.js';
import {actions,resolveAction,helpLines,parseCommand,commandSuggestions} from './actions.js';
import {keyName,F1Observer} from './input.js';
import {configEntries,configPath,resetConfig,saveConfig,setConfig} from './config.js';
import {expandPath,readMap,saveMap,suggestFilename,writeTextAtomic,resolveSaveDirectory} from './storage.js';
import {createBrowser,navigateBrowser,expandBrowser,collapseBrowser,refreshBrowser,filterBrowser,moveBrowserSelection,browserTreeRows,browserFiles,type BrowserState} from './browser.js';
import {browserLines,browserLocation} from './browser-view.js';
import {listRecoveries,writeRecovery,removeRecovery} from './recovery.js';

type Panel='map'|'input'|'help'|'settings'|'library'|'move'|'recoveries'|'confirm';
interface Dialog {kind:InputKind;value:string;cursor:number;prompt:string;after?:()=>void;returnTo?:Dialog}
interface Item {label:string;description?:string;value:string}
interface Confirmation {message:string;choices:string;accept:(key:string)=>void}
interface State {
  doc:DocumentState;config:AppConfig;file?:string;fingerprint?:string;
  hasDocument:boolean;browser?:BrowserState;returnToLibrary:boolean;saveDirectory?:string;
  panel:Panel;dialog?:Dialog;message:string;index:number;scroll:number;
  view:{x:number;y:number};manualPan:boolean;clipboard:MindmapNode[];
  items:Item[];confirmation?:Confirmation;previous?:{panel:Panel;dialog?:Dialog;index:number;scroll:number};widthOverride?:number;
}
export interface AppProps {nodes:MindmapNode[];config:AppConfig;file?:string;fingerprint?:string;fresh?:boolean;widthOverride?:number;browseDirectory?:string;onState?:(state:State)=>void}

export function App(props:AppProps) {
  const workspace=useRef(process.cwd()).current;
  const {exit}=useApp(),{stdin}=useStdin(),{setCursorPosition}=useCursor();
  const {columns,rows}=useWindowSize();
  const width=Math.max(12,columns-2);
  const initial:State={doc:initialDocument(props.nodes),config:props.config,file:props.file,fingerprint:props.fingerprint,
    hasDocument:!props.browseDirectory,returnToLibrary:false,
    panel:props.browseDirectory?'library':'map',message:'只输入想法，分支自动排版。',index:0,scroll:0,view:{x:0,y:0},manualPan:false,clipboard:[],items:[],widthOverride:props.widthOverride};
  const [state,setState]=useState(initial),current=useRef(state),session=useRef(randomUUID()),leaving=useRef(false);
  const inputDialog=state.panel==='input'?state.dialog:undefined;
  const height=Math.max(1,rows-(inputDialog?9:7));
  const update=(fn:(s:State)=>State)=>{const next=fn(current.current);current.current=next;setState(next);props.onState?.(next);};
  const message=(text:string)=>update(s=>({...s,message:text}));
  const safely=(fn:()=>void)=>{try{fn();}catch(error){message(error instanceof Error?error.message:String(error));}};
  const layout=useMemo(()=>layoutMap(state.doc.nodes,{nodeWidth:Math.min(state.widthOverride??state.config.nodeWidth,Math.max(8,width-8)),mode:state.config.layout}),[state.doc.nodes,state.config.nodeWidth,state.config.layout,state.widthOverride,width]);
  const view=state.manualPan?state.view:followSelection(layout,state.doc.selected,state.view,width,height);
  const liveView=useRef(view);liveView.current=view;

  function inLibrary(s=current.current){return s.panel==='library'||s.returnToLibrary||!s.hasDocument;}
  function saveDirectory(s=current.current){return s.saveDirectory||resolveSaveDirectory(s.config,workspace);}
  function requireDocument(){if(!current.current.hasDocument)throw new Error('请先按 n 新建，或打开一张脑图。');}
  function contextualHelp(s:State){return helpLines(s.config,inLibrary(s)||s.previous?.panel==='library'||s.previous?.dialog?.kind==='filter');}
  function closePanel(){update(s=>({...s,panel:s.dialog?.returnTo?'input':inLibrary(s)?'library':'map',dialog:s.dialog?.returnTo,index:0,confirmation:undefined,previous:undefined,message:''}));}
  function begin(kind:InputKind,value='',prompt?:string,after?:()=>void){
    const labels:Record<InputKind,string>={edit:'编辑节点',child:'添加子节点',sibling:'添加同级节点',save:'保存到文件',command:'命令菜单',search:'搜索全部节点',open:'打开文件或目录',import:'导入 Markdown',export:'导出 Markdown',filter:'筛选文件和目录'};
    update(s=>({...s,panel:'input',dialog:{kind,value,cursor:graphemes(value).length,prompt:prompt||labels[kind],after,
      returnTo:['edit','child','sibling'].includes(kind)?undefined:s.dialog?.returnTo},returnToLibrary:inLibrary(s),index:0,message:''}));
  }
  function openCommands(value='',returnTo?:Dialog){
    begin('command',value);
    if(returnTo)update(s=>({...s,dialog:s.dialog?{...s.dialog,returnTo}:undefined}));
  }
  const noDocumentCommands=new Set(['help','settings','config','keys','set','bind','reset','new','open','library','import','recover','quit','q']);
  function suggestions(value:string){return commandSuggestions(value).filter(x=>current.current.hasDocument||noDocumentCommands.has(x.value.trim().split(/\s/u)[0]!));}
  function chooseCommand(execute:boolean){
    const s=current.current,d=s.dialog;if(d?.kind!=='command')return;
    const options=suggestions(d.value),choice=options[Math.min(s.index,options.length-1)];
    if(!choice){if(execute)command(d.value);else message('没有匹配的命令；参数请直接输入。');return;}
    if(!execute||choice.requiresArgs){
      update(x=>({...x,dialog:x.dialog?{...x.dialog,value:choice.value,cursor:graphemes(choice.value).length}:undefined,index:0,
        message:choice.requiresArgs?`请补充参数：/${choice.label}`:''}));
    }else command(choice.value);
  }
  function apply(op:Operation,content=true){update(s=>({...s,doc:commit(s.doc,op,content),panel:'map',dialog:undefined,returnToLibrary:false,view:liveView.current,manualPan:false,message:''}));}
  function selected(){return current.current.doc.nodes.find(n=>n.id===current.current.doc.selected)!;}
  function confirm(message:string,choices:string,accept:(key:string)=>void){update(s=>({...s,panel:'confirm',confirmation:{message,choices,accept},message:''}));}
  function finish(){leaving.current=true;safely(()=>removeRecovery(session.current));exit();}
  function askLeave(after:()=>void){
    if(!current.current.doc.dirty){after();return;}
    const origin=current.current;
    const resumeOrigin=()=>update(s=>({...s,panel:origin.panel,dialog:origin.dialog,index:origin.index,scroll:origin.scroll,previous:origin.previous,returnToLibrary:origin.returnToLibrary,confirmation:undefined,message:''}));
    confirm('有未保存的修改','s 保存后继续 · d 放弃修改 · Esc 返回',key=>{
      if(key==='s'||key==='Ctrl+s'){resumeOrigin();save(false,after);}
      else if(key==='d'){after();}
      else if(key==='Esc'||key==='Ctrl+c')resumeOrigin();
    });
  }
  function installDocument(nodes:MindmapNode[],file?:string,fingerprint?:string,dirty=false,saveDirectory?:string){
    removeRecovery(session.current);session.current=randomUUID();
    update(s=>({...s,doc:initialDocument(nodes,dirty),file,fingerprint,saveDirectory,hasDocument:true,returnToLibrary:false,panel:'map',dialog:undefined,confirmation:undefined,previous:undefined,view:{x:0,y:0},manualPan:false,message:''}));
  }
  function save(as=false,after?:()=>void){
    requireDocument();
    const s=current.current;
    if(!as&&s.file){persist(s.file,after);return;}
    begin('save',s.file||path.join(saveDirectory(s),suggestFilename(s.doc.nodes[0]!.text)),undefined,after);
  }
  function persist(input:string,after?:()=>void,overwrite=false){
    requireDocument();
    const s=current.current,target=expandPath(input,saveDirectory(s));
    const same=target===s.file;
    try{
      const result=saveMap(target,s.doc.nodes,{expectedFingerprint:same?s.fingerprint:undefined,overwrite});
      update(x=>({...x,file:result.file,fingerprint:result.fingerprint,doc:{...x.doc,dirty:false},panel:'map',dialog:undefined,returnToLibrary:false,message:`已保存：${result.file}`}));
      removeRecovery(session.current);after?.();
    }catch(error){
      const code=(error as {code?:string}).code;
      if(code==='EXISTS')confirm(`该文件已存在：${target}。是否覆盖？`,'y 覆盖 · Esc 取消',key=>{if(key==='y')safely(()=>persist(input,after,true));else if(key==='Esc'||key==='Ctrl+c')begin('save',input,undefined,after);});
      else if(code==='CONFLICT'){
        confirm('文件已被其他程序修改，原文件未覆盖。','S 另存为 · Esc 返回',key=>{if(key==='S')begin('save',target,undefined,after);else if(key==='Esc'||key==='Ctrl+c')closePanel();});
      }else throw error;
    }
  }
  function openFile(input:string){
    const target=expandPath(input,inLibrary()?current.current.browser?.directory||workspace:workspace);
    if(statSync(target).isDirectory()){showLibrary(target);return;}
    readMap(target);
    askLeave(()=>{const result=readMap(target);installDocument(result.nodes,result.file,result.fingerprint);});
  }
  function newMap(){const directory=inLibrary()?current.current.browser?.directory||workspace:undefined;askLeave(()=>{installDocument(model.createMap(),undefined,undefined,false,directory);begin('edit','');});}
  function showHelp(){
    const s=current.current;
    if(s.panel==='help'){update(x=>({...x,panel:x.previous?.panel||'map',dialog:x.previous?.dialog,index:x.previous?.index??0,scroll:x.previous?.scroll??0,previous:undefined}));return;}
    update(x=>({...x,previous:{panel:x.panel,dialog:x.dialog,index:x.index,scroll:x.scroll},panel:'help',scroll:0,message:''}));
  }
  function showLibrary(input?:string){
    const s=current.current,directory=input|| (s.file?path.dirname(s.file):s.browser?.directory||workspace);
    let browser=s.browser?navigateBrowser({...s.browser,query:''},directory):createBrowser(directory);
    if(!input&&s.file){const index=browserFiles(browser).findIndex(x=>x.file===s.file);if(index>=0)browser={...browser,fileIndex:index,focus:'files'};}
    update(x=>({...x,panel:'library',browser,dialog:undefined,returnToLibrary:false,index:0,message:''}));
  }
  function showRecoveries(){
    const items=listRecoveries().filter(x=>x.sessionId!==session.current).map(x=>({label:x.nodes[0]?.text||'恢复快照',description:x.updatedAt,value:x.sessionId}));
    update(s=>({...s,panel:'recoveries',items,index:0,returnToLibrary:inLibrary(s),message:items.length?'Enter 恢复 · d 删除快照 · Esc 继续':'没有待恢复快照。Esc 返回。'}));
  }
  function restore(id:string){
    const recovery=listRecoveries().find(x=>x.sessionId===id);if(!recovery)throw new Error('恢复快照已不存在。');
    askLeave(()=>{
      installDocument(recovery.nodes,recovery.file,recovery.baseFingerprint,true,recovery.saveDirectory);
      writeRecovery({sessionId:session.current,nodes:recovery.nodes,file:recovery.file,baseFingerprint:recovery.baseFingerprint,saveDirectory:recovery.saveDirectory});
      removeRecovery(id);message('已恢复未保存内容，请检查后保存。');
    });
  }
  function showMove(){
    const s=current.current,id=s.doc.selected,index=s.doc.nodes.findIndex(n=>n.id===id),depth=selected().depth;
    if(depth===0)throw new Error('根节点不能移动。');
    let end=index+1;while(end<s.doc.nodes.length&&s.doc.nodes[end]!.depth>depth)end++;
    const items=s.doc.nodes.filter((_,i)=>i<index||i>=end).map(n=>({label:'  '.repeat(n.depth)+n.text,value:n.id}));
    update(x=>({...x,panel:'move',items,index:0,message:'选择新的父节点；移动后可撤销。'}));
  }
  function changeConfig(key:string,value?:string,reset=false){
    const s=current.current,candidate=reset?resetConfig(s.config,key||undefined):setConfig(s.config,key,value||'');
    saveConfig(candidate);update(x=>({...x,config:candidate,widthOverride:key==='node-width'||!key?undefined:x.widthOverride,message:`已保存设置：${key||'全部'}`,manualPan:false}));
  }
  function command(value:string){
    const [name,...args]=parseCommand(value);if(!name){closePanel();return;}
    if(!current.current.hasDocument&&!noDocumentCommands.has(name))requireDocument();
    const requireArgs=(min:number,max=min)=>{if(args.length<min||args.length>max)throw new Error('参数数量不正确，请输入 help 查看命令。');};
    switch(name){
      case 'help':requireArgs(0);closePanel();showHelp();break;
      case 'settings':case 'config':case 'keys':requireArgs(0);update(s=>({...s,panel:'settings',index:0,message:`配置：${configPath()}`}));break;
      case 'set':requireArgs(2);changeConfig(args[0]!,args[1]);closePanel();message('设置已保存并立即生效。');break;
      case 'bind':requireArgs(2);changeConfig(`key.${args[0]}`,args[1]);closePanel();message('快捷键已更新。');break;
      case 'reset':requireArgs(0,1);changeConfig(args[0]||'',undefined,true);closePanel();message('已恢复默认设置。');break;
      case 'save':case 'w':case 'write':case 'save-as':{
        requireArgs(0,name==='save-as'?0:1);
        const origin=current.current.dialog?.returnTo;
        const resume=origin?()=>update(s=>({...s,panel:'input',dialog:origin,index:0})):undefined;
        args.length?persist(args[0]!,resume):save(name==='save-as',resume);break;
      }
      case 'q':case 'quit':requireArgs(0);closePanel();askLeave(finish);break;
      case 'new':requireArgs(0);newMap();break;
      case 'open':requireArgs(0,1);args.length?openFile(args[0]!):showLibrary();break;
      case 'search':requireArgs(0,1);begin('search',args[0]||'');break;
      case 'layout':requireArgs(1);changeConfig('layout',args[0]);closePanel();break;
      case 'import':requireArgs(0,1);if(args.length)importFile(args[0]!);else begin('import');break;
      case 'export':requireArgs(0,1);if(args.length)exportFile(args[0]!);else startExport();break;
      case 'recover':requireArgs(0);showRecoveries();break;
      default:if(actions.some(([id])=>id===name)){requireArgs(0);closePanel();perform(name);}else throw new Error(`未知命令：${name}。按 Tab 查看补全，help 查看帮助。`);
    }
  }
  function importFile(input:string){
    const directory=inLibrary()?current.current.browser?.directory||workspace:undefined;
    const source=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(expandPath(input,directory||workspace)));
    const nodes=importMarkdown(source);
    askLeave(()=>{installDocument(nodes,undefined,undefined,true,directory);message('Markdown 已导入为新脑图，请保存。');});
  }
  function startExport(){requireDocument();const s=current.current;begin('export',path.join(saveDirectory(s),suggestFilename(s.doc.nodes[0]!.text).replace(/\.mm$/u,'.md')));}
  function exportFile(input:string,overwrite=false){
    requireDocument();const s=current.current,target=expandPath(input,saveDirectory(s));
    try{writeTextAtomic(target,exportMarkdown(s.doc.nodes),{overwrite});closePanel();message(`已导出：${target}`);}
    catch(error){if((error as {code?:string}).code==='EXISTS')confirm(`导出文件已存在：${target}。是否覆盖？`,'y 覆盖 · Esc 取消',key=>{if(key==='y')safely(()=>exportFile(input,true));else if(key==='Esc'||key==='Ctrl+c')begin('export',input);});else throw error;}
  }
  function perform(action:string){
    if(!current.current.hasDocument&&!['quit','help','command','settings','library','new','import'].includes(action))requireDocument();
    const s=current.current,{nodes,selected:id}=s.doc,n=selected(),visible=model.visibleNodes(nodes);
    const choose=(target:string|undefined)=>{if(target)update(x=>({...x,doc:{...x.doc,nodes:model.revealNode(x.doc.nodes,target),selected:target},view:liveView.current,manualPan:false,message:''}));};
    switch(action){
      case 'child':case 'sibling':begin(action);break;
      case 'edit':begin('edit',n.text);break;
      case 'delete':apply(model.removeBranch(nodes,id));break;
      case 'fold':apply(model.toggleFold(nodes,id),false);break;
      case 'parent':choose(model.parentId(nodes,id));break;
      case 'child-select':{
        let candidate=nodes;if(n.folded){candidate=model.toggleFold(nodes,id).nodes;update(x=>({...x,doc:{...x.doc,nodes:candidate}}));}
        const i=candidate.findIndex(x=>x.id===id),next=candidate[i+1];if(next&&next.depth===n.depth+1)choose(next.id);break;
      }
      case 'up':case 'down':{const index=visible.findIndex(x=>x.id===id);choose(visible[index+(action==='up'?-1:1)]?.id);break;}
      case 'root':{
        const root=layout.nodes.find(node=>node.id===nodes[0]?.id);
        if(root){
          const centered={x:root.x-Math.max(0,Math.floor((width-root.width)/2)),y:root.y-Math.max(0,Math.floor((Math.max(1,rows-7)-root.height)/2))};
          liveView.current=centered;
          update(x=>({...x,doc:{...x.doc,selected:root.id},view:centered,manualPan:false,message:'已回到根节点'}));
        }
        break;
      }
      case 'undo':case 'redo':update(x=>({...x,doc:travel(x.doc,action),view:liveView.current,manualPan:false,message:''}));break;
      case 'save':save();break;case 'save-as':save(true);break;
      case 'quit':askLeave(finish);break;case 'help':showHelp();break;case 'command':openCommands();break;
      case 'search':begin('search');break;
      case 'copy':update(x=>({...x,clipboard:model.copyBranch(nodes,id),message:'分支已复制；选择目标节点后按粘贴。'}));break;
      case 'paste':if(!s.clipboard.length)throw new Error('请先复制一个分支。');apply(model.pasteBranch(nodes,id,s.clipboard));break;
      case 'move':showMove();break;
      case 'move-up':case 'move-down':apply(model.reorderBranch(nodes,id,action==='move-up'?-1:1));break;
      case 'page-up':case 'page-down':pan(0,action==='page-up'?-Math.max(1,rows-8):Math.max(1,rows-8));break;
      case 'pan-left':pan(-8,0);break;case 'pan-right':pan(8,0);break;
      case 'pan-up':pan(0,-3);break;case 'pan-down':pan(0,3);break;
      case 'settings':update(x=>({...x,panel:'settings',index:0,message:`配置：${configPath()}`}));break;
      case 'library':showLibrary();break;case 'new':newMap();break;
      case 'import':begin('import');break;case 'export':startExport();break;
    }
  }
  function pan(dx:number,dy:number){
    update(s=>{
      // Free movement also works when the entire map already fits on screen.
      // Use committed manual coordinates so consecutive key events accumulate.
      const base=s.manualPan?s.view:liveView.current;
      const next={x:base.x+dx,y:base.y+dy};
      liveView.current=next;
      return {...s,manualPan:true,view:next,message:`已平移画布 · ${s.config.keys.root||':root'} 回到根节点`};
    });
  }
  function submit(){
    const s=current.current,d=s.dialog;if(!d)return;
    switch(d.kind){
      case 'filter':update(x=>({...x,panel:'library',dialog:undefined,returnToLibrary:false,message:''}));break;
      case 'edit':apply(model.editNode(s.doc.nodes,s.doc.selected,d.value));break;
      case 'child':apply(model.addChild(s.doc.nodes,s.doc.selected,d.value));break;
      case 'sibling':apply(model.addSibling(s.doc.nodes,s.doc.selected,d.value));break;
      case 'save':if(!d.value.trim())throw new Error('文件名不能为空。');persist(d.value,d.after);break;
      case 'command':chooseCommand(true);break;
      case 'open':openFile(d.value);break;case 'import':importFile(d.value);break;case 'export':exportFile(d.value);break;
      case 'search':{const matches=model.searchNodes(s.doc.nodes,d.value),target=matches[s.index];if(!target){message('没有匹配节点。');break;}update(x=>({...x,doc:{...x.doc,nodes:model.revealNode(x.doc.nodes,target.id),selected:target.id},panel:'map',dialog:undefined,returnToLibrary:false,manualPan:false,message:`已定位：${target.text}`}));break;}
    }
  }
  function insert(text:string){update(s=>{
    if(s.panel!=='input'||!s.dialog)return {...s,message:'请先编辑节点再粘贴，浏览模式不会执行粘贴中的快捷键。'};
    const d=s.dialog,next=editBuffer(d,'insert',sanitizePaste(text));
    if(['edit','child','sibling'].includes(d.kind)&&Array.from(next.value).length>300)return {...s,message:'每个节点最多 300 个字符；此次输入未插入。'};
    if(next.value.length>8192)return {...s,message:'输入过长。'};
    return {...s,dialog:{...d,...next},browser:d.kind==='filter'&&s.browser?filterBrowser(s.browser,next.value):s.browser,index:0,message:''};
  });}
  function browseKey(name:string){
    const s=current.current,b=s.browser;
    if(['q','Ctrl+c','Ctrl+d'].includes(name)){askLeave(finish);return;}
    if(['?','？'].includes(name)){showHelp();return;}
    if(['/','：',':'].includes(name)){openCommands();return;}
    if(name==='n'){newMap();return;}
    if(name==='o'){begin('open');return;}
    if(name==='r'){showRecoveries();return;}
    if(name==='Esc'){
      if(b?.query){update(x=>({...x,browser:filterBrowser(b,''),message:''}));return;}
      if(s.hasDocument)update(x=>({...x,panel:'map',dialog:undefined,returnToLibrary:false,message:''}));
      else message('Enter 打开文件 · n 新建脑图 · q 退出');
      return;
    }
    if(!b){if(name==='Ctrl+r')showLibrary(props.browseDirectory||workspace);return;}
    const setBrowser=(browser:BrowserState)=>update(x=>({...x,browser,message:''}));
    const upDirectory=(directory:string)=>{
      const parent=path.dirname(directory);
      if(parent===directory){message('已到文件系统根目录，没有上级目录。');return;}
      setBrowser(navigateBrowser(b,parent));
    };
    if(name==='Tab'){setBrowser({...b,focus:b.focus==='files'?'directories':'files'});return;}
    if(name==='f'){begin('filter',b.query);return;}
    if(name==='.'||name==='Ctrl+r'){setBrowser(refreshBrowser(b,name==='.'?!b.showHidden:b.showHidden));return;}
    if(name==='Backspace'){upDirectory(b.directory);return;}
    const steps:Record<string,number|'first'|'last'>={Up:-1,Down:1,PageUp:-Math.max(1,height-2),PageDown:Math.max(1,height-2),Home:'first',End:'last'};
    if(steps[name]!==undefined){setBrowser(moveBrowserSelection(b,steps[name]!));return;}
    if(name==='Enter'){
      if(b.focus==='directories')setBrowser(navigateBrowser(b,b.selectedDirectory));
      else {const file=browserFiles(b)[b.fileIndex];if(file)openFile(file.file);else message('当前目录没有匹配的脑图，按 n 新建。');}
      return;
    }
    if(name==='Left'){
      if(b.focus==='files'){setBrowser({...b,focus:'directories',selectedDirectory:b.directory});return;}
      if(b.selectedDirectory===b.root||browserTreeRows(b).find(x=>x.file===b.selectedDirectory)?.kind==='parent'){upDirectory(b.root);return;}
      if(b.query){message('筛选期间保留匹配目录的层级；按 Esc 清除筛选后可收起。');return;}
      if(b.expanded.includes(b.selectedDirectory))setBrowser(collapseBrowser(b,b.selectedDirectory));
      else {const parent=path.dirname(b.selectedDirectory);if(browserTreeRows(b).some(x=>x.file===parent))setBrowser({...b,selectedDirectory:parent});}
      return;
    }
    if((name==='Right'||name==='Space')&&b.focus==='directories'){
      if(browserTreeRows(b).find(x=>x.file===b.selectedDirectory)?.kind==='parent'){
        if(name==='Right')setBrowser(navigateBrowser(b,b.selectedDirectory));
        else message('按 Enter 或 → 打开上级目录。');
        return;
      }
      if(name==='Space'&&b.query){message('筛选期间保留匹配目录的层级；按 Esc 清除筛选后可收起。');return;}
      if(!b.expanded.includes(b.selectedDirectory)){setBrowser(expandBrowser(b,b.selectedDirectory));return;}
      if(name==='Space'){setBrowser(collapseBrowser(b,b.selectedDirectory));return;}
      const rows=browserTreeRows(b),index=rows.findIndex(x=>x.file===b.selectedDirectory),child=rows[index+1];
      if(child&&path.dirname(child.file)===b.selectedDirectory)setBrowser({...b,selectedDirectory:child.file});
      return;
    }
    if(name==='Right'&&b.focus==='files'){const file=browserFiles(b)[b.fileIndex];if(file)openFile(file.file);}
  }
  function handle(input:string,key:Parameters<typeof keyName>[1]){
    if(key.eventType==='release')return;
    const name=keyName(input,key),s=current.current;
    if(!name)return;
    if(s.panel==='help'){
      if(['?','？','Esc','q','Ctrl+c',s.config.keys.help].includes(name)){showHelp();return;}
      const max=Math.max(0,contextualHelp(s).length-height);
      update(x=>({...x,scroll:name==='Home'?0:name==='End'?max:Math.max(0,Math.min(max,x.scroll+(['Down','PageDown','Tab','Right'].includes(name)?(name==='Down'?1:height-1):['Up','PageUp','Left'].includes(name)?(name==='Up'?-1:1-height):0)))}));return;
    }
    if(s.panel==='confirm'){s.confirmation?.accept(name);return;}
    if((rows<12||columns<48)&&['q','Ctrl+c','Ctrl+d'].includes(name)){askLeave(finish);return;}
    if(s.panel==='input'){
      if(name==='Esc'||name==='Ctrl+c'||name==='Ctrl+d'){
        if(s.dialog?.kind==='filter'&&s.browser)update(x=>({...x,panel:'library',dialog:undefined,browser:filterBrowser(s.browser!,''),returnToLibrary:false,message:''}));
        else closePanel();return;
      }
      const d=s.dialog;
      if(d&&['edit','child','sibling'].includes(d.kind)&&!d.value&&!key.ctrl&&!key.meta&&input.startsWith('/')){
        if(input.startsWith('//'))insert(input.slice(1));else openCommands(input.slice(1),d);
        return;
      }
      if(d?.kind==='command'&&d.returnTo&&!d.value&&!key.ctrl&&!key.meta&&input.startsWith('/')){
        update(x=>({...x,dialog:d.returnTo,index:0,message:''}));
        insert(input);return;
      }
      if(name==='Enter'){submit();return;}
      if(d?.kind==='filter'&&s.browser&&['Tab','Up','Down','PageUp','PageDown'].includes(name)){
        const browser=s.browser;
        update(x=>({...x,browser:name==='Tab'?{...browser,focus:browser.focus==='files'?'directories':'files'}:moveBrowserSelection(browser,name==='Up'?-1:name==='Down'?1:name==='PageUp'?-Math.max(1,height-2):Math.max(1,height-2))}));return;
      }
      if(d?.kind==='command'){
        if(name==='Tab'){chooseCommand(false);return;}
        if(['Up','Down','PageUp','PageDown'].includes(name)){
          const total=suggestions(d.value).length,step=name==='Up'?-1:name==='Down'?1:name==='PageUp'?-Math.max(1,height-1):Math.max(1,height-1);
          update(x=>({...x,index:Math.max(0,Math.min(Math.max(0,total-1),x.index+step))}));return;
        }
      }
      if(s.dialog?.kind==='search'&&(name==='Up'||name==='Down')){
        const total=model.searchNodes(s.doc.nodes,s.dialog.value).length;update(x=>({...x,index:Math.max(0,Math.min(total-1,x.index+(name==='Up'?-1:1)))}));return;
      }
      const editing:Record<string,string>={Left:'left',Right:'right',Home:'home',End:'end',Backspace:'backspace',Delete:'delete','Ctrl+u':'clear'};
      if(editing[name]){update(x=>{const dialog=x.dialog?{...x.dialog,...editBuffer(x.dialog,editing[name]!)}:undefined;return {...x,dialog,
        browser:dialog?.kind==='filter'&&x.browser&&dialog.value!==x.browser.query?filterBrowser(x.browser,dialog.value):x.browser,
        index:['Backspace','Delete','Ctrl+u'].includes(name)?0:x.index,message:''};});return;}
      if(!key.ctrl&&!key.meta&&!['Tab','Up','Down','PageUp','PageDown'].includes(name))insert(input);return;
    }
    if(s.panel==='library'){browseKey(name);return;}
    if(s.panel!=='map'){
      if(['Esc','q','Ctrl+c'].includes(name)){closePanel();return;}
      if(name==='/'||name===':'||name==='：'){openCommands();return;}
      if(s.panel==='settings'){
        const entries=Object.entries(configEntries(s.config));
        if(name==='Up'||name==='Down')update(x=>({...x,index:Math.max(0,Math.min(entries.length-1,x.index+(name==='Up'?-1:1)))}));
        if(name==='Enter'){const entry=entries[s.index];if(entry)begin('command',`set ${entry[0]} ${JSON.stringify(entry[1])}`);}return;
      }
      if(name==='Up'||name==='Down'||name==='PageUp'||name==='PageDown')update(x=>({...x,index:Math.max(0,Math.min(x.items.length-1,x.index+(name==='Up'?-1:name==='Down'?1:name==='PageUp'?-height:height)))}));
      const item=s.items[s.index];if(!item)return;
      if(s.panel==='recoveries'&&name==='d'){confirm('删除这个恢复快照？','y 删除 · Esc 返回',k=>{if(k==='y'){removeRecovery(item.value);showRecoveries();}else if(k==='Esc')showRecoveries();});return;}
      if(name==='Enter'){if(s.panel==='move')apply(model.moveBranch(s.doc.nodes,s.doc.selected,item.value));else if(s.panel==='recoveries')restore(item.value);}return;
    }
    const actionKey=key.shift&&['Up','Down','Left','Right'].includes(name)?`Shift+${name}`:name;
    const action=resolveAction(actionKey,s.config);if(action)perform(action);
  }
  useInput((input,key)=>safely(()=>handle(input,key)));
  usePaste(text=>safely(()=>insert(text)));
  const onF1=useRef(()=>safely(showHelp));onF1.current=()=>safely(showHelp);
  useEffect(()=>{
    const observer=new F1Observer();
    const observe=(data:Buffer|string)=>{
      const count=observer.push(String(data));
      // Let Ink consume preceding text from the same chunk before opening help.
      for(let i=0;i<count;i++)queueMicrotask(()=>onF1.current());
    };
    stdin.on('data',observe);return()=>{stdin.off('data',observe);};
  },[stdin]);
  useEffect(()=>{
    if(leaving.current)return;
    if(!state.doc.dirty)return;
    const timer=setTimeout(()=>safely(()=>writeRecovery({sessionId:session.current,nodes:current.current.doc.nodes,file:current.current.file,baseFingerprint:current.current.fingerprint,saveDirectory:current.current.saveDirectory})),1000);
    return()=>clearTimeout(timer);
  },[state.doc.nodes,state.doc.dirty,state.file]);
  useEffect(()=>{
    const flush=()=>{if(current.current.doc.dirty)writeRecovery({sessionId:session.current,nodes:current.current.doc.nodes,file:current.current.file,baseFingerprint:current.current.fingerprint,saveDirectory:current.current.saveDirectory});};
    const terminate=()=>{try{flush();}finally{leaving.current=true;exit();}};
    process.on('SIGTERM',terminate);process.on('SIGHUP',terminate);
    return()=>{process.off('SIGTERM',terminate);process.off('SIGHUP',terminate);if(!leaving.current)try{flush();}catch{/* Shutdown cannot overwrite application errors. */}};
  },[]);
  useEffect(()=>{safely(()=>{
    if(props.browseDirectory){showLibrary(props.browseDirectory);const count=listRecoveries().length;if(count)message(`有 ${count} 份未保存内容可恢复，按 r 查看。`);}
    else if(listRecoveries().length)showRecoveries();else if(props.fresh)begin('edit','');
  });},[]);

  let body:React.ReactNode[]=[];
  const textLine=(text:string,color?:string)=> <Text color={color} wrap="truncate">{clipText(sanitizePaste(text),0,width)}</Text>;
  const browsing=state.panel==='library'||!!inputDialog&&inLibrary(state);
  let prompt='',footer='';
  if(state.panel==='help'){
    body=contextualHelp(state).slice(state.scroll,state.scroll+height).map(x=>textLine(x));
    prompt='帮助 · ↑↓ 滚动 / PgUp PgDn 翻页';footer='? / F1 / Esc 返回 · Enter 保留帮助';
  }else if(state.panel==='settings'){
    const entries=Object.entries(configEntries(state.config)),start=Math.max(0,state.index-height+1);
    body=entries.slice(start,start+height).map(([k,v],i)=>textLine(`${start+i===state.index?'›':' '} ${k} = ${k==='save-dir'&&!v?'启动目录（默认）':v}`,start+i===state.index?'cyan':undefined));
    prompt='设置 · ↑↓ 选择 / Enter 修改';footer='设置立即生效 · : 打开命令 · Esc 返回';
  }else if(browsing){
    body=state.browser?browserLines(state.browser,width,height):[textLine('目录无法读取。o 输入路径 · Ctrl-R 重试','yellow')];
    prompt=width>=78?'Tab 切区 · ↑↓ 选择 · Enter 打开 · → 展开 · ← 收起/上级 · Backspace 上级':'Tab 切区 · Enter 打开 · ← 收起/上级 · 退格上级';
    footer=width>=78?'n 新建 · f 筛选 · o 路径 · . 隐藏 · Ctrl-R 刷新 · / 命令 · Esc 返回 · q 退出':'n 新建 · f 筛选 · o 路径 · / 命令 · q 退出';
  }else if(['move','recoveries'].includes(state.panel)){
    const start=Math.max(0,state.index-height+1);
    body=state.items.slice(start,start+height).map((x,i)=>textLine(`${start+i===state.index?'›':' '} ${x.label}${x.description?'  · '+x.description:''}`,start+i===state.index?'cyan':undefined));
    prompt=state.panel==='move'?'移动分支 · 选择新的父节点':'恢复未保存的脑图';footer='↑↓ 选择 · Enter 确认 · Esc 返回';
  }else if(state.panel==='confirm'){
    body=wrapText(state.confirmation?.message||'',width).map(line=>textLine(line,'yellow'));prompt=state.confirmation?.choices||'';
  }else{
    body=renderViewport(layout,{...view,width,height,selected:state.doc.selected}).map(row=><Text>{row.map((span,i)=><Text key={i} color={span.tone==='edge'?'gray':span.tone==='selected'?'black':'cyan'} backgroundColor={span.tone==='selected'?'cyan':undefined}>{span.text}</Text>)}</Text>);
    prompt=`${state.config.keys.child} 子节点 · ${state.config.keys.sibling} 同级 · ${state.config.keys.edit} 编辑 · ${state.config.keys.help} 帮助 · / 命令`;
    footer=`${state.config.keys.save} 保存 · ${state.config.keys.search||'/search'} 搜索 · ${state.config.keys.library||'/open'} 文件浏览 · ${state.config.keys.quit} 退出`;
  }
  const editor=inputDialog?inputViewport(inputDialog.value,inputDialog.cursor,width):undefined;
  if(inputDialog){
    const d=inputDialog;
    if(d.kind==='search'){
      const matches=model.searchNodes(state.doc.nodes,d.value),start=Math.max(0,state.index-height+2);
      body=[textLine(`${matches.length} 个结果 · ↑↓ 选择 / Enter 定位`),...matches.slice(start,start+height-1).map((n,i)=>textLine(`${start+i===state.index?'›':' '} ${'  '.repeat(n.depth)}${n.text}`,start+i===state.index?'cyan':undefined))];
    }else if(d.kind==='command'){
      const candidates=suggestions(d.value),selectedIndex=Math.min(state.index,Math.max(0,candidates.length-1));
      const capacity=Math.max(1,height-1),start=Math.max(0,selectedIndex-capacity+1);
      body=[textLine(`命令 · ${candidates.length} 个匹配 · ↑↓ 选择`,'magenta')];
      if(candidates.length){
        body.push(...candidates.slice(start,start+capacity).map((candidate,i)=>{
          const active=start+i===selectedIndex,label=clipText(`${active?'›':' '} /${candidate.label}  ${candidate.description}`,0,width);
          return <Text color={active?'black':'magenta'} backgroundColor={active?'magenta':undefined} wrap="truncate">{label}{' '.repeat(Math.max(0,width-displayWidth(label)))}</Text>;
        }));
      }else body.push(textLine(d.value.trimStart().includes(' ')?'参数输入中 · Enter 执行，路径含空格请加引号':'没有匹配的命令 · 修改关键词或 Esc 返回'));
    }
  }
  // Ink records this position for the current render; an effect lags one frame.
  setCursorPosition(editor&&rows>=12&&columns>=48?{x:1+editor.cursorX,y:rows-4}:undefined);
  if(rows<12||columns<48)return <Box flexDirection="column" width={Math.max(1,columns)}><Text wrap="truncate">SMM · 请放大至 48 列 × 12 行</Text><Text wrap="truncate">当前 {columns} × {rows} · q 退出</Text><Text wrap="truncate">{state.panel==='confirm'?state.confirmation?.choices:state.message}</Text></Box>;
  while(body.length<height)body.push(textLine(''));
  const fileTitle=state.file?path.basename(state.file):'未命名脑图';
  return <Box flexDirection="column" width={columns} height={rows} paddingX={1}>
    <Text bold color="cyan" wrap="truncate">Shell Mindmap  {browsing?'SMM · 文件浏览':`${state.doc.dirty?'● ':''}${clipText(fileTitle,0,Math.max(1,width-20))}`}</Text>
    {textLine(browsing?browserLocation(state.browser?.directory||props.browseDirectory||workspace,state.browser?.query||'',width):`${state.config.layout==='right'?'向右布局':'双侧布局'} · ${state.doc.nodes.length} 节点 · ${state.file||saveDirectory(state)}`)}
    {textLine('─'.repeat(width),'gray')}
    <Box flexDirection="column" height={height} overflow="hidden">{body.map((line,i)=><Box key={i} height={1}>{line}</Box>)}</Box>
    {inputDialog&&editor?<>
      <InputField kind={inputDialog.kind} title={inputDialog.prompt} value={inputDialog.value} width={width} viewport={editor} message={state.message}/>
      {/* Ink 7 needs the last terminal row blank to anchor the real cursor reliably. */}
      {textLine('')}
    </>:<>
      {textLine(prompt)}
      {textLine(footer)}
      {textLine(state.message||(browsing?`当前目录：${path.basename(state.browser?.directory||workspace)||path.parse(state.browser?.directory||workspace).root} · r 恢复${state.hasDocument?' · Esc 返回正在编辑的脑图':''}`:''),state.message?'yellow':undefined)}
      {textLine('')}
    </>}
  </Box>;
}
