/**
 * 无源器件自动关联 KiCad 官方封装库 —— 电阻/电容/连接器等 ezPLM 未收录的器件，
 * 按封装名前缀推断所属官方库，拉取 .kicad_mod 注册精确焊盘，并从 (model) 引用挂真实 3D。
 *
 * 尽力而为的异步过程：失败静默回退名字解析参数化，不阻塞放置。
 */
import { parseKicadMod } from './kicad-file-parser';
import { registerFootprintOverride, footprintOverrideFor } from './lib-file-registry';
import { bumpLibRegistry } from './lib-file-registry';

/** 封装名前缀 → KiCad 官方库候选（按命中概率排序） */
const LIB_GUESS: [RegExp, string[]][] = [
  [/^R_/, ['Resistor_SMD', 'Resistor_THT']],
  [/^C_/, ['Capacitor_SMD', 'Capacitor_THT', 'Capacitor_Tantalum_SMD']],
  [/^CP_/, ['Capacitor_SMD', 'Capacitor_THT']],
  [/^L_/, ['Inductor_SMD', 'Inductor_THT']],
  [/^FB_/, ['Inductor_SMD']],
  [/^LED_/, ['LED_SMD', 'LED_THT']],
  [/^(D_|SOD)/, ['Diode_SMD', 'Diode_THT']],
  [/^PinHeader_/, ['Connector_PinHeader_2.54mm', 'Connector_PinHeader_1.27mm', 'Connector_PinHeader_2.00mm']],
  [/^PinSocket_/, ['Connector_PinSocket_2.54mm']],
  [/^USB_/, ['Connector_USB']],
  [/^(SW_|Button)/, ['Button_Switch_SMD', 'Button_Switch_THT']],
  [/^Crystal_/, ['Crystal']],
  [/^(Fuse)/, ['Fuse']],
  [/^SOT-?\d/, ['Package_TO_SOT_SMD']],
  [/^(SOIC|SO-?\d|SSOP|TSSOP|MSOP)/, ['Package_SO']],
  [/QFP/, ['Package_QFP']],
  [/(QFN|DFN)/, ['Package_DFN_QFN']],
];

const inflight = new Set<string>();
const failed = new Set<string>();

/** 按封装名尝试自动挂官方库（注册焊盘 override）；命中时返回 stepUrl（供挂 3D） */
export async function autoKicadFootprint(footprintName: string): Promise<string | undefined> {
  if (!footprintName || inflight.has(footprintName) || failed.has(footprintName)) return undefined;
  // 已有精确焊盘（KiCad 库添加/导入注册过）则只需补 3D —— 仍走一遍拿 model 引用
  const guess = LIB_GUESS.find(([re]) => re.test(footprintName));
  if (!guess) return undefined;
  inflight.add(footprintName);
  try {
    for (const lib of guess[1]) {
      const r = await fetch(`/api/kicadlib?path=mod&lib=${encodeURIComponent(lib)}&name=${encodeURIComponent(footprintName)}`);
      if (!r.ok) continue;
      const text = await r.text();
      if (!text.trimStart().startsWith('(')) continue;
      if (!footprintOverrideFor(footprintName)) {
        const fp = parseKicadMod(text);
        if (fp && fp.pads.length) {
          registerFootprintOverride(footprintName, fp);
          bumpLibRegistry();
        }
      }
      // (model) 权威 3D 引用 → stepUrl
      const modelRef = text.match(/\(model\s+"([^"]+)"/)?.[1];
      const mm = modelRef?.match(/([^/\\]+)\.3dshapes[/\\]([^/\\]+)\.(step|stp|wrl)$/i);
      if (mm) return `/api/kicadlib?path=step&lib=${encodeURIComponent(mm[1])}&name=${encodeURIComponent(mm[2])}`;
      return undefined; // 封装命中但无 model 引用
    }
    failed.add(footprintName);
  } catch {
    /* 网络失败静默，参数化兜底 */
  } finally {
    inflight.delete(footprintName);
  }
  return undefined;
}
