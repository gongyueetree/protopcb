/**
 * design-core/geometry/pad-types.ts
 * 焊盘与封装的基础类型 —— 叶子模块，不 import 任何东西。
 * 此前定义在 footprint-pads.ts，解析器/注册表反过来 import 它形成环。
 */
export interface Pad {
  /** 焊盘中心相对封装中心 (mm) */
  x: number;
  y: number;
  /** 焊盘尺寸 (mm) */
  w: number;
  h: number;
  /**
   * 引脚号。string | number 联合：BGA/WLCSP 的真实球号是 "A1"/"B3" 这类字符串，
   * 早期 numeric 设计会把 A1 压成 1，属于工程级错误。内部比较一律用 String(num)。
   */
  num: string | number;
  /** 圆形焊盘（THT）时为 true */
  round?: boolean;
}

export interface PadFootprint {
  /**
   * 近似封装标记：由参数猜测（如 BGA 按 body+pitch 铺球）而非真实数据生成。
   * 带此标记的封装在 trust 体系中只能是 CANDIDATE/PLACEHOLDER，不能 VERIFIED。
   */
  approximate?: boolean;
  /** 器件本体高度 mm（datasheet 机械图提取；3D 参数化模型优先使用） */
  heightMm?: number;
  /** 本体丝印外框 (mm) */
  bodyW: number;
  bodyH: number;
  /** 本体中心相对封装原点的偏移 (mm)：卧式晶振等本体偏在引脚一侧的封装非零 */
  bodyCx?: number;
  bodyCy?: number;
  pads: Pad[];
  /** 引脚1标记位置 (mm)，可选 */
  pin1?: { x: number; y: number };
}
