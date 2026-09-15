/**
 * PCB 板面贴图：把 2D 版图画进 CanvasTexture，贴到 3D 板体的上下表面。
 *
 * 3D 观感的最大缺口不在器件而在板子——整块纯绿挤出体没有铜箔、焊盘和丝印。
 * 这里复用画布已有的数据（导入的走线/过孔、每个器件的真实焊盘、位号），
 * 在离屏 canvas 上按真实毫米坐标绘制，再作为纹理贴上去。
 *
 * 坐标：canvas 像素 = mm × PX_PER_MM_TEX，原点为板左上角，与 2D 画布一致。
 */
import * as THREE from 'three';
import type { CircuitCanvasDocument, PlacedComponent } from '../../design-core/document/types';
import { padFootprintFor } from '../../design-core/geometry/footprint-pads';

/** 贴图分辨率：每毫米像素数。8 px/mm 在 51×23mm 板上约 408×184，足够看清丝印又不吃显存 */
const PX_PER_MM_TEX = 8;
const MAX_TEX_PX = 4096;

const C = {
  soldermask: '#0f5132',      // 阻焊绿
  maskShade: '#0b3d27',       // 暗部（营造质感）
  copper: '#b8863b',          // 走线铜
  copperBottom: '#8a6a34',
  pad: '#d9b45b',             // 焊盘沉金
  padHole: '#2a2a2a',
  silk: '#e8e8e6',            // 丝印白
  viaRing: '#c9a24b',
};

/** 器件焊盘在板坐标系中的位置（含器件旋转，与 2D/导出一致：KiCad 逆时针 → -rot） */
function padsOf(c: PlacedComponent): { x: number; y: number; w: number; h: number; round: boolean }[] {
  const fp = padFootprintFor(c.footprint.name);
  if (!fp) return [];
  const deg = -c.placement.rotation * Math.PI / 180;
  const cos = Math.cos(deg), sin = Math.sin(deg);
  const swap = Math.abs(c.placement.rotation % 180) === 90;
  return fp.pads.map((p) => ({
    x: c.placement.xMm + p.x * cos - p.y * sin,
    y: c.placement.yMm + p.x * sin + p.y * cos,
    w: swap ? p.h : p.w,
    h: swap ? p.w : p.h,
    round: !!p.round,
  }));
}

/**
 * 生成板面贴图。side='top' 画顶层铜箔+丝印，'bottom' 画底层。
 * 返回 null 表示板尺寸异常，调用方回退到纯色材质。
 */
/**
 * @param opts.showRefDes 位号总开关（与 2D 画布共用同一个 store 状态）。
 *   此前贴图只看每个器件自己的 refDesDisplay.hidden，全局开关根本没传进来，
 *   2D 关了位号、3D 板面上照样一片位号。
 */
export function buildBoardTexture(doc: CircuitCanvasDocument, side: 'top' | 'bottom', opts: { showRefDes?: boolean } = {}): THREE.CanvasTexture | null {
  const W = doc.board.widthMm, H = doc.board.heightMm;
  if (!(W > 0) || !(H > 0)) return null;

  const scale = Math.min(PX_PER_MM_TEX, MAX_TEX_PX / Math.max(W, H));
  const cw = Math.max(2, Math.round(W * scale));
  const ch = Math.max(2, Math.round(H * scale));
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const g = cv.getContext('2d');
  if (!g) return null;

  const X = (mm: number) => mm * scale;
  const Y = (mm: number) => mm * scale;

  // ── 阻焊底色 + 轻微噪点，避免纯色塑料感 ──
  g.fillStyle = C.soldermask;
  g.fillRect(0, 0, cw, ch);
  g.fillStyle = C.maskShade;
  for (let i = 0; i < (cw * ch) / 900; i++) {
    g.fillRect(Math.random() * cw, Math.random() * ch, 1, 1);
  }

  // ── 铜箔走线（导入工程带来的真实线宽）──
  const layerKey = side === 'top' ? 'top' : 'bottom';
  g.lineCap = 'round';
  g.strokeStyle = side === 'top' ? C.copper : C.copperBottom;
  for (const t of doc.tracks ?? []) {
    if (t.layer !== layerKey) continue;
    g.lineWidth = Math.max(0.8, t.w * scale);
    g.beginPath();
    g.moveTo(X(t.x1), Y(t.y1));
    g.lineTo(X(t.x2), Y(t.y2));
    g.stroke();
  }

  // ── 过孔（两面都可见）──
  for (const v of doc.vias ?? []) {
    const r = Math.max(1, (v.size / 2) * scale);
    g.fillStyle = C.viaRing;
    g.beginPath(); g.arc(X(v.x), Y(v.y), r, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.padHole;
    g.beginPath(); g.arc(X(v.x), Y(v.y), r * 0.45, 0, Math.PI * 2); g.fill();
  }

  // ── 焊盘（本层器件）──
  const sideKey = side === 'top' ? 'TOP' : 'BOTTOM';
  for (const c of doc.components) {
    if (c.placement.side !== sideKey) continue;
    g.fillStyle = C.pad;
    for (const p of padsOf(c)) {
      const w = Math.max(1, p.w * scale), h = Math.max(1, p.h * scale);
      const x = X(p.x) - w / 2, y = Y(p.y) - h / 2;
      if (p.round) {
        g.beginPath(); g.arc(X(p.x), Y(p.y), Math.max(w, h) / 2, 0, Math.PI * 2); g.fill();
        g.fillStyle = C.padHole;
        g.beginPath(); g.arc(X(p.x), Y(p.y), Math.max(w, h) / 4, 0, Math.PI * 2); g.fill();
        g.fillStyle = C.pad;
      } else {
        const r = Math.min(w, h) * 0.18;
        g.beginPath();
        g.moveTo(x + r, y);
        g.arcTo(x + w, y, x + w, y + h, r);
        g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r);
        g.arcTo(x, y, x + w, y, r);
        g.closePath(); g.fill();
      }
    }
  }

  // ── 丝印位号（受总开关控制）──
  g.fillStyle = C.silk;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const c of doc.components) {
    if (opts.showRefDes === false) break;
    if (c.placement.side !== sideKey) continue;
    if (c.refDesDisplay?.hidden) continue;
    const fp = padFootprintFor(c.footprint.name);
    const bodyH = fp?.bodyH ?? 1.5;
    const fs = Math.max(5, Math.min(1.2 * scale, bodyH * scale * 0.7));
    g.font = `600 ${fs}px ui-monospace, monospace`;
    const dx = c.refDesDisplay?.dx ?? 0;
    const dy = c.refDesDisplay?.dy ?? 0;
    g.fillText(c.reference, X(c.placement.xMm + dx), Y(c.placement.yMm + dy - bodyH / 2 - 0.5));
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  // 底面在 3D 中是镜像观察的，横向翻转让丝印文字方向正确
  if (side === 'bottom') { tex.wrapS = THREE.RepeatWrapping; tex.repeat.x = -1; tex.offset.x = 1; }
  tex.needsUpdate = true;
  return tex;
}
