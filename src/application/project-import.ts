/**
 * application/project-import.ts — ProjectImportService
 * KiCad / JSON 工程导入的唯一入口（从 App.tsx 抽出）：
 *   zip（多页层级原理图 + PCB + 工程自带 STEP 绑定）、.kicad_pcb、.kicad_sch、KiCad 5 .sch/.lib、设计 JSON。
 * 只依赖 Domain 解析器、store 与 dialog 服务；不持有 React 状态。
 */
import { useDesignStore } from '../state/designStore';
import { tr } from '../shared/i18n';
import { parseKicadPcb } from '../design-core/geometry/kicad-pcb-import';
import { parseKicadSch } from '../design-core/geometry/kicad-sch-import';
import { parseLegacySch, isLegacySch } from '../design-core/geometry/kicad-sch-legacy';
import { parseLegacyLib, legacyToParsedSymbol } from '../design-core/geometry/kicad-lib-legacy';
import { safeUnzipOffThread } from '../design-core/geometry/safe-unzip-worker';

import { registerSymbolOverride, parseKicadSym } from '../design-core/geometry/lib-file-registry';
import { ZipSafetyError } from '../design-core/geometry/safe-unzip';
import { keyOf } from '../shared/storage';
import { importDocumentFromFile } from '../design-core/document/persistence-service';
import { registerModelBlob, revokeAllModelBlobs } from '../infrastructure/model-assets';
import type { SchematicSheetData } from '../design-core/document/types';

/**
 * 导入结果。application 层只**返回**发生了什么，由 UI 决定怎么提示 ——
 * 此前这里直接调 modules/ui/dialogStore，是 application → UI 的反向依赖。
 */
export type ImportKind = 'zip' | 'pcb' | 'schematic' | 'legacy-schematic' | 'json';
export interface ImportNotice { level: 'success' | 'warning' | 'error'; text: string }
export interface ImportResult {
  kind: ImportKind;
  pcbComponents?: number;
  skipped?: number;
  schematicSheets?: number;
  linkedSymbols?: number;
  extractedSymbols?: number;
  projectModels?: number;
  notices: ImportNotice[];
}

/** KiCad 水平对齐 → SVG textAnchor */
const JUST = { L: 'start', C: 'middle', R: 'end' } as const;

/** 解析期产生的告警，由 importProjectFile 汇总进 notices */
const pendingWarnings: string[] = [];

export const importPcbText = (text: string): { comps: number; skipped: number; projectModelPaths: Record<string, string> } => {
  const data = parseKicadPcb(text);
  // 注册 PCB 内嵌封装定义 → 导入器件焊盘精确、3D 按真实焊盘构建
  // PROJECT 层的注册由 store 的 importKicad 统一做（与 doc.importedFootprints 同步），这里不再单独注册
  useDesignStore.getState().importKicad(data);
  // 同名封装但几何不同：保留了首次出现的定义，其余实例如实告知，不静默丢信息
  for (const c of data.footprintConflicts ?? []) {
    pendingWarnings.push(`${tr('封装几何冲突')}：${c.footprintName}（${c.references.join('、')} ${tr('的焊盘与首个实例不同，已按首个实例渲染')}）`);
  }
  return { comps: data.comps.length, skipped: data.skipped.length, projectModelPaths: data.projectModelPaths };
};

/** KiCad 5 旧版 .sch：无内嵌符号定义，仅提取实例/连线/标签用于原样视图 */

/** KiCad 水平对齐 → SVG textAnchor */

export const applyLegacySch = (text: string, libText?: string): { symbols: number; linked: number } => {
  const r = parseLegacySch(text);
  // 旧工程的符号图形在 -cache.lib 中；不解析它原理图就只有连线没有器件
  const legacySymbols = libText ? parseLegacyLib(libText) : {};
  // 工程自带符号按位号注册：库中找不到型号符号时，右侧详情回落显示"工程原图里的那个符号"
  for (const cp of r.comps) {
    const g = legacySymbols[cp.libId.replace(':', '_')] ?? legacySymbols[cp.libId];
    if (g) registerSymbolOverride(`PRJSYM:${cp.ref}`, legacyToParsedSymbol(g));
  }
  useDesignStore.getState().setSchematicSheets({ 'legacy.sch': {
    // 位号/值按 .sch 里的绝对字段位置渲染（此前固定画在符号上下，会压在连线上）
    instances: r.comps.map((c) => ({
      ref: c.ref, libId: c.libId, value: c.value, x: c.x, y: c.y, rot: c.rot, mirror: c.mirror, unit: c.unit, mat: c.mat,
      refPos: c.refField ? { x: c.refField.x, y: c.refField.y, rot: c.refField.vertical ? 90 : 0, hidden: false, sizeMm: c.refField.sizeMm, anchor: JUST[c.refField.just] } : undefined,
      valPos: c.valueField ? { x: c.valueField.x, y: c.valueField.y, rot: c.valueField.vertical ? 90 : 0, hidden: false, sizeMm: c.valueField.sizeMm, anchor: JUST[c.valueField.just] } : undefined,
    })),
    wires: r.wires,
    buses: r.buses,
    busEntries: r.busEntries,
    junctions: r.junctions,
    labels: r.labels,
    noConnects: r.noConnects,
    libSymbols: {},
    legacySymbols,
    frame: r.sheet,
  } }, 'legacy.sch');
  return { symbols: Object.keys(legacySymbols).length, linked: 0 };
};

/** 从 .kicad_sch 文本提取内嵌符号并按位号挂到已导入器件（原理图区随即显示真符号） */
export const applySchText = (text: string, fileName = 'schematic.kicad_sch', collectOnly = false): { symbols: number; linked: number; sheet: SchematicSheetData } => {
  const sch = parseKicadSch(text);
  let symbols = 0;
  const refKeyMap: Record<string, string> = {};
  for (const [libId, block] of Object.entries(sch.libSymbols)) {
    const parsed = parseKicadSym(`(kicad_symbol_lib ${block})`);
    if (!parsed || !parsed.pins.length) continue;
    const key = `KICADSCH:${libId}`;
    registerSymbolOverride(key, parsed);
    try { localStorage.setItem(keyOf.ksym(key), `(kicad_symbol_lib ${block})`); } catch { /* 空间不足忽略 */ }
    symbols++;
    for (const [ref, lid] of Object.entries(sch.refToLibId)) if (lid === libId) refKeyMap[ref] = key;
  }
  const linked = useDesignStore.getState().assignSymbolsByReference(refKeyMap);
  const sheet: SchematicSheetData = {
    instances: sch.instances,
    wires: sch.wires,
    junctions: sch.junctions,
    labels: sch.labels,
    noConnects: sch.noConnects,
    libSymbols: sch.libSymbols,
    buses: sch.buses,
    busEntries: sch.busEntries,
    frame: sch.frame,
    sheets: sch.sheets,
    file: fileName,
  };
  // 单文件导入：直接作为当前页；zip 多页由调用方汇总后用 setSchematicSheets 写入
  if (!collectOnly) useDesignStore.getState().setSchematicSheets({ [fileName]: sheet }, fileName);
  return { symbols, linked, sheet };
};

/** 统一入口：按文件类型分派到 zip / pcb / sch / legacy / JSON */
export const importProjectFile = async (f: File): Promise<ImportResult> => {
  const notices: ImportNotice[] = [];
  pendingWarnings.length = 0;
  let result: ImportResult | undefined;
  try {
    if (/\.zip$/i.test(f.name)) {
      // KiCad 工程压缩包：解压 → PCB 上画布 + 原理图符号逐器件挂载
      const { strFromU8 } = await import('fflate');
      // 安全解压：中央目录预检（inflate 前拒绝炸弹）+ zip-slip + 压缩比检查；
      // 解压在 Web Worker 内进行，30~60MB 工程不再卡死 UI 线程
      const entries = await safeUnzipOffThread(new Uint8Array(await f.arrayBuffer()));
      const names = Object.keys(entries).filter((n) => !n.startsWith('__MACOSX') && !n.endsWith('/'));
      const pcbName = names.filter((n) => /\.kicad_pcb$/i.test(n)).sort((a, b) => entries[b].length - entries[a].length)[0];
      const schNames = names.filter((n) => /\.kicad_sch$/i.test(n));
      const legacySchNames = names.filter((n) => /\.sch$/i.test(n) && !/\.kicad_sch$/i.test(n));
      if (!pcbName) throw new Error(tr('压缩包内未找到 .kicad_pcb 文件'));
      const r = importPcbText(strFromU8(entries[pcbName]));
      // 工程自带的 3D 模型：.kicad_pcb 里 (model "${KIPRJMOD}/3D/xxx.step") 这类引用，
      // 包内有对应文件就按文件名匹配并注册（官方库里没有的按键、弯针连接器靠的就是它）
      let projModels = 0;
      // 上一次导入登记的 blob 全部撤销（否则每次导入都是一批新泄漏）
      revokeAllModelBlobs();
      if (r.projectModelPaths) {
        const stepFiles = names.filter((n) => /\.(step|stp)$/i.test(n));
        const base = (p: string) => p.split(/[\\/]/).pop()!.toLowerCase();
        for (const [fpName, mpath] of Object.entries(r.projectModelPaths)) {
          const hit = stepFiles.find((n) => base(n) === base(mpath));
          if (!hit) continue;
          const url = registerModelBlob(fpName, entries[hit]);
          useDesignStore.getState().setStepUrlByFootprint(fpName, url);
          projModels++;
        }
      }
      let symTotal = 0, linkTotal = 0;
      // 多页层级工程：全部页面都解析，按文件名归档；根页 = 有子页引用但不被任何页引用的那张
      const sheets: Record<string, SchematicSheetData> = {};
      const referenced = new Set<string>();
      for (const sn of schNames) {
        const base = sn.split('/').pop()!;
        const rr = applySchText(strFromU8(entries[sn]), base, true);
        symTotal += rr.symbols; linkTotal += rr.linked;
        sheets[base] = rr.sheet;
        for (const sub of rr.sheet.sheets ?? []) referenced.add(sub.file.split('/').pop()!);
      }
      // 子页名字：父页的 Sheetname 属性才是人读的名字（文件名可能被多次复用，如 Scope AFE1/2 共用 scope_afe）
      for (const sh of Object.values(sheets)) for (const sub of sh.sheets ?? []) {
        const target = sheets[sub.file.split('/').pop()!];
        if (target && !target.name) target.name = sub.name;
      }
      const rootFile = Object.keys(sheets).find((f) => !referenced.has(f) && (sheets[f].sheets?.length ?? 0) > 0)
        ?? Object.keys(sheets).sort((a, b) => sheets[b].instances.length - sheets[a].instances.length)[0];
      if (rootFile) { sheets[rootFile].name = sheets[rootFile].name || tr('根页'); useDesignStore.getState().setSchematicSheets(sheets, rootFile); }
      // KiCad 5 旧格式：取器件最多的那张作为主图（老工程常为多页层级图）
      if (!schNames.length && legacySchNames.length) {
        const best = legacySchNames
          .map((n) => ({ n, txt: strFromU8(entries[n]) }))
          .filter((x) => isLegacySch(x.txt))
          .sort((a, b) => (b.txt.match(/^\$Comp/gm)?.length ?? 0) - (a.txt.match(/^\$Comp/gm)?.length ?? 0))[0];
        if (best) {
          const libName = names.find((n) => /-cache\.lib$/i.test(n)) ?? names.find((n) => /\.lib$/i.test(n));
          applyLegacySch(best.txt, libName ? strFromU8(entries[libName]) : undefined);
        }
      }
        notices.push({ level: 'success', text: `${tr('工程导入完成')}：PCB ${r.comps} ${tr('个器件')}${r.skipped ? `（${r.skipped} ${tr('个跳过')}）` : ''}${projModels ? ` · ${projModels} ${tr('个工程自带 3D 模型已关联')}` : ''}${symTotal ? ` · ${tr('原理图')} ${symTotal} ${tr('个符号')}，${linkTotal} ${tr('个已挂载')}` : ''}` });
        result = { kind: 'zip', pcbComponents: r.comps, skipped: r.skipped, schematicSheets: Object.keys(sheets).length, linkedSymbols: linkTotal, extractedSymbols: symTotal, projectModels: projModels, notices };
    } else if (/\.kicad_pcb$/i.test(f.name)) {
      const r = importPcbText(await f.text());
      if (r.skipped) notices.push({ level: 'warning', text: `${tr('已导入')} ${r.comps} ${tr('个器件')}；${r.skipped} ${tr('个封装缺少位置信息被跳过')}` });
      result = { kind: 'pcb', pcbComponents: r.comps, skipped: r.skipped, notices };
    } else if (/\.sch$/i.test(f.name) && !/\.kicad_sch$/i.test(f.name)) {
      const txt = await f.text();
      if (!isLegacySch(txt)) throw new Error(tr('无法识别的原理图格式'));
      applyLegacySch(txt);
        notices.push({ level: 'success', text: tr('已载入 KiCad 5 旧版原理图（原样视图）') });
        result = { kind: 'legacy-schematic', notices };
    } else if (/\.kicad_sch$/i.test(f.name)) {
      // 单独补挂原理图（画布已有对应位号的器件时）
      const rr = applySchText(await f.text());
        notices.push({ level: 'success', text: `${tr('原理图符号提取完成')}：${rr.symbols} ${tr('个符号')}，${rr.linked} ${tr('个器件已挂载')}` });
        result = { kind: 'schematic', extractedSymbols: rr.symbols, linkedSymbols: rr.linked, notices };
    } else {
      const loaded = await importDocumentFromFile(f);
      useDesignStore.getState().loadDocument(loaded);
      notices.push({ level: 'success', text: `${tr('设计文件导入完成')}：${loaded.components.length} ${tr('个器件')}` });
      result = { kind: 'json', notices };
    }
  } catch (err) {
    // ZIP 安全限额的报错文案已面向用户，直接展示；其余带上原始信息便于排查
    const msg = err instanceof ZipSafetyError ? err.message : (err as Error).message;
    notices.push({ level: 'error', text: tr('导入失败：') + msg });
    return { kind: result?.kind ?? 'json', notices };
  }
  for (const w of pendingWarnings) notices.push({ level: 'warning', text: w });
  return result ?? { kind: 'json', notices };
};
