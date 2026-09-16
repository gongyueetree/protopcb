/**
 * modules/component-search/Component3DPreview.tsx
 * 详情面板内嵌 3D 预览 —— 显示当前器件的立体模型。
 * 真实 STEP（转换缓存就绪时）优先，否则参数化模型；拖拽旋转 · 滚轮缩放 · 自动慢转。
 */
import { tr } from '../../shared/i18n';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { buildStudioEnvironment } from '../board-editor/studio-env';
import type { PlacedComponent } from '../../design-core/document/types';
import { buildComponent3D } from '../board-editor/footprint3d';
import { stepStatusFor, stepFailReasonFor } from '../board-editor/step-loader';
import { useLibFileStore } from '../../state/libFileStore';

export function Component3DPreview({ c }: { c: PlacedComponent }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const version = useLibFileStore((s) => s.version); // STEP 转换完成时重建
  const [webglFail, setWebglFail] = useState(false);
  const rot = useRef({ x: -0.62, y: 0.72, dragging: false, sx: 0, sy: 0, auto: true });
  const zoomRef = useRef(1);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setWebglFail(true);
      return;
    }
    const W = el.clientWidth || 300, H = 180;
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.4;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    // studio 环境反射（明暗分区 → 金属高光有层次，非平灰）
    scene.environment = buildStudioEnvironment(renderer);

    // 三点光：主光 + 补光 + 轮廓光
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(5, 9, 6);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdce6f2, 0.55);
    fill.position.set(-6, 3, 5);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.set(-2, 4, -7);
    scene.add(rim);

    // 模型：buildComponent3D 内部已做 STEP 缓存优先 + 触发异步转换
    const pivot = new THREE.Group();
    const model = buildComponent3D(c);
    // 居中 + 归一化尺寸
    const box = new THREE.Box3().setFromObject(model);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    model.position.sub(center);
    pivot.add(model);
    scene.add(pivot);

    const maxDim = Math.max(size.x, size.y, size.z, 0.5);
    const camera = new THREE.PerspectiveCamera(40, W / H, 0.01, maxDim * 50);
    const baseDist = maxDim * 2.4;
    camera.position.set(0, 0, baseDist);


    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      if (rot.current.auto && !rot.current.dragging) rot.current.y += 0.006;
      pivot.rotation.x = rot.current.x;
      pivot.rotation.y = rot.current.y;
      camera.position.z = baseDist / zoomRef.current;
      renderer.render(scene, camera);
    };
    animate();

    const onDown = (e: MouseEvent) => { rot.current.dragging = true; rot.current.auto = false; rot.current.sx = e.clientX; rot.current.sy = e.clientY; };
    const onMove = (e: MouseEvent) => {
      if (!rot.current.dragging) return;
      rot.current.y += (e.clientX - rot.current.sx) * 0.01;
      rot.current.x += (e.clientY - rot.current.sy) * 0.01;
      rot.current.x = Math.max(-1.4, Math.min(1.4, rot.current.x));
      rot.current.sx = e.clientX; rot.current.sy = e.clientY;
    };
    const onUp = () => { rot.current.dragging = false; };
    const onWheel = (e: WheelEvent) => { e.preventDefault(); zoomRef.current = Math.min(6, Math.max(0.4, zoomRef.current * (e.deltaY > 0 ? 0.9 : 1.12))); };
    const onDbl = () => { rot.current.x = -0.62; rot.current.y = 0.72; rot.current.auto = true; zoomRef.current = 1; };
    renderer.domElement.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    renderer.domElement.addEventListener('dblclick', onDbl);

    return () => {
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.domElement.removeEventListener('dblclick', onDbl);
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      scene.environment?.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
    // version 变化（STEP 转换完成）时整体重建，切换到真实模型
  }, [c.instanceId, c.footprint.name, version]);

  const st = stepStatusFor(c.display?.stepUrl);
  const isProjectModel = !!c.display?.stepUrl?.startsWith('blob:');
  const label = c.display?.sessionModelLost && !c.display?.stepUrl
    ? [tr('工程自带 3D 模型已随会话失效 · 重新导入 zip 可恢复 · 参数化预览'), '#854d0e', '#fef9c3']
    : st === 'ready' ? [tr(isProjectModel ? '工程自带 STEP 模型 ✓' : 'ezPLM 真实 STEP 模型 ✓'), '#166534', '#dcfce7']
    : st === 'loading' ? [tr('STEP 转换中…（首次需下载 3D 引擎）· 暂为参数化'), '#854d0e', '#fef9c3']
    : st === 'failed' && /无匹配模型|no step model/.test(stepFailReasonFor(c.display?.stepUrl) ?? '')
      ? [tr('官方 3D 库未收录该封装 · 参数化预览'), '#64748b', '#f1f5f9']
    : st === 'failed' ? [tr('STEP 失败') + '：' + (stepFailReasonFor(c.display?.stepUrl)?.slice(0, 60) ?? '未知') + ' · ' + tr('参数化预览'), '#991b1b', '#fee2e2']
    : c.display?.stepUrl ? [tr('准备转换 STEP…'), '#854d0e', '#fef9c3']
    : [tr('参数化 3D 预览'), '#64748b', '#f1f5f9'];

  if (webglFail) return <div style={{ padding: 12, fontSize: 10.5, color: '#94a3b8' }}>{tr('当前浏览器不支持 WebGL，无法显示 3D 预览')}</div>;

  return (
    <div>
      <div ref={boxRef} title={tr('拖拽旋转 · 滚轮缩放 · 双击复位')} style={{ height: 190, borderRadius: 6, background: '#ffffff', cursor: 'grab', overflow: 'hidden' }} />
      <div style={{ marginTop: 5 }}>
        <span style={{ fontSize: 9, padding: '1px 7px', borderRadius: 4, fontWeight: 700, color: label[1], background: label[2] }}>{label[0]}</span>
      </div>
    </div>
  );
}
