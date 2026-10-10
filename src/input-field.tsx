import React from 'react';
import {Box,Text} from 'ink';
import {clipText,displayWidth,graphemes} from './text.js';

export type InputKind='edit'|'child'|'sibling'|'save'|'command'|'search'|'open'|'import'|'export'|'filter';

const placeholders:Record<InputKind,string>={
  edit:'输入节点文字，或 / 查看命令',child:'输入子节点文字，或 / 查看命令',sibling:'输入同级节点文字，或 / 查看命令',
  save:'输入保存路径，例如 项目计划.mm',command:'输入命令或中文描述，例如 保存',
  search:'输入关键词，搜索全部节点…',open:'输入文件或目录路径，例如 项目计划.mm',
  import:'输入 Markdown 路径，例如 大纲.md',export:'输入导出路径，例如 大纲.md',
  filter:'筛选已加载的目录和当前目录的脑图…',
};

/** Reserve one visible cell after the cursor, even at the end of long CJK input. */
export function inputViewport(value:string,cursor:number,width:number){
  const textWidth=Math.max(1,width-6); // Borders, padding and the two-column prompt.
  const column=displayWidth(graphemes(value).slice(0,cursor).join(''));
  const offset=Math.max(0,column-textWidth+1);
  return {textWidth,offset,cursorX:4+column-offset,text:clipText(value,offset,textWidth)};
}

interface InputFieldProps {
  kind:InputKind;title:string;value:string;width:number;
  viewport:ReturnType<typeof inputViewport>;message?:string;
}

/** Five rows; the application owns input events, the real cursor and status messages. */
export function InputField({kind,title,value,width,viewport,message}:InputFieldProps){
  const nodeInput=['edit','child','sibling'].includes(kind);
  const accent=message?'yellow':kind==='command'?'magenta':kind==='search'?'green':'cyan';
  const count=nodeInput?`${Array.from(value).length} 字`:'';
  const titleWidth=Math.max(1,width-(count?displayWidth(count)+1:0));
  const shown=clipText(value?viewport.text:placeholders[kind],0,viewport.textWidth);
  const hint=kind==='command'?'↑↓ 选择 · Tab 补全 · Enter 确认 · Esc 返回'
    :kind==='filter'?'↑↓ 选择 · Tab 切区 · Enter 保留筛选 · Esc 清除'
    :kind==='search'?'↑↓ 选结果 · Enter 定位 · Esc 取消'
    :'Enter 确认 · Esc 取消 · Ctrl-U 清空';
  return <Box flexDirection="column" width={width} height={5} flexShrink={0}>
    <Box width={width} height={1} flexShrink={0}>
      <Box width={titleWidth}><Text bold color={accent} wrap="truncate">{clipText(title,0,titleWidth)}</Text></Box>
      {count&&<Text>{' '+count}</Text>}
    </Box>
    <Box width={width} height={3} borderStyle="round" borderColor={accent} paddingX={1} flexShrink={0}>
      <Text wrap="truncate"><Text color={accent} bold>{kind==='command'?'/ ':kind==='search'?'? ':'› '}</Text><Text italic={!value}>{shown}{' '.repeat(Math.max(0,viewport.textWidth-displayWidth(shown)))}</Text></Text>
    </Box>
    <Text color={message?'yellow':undefined} wrap="truncate">{clipText(message||hint,0,width)}</Text>
  </Box>;
}
