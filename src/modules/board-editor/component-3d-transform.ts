/**
 * modules/board-editor/component-3d-transform.ts
 * 器件 3D 摆位的**唯一**实现 —— BoardView3D（透视全视图）与
 * PcbProjection3DLayer（正交投影层）都调用它。
 *
 * 为什么必须共用：Top/Bottom 的翻转与旋转镜像规则一旦两处各写一份，
 * 迟早出现"3D 全视图对、投影层反了"这种只在某个角度才暴露的错位。
 */
import type { PlacedComponent, BoardDefinition } from '../../design-core/document/types';

export interface Component3DPose {
  /** 场景坐标：以板中心为原点，x 向右、z 向下（对应板坐标 y）、y 向上 */
  x: number; y: number; z: number;
  /** 绕 X 轴（底层翻面用，弧度） */
  rotX: number;
  /** 绕 Y 轴（板面内旋转，弧度） */
  rotY: number;
}

export interface PoseOptions {
  /** PCB 板厚（mm）；底层器件挂在板下方 */
  boardThicknessMm?: number;
}

/** 计算器件在场景中的位姿（纯函数，可单测） */
export function componentPose(
  comp: PlacedComponent,
  board: BoardDefinition,
  opts: PoseOptions = {},
): Component3DPose {
  const boardThk = opts.boardThicknessMm ?? 1.6;
  const localX = comp.placement.xMm - board.widthMm / 2;
  const localZ = comp.placement.yMm - board.heightMm / 2;
  const zOff = comp.display?.zOffsetMm ?? 0;
  const rad = (comp.placement.rotation * Math.PI) / 180;

  if (comp.placement.side === 'BOTTOM') {
    // 底层：绕 X 轴翻 180° 挂到板下方；翻面后板面内的旋转方向取镜像，
    // 这样从板底看过去，3D 引脚与 2D 底层焊盘（scale(-1,1) 镜像）落点一致。
    return { x: localX, y: -boardThk - zOff, z: localZ, rotX: Math.PI, rotY: -rad };
  }
  return { x: localX, y: zOff, z: localZ, rotX: 0, rotY: rad };
}

/** 把位姿应用到 Three.js 对象（只写 position/rotation，不碰其它属性） */
export function applyComponent3DTransform(
  object: { position: { set(x: number, y: number, z: number): void }; rotation: { x: number; y: number } },
  comp: PlacedComponent,
  board: BoardDefinition,
  opts: PoseOptions = {},
): Component3DPose {
  const p = componentPose(comp, board, opts);
  object.position.set(p.x, p.y, p.z);
  object.rotation.x = p.rotX;
  object.rotation.y = p.rotY;
  return p;
}
