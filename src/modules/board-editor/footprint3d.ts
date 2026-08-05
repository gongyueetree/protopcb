/**
 * modules/board-editor/footprint3d.ts
 * 参数化 3D 封装模型生成器 —— 用 Three.js 几何体按封装类型生成逼真模型。
 * 无需 STEP 文件：芯片本体+引脚、片式电容、电感、连接器等都参数化构建。
 * 单位 mm，与设计内核一致。
 */
import * as THREE from 'three';
import { padFootprintFor } from '../../design-core/geometry/footprint-pads';
import { stepModelFor, ensureStepModel } from './step-loader';
import type { PlacedComponent } from '../../design-core/document/types';

const MAT = {
  blackBody: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5, metalness: 0.3 }),
  darkBody: new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.45, metalness: 0.35 }),
  lead: new THREE.MeshStandardMaterial({ color: 0xcfd4d8, roughness: 0.3, metalness: 0.85 }),
  tin: new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.35, metalness: 0.8 }),
  capBrown: new THREE.MeshStandardMaterial({ color: 0xa97b50, roughness: 0.6, metalness: 0.1 }),
  capBeige: new THREE.MeshStandardMaterial({ color: 0xd8c9a0, roughness: 0.6, metalness: 0.05 }),
  metalCan: new THREE.MeshStandardMaterial({ color: 0xb0b4b8, roughness: 0.25, metalness: 0.9 }),
  pcbGreen: new THREE.MeshStandardMaterial({ color: 0x0a7a3a, roughness: 0.5, metalness: 0.1 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xd4af37, roughness: 0.3, metalness: 0.85 }),
  white: new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.7, metalness: 0 }),
};

/** SOIC/SOP/QFP 类：黑色本体 + 金属引脚 */
function makeChip(bodyW: number, bodyH: number, bodyT: number, opts: { gull?: boolean; perSideX?: number; perSideY?: number } = {}): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(bodyW, bodyT, bodyH), MAT.blackBody);
  body.position.y = bodyT / 2 + 0.05;
  g.add(body);
  // 引脚1凹点
  const dot = new THREE.Mesh(new THREE.CylinderGeometry(bodyW * 0.06, bodyW * 0.06, 0.05, 12), MAT.darkBody);
  dot.position.set(-bodyW / 2 + bodyW * 0.18, bodyT + 0.05, -bodyH / 2 + bodyH * 0.18);
  g.add(dot);
  // 引脚（鸥翼）
  const leadLen = 0.5, leadW = 0.3, leadT = 0.15;
  const addLeads = (count: number, along: 'x' | 'z', edge: number) => {
    if (count <= 0) return;
    const span = (along === 'x' ? bodyW : bodyH) * 0.8;
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : -span / 2 + (span * i) / (count - 1);
      const lead = new THREE.Mesh(new THREE.BoxGeometry(along === 'x' ? leadW : leadLen, leadT, along === 'x' ? leadLen : leadW), MAT.lead);
      if (along === 'x') lead.position.set(t, leadT / 2, edge > 0 ? bodyH / 2 + leadLen / 2 : -bodyH / 2 - leadLen / 2);
      else lead.position.set(edge > 0 ? bodyW / 2 + leadLen / 2 : -bodyW / 2 - leadLen / 2, leadT / 2, t);
      g.add(lead);
    }
  };
  const psx = opts.perSideX ?? 0, psy = opts.perSideY ?? 0;
  addLeads(psx, 'x', 1); addLeads(psx, 'x', -1);
  addLeads(psy, 'z', 1); addLeads(psy, 'z', -1);
  return g;
}

/** 片式元件（电容/电阻/电感） */
function makeChipComponent(w: number, h: number, t: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, t, h), mat);
  body.position.y = t / 2 + 0.02;
  g.add(body);
  // 两端电极
  for (const sx of [-1, 1]) {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w * 0.18, t * 1.05, h * 1.02), MAT.tin);
    cap.position.set(sx * (w / 2 - w * 0.09), t / 2 + 0.02, 0);
    g.add(cap);
  }
  return g;
}

/** 圆柱电感/钽电容 */
function makeCan(d: number, hgt: number): THREE.Group {
  const g = new THREE.Group();
  const can = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, hgt, 24), MAT.metalCan);
  can.position.y = hgt / 2 + 0.05;
  g.add(can);
  return g;
}

/** SOT-223 */
function makeSot223(): THREE.Group {
  const g = makeChip(6.5, 3.5, 1.6, { perSideX: 3 });
  // 散热焊片
  const tab = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.15, 1.5), MAT.lead);
  tab.position.set(0, 0.075, -2.4);
  g.add(tab);
  return g;
}

/** USB-C 母座连接器：金属外壳 + 椭圆开口 + 内部舌片 */
function makeUsbC(): THREE.Group {
  const g = new THREE.Group();
  const shellW = 9.0, shellH = 3.2, shellD = 7.0;
  // 金属外壳（圆角）
  const shellShape = new THREE.Shape();
  const r = shellH / 2;
  shellShape.moveTo(-shellW / 2 + r, -shellH / 2);
  shellShape.lineTo(shellW / 2 - r, -shellH / 2);
  shellShape.quadraticCurveTo(shellW / 2, -shellH / 2, shellW / 2, -shellH / 2 + r);
  shellShape.lineTo(shellW / 2, shellH / 2 - r);
  shellShape.quadraticCurveTo(shellW / 2, shellH / 2, shellW / 2 - r, shellH / 2);
  shellShape.lineTo(-shellW / 2 + r, shellH / 2);
  shellShape.quadraticCurveTo(-shellW / 2, shellH / 2, -shellW / 2, shellH / 2 - r);
  shellShape.lineTo(-shellW / 2, -shellH / 2 + r);
  shellShape.quadraticCurveTo(-shellW / 2, -shellH / 2, -shellW / 2 + r, -shellH / 2);
  const shellGeo = new THREE.ExtrudeGeometry(shellShape, { depth: shellD, bevelEnabled: false });
  shellGeo.rotateX(-Math.PI / 2);
  const shell = new THREE.Mesh(shellGeo, MAT.metalCan);
  shell.position.set(0, shellH / 2 + 0.05, shellD / 2); // 朝 +z（板边）方向延伸
  g.add(shell);
  // 内部黑色舌片（Type-C 中间的舌头）
  const tongue = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.7, 4), MAT.blackBody);
  tongue.position.set(0, shellH / 2 + 0.05, shellD - 1.5);
  g.add(tongue);
  // 开口处的黑色内衬
  const innerLip = new THREE.Mesh(new THREE.BoxGeometry(shellW - 1, shellH - 0.8, 0.6), MAT.darkBody);
  innerLip.position.set(0, shellH / 2 + 0.05, shellD - 0.3);
  g.add(innerLip);
  // 焊接固定脚
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 1.8), MAT.lead);
    leg.position.set(sx * 4.3, 0.15, 1);
    g.add(leg);
  }
  return g;
}

/** 排针：黑色塑料基座 + 金属针 */
function makeHeader(cols: number, rows: number): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(cols * 2.54, 2.5, rows * 2.54), MAT.blackBody);
  base.position.y = 2.5 / 2 + 0.05;
  g.add(base);
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    const pin = new THREE.Mesh(new THREE.BoxGeometry(0.64, 6, 0.64), MAT.gold);
    pin.position.set(-((cols - 1) * 2.54) / 2 + c * 2.54, 3, -((rows - 1) * 2.54) / 2 + r * 2.54);
    g.add(pin);
  }
  return g;
}


/** 从 2D 焊盘数据构建通用 3D 模型 —— 引脚位于每个焊盘的真实位置，与 2D 布局严格一致。
 *  SMD 矩形焊盘 → 金属引脚片；圆形小盘(<1.2mm) → 焊球(WLCSP/BGA)；圆形大盘 → 通孔引脚。 */
function makeFromPads(fp: import('../../design-core/geometry/footprint-pads').PadFootprint, fpName: string): THREE.Group {
  const g = new THREE.Group();
  const N = fpName.toUpperCase();
  const isBall = fp.pads.every((p) => p.round) && /(WLCSP|BGA|CSP)/.test(N);
  // 高度启发式：真实高度不在 .kicad_mod 里（只有 3D 模型路径引用），按封装类型+尺寸估计；
  // 真实 STEP 加载成功后会整体替换本参数化模型
  const minDim = Math.min(fp.bodyW, fp.bodyH);
  const hasTht = fp.pads.some((pd) => pd.round && pd.w >= 1.2);
  const bodyT = isBall ? 0.6
    : /(QFN|DFN|SON)/.test(N) ? 0.9
    : /(SOIC|SOP|SSOP|TSSOP|SOT|QFP)/.test(N) ? 1.6
    : /(MODULE|FEATHER|ESP|BOARD|SHIELD)/.test(N) ? 3.2
    : /(CRYSTAL|OSC|XTAL)/.test(N) ? Math.min(minDim * 0.8, 13.5)
    : /(POT|SWITCH|BUTTON|RELAY|CONN|SOCKET|HEADER|USB)/.test(N) ? Math.min(Math.max(minDim * 0.6, 3), 12)
    : Math.min(Math.max(minDim * (hasTht ? 0.5 : 0.3), 1.2), 10);
  const body = new THREE.Mesh(new THREE.BoxGeometry(fp.bodyW, bodyT, fp.bodyH), MAT.blackBody);
  body.position.x = fp.bodyCx ?? 0;
  body.position.z = fp.bodyCy ?? 0;
  body.position.y = bodyT / 2 + (isBall ? 0.3 : 0.06);
  g.add(body);
  // 引脚1凹点
  if (fp.pin1) {
    const dot = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(fp.bodyW, fp.bodyH) * 0.07, Math.min(fp.bodyW, fp.bodyH) * 0.07, 0.05, 10), MAT.darkBody);
    const bx = fp.bodyCx ?? 0, by = fp.bodyCy ?? 0;
    dot.position.set(Math.max(bx - fp.bodyW / 2 + 0.4, Math.min(bx + fp.bodyW / 2 - 0.4, fp.pin1.x)), bodyT + (isBall ? 0.3 : 0.06) + 0.03, Math.max(by - fp.bodyH / 2 + 0.4, Math.min(by + fp.bodyH / 2 - 0.4, fp.pin1.y)));
    g.add(dot);
  }
  for (const p of fp.pads) {
    if (p.round && p.w < 1.2) {
      // 焊球
      const ball = new THREE.Mesh(new THREE.SphereGeometry(p.w / 2, 10, 8), MAT.lead);
      ball.position.set(p.x, p.w / 2 * 0.7, p.y);
      g.add(ball);
    } else if (p.round) {
      // 通孔引脚
      const pinH = Math.max(4, bodyT + 1.5);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, pinH, 10), MAT.gold);
      pin.position.set(p.x, pinH / 2, p.y);
      g.add(pin);
    } else {
      // SMD 引脚片：按焊盘尺寸/位置
      const lead = new THREE.Mesh(new THREE.BoxGeometry(p.w, 0.22, p.h), MAT.lead);
      lead.position.set(p.x, 0.11, p.y);
      g.add(lead);
    }
  }
  return g;
}

/** 模组（ESP32 等）：黑色 PCB 模块 + 屏蔽罩 */
function makeModule(w: number, h: number): THREE.Group {
  const g = new THREE.Group();
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(w, 0.8, h), MAT.blackBody);
  pcb.position.y = 0.4 + 0.05;
  g.add(pcb);
  const shield = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 1.5, h * 0.75), MAT.metalCan);
  shield.position.set(0, 0.8 + 0.75 + 0.05, -h * 0.08);
  g.add(shield);
  return g;
}

/**
 * 根据器件生成 3D 模型 Group（局部坐标，y 向上，停在 z=0 平面上方）。
 */
export function buildComponent3D(comp: PlacedComponent): THREE.Group {
  // ezPLM 真实 STEP 模型优先（已转换缓存则直接使用；否则触发异步加载，先用参数化模型）
  const stepUrl = comp.display?.stepUrl;
  if (stepUrl) {
    const real = stepModelFor(stepUrl);
    if (real) return real;
    ensureStepModel(stepUrl);
  }
  const fp = comp.footprint.name;
  let group: THREE.Group;

  switch (fp) {
    case '0402': group = makeChipComponent(1.0, 0.5, 0.5, comp.display?.family === 'MLCC' ? MAT.capBeige : MAT.darkBody); break;
    case '0603': group = makeChipComponent(1.6, 0.8, 0.8, comp.display?.family === 'MLCC' ? MAT.capBeige : MAT.darkBody); break;
    case '0805': group = makeChipComponent(2.0, 1.25, 1.0, MAT.capBeige); break;
    case '4018': group = makeCan(4.0, 1.8); break;
    case 'Module-44': group = makeModule(18.0, 25.5); break;
    case 'USB-C-16P': group = makeUsbC(); break;
    case 'THT-2.54mm': group = makeHeader(2, 5); break;
    default: {
      const fp = padFootprintFor(comp.footprint.name);
      group = fp ? makeFromPads(fp, comp.footprint.name)
        : makeChip(comp.footprint.geometry.bodyWidthMm, comp.footprint.geometry.bodyHeightMm, 1.2, { perSideX: 4 });
    }
  }
  return group;
}

export { MAT };
