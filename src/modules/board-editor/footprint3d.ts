/**
 * modules/board-editor/footprint3d.ts
 * 参数化 3D 封装模型生成器 —— 用 Three.js 几何体按封装类型生成逼真模型。
 * 无需 STEP 文件：芯片本体+引脚、片式电容、电感、连接器等都参数化构建。
 * 单位 mm，与设计内核一致。
 */
import * as THREE from 'three';
import { padFootprintFor, type PadFootprint } from '../../design-core/geometry/footprint-pads';
import { componentBodyHeight } from '../../design-core/enclosure';
import { stepModelFor, ensureStepModel, bodyColorForFootprint } from './step-loader';
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
function makeChipComponent(w: number, h: number, t: number, mat: THREE.Material, capMat: THREE.Material = MAT.tin): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, t, h), mat);
  body.position.y = t / 2 + 0.02;
  g.add(body);
  // 两端电极
  for (const sx of [-1, 1]) {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w * 0.18, t * 1.05, h * 1.02), capMat);
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
function _makeSot223(): THREE.Group {
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
  // shape 的 x = 壳体宽、y = 壳体高，ExtrudeGeometry 沿 +z 挤出 = 伸向板边方向。
  // ⚠ 此前多做了一次 rotateX(-90°)，把挤出方向从"水平伸出"扳成了"竖直向上"，
  // 于是 USB-C 在板上立成一根 7mm 高的柱子。场景 y 已经朝上，这里不需要任何旋转。
  const shellGeo = new THREE.ExtrudeGeometry(shellShape, { depth: shellD, bevelEnabled: false });
  const shell = new THREE.Mesh(shellGeo, MAT.metalCan);
  // 本体在 z 向以封装原点居中（焊盘也以原点居中），底面抬到板面之上 0.05mm。
  // ⚠ 挤出方向是 +z，所以起点要放在 -shellD/2，壳体才占据 [-D/2, +D/2]。
  //   此前写成 -shellD（壳体落在 [-D, 0]），而舌片/内衬按 +D/2 摆 —— 壳体和开口各朝一边，
  //   看上去就是整个连接器转了 180°。
  shell.position.set(0, shellH / 2 + 0.05, -shellD / 2);
  g.add(shell);
  const zFront = shellD / 2;                       // 插口朝向（+z 为板外）
  // 内部黑色舌片（Type-C 中间的舌头）
  const tongue = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.7, 4), MAT.blackBody);
  tongue.position.set(0, shellH / 2 + 0.05, zFront - 2.2);
  g.add(tongue);
  // 开口处的黑色内衬
  const innerLip = new THREE.Mesh(new THREE.BoxGeometry(shellW - 1, shellH - 0.8, 0.6), MAT.darkBody);
  innerLip.position.set(0, shellH / 2 + 0.05, zFront - 0.3);
  g.add(innerLip);
  // 焊接固定脚
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 1.8), MAT.lead);
    leg.position.set(sx * 4.3, 0.15, -shellD / 2 + 1);
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


/**
 * 应用 .kicad_pcb 里 (model) 的 offset/rotate/scale。
 *
 * KiCad 用这三个字段把厂商 STEP 摆正 —— 忽略它们的后果是实打实的：
 * USB-C 的 (rotate 180 0 0) 丢掉就整个翻过来；轻触开关的 (rotate -90 0 0) 丢掉就立着。
 *
 * 坐标系换算：KiCad 3D 的 X 向右、Y 向**前**（板面内）、Z 向上；
 * 我们的场景是 X 向右、Y 向上、Z 向下（板面内）。故 (x,y,z)_kicad → (x, z, -y)_scene，
 * 旋转角同理换轴，且 KiCad 的 rotate 是顺时针为正（与 three.js 相反），需取负。
 */
export function applyModelTransform(
  group: THREE.Group,
  t?: { offset?: [number, number, number]; rotate?: [number, number, number]; scale?: [number, number, number] },
): THREE.Group {
  if (!t) return group;
  const wrap = new THREE.Group();
  if (t.scale) group.scale.set(t.scale[0], t.scale[2], t.scale[1]);
  if (t.rotate) {
    const [rx, ry, rz] = t.rotate.map((d) => (-d * Math.PI) / 180);
    // KiCad 绕 X/Y/Z → 场景绕 X/Z/Y（Y 与 Z 互换），顺序 ZYX 与 KiCad 一致
    group.rotation.set(rx, rz, ry, 'ZYX');
  }
  if (t.offset) group.position.set(t.offset[0], t.offset[2], -t.offset[1]);
  wrap.add(group);
  return wrap;
}

/**
 * 按真实焊盘建排针/排母：塑料基座覆盖焊盘外接框（含卧式封装的本体偏移），
 * 每个焊盘位置竖一根针。这样 3D 与 2D 焊盘永远对齐，不依赖封装名的命名习惯。
 */
function makeHeaderFromPads(fp: PadFootprint): THREE.Group {
  const g = new THREE.Group();
  const xs = fp.pads.map((p) => p.x), ys = fp.pads.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const padW = Math.max(...fp.pads.map((p) => p.w));
  const padH = Math.max(...fp.pads.map((p) => p.h));
  // 基座尺寸取焊盘阵列外沿再各放 0.6mm（2.54 排针的塑料基座正好略大于焊盘间距）
  const baseW = (x1 - x0) + padW + 0.6;
  const baseD = (y1 - y0) + padH + 0.6;
  const base = new THREE.Mesh(new THREE.BoxGeometry(baseW, 2.5, baseD), MAT.blackBody);
  base.position.set((x0 + x1) / 2, 2.5 / 2 + 0.05, (y0 + y1) / 2);
  g.add(base);
  for (const p of fp.pads) {
    const pin = new THREE.Mesh(new THREE.BoxGeometry(0.64, 6, 0.64), MAT.gold);
    pin.position.set(p.x, 3, p.y);
    g.add(pin);
  }
  return g;
}

/** 从 2D 焊盘数据构建通用 3D 模型 —— 引脚位于每个焊盘的真实位置，与 2D 布局严格一致。
 *  SMD 矩形焊盘 → 金属引脚片；圆形小盘(<1.2mm) → 焊球(WLCSP/BGA)；圆形大盘 → 通孔引脚。 */
/** 封装族基色 → 材质（按色值缓存，避免每个器件都新建材质） */
const bodyMatCache = new Map<number, THREE.MeshStandardMaterial>();
function bodyMatFor(fpName: string): THREE.MeshStandardMaterial {
  const c = bodyColorForFootprint(fpName);
  let m = bodyMatCache.get(c);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: 0.2 });
    bodyMatCache.set(c, m);
  }
  return m;
}

function makeFromPads(fp: import('../../design-core/geometry/footprint-pads').PadFootprint, fpName: string): THREE.Group {
  const g = new THREE.Group();
  const N = fpName.toUpperCase();
  const isBall = fp.pads.every((p) => p.round) && /(WLCSP|BGA|CSP)/.test(N);
  // 高度：datasheet 机械图提取的真实高度（fp.heightMm，定制器件向导写入）优先；
  // 没有真实数据时才按封装类型+尺寸启发式估计。真实 STEP 加载成功后整体替换本模型。
  // 高度真值统一由 design-core/enclosure 提供：3D 渲染与外壳干涉检查必须用同一套数字，
  // 否则"3D 看着装得下、检查说装不下"这种矛盾迟早出现。
  const bodyT = componentBodyHeight(fpName).bodyMm;
  // 本体按封装族取基色：STEP 加载失败时兜底模型也有层次，而非整板黑盒
  const body = new THREE.Mesh(new THREE.BoxGeometry(fp.bodyW, bodyT, fp.bodyH), bodyMatFor(fpName));
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
      // 通孔引脚：向上穿过本体、向下穿出板底（板厚 1.6mm），背面能看到管脚
      const above = Math.max(2.5, bodyT + 0.8);
      const below = 2.4;
      const pinH = above + below;
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.28, pinH, 10), MAT.gold);
      pin.position.set(p.x, above - pinH / 2, p.y);
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
    if (real) return applyModelTransform(real, comp.display?.modelTransform);
    ensureStepModel(stepUrl, comp.footprint.name);
  }
  const fp = comp.footprint.name;
  let group: THREE.Group;

  // 导入的 KiCad 封装名：按器件族给形状与配色，避免整板一个颜色
  const K = fp.toUpperCase();

  /**
   * 测试点 / 定位孔：板上没有"器件本体"，只有一片裸露的圆形焊盘（或一个孔）。
   * 此前落到通用分支画成黑色方块 —— 板子看上去多了几十个不存在的小器件。
   */
  if (/^TESTPOINT/.test(K)) {
    const g = new THREE.Group();
    const d = parseFloat(K.match(/_D(\d+(?:\.\d+)?)MM/)?.[1] ?? '1');
    // 裸铜/沉金焊盘：薄圆片贴在板面上，略高于阻焊
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, 0.05, 24), MAT.gold);
    pad.position.y = 0.025;
    g.add(pad);
    return g;
  }
  if (/^MOUNTINGHOLE/.test(K)) {
    const g = new THREE.Group();
    const d = parseFloat(K.match(/^MOUNTINGHOLE_(\d+(?:\.\d+)?)MM/)?.[1] ?? '3.2');
    // 只画一圈铜环示意（孔本身由板框几何开出），不画本体
    const ring = new THREE.Mesh(new THREE.RingGeometry(d / 2, d / 2 + 0.6, 24), MAT.gold);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    g.add(ring);
    return g;
  }
  const chipSize = (): [number, number, number] | null => {
    const m = K.match(/_(\d{4})_/);
    const map: Record<string, [number, number, number]> = {
      '0201': [0.6, 0.3, 0.3], '0402': [1.0, 0.5, 0.5], '0603': [1.6, 0.8, 0.8],
      '0805': [2.0, 1.25, 1.1], '1206': [3.2, 1.6, 1.1], '1210': [3.2, 2.5, 1.3],
    };
    return m && map[m[1]] ? map[m[1]] : null;
  };
  const cs = chipSize();
  if (cs) {
    if (/^R_/.test(K)) return makeChipComponent(cs[0], cs[1], cs[2], MAT.blackBody, MAT.tin);   // 电阻：黑体银端
    if (/^C_/.test(K)) return makeChipComponent(cs[0], cs[1], cs[2], MAT.capBeige, MAT.tin);    // MLCC：米色
    if (/^L_|^FB_/.test(K)) return makeChipComponent(cs[0], cs[1], cs[2], MAT.darkBody, MAT.tin); // 电感/磁珠
    if (/^LED_/.test(K)) return makeChipComponent(cs[0], cs[1], cs[2], MAT.white, MAT.tin);      // LED：白色透亮
    if (/^D_/.test(K)) return makeChipComponent(cs[0], cs[1], cs[2], MAT.darkBody, MAT.tin);
    if (/^FUSE_/.test(K)) return makeChipComponent(cs[0], cs[1], cs[2], MAT.capBrown, MAT.tin);
  }
  // 2.54mm 排针/排母
  const hdr = K.match(/PINHEADER_(\d)X(\d{1,2})|PINSOCKET_(\d)X(\d{1,2})/);
  if (hdr) {
    // 优先按**真实焊盘**建模：名字里的 1x12 只说明有几排几位，
    // 说不清排布方向（KiCad 的 1x12 焊盘是沿 Y 排成一列），也说不清卧式封装的本体偏移。
    // 此前把两个数字当成 rows/cols 直接用，模型整体转了 90°，看起来就是"3D 错位"。
    const hdrPads = padFootprintFor(fp);
    if (hdrPads && hdrPads.pads.length >= 2) return makeHeaderFromPads(hdrPads);
    const cols = Number(hdr[1] ?? hdr[3] ?? 1);   // 第一个数 = 排数（X 方向）
    const rows = Number(hdr[2] ?? hdr[4] ?? 2);   // 第二个数 = 每排位数（Y 方向）
    return makeHeader(cols, rows);
  }
  if (/^USB_C_/.test(K)) return makeUsbC();
  if (/CRYSTAL|OSCILLATOR/.test(K)) {
    const pf = padFootprintFor(comp.footprint.name);
    return makeCan(pf ? Math.max(pf.bodyW, pf.bodyH) : 3.2, 1.0);
  }

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
