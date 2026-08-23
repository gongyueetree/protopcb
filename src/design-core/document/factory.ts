/**
 * design-core/document/factory.ts
 * 文档创建、序列化、反序列化。
 */
import { nanoid } from 'nanoid';
import { SCHEMA_VERSION } from './types';
import type { CircuitCanvasDocument, BoardDefinition, RunMode } from './types';
import { parseDocument } from './schema';

export const DEFAULT_PLACEMENT_ZONES = [
  { id: 'z-power', label: '电源区域', category: 'power' as const, normRect: [0.05, 0.05, 0.35, 0.35] as [number, number, number, number] },
  { id: 'z-mcu', label: 'MCU 核心区域', category: 'mcu' as const, normRect: [0.3, 0.25, 0.7, 0.65] as [number, number, number, number] },
  { id: 'z-ic', label: 'IC 区域', category: 'ic' as const, normRect: [0.5, 0.2, 0.9, 0.7] as [number, number, number, number] },
];

export function createBoard(widthMm = 100, heightMm = 80): BoardDefinition {
  return {
    id: nanoid(8),
    widthMm,
    heightMm,
    shape: 'rect',
    mountingHoles: [],
    keepoutZones: [],
    placementZones: DEFAULT_PLACEMENT_ZONES,
    layerCount: 2,
  };
}

/** 未命名文档的占位名。存储层统一用它，展示层经 i18n 翻译。 */
export const UNTITLED_DOC_NAME = '未命名设计';

export function createDocument(opts?: {
  name?: string;
  source?: RunMode;
  createdBy?: string;
  board?: BoardDefinition;
}): CircuitCanvasDocument {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: nanoid(12),
    name: opts?.name ?? UNTITLED_DOC_NAME,
    context: { source: opts?.source ?? 'demo' },
    board: opts?.board ?? createBoard(),
    components: [],
    functionalBlocks: [],
    connections: [],
    bom: [],
    reviewResults: [],
    metadata: {
      createdBy: opts?.createdBy ?? 'anonymous',
      createdAt: now,
      updatedAt: now,
      revision: 1,
    },
  };
}

export function serializeDocument(doc: CircuitCanvasDocument): string {
  return JSON.stringify(doc, null, 2);
}

export function deserializeDocument(json: string): CircuitCanvasDocument {
  const raw = JSON.parse(json);
  const result = parseDocument(raw);
  if (!result.ok) throw new Error(`设计文档校验失败: ${result.error}`);
  return result.document;
}

export function touchDocument(doc: CircuitCanvasDocument): CircuitCanvasDocument {
  return {
    ...doc,
    metadata: { ...doc.metadata, updatedAt: new Date().toISOString(), revision: doc.metadata.revision + 1 },
  };
}
