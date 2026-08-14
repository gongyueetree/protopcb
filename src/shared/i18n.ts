/**
 * shared/i18n.ts — 中英双语
 *
 * 两层机制：
 * 1) 界面固定文案：内置词典（以中文原文为 key），切换即时、零网络
 * 2) ezPLM 动态内容（器件描述/分类/参数名等中文数据）：英文模式下经 Gemini
 *    批量翻译（300ms 合批 + 会话/localStorage 双缓存，同一文案只翻一次）
 */
import { create } from 'zustand';
import { useEffect, useState } from 'react';
import { geminiComplete, extractJson, geminiAvailable } from '../providers/gemini';

export type Lang = 'zh' | 'en';

interface LangState {
  lang: Lang;
  toggle: () => void;
  setLang: (l: Lang) => void;
}

export const useLangStore = create<LangState>((set) => ({
  lang: (localStorage.getItem('cc_lang') as Lang) || 'zh',
  toggle: () => set((s) => {
    const lang: Lang = s.lang === 'zh' ? 'en' : 'zh';
    localStorage.setItem('cc_lang', lang);
    return { lang };
  }),
  setLang: (lang) => { localStorage.setItem('cc_lang', lang); set({ lang }); },
}));

/* ───────────── 固定文案词典（key = 中文原文） ───────────── */
const DICT: Record<string, string> = {
  '项目名称': 'Project name', '点击修改项目名称': 'Click to rename project',
  '请为该工程命名（将作为导出文件名）': 'Name this project (used as the export filename)',
  '我的硬件方案': 'My Hardware Design', '演示·估价': 'demo estimate',
  '跨库搜索封装名，如 SOIC-8 / 0402 / USB_C': 'Search all libs, e.g. SOIC-8 / 0402 / USB_C',
  '跨库搜索符号，如 STM32F103 / LED': 'Search all symbol libs, e.g. STM32F103 / LED',
  '跨库搜索封装，如 0402 / SOIC-8 / USB_C': 'Search all footprint libs, e.g. 0402 / SOIC-8 / USB_C',
  '搜索结果': 'Results', '未搜到，可换关键词或按库浏览': 'No match — try other keywords or browse by library',
  '加载封装库列表…': 'Loading footprint libraries…',
  '筛选封装名…': 'Filter footprints…', '加载封装…': 'Loading footprint…',
  '封装解析失败（无焊盘）': 'Footprint parse failed (no pads)', '已关联封装': 'Footprint linked',
  '（同型号器件已一并更新）': ' (all parts with same MPN updated)', '关联失败': 'Link failed', '封装列表加载失败': 'Failed to load footprint list',
  '按型号词干与封装找到的近似料，点击选用：': 'Close matches by MPN stem & footprint — click to use:',
  'KiCad 原图': 'KiCad Original', '自动生成': 'Auto Layout',
  '压缩包内未找到 .kicad_pcb 文件': 'No .kicad_pcb found in the zip',
  '工程导入完成': 'Project imported', '个跳过': 'skipped', '张': 'sheet(s)', '个符号': 'symbol(s)',
  '个器件已挂真符号': 'component(s) linked to real symbols', '包内无原理图，符号用名字解析': 'no schematic in zip — symbols by name parsing',
  '原理图符号提取完成': 'Schematic symbols extracted', '个器件已挂载': 'component(s) linked',
  '诊断符号链路': 'Diagnose symbol chain',
  '加载符号…': 'Loading symbol…', '解析成功但 0 管脚': 'parsed but 0 pins', '格式无法解析': 'unparseable format', '开头': 'head',
  '加载符号库列表…': 'Loading symbol libraries…', '可稍后重试': 'retry later',
  '已选中': 'Selected', '拖动任一可整组移动 · Delete 删除': 'drag any to move group · Delete to remove',
  'R 旋转 · L 换层 · Delete 删除 · Shift+拖拽框选 · 拖位号可移动': 'R rotate · L flip · Delete remove · Shift+drag to box-select · drag refdes to move',
  '当前仅搜索：': 'Searching only: ', '一键搜索全部分类': 'Search all categories',
  '确定清空画布？将移除': 'Clear the canvas? This removes', '个器件（可用「撤销」恢复）': 'component(s) (Undo can restore)',
  '请先输入需求描述，如：USB转串口调试器': 'Describe your requirement first, e.g. USB-UART debugger',
  '输入需求后生成方案': 'Enter a requirement to generate',
  '官方 3D 库未收录该封装 · 参数化预览': 'No official 3D model for this footprint · parametric preview',
  'STEP 失败': 'STEP failed', '参数化预览': 'parametric preview', 'STEP 源文件': 'STEP source file',
  'KiCad封装库': 'KiCad Footprints', '尚未关联原理图符号': 'No schematic symbol linked yet',
  '用上方「从 ezPLM 库关联」/「KiCad 符号库」/「创建」赋予真实符号': 'Link one via ezPLM / KiCad symbol library / Create above',
  'KiCad 官方符号库': 'KiCad Official Symbol Libraries', '选择符号库…': 'Select a symbol library…', '筛选符号名…': 'Filter symbols…',
  '符号解析失败': 'symbol parse failed', '已关联符号': 'symbol linked:',
  '输入型号/关键词检索 ezPLM 实时库；通用封装请用「KiCad封装库」tab': 'Search the ezPLM live library by MPN/keyword; for generic footprints use the KiCad Footprints tab',
  'KiCad 官方封装库': 'KiCad Official Footprint Libraries',
  '来源 gitlab.com/kicad/libraries · 按需拉取封装与 3D，不占本地空间': 'From gitlab.com/kicad/libraries · footprints & 3D fetched on demand',
  '加载库列表…': 'Loading libraries…', '选择封装库…': 'Select a library…', '在库内筛选封装名…': 'Filter footprints in library…',
  '加载封装列表…': 'Loading footprints…', '仅显示前 200 个，请用筛选缩小范围': 'Showing first 200 — filter to narrow down',
  '网络错误，无法访问 KiCad 官方库': 'Network error — cannot reach KiCad libraries', '封装解析失败': 'footprint parse failed', '添加失败：': 'Add failed: ',
  '自动整理': 'Auto Arrange', '按电气规则重新自动布局全部器件（可撤销）': 'Re-layout all parts by electrical rules (undoable)',
  '已自动保存': 'Auto-saved', '设计已自动保存在本浏览器（localStorage），导出设计可得到可分享的 JSON 文件': 'Design auto-saves in this browser (localStorage); use Export for a shareable JSON file',
  '勾选后确认时跳过电阻/电容/电感等无源器件': 'When checked, passives (R/C/L) are skipped on confirm',
  '已开启': 'ON', '矩形': 'Rectangle', '方形': 'Square', '圆形': 'Circle', 'L形': 'L-shape',
  '板宽 (mm)': 'Board width (mm)', '板高 (mm)': 'Board height (mm)',
  '网络或服务异常，请稍后重试；若持续失败请检查 Vercel 的 EZPLM_API_KEY 配置': 'Network/service error — retry later; if persistent, check EZPLM_API_KEY in Vercel',
  '演示目录未收录该型号 —— 配置 EZPLM_API_KEY 接入实时库，或用「定制模块」自行创建': 'Not in demo catalog — set EZPLM_API_KEY for the live library, or build it in Custom Parts',
  'ezPLM 库未收录该型号 —— 可换关键词，或用「定制模块」上传 datasheet 创建': 'Not found in ezPLM — try other keywords, or create it in Custom Parts from a datasheet',
  '画布上已有该型号，可重复添加': 'Already on canvas — add again for another instance',
  // ── 顾问面板 / 3D 视图 ──
  '系统补全建议': 'System Completeness', '子电路推荐': 'Sub-circuit Recs', 'PCB设计规格': 'PCB Design Specs', '设计风险': 'Design Risks',
  '添加器件后，AI 分析系统还缺什么': 'Add parts — AI analyzes what the system still needs',
  '添加器件后推荐配套子电路': 'Sub-circuit recommendations appear after adding parts',
  '分析中...': 'Analyzing...', '当前构成已较完整 ✓': 'System looks complete ✓', '添加': 'Add', '上板': 'Place',
  '由 Gemini 基于画布器件实时生成': 'Generated live by Gemini from canvas parts',
  '规则引擎基于画布器件动态生成（在 Vercel 配置 GEMINI_API_KEY 后由 Gemini 生成）': 'Rule engine (set GEMINI_API_KEY in Vercel for Gemini)',
  '层数': 'Layers', '层': 'L', '板厚': 'Thickness', '铜厚': 'Copper', '线宽/距': 'Trace/Space', '板框': 'Outline',
  '密度高,建议4层': 'dense — 4L advised', '2层可满足': '2L sufficient', '标准': 'standard',
  '大电流局部2oz': '2oz local for high current', '标准工艺': 'standard process', '异形(费用+)': 'irregular (cost+)', '常规': 'regular', '高': ' high',
  '晶振贴MCU包地 · 去耦电容贴引脚 · USB差分等长(90Ω) · 电源回路最小化 · 连接器靠板边': 'Crystal near MCU w/ guard ring · decoupling at pins · USB diff pairs matched (90Ω) · minimize power loops · connectors at board edge',
  '拖拽旋转 · 滚轮缩放 · 真实 3D 封装': 'Drag to rotate · scroll to zoom · real 3D packages',
  '顶视Top': 'Top View', '看Bottom': 'Bottom View', '复位视角': 'Reset View',
  // ── 变量传入 tr() 的数据源 key（枚举/分类名） ──
  'BOOT配置': 'BOOT Config',
  'CC配置': 'CC Config',
  'ESD防护': 'ESD Protection',
  'SPI上拉': 'SPI Pull-ups',
  'ezPLM云端': 'ezPLM Cloud',
  '两端贴片 (阻容)': '2-Pad Chip (R/C)',
  '单排针 (2.54)': 'Pin Header (2.54)',
  '去耦电容': 'Decoupling Caps',
  '去耦网络': 'Decoupling Network',
  '双列贴片 (SOP/TSSOP)': 'Dual SMD (SOP/TSSOP)',
  '四边无脚 (QFN)': 'Quad No-lead (QFN)',
  '四边鸥翼 (QFP)': 'Quad Gull-wing (QFP)',
  '复位电路': 'Reset Circuit',
  '封装占位': 'Placeholder',
  '小外形晶体管': 'SOT',
  '异形·手动焊盘坐标（继电器/模块等）': 'Irregular · manual pads (relay/module)',
  '时钟电路': 'Clock Circuit',
  '机电(继电器/开关)': 'Electromech (Relay/Switch)',
  '直插类': 'THT',
  '调试接口': 'Debug Interface',
  '贴片阻容': 'Chip R/C',
  '输入保护': 'Input Protection',
  '输入滤波': 'Input Filter',
  '输出滤波': 'Output Filter',
  '连接器封装': 'Connectors',
  '个封装 · 点击 + 直接放到画布': 'footprints · click + to place on canvas',
  '取消连线': 'Cancel Wire',
  '新模块': 'New Block',
  '模块': 'Block',
  '点击目标模块完成连线': 'click target block to finish',
  '点击起点模块': 'click source block',
  '脚': 'pin',
  '连线': 'Wire',
  // ── 补齐：向导/弹窗/详情/面板（代码已包裹的 key 全量收录） ──
  '⬆ 上传符号 (SVG)': '⬆ Upload Symbol (SVG)',
  '从文本提取': 'Extract from text', '共': 'Total', '项': 'items',
  '功能描述': 'Description', '名称': 'Name', '描述': 'Desc', '型号 *': 'MPN *',
  '布局要点': 'Layout Tips', '形状:': 'Shape:',
  '当前浏览器不支持 WebGL，无法显示 3D 预览': 'WebGL not supported — 3D preview unavailable',
  '或直接粘贴 datasheet 关键文本（管脚表/封装尺寸）…': 'or paste key datasheet text (pin table / dimensions)…',
  '或粘贴器件页面 URL…': 'or paste part page URL…',
  '提取': 'Extract', '提取中…': 'Extracting…',
  '搜索 ezPLM 型号…': 'Search ezPLM MPN…', '无匹配结果': 'no match',
  '本体': 'Body', '间距': 'Pitch', '轮廓': 'Outline', '焊盘偏移': 'Pads Offset',
  '添加器件后自动生成原理图': 'Schematic auto-generates after adding parts',
  '添加器件后自动生成框图，或点「+ 模块」手动创建': 'Block diagram auto-generates after adding parts, or click "+ Block"',
  '演示·网络估价': 'demo estimate',
  '🌐 官网': '🌐 Vendor', '🌐 官网检索': '🌐 Vendor Search',
  '💡 替代料（AI × ezPLM）': '💡 Alternatives (AI × ezPLM)',
  '📄 PDF下载': '📄 Datasheet', '📄 PDF检索': '📄 Find PDF',
  '📐 仅符号': '📐 Symbol Only', '📐 参考设计（来自 ezPLM）': '📐 Reference Designs (ezPLM)',
  '📦 匹配型号': '📦 Full Match', '📦 封装占位器件 · 补充信息': '📦 Placeholder Part · Complete Info',
  '🔗 从 ezPLM 库关联': '🔗 Link from ezPLM', '🔲 仅封装': '🔲 Footprint Only',
  '🤖 从 URL / PDF 提取生成': '🤖 Extract from URL / PDF',
  // 品牌
  '硬件原型工坊': 'Tindie Proto',
  'AI 方案生成、器件选型与 PCB 预布局': 'AI Hardware Planning, Parts Selection & PCB Pre-Layout',
  // 顶栏
  '导出PCB': 'Export PCB', '方案报告': 'Report', '导出设计': 'Export', '导入设计': 'Import',
  // 左栏
  'AI 生成方案': 'AI Design Generator',
  '如：USB转串口调试器 / WiFi物联网节点 / 12V车载CAN控制器': 'e.g. USB-UART debugger / WiFi IoT node / 12V automotive CAN controller',
  '生成方案上画布': 'Generate & Place', '生成中…': 'Generating…',
  '型号搜索': 'Part Search', '封装库': 'Footprints', '定制模块': 'Custom Parts',
  '已连接 ezPLM 元器件库（实时检索）': 'ezPLM parts library connected (live)',
  'ezPLM 库连接失败，使用演示目录': 'ezPLM unavailable, using demo catalog',
  '微控制器': 'MCU', '电源管理': 'Power', '无源器件': 'Passive', '连接器': 'Connector', '集成电路': 'IC',
  '机电（继电器/开关）': 'Electromech (Relay/Switch)', '机电器件': 'Electromech', '射频无线': 'RF/Wireless',
  '通用': 'Generic', '本组织': 'My Org', '拖拽旋转 · 滚轮缩放': 'Drag to rotate · scroll to zoom', '传感器': 'Sensor', '射频': 'RF', '电源': 'Power', '无源': 'Passive',
  '仅显示本组织物料': 'My organization only',
  '搜索型号、封装、关键词...': 'Search MPN, footprint, keyword...',
  '找到': 'Found', '个结果': 'results',
  '＋ 新建定制器件（AI 提取 / 手工向导）': '＋ New Custom Part (AI extract / manual)',
  '还没有定制器件': 'No custom parts yet', '上传 Datasheet 或手工填写管脚即可构建': 'Upload a datasheet or fill in pins to build one',
  '自建': 'Custom',
  // 画布工具栏
  '撤销': 'Undo', '重做': 'Redo', '清除': 'Clear', '2D 布局': '2D Layout', '3D 视图': '3D View',
  'Top层': 'Top', 'Bottom层': 'Bottom', '位号': 'RefDes',
  'R 旋转 · L 换层 · Delete 删除 · 拖位号可移动': 'R rotate · L flip · Delete remove · drag refdes to move',
  '从左侧添加器件，自动按电气规则摆放': 'Add parts from the left — auto-placed by electrical rules',
  '旋转': 'Rotate', '隐位号': 'Hide Ref', '移除': 'Remove',
  // 底栏
  '定位孔': 'Mounting Holes', '切角': 'Cutout', '圆角': 'Radius',
  'BOM清单': 'BOM', '系统框图': 'Block Diagram', '原理图': 'Schematic',
  // 右栏
  '当前元件': 'Component', 'AI顾问': 'AI Advisor',
  '点击画布中的元件查看详情': 'Select a component on the canvas to see details',
  '官网检索': 'Vendor Site', '官网': 'Vendor', 'PDF检索': 'Find PDF', 'PDF下载': 'Datasheet', '无PDF': 'No PDF',
  '分类：': 'Category: ',
  '核心参数': 'Key Specs',
  'PCB 设计库文件': 'PCB Library Files', '原理图符号': 'Schematic Symbol', 'PCB 封装': 'PCB Footprint', '3D 模型': '3D Model',
  'ezPLM 精确数据 ✓': 'ezPLM exact data ✓',
  '拉取库文件中…（暂用名字解析）': 'Fetching library file… (name-parsed for now)',
  '文件解析失败 · 用名字解析兜底': 'File parse failed · fallback to name parsing',
  '接口未提供文件链接 · 名字解析': 'No file link from API · name-parsed',
  'STEP 源文件（ezPLM）': 'STEP source (ezPLM)', 'ezPLM 未提供该器件的 STEP 文件': 'No STEP file from ezPLM',
  'ezPLM 真实 STEP 模型 ✓': 'Real STEP model (ezPLM) ✓',
  'STEP 转换中…（首次需下载 3D 引擎）· 暂为参数化': 'Converting STEP… (3D engine downloads once) · parametric for now',
  'STEP 转换失败 · 参数化预览': 'STEP conversion failed · parametric preview',
  '准备转换 STEP…': 'Preparing STEP conversion…', '参数化 3D 预览': 'Parametric 3D preview',
  '拖拽旋转 · 滚轮缩放 · 双击复位': 'Drag to rotate · scroll to zoom · double-click to reset',
  '采购渠道': 'Suppliers', '实时': 'Live', '演示': 'Demo', '库存': 'Stock', '跳转 ↗': 'Open ↗',
  '未收录该型号': 'not listed', '查询中… / 未配置': 'querying… / not configured',
  '替代料（AI × ezPLM）': 'Alternatives (AI × ezPLM)', 'AI 搜索替代料': 'AI Find Alternatives', '搜索中…': 'Searching…',
  '参考设计（来自 ezPLM）': 'Reference Designs (ezPLM)',
  '封装占位器件 · 补充信息': 'Placeholder Part · Complete Info',
  '输入器件型号，如 GD32F103C8T6': 'Enter MPN, e.g. GD32F103C8T6', '设为型号': 'Set MPN',
  '从 ezPLM 库关联': 'Link from ezPLM', '匹配型号': 'Full Match', '仅符号': 'Symbol Only', '仅封装': 'Footprint Only',
  '从 URL / PDF 提取生成': 'Extract from URL / PDF', '上传符号 (SVG)': 'Upload Symbol (SVG)',
  // BOM
  'BOM 总价（DigiKey 实时价优先）': 'BOM Total (DigiKey live prices first)', '导出 CSV': 'Export CSV', '全屏': 'Fullscreen',
  '序号': '#', '厂商': 'Mfr', '封装': 'Footprint', '来源': 'Source', '单价': 'Unit Price', '数量': 'Qty', '型号': 'MPN',
  // 弹窗
  'AI 方案建议 · 请确认': 'AI Proposal · Confirm', '✓ Gemini 生成': '✓ Generated by Gemini', '演示引擎': 'Demo engine',
  '仅加载核心器件': 'Core parts only', '取消': 'Cancel', '确认上画布': 'Place on Canvas', '个器件': 'parts',
  '关联库器件': 'Link Library Part', '创建': 'Create',
  // 向导
  '定制器件构建向导': 'Custom Part Wizard',
  '保存到定制库': 'Save to Library', '添加管脚': 'Add Pin', '管脚定义': 'Pin Definition',
  '封装参数': 'Package', '封装预览': 'Footprint Preview', '焊盘': 'pads', '模块轮廓（可选）': 'Module Outline (optional)',
};

/** 非 hook 版（深层组件直接调用；语言切换时 App 整树重渲染保证及时生效） */
export const tr = (text: string): string =>
  (useLangStore.getState().lang === 'en' ? DICT[text] ?? text : text);

/** 固定文案翻译：zh 模式原样返回；en 模式查词典，未命中返回原文 */
export function useT() {
  const lang = useLangStore((s) => s.lang);
  return (text: string): string => (lang === 'en' ? DICT[text] ?? text : text);
}

/* ───────────── 动态内容翻译（ezPLM 中文数据 → 英文） ───────────── */
const trCache = new Map<string, string>();
try {
  const saved = JSON.parse(localStorage.getItem('cc_tr_cache') ?? '{}') as Record<string, string>;
  for (const [k, v] of Object.entries(saved)) trCache.set(k, v);
} catch { /* 忽略损坏缓存 */ }

let pendingQueue = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function persistCache() {
  const obj: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of trCache) { obj[k] = v; if (++n >= 800) break; }
  localStorage.setItem('cc_tr_cache', JSON.stringify(obj));
}

async function flushQueue() {
  const batch = [...pendingQueue].slice(0, 40);
  pendingQueue = new Set([...pendingQueue].slice(40));
  if (!batch.length) return;
  try {
    if (!(await geminiAvailable())) return;
    const text = await geminiComplete(
      `将以下电子元器件领域的中文文本翻译成简洁的英文（专业术语标准化，如"运算放大器"→"op-amp"）。严格输出 JSON 字符串数组，与输入等长、顺序一致，勿输出其它文字：\n${JSON.stringify(batch)}`,
    );
    const out = extractJson<string[]>(text);
    batch.forEach((src, i) => { if (typeof out[i] === 'string' && out[i]) trCache.set(src, out[i]); });
    persistCache();
    listeners.forEach((fn) => fn());
  } catch { /* 翻译失败保留原文，下次进入视图重试 */ }
  if (pendingQueue.size) { flushTimer = setTimeout(flushQueue, 400); } else { flushTimer = null; }
}

const hasCJK = (s: string) => /[\u4e00-\u9fff]/.test(s);

/** 动态文本翻译 hook：en 模式下含中文的文本进入批量翻译队列，完成后自动刷新 */
export function useTranslated(text: string | undefined): string | undefined {
  const lang = useLangStore((s) => s.lang);
  const [, force] = useState(0);
  useEffect(() => {
    if (lang !== 'en' || !text || !hasCJK(text) || trCache.has(text)) return;
    pendingQueue.add(text);
    if (!flushTimer) flushTimer = setTimeout(flushQueue, 300);
    const cb = () => force((x) => x + 1);
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }, [lang, text]);
  if (lang !== 'en' || !text) return text;
  return trCache.get(text) ?? text;
}
