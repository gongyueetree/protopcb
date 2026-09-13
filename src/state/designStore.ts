/**
 * state/designStore.ts
 * 设计状态管理 (Zustand + immer)。
 * 持有当前 CircuitCanvasDocument，提供器件增删改、撤销重做、放置等动作。
 * 编辑器状态(选中/缩放)与文档数据分离。
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { ComponentCategory, CircuitCanvasDocument, PlacedComponent, BoardShapeKind } from '../design-core/document/types';
import { createDocument, touchDocument , createBoard} from '../design-core/document/factory';
import type { ComponentSearchResult } from '../providers/types';
import { searchResultToPlaced, nextReference, buildBom, runDesignReview } from '../design-core/document/services';
import { resolveAffinity, signalFlowRank, isCore } from '../design-core/placement/affinity';
import { solvePlacementDetailed, DEFAULT_PLACEMENT_RULES, autoPlaceAllDetailed, type PlacementViolation } from '../design-core/placement';
import { DEFAULT_ENCLOSURE } from '../design-core/enclosure';
import { kicadPassiveDefaults } from '../design-core/geometry/kicad-passive-defaults';
import { clampComponentToBoard, findOverlaps, BOARD_MARGIN_MM } from '../design-core/collision';
import { appConfig } from '../config';

const HISTORY_LIMIT = 60;

interface DesignState {
  doc: CircuitCanvasDocument;
  // editor-only state
  selectedId: string | null;
  multiSel: string[];
  overlaps: Set<string>;
  /** 自动放置未找到合法位置的器件（instanceId → 违规明细）。UI 必须提示，禁止静默成功 */
  placementViolations: Record<string, PlacementViolation[]>;
  dismissPlacementViolations: () => void;
  /** iBOM 式网络高亮：当前选中的网络号（null = 未选）。2D 画布与连接关系视图共用 */
  selectedNet: number | null;
  selectNet: (net: number | null) => void;
  /** 外壳协同参数（部分更新） */
  setEnclosure: (patch: Partial<NonNullable<CircuitCanvasDocument['enclosure']>>) => void;
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
  /** 3D 高度偏移（mm） */
  setZOffset: (instanceId: string, zMm: number) => void;
  /** 拖动/连续操作开始前存快照（供撤回回到操作前的位置） */
  beginInteraction: () => void;
  /** 子电路一键上画布：辅件锚定核心器件、按管脚顺序围核心排布（不重叠，间距≥3mm） */
  /** 与该器件同组的全部器件实例 id（核心 + 其附属；传入附属件时返回它所属的整组） */
  groupMemberIds: (instanceId: string) => string[];
  /** 重新优化某核心器件的附属器件布局（保持"围绕核心"的语义，避开定位孔与其它器件） */
  reoptimizeGroup: (coreInstanceId: string) => { moved: number; violations: number };
  placeSubCircuit: (coreInstanceId: string, items: { role: string; value: string; mpn?: string; category: ComponentCategory; footprint: string; connectsTo: string; qty: number }[]) => number;
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
  setComponentMpn: (instanceId: string, mpn: string, manufacturer?: string) => void;
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
  renameDocument: (name: string) => void;
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
    placementViolations: {},
    selectedNet: null,
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
        // 器件比板大时先扩板：否则夹紧只能保证左上角在板内，主体会跑到画布外
        const gw = placed.footprint.geometry.courtyardWidthMm ?? placed.footprint.geometry.bodyWidthMm;
        const gh = placed.footprint.geometry.courtyardHeightMm ?? placed.footprint.geometry.bodyHeightMm;
        const need = (v: number) => Math.ceil(v + BOARD_MARGIN_MM * 2 + 2);
        if (gw > s.doc.board.widthMm - BOARD_MARGIN_MM * 2) s.doc.board.widthMm = need(gw);
        if (gh > s.doc.board.heightMm - BOARD_MARGIN_MM * 2) s.doc.board.heightMm = need(gh);

        // Detailed 求解：success=false 时仍以"最不坏"位置放下，但违规明确入 state 提示用户
        const out = solvePlacementDetailed(placed, { board: s.doc.board, existing: sameLayer, rules: DEFAULT_PLACEMENT_RULES });
        placed.placement.xMm = out.position.x;
        placed.placement.yMm = out.position.y;
        // 兜底：确保主体完整落在板内（clamp 用真实 courtyard）
        const fixed = clampComponentToBoard(placed, s.doc.board);
        placed.placement.xMm = fixed.x;
        placed.placement.yMm = fixed.y;
        if (!out.success) s.placementViolations[placed.instanceId] = out.violations;
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

    dismissPlacementViolations: () => set((s) => { s.placementViolations = {}; }),

    selectNet: (net) => set((s) => { s.selectedNet = net === 0 ? null : net; }),   // net 0 = 未连接，不高亮

    setEnclosure: (patch) =>
      set((s) => {
        s.doc.enclosure = { ...DEFAULT_ENCLOSURE, ...(s.doc.enclosure ?? {}), ...patch };
        s.doc = touchDocument(s.doc);
      }),

    autoArrange: () =>
      set((s) => {
        if (!s.doc.components.length) return;
        snapshot(s);
        const arr = autoPlaceAllDetailed(s.doc.components, s.doc.board);
        s.doc.components = arr.placed;
        s.placementViolations = arr.violations;   // 空对象 = 全部合法
        s.doc = touchDocument(s.doc);
        s.overlaps = findOverlaps(s.doc.components);
      }),

    removeComponent: (id) =>
      set((s) => {
        snapshot(s);
        // 删除核心器件时，其子电路附属器件一并删除（留下孤立的去耦电容没有意义）
        const me = s.doc.components.find((c) => c.instanceId === id);
        const satRefs = me ? new Set(s.doc.components.filter((c) => c.display?.anchorRef === me.reference).map((c) => c.instanceId)) : new Set<string>();
        s.doc.components = s.doc.components.filter((c) => c.instanceId !== id && !satRefs.has(c.instanceId));
        s.doc = touchDocument(refreshDerived(s.doc));
        s.selectedId = s.selectedId === id ? null : s.selectedId;
        s.overlaps = findOverlaps(s.doc.components);
      }),

    placeSubCircuit: (coreInstanceId, items) => {
      let placedCount = 0;
      set((s) => {
        const core = s.doc.components.find((c) => c.instanceId === coreInstanceId);
        if (!core) return;
        snapshot(s);
        // 按连接管脚名排序（同脚聚在一起 → 围核心时相邻）
        const flat: typeof items = [];
        for (const it of [...items].sort((a, b) => a.connectsTo.localeCompare(b.connectsTo))) {
          for (let i = 0; i < it.qty; i++) flat.push(it);
        }
        for (const it of flat) {
          // 推荐出来的附属器件同样统一到 KiCad 官方符号/封装
          const pv = kicadPassiveDefaults('', it.mpn ?? it.value, it.role, it.footprint);
          const fpName = pv?.footprint ?? it.footprint;
          const placed = searchResultToPlaced({
            componentId: `sub_${core.reference}_${it.role}`.replace(/[^\w-]/g, '_') + '_' + placedCount,
            mpn: it.mpn ?? it.value,
            manufacturer: '—',
            category: it.category,
            defaultFootprintName: fpName,
            family: /^C_/.test(it.footprint) ? 'MLCC' : /^R_/.test(it.footprint) ? 'Resistor' : /^L_/.test(it.footprint) ? 'Inductor' : /^LED/.test(it.footprint) ? 'LED' : /^D_/.test(it.footprint) ? 'Diode' : /Crystal/i.test(it.footprint) ? 'Crystal' : '子电路',
            description: `${it.role} · 接 ${core.reference}.${it.connectsTo}`,
            pins: 2,
          } as ComponentSearchResult, nextReference({ category: it.category, mpn: it.mpn ?? it.value, defaultFootprintName: it.footprint, description: it.role }, s.doc.components));
          placed.placement.side = core.placement.side;
          placed.display = { ...(placed.display ?? {}), anchorRef: core.reference, ...(pv ? { symbolFromMpn: pv.symbol } : {}) };
          const sameLayer = s.doc.components.filter((c) => c.placement.side === core.placement.side);
          const out = solvePlacementDetailed(placed, { board: s.doc.board, existing: sameLayer, rules: DEFAULT_PLACEMENT_RULES });
          placed.placement.xMm = out.position.x;
          placed.placement.yMm = out.position.y;
          if (!out.success) s.placementViolations[placed.instanceId] = out.violations;
          s.doc.components.push(placed);
          placedCount++;
        }
        s.doc = touchDocument(refreshDerived(s.doc));
      });
      return placedCount;
    },

    groupMemberIds: (instanceId) => {
      const doc = _get().doc;
      const me = doc.components.find((c) => c.instanceId === instanceId);
      if (!me) return [];
      // 传入的是附属件 → 找到它的核心；传入核心 → 就是自己
      const coreRef = me.display?.anchorRef ?? me.reference;
      const core = doc.components.find((c) => c.reference === coreRef);
      const sats = doc.components.filter((c) => c.display?.anchorRef === coreRef);
      if (!sats.length) return [instanceId];
      return [...(core ? [core.instanceId] : []), ...sats.map((c) => c.instanceId)];
    },

    reoptimizeGroup: (coreInstanceId) => {
      let moved = 0, violations = 0;
      set((s) => {
        const core = s.doc.components.find((c) => c.instanceId === coreInstanceId);
        if (!core) return;
        const sats = s.doc.components.filter((c) => c.display?.anchorRef === core.reference);
        if (!sats.length) return;
        snapshot(s);
        // 参与避让的"既有器件"：本组之外的全部同层器件（定位孔由求解器自身规则处理）
        const others = s.doc.components.filter((c) =>
          c.placement.side === core.placement.side
          && c.instanceId !== core.instanceId
          && !sats.some((x) => x.instanceId === c.instanceId));
        const placedSoFar = [...others, core];
        for (const sat of sats) {
          const out = solvePlacementDetailed(sat, { board: s.doc.board, existing: placedSoFar, rules: DEFAULT_PLACEMENT_RULES });
          sat.placement.xMm = out.position.x;
          sat.placement.yMm = out.position.y;
          if (!out.success) { s.placementViolations[sat.instanceId] = out.violations; violations++; }
          else delete s.placementViolations[sat.instanceId];
          placedSoFar.push({ ...sat });
          moved++;
        }
        s.doc = touchDocument(refreshDerived(s.doc));
        s.overlaps = findOverlaps(s.doc.components);
      });
      return { moved, violations };
    },

    beginInteraction: () => set((s) => { snapshot(s); }),

    setZOffset: (instanceId, zMm) =>
      set((s) => {
        const c = s.doc.components.find((x) => x.instanceId === instanceId);
        if (!c) return;
        c.display = { ...(c.display ?? {}), zOffsetMm: Math.max(-5, Math.min(30, zMm)) };
        s.doc = touchDocument(s.doc);
      }),

    moveComponent: (id, xMm, yMm) =>
      set((s) => {
        const c = s.doc.components.find((x) => x.instanceId === id);
        if (!c) return;
        // 先夹紧到板内
        const trial = { ...c, placement: { ...c.placement, xMm, yMm } };
        const clamped = clampComponentToBoard(trial, s.doc.board);
        // 附属器件跟随核心整体平移（保持相对关系），并各自夹紧在板内
        const dx = clamped.x - c.placement.xMm, dy = clamped.y - c.placement.yMm;
        if (dx || dy) {
          for (const sat of s.doc.components) {
            if (sat.display?.anchorRef !== c.reference) continue;
            const t = { ...sat, placement: { ...sat.placement, xMm: sat.placement.xMm + dx, yMm: sat.placement.yMm + dy } };
            const cl = clampComponentToBoard(t, s.doc.board);
            sat.placement.xMm = cl.x;
            sat.placement.yMm = cl.y;
          }
        }
        // 允许自由移动（密集板上处处违反间距会导致完全拖不动）；重叠以红色高亮提示而非阻止
        c.placement.xMm = clamped.x;
        c.placement.yMm = clamped.y;
        // 用户手动挪过 = 已知情处理该器件的自动放置违规
        if (s.placementViolations[id]) delete s.placementViolations[id];
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

    setComponentMpn: (id, mpn, manufacturer) =>
      set((s) => {
        const c = s.doc.components.find((x) => x.instanceId === id);
        if (!c || !mpn.trim()) return;
        snapshot(s);
        c.mpn = mpn.trim();
        if (manufacturer?.trim()) c.manufacturer = manufacturer.trim();
        // 用户手工指定的型号：证据是"用户确认"，不是数据库精确匹配 —— 不标 VERIFIED
        c.trust = {
          level: 'CANDIDATE',
          evidence: '用户从智能匹配候选中手工选定，未经器件库精确匹配核验',
          source: 'ezplm-candidate',
          verifiedAt: new Date().toISOString(),
        };
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

    renameDocument: (name) =>
      set((s) => {
        s.doc.name = name.trim() || s.doc.name;
        s.doc = touchDocument(s.doc);
      }),

    clearAll: () =>
      set((s) => {
        snapshot(s);
        s.doc.components = [];
        // 清画布 = 清整个设计上下文：框图、连接、导入原理图、AI 方案意图、板框尺寸一并复位
        s.doc.functionalBlocks = [];
        s.doc.connections = [];
        s.doc.schematicSheet = undefined;
        s.doc.tracks = undefined;         // 导入的铜箔走线/过孔一并清除
        s.doc.vias = undefined;
        s.doc.nets = undefined;
        s.doc.designIntent = undefined;   // 方案报告不再带入清除前的 AI 方案
        s.doc.reviewResults = [];
        s.doc.board = createBoard();      // 板框长宽/形状回默认
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
        const placed: PlacedComponent[] = [];
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
        const schemeOut = autoPlaceAllDetailed(ordered, s.doc.board, DEFAULT_PLACEMENT_RULES);
        s.doc.components = schemeOut.placed;
        s.placementViolations = schemeOut.violations;
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
          if (k.padNets) placed.display = { ...(placed.display ?? {}), padNets: k.padNets };
          placed.placement = {
            ...placed.placement,
            xMm: k.xMm,
            yMm: k.yMm,
            // 保留任意角度（KiCad 支持 0.1° 精度）；此前非 90/180/270 一律归零导致器件朝向错乱
            rotation: ((k.rotation % 360) + 360) % 360,
            side: k.layer === 'bottom' ? 'BOTTOM' : 'TOP',
          };
          return placed;
        });
        s.doc.nets = Object.fromEntries(Object.entries(data.nets ?? {}).map(([k, v]) => [k, String(v)]));
        s.doc.copperLayers = data.copperLayers?.length ? data.copperLayers : ['F.Cu', 'B.Cu'];
        s.doc.tracks = (data.tracks ?? []).slice(0, 4000);
        s.doc.vias = (data.vias ?? []).slice(0, 1500);
        s.doc.board.widthMm = data.widthMm;
        s.doc.board.heightMm = data.heightMm;
        s.doc.board.shape = 'rect';
        s.doc.board.mountingHolesEnabled = data.hasMountingHoles;
        // 真实定位孔坐标（此前一律按板四角推算，与原设计不符）
        s.doc.board.mountingHoles = (data.mountingHoles ?? []).map((h) => ({ position: { x: h.x, y: h.y }, diameterMm: h.d }));
        s.selectedId = null;
        s.multiSel = [];
        s.doc = touchDocument(refreshDerived(s.doc));
        // 导入后同步重叠状态：此前漏了这一句，store 里一直是导入前的旧值，
        // 而流程条/审查页各自现算，两处对不上
        s.overlaps = findOverlaps(s.doc.components);
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
