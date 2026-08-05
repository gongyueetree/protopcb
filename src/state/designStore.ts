/**
 * state/designStore.ts
 * 设计状态管理 (Zustand + immer)。
 * 持有当前 CircuitCanvasDocument，提供器件增删改、撤销重做、放置等动作。
 * 编辑器状态(选中/缩放)与文档数据分离。
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { ComponentCategory, CircuitCanvasDocument, PlacedComponent, BoardShapeKind } from '../design-core/document/types';
import { createDocument, touchDocument } from '../design-core/document/factory';
import type { ComponentSearchResult } from '../providers/types';
import { searchResultToPlaced, nextReference, buildBom, runDesignReview } from '../design-core/document/services';
import { resolveAffinity, signalFlowRank, isCore } from '../design-core/placement/affinity';
import { solvePlacement, DEFAULT_PLACEMENT_RULES, autoPlaceAll } from '../design-core/placement';
import { clampComponentToBoard, hasOverlap, findOverlaps, isPositionFree } from '../design-core/collision';
import { appConfig } from '../config';

const HISTORY_LIMIT = 60;

interface DesignState {
  doc: CircuitCanvasDocument;
  // editor-only state
  selectedId: string | null;
  multiSel: string[];
  overlaps: Set<string>;
  activeLayer: 'TOP' | 'BOTTOM';
  hideAllRefDes: boolean;
  // history
  past: CircuitCanvasDocument[];
  future: CircuitCanvasDocument[];

  // actions
  addComponent: (r: ComponentSearchResult) => void;
  removeComponent: (instanceId: string) => void;
  /** 批量删除（框选/多选后 Delete） */
  removeComponents: (instanceIds: string[]) => void;
  /** 框选结果整批设置多选 */
  setMultiSel: (ids: string[]) => void;
  /** 一键整理：对画布现有器件重新自动布局（进撤销历史） */
  autoArrange: () => void;
  moveComponent: (instanceId: string, xMm: number, yMm: number) => void;
  rotateComponent: (instanceId: string) => void;
  setBoardSize: (w: number, h: number) => void;
  setBoardShape: (shape: BoardShapeKind) => void;
  setBoardCut: (cutW: number, cutH: number, cornerR: number) => void;
  toggleMountingHoles: () => void;
  setActiveLayer: (layer: 'TOP' | 'BOTTOM') => void;
  flipComponentLayer: (instanceId: string) => void;
  moveRefDes: (instanceId: string, dx: number, dy: number) => void;
  toggleRefDesHidden: (instanceId: string) => void;
  toggleAllRefDes: () => void;
  setComponentMpn: (instanceId: string, mpn: string) => void;
  setCustomSymbol: (instanceId: string, svg: string) => void;
  /** 整体替换为库中器件（型号+符号+封装全部采用） */
  replaceComponentWith: (instanceId: string, src: ComponentSearchResult) => void;
  /** 仅关联原理图符号（借用库中器件的符号，型号/封装不变） */
  linkSymbolFrom: (instanceId: string, src: { mpn: string; symbolFileUrl?: string }) => void;
  /** 同型号全部器件关联同一符号（灯板等重复器件一次到位） */
  linkSymbolByMpn: (mpn: string, symbolKey: string) => void;
  /** 同型号全部器件关联同一封装（含 3D） */
  linkFootprintByMpn: (mpn: string, src: { footprintName: string; stepUrl?: string; pins?: number }) => void;
  /** 工程导入：按位号批量挂载原理图符号，返回命中数 */
  assignSymbolsByReference: (map: Record<string, string>) => number;
  setSchematicSheet: (sheet: CircuitCanvasDocument['schematicSheet']) => void;
  /** 给全部同封装且尚无 3D 的器件挂 stepUrl（无源器件自动关联 KiCad 官方库用） */
  setStepUrlByFootprint: (footprintName: string, stepUrl: string) => void;
  /** 仅关联 PCB 封装（借用库中器件的封装，型号/符号不变） */
  linkFootprintFrom: (instanceId: string, src: { footprintName: string; footprintFileUrl?: string; stepUrl?: string; pins?: number }) => void;
  select: (id: string | null) => void;
  toggleMulti: (id: string) => void;
  clearAll: () => void;
  placeScheme: (results: ComponentSearchResult[], intent?: { requirement: string; rationale: string }) => void;
  loadDocument: (doc: CircuitCanvasDocument) => void;
  /** 导入 KiCad 板文件解析结果：按板框设尺寸、按位置摆放器件 */
  importKicad: (data: import('../design-core/geometry/kicad-pcb-import').KicadImportResult) => void;
  undo: () => void;
  redo: () => void;
  recompute: () => void;
  // block diagram + connections
  setFunctionalBlocks: (blocks: CircuitCanvasDocument['functionalBlocks']) => void;
  setConnections: (conns: CircuitCanvasDocument['connections']) => void;
  generateBlocksFromComponents: () => void;
}

function snapshot(state: DesignState) {
  state.past.push(JSON.parse(JSON.stringify(state.doc)));
  if (state.past.length > HISTORY_LIMIT) state.past.shift();
  state.future = [];
}

function refreshDerived(doc: CircuitCanvasDocument): CircuitCanvasDocument {
  return { ...doc, bom: buildBom(doc), reviewResults: runDesignReview(doc) };
}

export const useDesignStore = create<DesignState>()(
  immer((set, _get) => ({
    doc: refreshDerived(createDocument({ source: appConfig.mode })),
    selectedId: null,
    multiSel: [],
    overlaps: new Set<string>(),
    activeLayer: 'TOP' as const,
    hideAllRefDes: false,
    past: [],
    future: [],

    addComponent: (r) =>
      set((s) => {
        snapshot(s);
        const placed = searchResultToPlaced(r, nextReference(r, s.doc.components));
        placed.placement.side = s.activeLayer;
        // 只与同层器件避让
        const sameLayer = s.doc.components.filter((c) => c.placement.side === s.activeLayer);
        const pos = solvePlacement(placed, { board: s.doc.board, existing: sameLayer, rules: DEFAULT_PLACEMENT_RULES });
        placed.placement.xMm = pos.x;
        placed.placement.yMm = pos.y;
        s.doc.components.push(placed);
        s.doc = touchDocument(refreshDerived(s.doc));
        s.overlaps = findOverlaps(s.doc.components);
      }),

    removeComponents: (ids) =>
      set((s) => {
        if (!ids.length) return;
        snapshot(s);
        const kill = new Set(ids);
        s.doc.components = s.doc.components.filter((c) => !kill.has(c.instanceId));
        s.multiSel = [];
        if (s.selectedId && kill.has(s.selectedId)) s.selectedId = null;
        s.doc = touchDocument(refreshDerived(s.doc));
        s.overlaps = findOverlaps(s.doc.components);
      }),

    setMultiSel: (ids) => set((s) => { s.multiSel = ids; }),

    autoArrange: () =>
      set((s) => {
        if (!s.doc.components.length) return;
        snapshot(s);
        s.doc.components = autoPlaceAll(s.doc.components, s.doc.board);
        s.doc = touchDocument(s.doc);
        s.overlaps = findOverlaps(s.doc.components);
      }),

    removeComponent: (id) =>
      set((s) => {
        snapshot(s);
        s.doc.components = s.doc.components.filter((c) => c.instanceId !== id);
        s.doc = touchDocument(refreshDerived(s.doc));
        s.selectedId = s.selectedId === id ? null : s.selectedId;
        s.overlaps = findOverlaps(s.doc.components);
      }),

    moveComponent: (id, xMm, yMm) =>
      set((s) => {
        const c = s.doc.components.find((x) => x.instanceId === id);
        if (!c) return;
        // 先夹紧到板内
        const trial = { ...c, placement: { ...c.placement, xMm, yMm } };
        const clamped = clampComponentToBoard(trial, s.doc.board);
        // 与其它同层器件保持 0.5mm 间距、避开定位孔；不满足则拒绝本次移动（停在障碍前）
        if (!isPositionFree(c, clamped.x, clamped.y, s.doc.components, s.doc.board)) return;
        c.placement.xMm = clamped.x;
        c.placement.yMm = clamped.y;
        s.overlaps = findOverlaps(s.doc.components);
      }),

    rotateComponent: (id) =>
      set((s) => {
        snapshot(s);
        const c = s.doc.components.find((x) => x.instanceId === id);
        if (!c) return;
        c.placement.rotation = (c.placement.rotation + (c.footprint.geometry.rotationStep || 90)) % 360;
        const clamped = clampComponentToBoard(c, s.doc.board);
        c.placement.xMm = clamped.x;
        c.placement.yMm = clamped.y;
        s.doc = touchDocument(s.doc);
        s.overlaps = findOverlaps(s.doc.components);
      }),

    setBoardSize: (w, h) =>
      set((s) => {
        s.doc.board.widthMm = w;
        s.doc.board.heightMm = h;
        s.doc = touchDocument(s.doc);
      }),

    setBoardCut: (cutW, cutH, cornerR) =>
      set((s) => {
        s.doc.board.cutWidthMm = Math.max(5, cutW);
        s.doc.board.cutHeightMm = Math.max(5, cutH);
        s.doc.board.cornerRadiusMm = Math.max(0, Math.min(15, cornerR));
        s.doc = touchDocument(s.doc);
      }),

    setBoardShape: (shape) =>
      set((s) => {
        s.doc.board.shape = shape;
        s.doc = touchDocument(s.doc);
      }),

    toggleMountingHoles: () =>
      set((s) => {
        s.doc.board.mountingHolesEnabled = !s.doc.board.mountingHolesEnabled;
        s.doc = touchDocument(s.doc);
        s.overlaps = findOverlaps(s.doc.components);
      }),

    setActiveLayer: (layer) => set((s) => { s.activeLayer = layer; }),

    flipComponentLayer: (id) =>
      set((s) => {
        snapshot(s);
        const c = s.doc.components.find((x) => x.instanceId === id);
        if (!c) return;
        c.placement.side = c.placement.side === 'TOP' ? 'BOTTOM' : 'TOP';
        // 换层 = 沿 Y 轴翻面：旋转取镜像（保持管脚排列正确）
        c.placement.rotation = (360 - c.placement.rotation) % 360;
        s.doc = touchDocument(s.doc);
        s.overlaps = findOverlaps(s.doc.components);
      }),

    moveRefDes: (id, dx, dy) =>
      set((s) => {
        const c = s.doc.components.find((x) => x.instanceId === id);
        if (!c) return;
        const cur = c.refDesDisplay ?? { dx: 0, dy: 0, rotation: 0, hidden: false };
        c.refDesDisplay = { ...cur, dx, dy };
      }),

    toggleRefDesHidden: (id) =>
      set((s) => {
        const c = s.doc.components.find((x) => x.instanceId === id);
        if (!c) return;
        const cur = c.refDesDisplay ?? { dx: 0, dy: 0, rotation: 0, hidden: false };
        c.refDesDisplay = { ...cur, hidden: !cur.hidden };
      }),

    toggleAllRefDes: () => set((s) => { s.hideAllRefDes = !s.hideAllRefDes; }),

    setComponentMpn: (id, mpn) =>
      set((s) => {
        const c = s.doc.components.find((x) => x.instanceId === id);
        if (!c || !mpn.trim()) return;
        snapshot(s);
        c.mpn = mpn.trim();
        s.doc = touchDocument(refreshDerived(s.doc));
      }),

    setCustomSymbol: (id, svg) =>
      set((s) => {
        const c = s.doc.components.find((x) => x.instanceId === id);
        if (!c) return;
        c.customSymbolSvg = svg;
        s.doc = touchDocument(s.doc);
      }),

    replaceComponentWith: (id, src) =>
      set((s) => {
        const c = s.doc.components.find((x) => x.instanceId === id);
        if (!c) return;
        snapshot(s);
        c.mpn = src.mpn;
        c.manufacturer = src.manufacturer;
        c.category = src.category;
        c.componentId = src.componentId;
        c.footprint = { ...c.footprint, name: src.defaultFootprintName };
        c.customSymbolSvg = undefined;
        c.display = {
          ...(c.display ?? {}),
          family: src.family,
          description: src.description,
          pins: src.pins,
          footprintFileUrl: src.footprintFileUrl,
          symbolFileUrl: src.symbolFileUrl,
          symbolFromMpn: undefined,
          stepUrl: src.stepUrl,
          datasheetUrl: src.datasheetUrl,
          officialUrl: src.productUrl,
        };
        s.doc = touchDocument(refreshDerived(s.doc));
      }),

    linkSymbolFrom: (id, src) =>
      set((s) => {
        const c = s.doc.components.find((x) => x.instanceId === id);
        if (!c) return;
        snapshot(s);
        c.display = { ...(c.display ?? {}), symbolFileUrl: src.symbolFileUrl, symbolFromMpn: src.mpn };
        c.customSymbolSvg = undefined; // 库符号优先于此前上传的 SVG
        s.doc = touchDocument(s.doc);
      }),

    setStepUrlByFootprint: (footprintName, stepUrl) =>
      set((s) => {
        let hit = false;
        for (const c of s.doc.components) {
          if (c.footprint.name !== footprintName || c.display?.stepUrl) continue;
          c.display = { ...(c.display ?? {}), stepUrl };
          hit = true;
        }
        if (hit) s.doc = touchDocument(s.doc);
      }),

    setSchematicSheet: (sheet) =>
      set((s) => {
        s.doc.schematicSheet = sheet;
        s.doc = touchDocument(s.doc);
      }),

    assignSymbolsByReference: (map) => {
      let hit = 0;
      set((s) => {
        for (const c of s.doc.components) {
          const key = map[c.reference];
          if (!key) continue;
          c.display = { ...(c.display ?? {}), symbolFromMpn: key };
          c.customSymbolSvg = undefined;
          hit++;
        }
        if (hit) s.doc = touchDocument(s.doc);
      });
      return hit;
    },

    linkFootprintByMpn: (mpn, src) =>
      set((s) => {
        snapshot(s);
        for (const c of s.doc.components) {
          if (c.mpn !== mpn) continue;
          c.footprint = { ...c.footprint, name: src.footprintName };
          c.display = { ...(c.display ?? {}), stepUrl: src.stepUrl ?? c.display?.stepUrl, pins: src.pins ?? c.display?.pins };
        }
        s.doc = touchDocument(refreshDerived(s.doc));
      }),

    linkSymbolByMpn: (mpn, symbolKey) =>
      set((s) => {
        snapshot(s);
        for (const c of s.doc.components) {
          if (c.mpn !== mpn) continue;
          c.display = { ...(c.display ?? {}), symbolFromMpn: symbolKey };
          c.customSymbolSvg = undefined;
        }
        s.doc = touchDocument(s.doc);
      }),

    linkFootprintFrom: (id, src) =>
      set((s) => {
        const c = s.doc.components.find((x) => x.instanceId === id);
        if (!c) return;
        snapshot(s);
        c.footprint = { ...c.footprint, name: src.footprintName };
        c.display = { ...(c.display ?? {}), footprintFileUrl: src.footprintFileUrl, stepUrl: src.stepUrl, pins: src.pins ?? c.display?.pins };

        s.doc = touchDocument(refreshDerived(s.doc));
      }),

    select: (id) => set((s) => { s.selectedId = id; }),
    toggleMulti: (id) =>
      set((s) => {
        s.multiSel = s.multiSel.includes(id) ? s.multiSel.filter((x) => x !== id) : [...s.multiSel, id];
      }),

    clearAll: () =>
      set((s) => {
        snapshot(s);
        s.doc.components = [];
        // 清画布 = 清整个设计上下文：框图、连接、导入的原理图原样视图一并清空
        s.doc.functionalBlocks = [];
        s.doc.connections = [];
        s.doc.schematicSheet = undefined;
        s.doc = touchDocument(refreshDerived(s.doc));
        s.selectedId = null;
        s.multiSel = [];
        s.overlaps = new Set();
        // 原理图编辑状态（位置/连线）同步复位
        import('../modules/schematic/schematicStore').then((m) => m.useSchematicStore.getState().reset()).catch(() => { /* 忽略 */ });
      }),

    placeScheme: (results, intent) =>
      set((s) => {
        snapshot(s);
        if (intent) s.doc.designIntent = { ...intent, generatedAt: new Date().toISOString() };
        let placed: PlacedComponent[] = [];
        for (const r of results) {
          const p = searchResultToPlaced(r, nextReference(r, placed));
          placed.push(p);
        }
        // 功能归属：辅件锚定核心（关键词+方案顺序），核心按信号流排队、辅件紧随其核心
        const affItems = placed.map((c) => ({ reference: c.reference, category: c.category, mpn: c.mpn, description: c.display?.description }));
        const aff = resolveAffinity(affItems);
        for (const c of placed) {
          const coreRef = aff[c.reference];
          if (coreRef) c.display = { ...(c.display ?? {}), anchorRef: coreRef };
        }
        const cores = placed.filter((c) => isCore(c)).sort((a, b) => signalFlowRank(a) - signalFlowRank(b));
        const ordered: PlacedComponent[] = [];
        for (const core of cores) {
          ordered.push(core);
          ordered.push(...placed.filter((c) => c.display?.anchorRef === core.reference));
        }
        for (const c of placed) if (!ordered.includes(c)) ordered.push(c);
        placed = autoPlaceAll(ordered, s.doc.board, DEFAULT_PLACEMENT_RULES);
        s.doc.components = placed;
        s.doc = touchDocument(refreshDerived(s.doc));
        s.overlaps = findOverlaps(s.doc.components);
      }),

    importKicad: (data) =>
      set((s) => {
        snapshot(s);
        s.doc.components = data.comps.map((k) => {
          const cat: ComponentCategory = /^U/.test(k.reference) ? 'ic' : /^(R|C|L|D|Y|FB)/.test(k.reference) ? 'passive' : /^(J|P|X|CN)/.test(k.reference) ? 'connector' : /^(VR|PS)/.test(k.reference) ? 'power' : 'ic';
          // 符号家族：位号/封装名推断（C→电容 R→电阻 L→电感 LED→LED D→二极管），原理图符号随之正确
          const family = /^C\d/.test(k.reference) ? 'MLCC'
            : /^R\d/.test(k.reference) ? 'Resistor'
            : /^L\d/.test(k.reference) ? 'Inductor'
            : /LED/i.test(k.footprintName) ? 'LED'
            : /^D\d/.test(k.reference) ? 'Diode'
            : 'KiCad导入';
          const mref = data.modelRefs?.[k.footprintName];
          const placed = searchResultToPlaced({
            componentId: `kicad_${k.reference}`,
            mpn: k.value,
            manufacturer: '—',
            category: cat,
            defaultFootprintName: k.footprintName,
            family,
            description: `KiCad 工程导入 · ${k.footprintName}`,
            pins: 2,
            // 内嵌 (model) 引用 → 拉取 KiCad 官方 3D（LFS 经代理解析）
            stepUrl: mref ? `/api/kicadlib?path=step&lib=${encodeURIComponent(mref.lib3d)}&name=${encodeURIComponent(mref.name3d)}` : undefined,
          } as ComponentSearchResult, k.reference);
          placed.placement = {
            ...placed.placement,
            xMm: k.xMm,
            yMm: k.yMm,
            rotation: k.rotation === 90 || k.rotation === 180 || k.rotation === 270 ? k.rotation : 0,
            side: k.layer === 'bottom' ? 'BOTTOM' : 'TOP',
          };
          return placed;
        });
        s.doc.board.widthMm = data.widthMm;
        s.doc.board.heightMm = data.heightMm;
        s.doc.board.shape = 'rect';
        s.doc.board.mountingHolesEnabled = data.hasMountingHoles;
        s.selectedId = null;
        s.multiSel = [];
        s.doc = touchDocument(refreshDerived(s.doc));
      }),

    loadDocument: (doc) =>
      set((s) => {
        snapshot(s);
        s.doc = refreshDerived(doc);
        s.selectedId = null;
        s.multiSel = [];
        s.overlaps = findOverlaps(doc.components);
      }),

    undo: () =>
      set((s) => {
        const prev = s.past.pop();
        if (!prev) return;
        s.future.push(JSON.parse(JSON.stringify(s.doc)));
        s.doc = prev;
        s.overlaps = findOverlaps(prev.components);
        s.selectedId = null;
      }),

    redo: () =>
      set((s) => {
        const next = s.future.pop();
        if (!next) return;
        s.past.push(JSON.parse(JSON.stringify(s.doc)));
        s.doc = next;
        s.overlaps = findOverlaps(next.components);
      }),

    recompute: () => set((s) => { s.doc = refreshDerived(s.doc); s.overlaps = findOverlaps(s.doc.components); }),

    setFunctionalBlocks: (blocks) => set((s) => { s.doc.functionalBlocks = blocks; }),
    setConnections: (conns) => set((s) => { s.doc.connections = conns; }),

    generateBlocksFromComponents: () =>
      set((s) => {
        // 按类别聚合生成功能块（一个类别一个块）；过滤无源辅助器件
        const byCat = new Map<string, typeof s.doc.components>();
        for (const c of s.doc.components) {
          if (c.category === 'passive') continue;
          const arr = byCat.get(c.category) ?? [];
          arr.push(c);
          byCat.set(c.category, arr);
        }
        const labels: Record<string, string> = { mcu: '主控', power: '电源', passive: '无源', connector: '接口', ic: '外设IC' };
        const colors: Record<string, string> = { mcu: '#1a6b3c', power: '#b45309', passive: '#4b5563', connector: '#6d28d9', ic: '#0e7490' };
        const prev = s.doc.functionalBlocks;
        // 用户手动添加的块（非 blk_<类别> 命名）原样保留
        const customBlocks = prev.filter((b) => !/^blk_(mcu|power|connector|ic|passive)$/.test(b.id));
        let i = 0;
        const autoBlocks = Array.from(byCat.entries()).map(([cat, comps]) => {
          const old = prev.find((b) => b.id === `blk_${cat}`);
          const b = {
            id: `blk_${cat}`,
            label: old?.label ?? (labels[cat] ?? cat),
            sublabel: comps.map((c) => c.reference).join(' '),
            shape: old?.shape ?? ('rounded' as const),
            // 已有同类块：保留用户调整过的位置/尺寸/颜色
            x: old?.x ?? 60 + (i % 3) * 200,
            y: old?.y ?? 40 + Math.floor(i / 3) * 130,
            w: old?.w ?? 150,
            h: old?.h ?? 70,
            color: old?.color ?? (colors[cat] ?? '#4b5563'),
            componentIds: comps.map((c) => c.instanceId),
          };
          i++;
          return b;
        });
        const blocks = [...autoBlocks, ...customBlocks];
        const ids = new Set(blocks.map((b) => b.id));
        // 自动连线：仅补充缺失的骨干连线；保留用户已有连线；清理指向已删除块的连线
        const conns = s.doc.connections.filter((c) => ids.has(c.fromId) && ids.has(c.toId));
        const has = (from: string, to: string) => conns.some((c) => (c.fromId === from && c.toId === to) || (c.fromId === to && c.toId === from));
        const mk = (from: string, to: string, label: string) => { if (ids.has(from) && ids.has(to) && !has(from, to)) conns.push({ id: `c_${from}_${to}`, fromId: from, toId: to, label, style: 'single' as const }); };
        mk('blk_power', 'blk_mcu', 'VCC');
        mk('blk_power', 'blk_ic', 'VCC');
        mk('blk_connector', 'blk_mcu', 'IO');
        mk('blk_mcu', 'blk_ic', 'BUS');
        s.doc.functionalBlocks = blocks;
        s.doc.connections = conns;
      }),
  }))
);
