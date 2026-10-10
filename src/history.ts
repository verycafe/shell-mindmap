import type {MindmapNode, Operation} from './types.js';

export interface Snapshot {nodes: MindmapNode[]; selected: string}
export interface DocumentState extends Snapshot {dirty: boolean; undo: Snapshot[]; redo: Snapshot[]}
export function initialDocument(nodes: MindmapNode[], dirty = false): DocumentState {
  return {nodes, selected: nodes[0]!.id, dirty, undo: [], redo: []};
}
export function commit(state: DocumentState, next: Operation, content = true): DocumentState {
  if (!content) return {...state, ...next};
  if (JSON.stringify(state.nodes) === JSON.stringify(next.nodes)) return {...state, selected:next.selected};
  return {...state,...next,dirty:true,undo:[...state.undo,{nodes:state.nodes,selected:state.selected}].slice(-30),redo:[]};
}
export function travel(state: DocumentState, direction:'undo'|'redo'): DocumentState {
  const source=state[direction], target=direction==='undo'?'redo':'undo';
  const snapshot=source.at(-1); if (!snapshot) return state;
  return {...state,...snapshot,dirty:true,[direction]:source.slice(0,-1),
    [target]:[...state[target],{nodes:state.nodes,selected:state.selected}].slice(-30)};
}
