/**
 * modules/block-diagram/shapes.tsx
 * 框图形状定义与渲染（draw.io 风格基础形状）。
 */
import type { JSX } from 'react';
import { tr } from '../../shared/i18n';

export const BD_COLORS = ['#1a6b3c', '#b45309', '#0e7490', '#6d28d9', '#be185d', '#4b5563', '#0369a1', '#a16207'];

/** 形状清单：名称需随语言变化，故用函数而非模块级常量（常量只在加载时求值一次） */
export const bdShapes = (): { id: string; name: string; icon: string }[] => ([
  { id: 'rounded', name: tr('圆角矩形'), icon: '▢' },
  { id: 'rect', name: tr('矩形'), icon: '□' },
  { id: 'diamond', name: tr('菱形'), icon: '◇' },
  { id: 'ellipse', name: tr('椭圆'), icon: '○' },
  { id: 'hexagon', name: tr('六边形'), icon: '⬡' },
  { id: 'parallelogram', name: tr('平行四边形'), icon: '▱' },
  { id: 'cylinder', name: tr('圆柱'), icon: '⌸' },
  { id: 'triangle', name: tr('三角形'), icon: '△' },
]);

interface ShapeProps {
  shape: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  fillOpacity?: number;
  stroke: string;
  strokeWidth?: number;
  strokeDasharray?: string;
}

export function BdShape({ shape, x, y, w, h, fill, fillOpacity = 1, stroke, strokeWidth = 1.5, strokeDasharray }: ShapeProps): JSX.Element {
  const common = { fill, fillOpacity, stroke, strokeWidth, strokeDasharray };
  switch (shape) {
    case 'rect':
      return <rect x={x} y={y} width={w} height={h} {...common} />;
    case 'diamond':
      return <polygon points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`} {...common} />;
    case 'ellipse':
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
    case 'hexagon': {
      const q = w * 0.22;
      return <polygon points={`${x + q},${y} ${x + w - q},${y} ${x + w},${y + h / 2} ${x + w - q},${y + h} ${x + q},${y + h} ${x},${y + h / 2}`} {...common} />;
    }
    case 'parallelogram': {
      const s = w * 0.2;
      return <polygon points={`${x + s},${y} ${x + w},${y} ${x + w - s},${y + h} ${x},${y + h}`} {...common} />;
    }
    case 'cylinder': {
      const ry = h * 0.12;
      return (
        <g>
          <path d={`M${x},${y + ry} A${w / 2},${ry} 0 0,1 ${x + w},${y + ry} L${x + w},${y + h - ry} A${w / 2},${ry} 0 0,1 ${x},${y + h - ry} Z`} {...common} />
          <ellipse cx={x + w / 2} cy={y + ry} rx={w / 2} ry={ry} fill={fill} fillOpacity={fillOpacity} stroke={stroke} strokeWidth={strokeWidth} />
        </g>
      );
    }
    case 'triangle':
      return <polygon points={`${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}`} {...common} />;
    default: // rounded
      return <rect x={x} y={y} width={w} height={h} rx={10} {...common} />;
  }
}
