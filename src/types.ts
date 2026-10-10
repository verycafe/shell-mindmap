export interface MindmapNode { id: string; text: string; depth: number; folded: boolean }
export type LayoutMode = 'right' | 'bilateral';
export interface Operation { nodes: MindmapNode[]; selected: string }
export interface AppConfig { version: 2; saveDir: string; nodeWidth: number; layout: LayoutMode; keys: Record<string, string> }
