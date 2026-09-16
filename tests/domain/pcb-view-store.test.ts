/**
 * PCB 视图状态：显隐语义，且绝不触碰设计文档
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { usePcbViewStore } from '../../src/state/pcbViewStore';
import { useDesignStore } from '../../src/state/designStore';
import type { ComponentSearchResult } from '../../src/providers/types';

const part = (mpn: string): ComponentSearchResult => ({
  componentId: 'ez_' + mpn, mpn, manufacturer: '—', category: 'ic',
  defaultFootprintName: 'SOIC-8_3.9x4.9mm_P1.27mm', family: 'IC', pins: 8,
} as ComponentSearchResult);

describe('3D 可见性语义', () => {
  beforeEach(() => usePcbViewStore.getState().resetViewOptions());

  it('默认全部可见', () => {
    expect(usePcbViewStore.getState().is3DVisible('a')).toBe(true);
  });

  it('单件隐藏只影响该件', () => {
    usePcbViewStore.getState().hideComponent3D('a');
    expect(usePcbViewStore.getState().is3DVisible('a')).toBe(false);
    expect(usePcbViewStore.getState().is3DVisible('b')).toBe(true);
  });

  it('toggle 往返', () => {
    const st = () => usePcbViewStore.getState();
    st().toggleComponent3D('a');
    expect(st().is3DVisible('a')).toBe(false);
    st().toggleComponent3D('a');
    expect(st().is3DVisible('a')).toBe(true);
  });

  it('隐藏全部 → 显示全部', () => {
    const st = () => usePcbViewStore.getState();
    st().hideAll3D(['a', 'b', 'c']);
    expect(['a', 'b', 'c'].every((id) => !st().is3DVisible(id))).toBe(true);
    st().showAll3D();
    expect(['a', 'b', 'c'].every((id) => st().is3DVisible(id))).toBe(true);
  });

  it('solo：只看一个，其余不可见；取消后恢复', () => {
    const st = () => usePcbViewStore.getState();
    st().soloComponent3D('b');
    expect(st().is3DVisible('b')).toBe(true);
    expect(st().is3DVisible('a')).toBe(false);
    st().clearSolo3D();
    expect(st().is3DVisible('a')).toBe(true);
  });

  it('总开关关闭时一律不可见（优先级最高）', () => {
    const st = () => usePcbViewStore.getState();
    st().soloComponent3D('b');
    st().setShowComponent3D(false);
    expect(st().is3DVisible('b')).toBe(false);
  });

  it('对单件操作会退出 solo，避免按钮看起来没反应', () => {
    const st = () => usePcbViewStore.getState();
    st().soloComponent3D('a');
    st().toggleComponent3D('a');
    expect(st().solo3dId).toBeNull();
  });
});

describe('视图状态不得写入设计文档', () => {
  it('切模式/隐藏3D/solo 都不改 revision、不入 undo', () => {
    const ds = useDesignStore.getState();
    ds.clearAll();
    ds.addComponent(part('STM32F103C8T6'));
    const before = useDesignStore.getState().doc;
    const rev = before.metadata.revision;
    const updatedAt = before.metadata.updatedAt;
    const pastLen = useDesignStore.getState().past.length;

    const vs = usePcbViewStore.getState();
    vs.setMode('hybrid');
    vs.hideComponent3D(before.components[0].instanceId);
    vs.soloComponent3D(before.components[0].instanceId);
    vs.setViewport({ zoom: 2.5, panX: 100, panY: -40 });

    const after = useDesignStore.getState();
    expect(after.doc.metadata.revision).toBe(rev);
    expect(after.doc.metadata.updatedAt).toBe(updatedAt);
    expect(after.past.length).toBe(pastLen);
    expect(after.doc).toBe(before);          // 文档对象引用都没变
  });
});
