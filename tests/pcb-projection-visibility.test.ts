/**
 * 混合视图的显隐：单件隐藏后焊盘/选中/网络高亮必须仍然存在
 * （这是本功能的核心承诺：藏的只是 3D 模型，不是器件）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { usePcbViewStore } from '../src/state/pcbViewStore';
import { useDesignStore } from '../src/state/designStore';
import { padFootprintFor } from '../src/design-core/geometry/footprint-pads';
import type { ComponentSearchResult } from '../src/providers/types';

const part = (mpn: string, fp: string, cat = 'ic'): ComponentSearchResult => ({
  componentId: 'ez_' + mpn, mpn, manufacturer: '—', category: cat,
  defaultFootprintName: fp, family: 'X', pins: 8,
} as ComponentSearchResult);

/** 测试板：模块 + QFN + SOIC + 0603 + USB-C + 按键 */
function goldenBoard() {
  const ds = useDesignStore.getState();
  ds.clearAll();
  ds.setBoardSize(100, 80);
  ds.addComponent(part('ESP32-WROOM-32', 'ESP32-WROOM-32', 'rf'));
  ds.addComponent(part('TPS5430DDAR', 'QFN-16-1EP_4x4mm_P0.65mm'));
  ds.addComponent(part('LM358', 'SOIC-8_3.9x4.9mm_P1.27mm'));
  ds.addComponent(part('RC0603FR-0710KL', 'R_0603_1608Metric', 'passive'));
  ds.addComponent(part('USB-C-16P', 'USB_C_Receptacle_USB2.0', 'connector'));
  ds.addComponent(part('SW-TACT', 'SW_SPST_TL3342', 'electromech'));
  return useDesignStore.getState().doc.components;
}

describe('Golden 场景：隐藏 QFN 的 3D', () => {
  beforeEach(() => usePcbViewStore.getState().resetViewOptions());

  it('6 个器件全部上板', () => {
    expect(goldenBoard()).toHaveLength(6);
  });

  it('隐藏 QFN 后：该件 3D 不可见，其它件不受影响', () => {
    const comps = goldenBoard();
    const qfn = comps.find((c) => c.mpn === 'TPS5430DDAR')!;
    usePcbViewStore.getState().hideComponent3D(qfn.instanceId);
    const vs = usePcbViewStore.getState();
    expect(vs.is3DVisible(qfn.instanceId)).toBe(false);
    for (const c of comps.filter((x) => x !== qfn)) {
      expect(vs.is3DVisible(c.instanceId)).toBe(true);
    }
  });

  it('隐藏 3D 不影响器件本身：焊盘数据、位置、选中都还在', () => {
    const comps = goldenBoard();
    const qfn = comps.find((c) => c.mpn === 'TPS5430DDAR')!;
    const padsBefore = padFootprintFor(qfn.footprint.name)?.pads.length ?? 0;
    usePcbViewStore.getState().hideComponent3D(qfn.instanceId);
    useDesignStore.getState().select(qfn.instanceId);

    const after = useDesignStore.getState();
    const still = after.doc.components.find((c) => c.instanceId === qfn.instanceId)!;
    expect(still).toBeTruthy();
    expect(padFootprintFor(still.footprint.name)?.pads.length).toBe(padsBefore);
    expect(after.selectedId).toBe(qfn.instanceId);
  });

  it('隐藏全部 3D 后，所有器件仍在文档里（只是不渲染模型）', () => {
    const comps = goldenBoard();
    usePcbViewStore.getState().hideAll3D(comps.map((c) => c.instanceId));
    expect(useDesignStore.getState().doc.components).toHaveLength(6);
    expect(comps.every((c) => !usePcbViewStore.getState().is3DVisible(c.instanceId))).toBe(true);
  });

  it('恢复默认后全部 3D 回来', () => {
    const comps = goldenBoard();
    usePcbViewStore.getState().hideAll3D(comps.map((c) => c.instanceId));
    usePcbViewStore.getState().resetViewOptions();
    expect(comps.every((c) => usePcbViewStore.getState().is3DVisible(c.instanceId))).toBe(true);
  });
});
