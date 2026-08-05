/**
 * modules/report/persistence.ts
 * 设计文档的导入/导出/自动保存。
 */
import { serializeDocument, deserializeDocument } from '../../design-core/document/factory';
import type { CircuitCanvasDocument } from '../../design-core/document/types';

const AUTOSAVE_KEY = 'cc:autosave';

export function exportDocument(doc: CircuitCanvasDocument) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([serializeDocument(doc)], { type: 'application/json' }));
  a.download = `${doc.name || 'design'}.cc.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function importDocumentFromFile(file: File): Promise<CircuitCanvasDocument> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(deserializeDocument(String(reader.result))); }
      catch (e) { reject(e); }
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

export function autosave(doc: CircuitCanvasDocument) {
  try { localStorage.setItem(AUTOSAVE_KEY, serializeDocument(doc)); } catch { /* ignore */ }
}

export function loadAutosave(): CircuitCanvasDocument | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? deserializeDocument(raw) : null;
  } catch { return null; }
}

/**
 * 生成 Markdown 方案设计报告并下载。
 * 结构：需求 / 构成 / 框图(SVG内嵌) / 器件选择 / PCB布局图(SVG内嵌) / 原理图(SVG内嵌) / 供电方案 / 软件方案 / 设计审查。
 * SVG 以内嵌方式写入 Markdown（多数渲染器支持 <svg>；亦可另存 .svg 文件引用）。
 */
import { buildBlockDiagramSvg, buildPcbLayoutSvg, buildSchematicSvgFromDom } from './reportSvg';

/** SVG → Markdown 图片（base64 data-URI，Typora/VSCode/GitHub 均可渲染） */
function svgToMdImage(svg: string, alt: string): string {
  if (!svg.startsWith('<svg')) return svg; // 提示文字直接原样输出
  const b64 = btoa(unescape(encodeURIComponent(svg)));
  return `![${alt}](data:image/svg+xml;base64,${b64})`;
}

export function exportMarkdownReport(doc: CircuitCanvasDocument) {
  const total = doc.bom.reduce((s, l) => s + (l.unitPrice?.amount ?? 0) * l.quantity, 0);
  const cats = new Set(doc.components.map((c) => c.category));
  const mcus = doc.components.filter((c) => c.category === 'mcu');
  const powers = doc.components.filter((c) => c.category === 'power');
  const conns = doc.components.filter((c) => c.category === 'connector');
  const ics = doc.components.filter((c) => c.category === 'ic');

  const L: string[] = [];
  L.push(`# ${doc.name} — 方案设计报告`);
  L.push('');
  L.push(`> 生成时间：${new Date().toLocaleString('zh-CN')} · Circuit Canvas v3 · ezPLM.cn`);
  L.push('');

  // 一、方案需求
  L.push('## 一、方案需求');
  L.push('');
  if (doc.designIntent) {
    L.push(`**需求描述**：${doc.designIntent.requirement}`);
    L.push('');
    L.push(`**AI 选型理由**：${doc.designIntent.rationale}`);
  } else {
    L.push('（手动搭建的方案，未记录 AI 需求描述。可在左侧「AI 生成方案」输入需求生成。）');
  }
  L.push('');

  // 二、方案构成
  L.push('## 二、方案构成');
  L.push('');
  const catNames: Record<string, string> = { mcu: '主控', power: '电源管理', connector: '对外接口', ic: '功能外设', passive: '无源器件' };
  for (const cat of ['mcu', 'power', 'connector', 'ic', 'passive']) {
    const list = doc.components.filter((c) => c.category === cat);
    if (list.length) L.push(`- **${catNames[cat]}**：${list.map((c) => `${c.reference} ${c.mpn}`).join('、')}`);
  }
  L.push('');

  // 三、系统框图
  L.push('## 三、系统框图');
  L.push('');
  L.push(svgToMdImage(buildBlockDiagramSvg(doc), '系统框图'));
  L.push('');

  // 四、器件选择
  L.push('## 四、器件选择（BOM）');
  L.push('');
  L.push('| # | 位号 | 型号 | 厂商 | 封装 | 层 | 单价 | 数量 | 说明 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  doc.components.forEach((c, i) => {
    L.push(`| ${i + 1} | ${c.reference} | ${c.mpn} | ${c.manufacturer} | ${c.footprint.name} | ${c.placement.side} | ¥${(c.unitPrice?.amount ?? 0).toFixed(2)} | ${c.quantity} | ${c.display?.description ?? ''} |`);
  });
  L.push('');
  L.push(`**BOM 估算总价：¥${total.toFixed(2)}**`);
  L.push('');

  // 五、PCB 布局图
  L.push('## 五、PCB 布局图');
  L.push('');
  L.push(`板框 ${doc.board.widthMm}×${doc.board.heightMm}mm · ${doc.board.shape} · ${doc.board.mountingHolesEnabled ? '含四角定位孔 Ø3.2mm' : '无定位孔'}`);
  L.push('');
  L.push(svgToMdImage(buildPcbLayoutSvg(doc), 'PCB布局图'));
  L.push('');

  // 六、原理图
  L.push('## 六、原理图');
  L.push('');
  const schSvg = buildSchematicSvgFromDom();
  L.push(schSvg ? svgToMdImage(schSvg, '原理图') : '（原理图需在应用中打开「原理图」面板后再生成报告，或用面板中「导出SVG」单独获取。）');
  L.push('');

  // 七、供电方案
  L.push('## 七、供电方案');
  L.push('');
  if (powers.length) {
    for (const p of powers) {
      const fam = p.display?.family ?? '';
      const attrs = p.display?.attributes ?? {};
      L.push(`- **${p.reference} ${p.mpn}**（${fam}）：${p.display?.description ?? ''}${attrs.vin ? ` · 输入 ${attrs.vin}` : ''}${attrs.vout ? ` · 输出 ${attrs.vout}` : ''}${attrs.iout ? ` · 最大 ${attrs.iout}` : ''}`);
    }
    L.push('');
    L.push('供电链路建议：输入接口 → 保护（保险丝+TVS）→ ' + powers.map((p) => p.mpn).join(' → ') + ' → 各功能单元；每个电源引脚就近 100nF 去耦，整体加 10μF 储能。');
  } else {
    L.push('方案中暂无电源管理器件，请补充稳压/降压电路。');
  }
  L.push('');

  // 八、软件开发环境与软件方案
  L.push('## 八、软件开发环境与软件方案');
  L.push('');
  if (mcus.length) {
    for (const m of mcus) {
      const fam = m.display?.family ?? '';
      if (fam.startsWith('STM32')) {
        L.push(`- **${m.mpn}**：STM32CubeIDE / Keil MDK + STM32CubeMX 生成初始化代码；HAL/LL 库；SWD 烧录调试（ST-Link）。`);
      } else if (fam.startsWith('ESP32')) {
        L.push(`- **${m.mpn}**：ESP-IDF（官方）或 Arduino-ESP32；USB 串口烧录；FreeRTOS 内置；Wi-Fi/BLE 协议栈由 SDK 提供。`);
      } else if (fam.startsWith('GD32')) {
        L.push(`- **${m.mpn}**：GD32 Embedded Builder / Keil MDK；兼容 STM32 生态；SWD 烧录。`);
      } else {
        L.push(`- **${m.mpn}**：请参考厂商官方 SDK 与 IDE。`);
      }
    }
    L.push('');
    L.push('**软件方案构成建议**：');
    L.push('- 驱动层：GPIO/时钟/串口初始化' + (ics.some((i) => i.display?.family?.includes('Flash')) ? '、SPI Flash 驱动' : '') + (ics.some((i) => i.display?.family?.includes('CAN')) ? '、CAN 收发驱动' : '') + (conns.some((c) => c.display?.family?.includes('USB')) ? '、USB/串口通信' : ''));
    L.push('- 中间层：任务调度（裸机状态机或 FreeRTOS）、参数存储、协议解析');
    L.push('- 应用层：业务逻辑、上位机交互' + (mcus.some((m) => m.display?.family?.startsWith('ESP32')) ? '、OTA 升级与云端接入' : ''));
  } else {
    L.push('方案中无可编程主控，无需软件开发。');
  }
  L.push('');

  // 九、设计审查
  L.push('## 九、设计审查');
  L.push('');
  for (const r of doc.reviewResults) {
    const mark = r.level === 'high' ? '🔴' : r.level === 'mid' ? '🟡' : r.level === 'low' ? '🟢' : 'ℹ️';
    L.push(`- ${mark} **${r.title}**${r.detail ? ` — ${r.detail}` : ''}`);
  }
  L.push('');

  const md = L.join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
  a.download = `${doc.name || 'design'}-方案报告.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}
