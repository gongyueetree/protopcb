/**
 * modules/board-editor/PcbProjection3DLayer.tsx
 * PCB 2D 画布之上的 3D 正交投影层。
 *
 * 设计要点：
 *  1. 只渲染**器件模型**。板框、走线、过孔、焊盘、位号仍由下面的 SVG 负责 ——
 *     那层才是可交互的，WebGL 这层 pointerEvents:none，一个鼠标事件都不抢。
 *  2. 正交相机（不是透视）：目标是"从正上方投影"，透视畸变会让器件与焊盘对不齐。
 *  3. 增量更新：拖动器件只改那一个对象的 transform，缩放平移只动相机，
 *     绝不每帧重建场景 —— 这是这个功能能不能用的分水岭。
 *  4. STEP 复用现有 step-loader：未加载完先显示参数化模型，加载完只换那一个器件。
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useDesignStore } from '../../state/designStore';
import { usePcbViewStore } from '../../state/pcbViewStore';
import { useLibFileStore } from '../../state/libFileStore';
import { buildComponent3D } from './footprint3d';
import { stepStatusFor } from './step-loader';
import { cloneMaterialsForView } from './material-isolation';
import { applyComponent3DTransform } from './component-3d-transform';
import { orthoCameraParams } from './board-view-constants';
import type { PlacedComponent } from '../../design-core/document/types';

const BOARD_THK = 1.6;

/**
 * 决定某个器件的模型是否需要重建。
 *
 * ⚠ 绝不能把全局 libVersion 放进来：任意一个器件的 STEP 加载完成都会 bump 它，
 * 于是 100 个器件的 key 同时变化 → 整板重建。
 * 只取**这一个器件自身**依赖的东西：封装名、STEP 地址、该 STEP 的加载状态。
 */
export function modelKey(c: PlacedComponent, stepStatus: string): string {
  return [c.footprint.name, c.display?.stepUrl ?? '', stepStatus].join('|');
}

export function PcbProjection3DLayer({ activeLayer }: { activeLayer: 'TOP' | 'BOTTOM' }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
  /** instanceId → { object, key }：增量更新的账本 */
  const objectsRef = useRef(new Map<string, { obj: THREE.Group; key: string }>());
  const sizeRef = useRef({ w: 0, h: 0 });
  const frameRef = useRef(0);

  const doc = useDesignStore((s) => s.doc);
  const libVersion = useLibFileStore((s) => s.version);
  const viewport = usePcbViewStore((s) => s.viewport);
  const mode = usePcbViewStore((s) => s.mode);
  const showComponent3D = usePcbViewStore((s) => s.showComponent3D);
  const hidden3dIds = usePcbViewStore((s) => s.hidden3dIds);
  const solo3dId = usePcbViewStore((s) => s.solo3dId);
  const opacity = usePcbViewStore((s) => s.projectionOpacity);

  /* ---------- 初始化：renderer / scene / camera / 灯光 ---------- */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);               // 透明背景：下面的 SVG 要透出来
    renderer.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    // 顶视投影的打光：环境光保底 + 两盏方向光做出立体感（不追求真实阴影）
    scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.35); key.position.set(40, 120, 60); scene.add(key);
    const fill = new THREE.DirectionalLight(0xdbe7f5, 0.5); fill.position.set(-60, 80, -40); scene.add(fill);

    // 正交俯视相机：看向 -Y；up 取 -Z，使场景 z 轴朝屏幕下方，与 2D 的 y 轴同向
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
    camera.up.set(0, 0, -1);
    scene.add(camera);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      sizeRef.current = { w, h };
      // updateStyle 必须为 true：否则 canvas 的 CSS 尺寸不设置，
      // 在 DPR=2 的屏上会以 2 倍尺寸显示，模型整体放大并向右下偏移
      renderer.setSize(w, h);
      syncCamera();   // 尺寸变了相机必须跟着重算，否则首次挂载会停在默认 -1..1 视锥
    });
    ro.observe(host);
    sizeRef.current = { w: host.clientWidth, h: host.clientHeight };
    renderer.setSize(sizeRef.current.w || 1, sizeRef.current.h || 1);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(frameRef.current);
      // 只清理本层自己的资源。器件模型可能与 STEP 缓存共享 geometry/material，
      // 在这里 dispose 会把缓存里的模型一起弄坏 —— 所以只丢弃引用，不 dispose。
      objectsRef.current.clear();
      scene.clear();
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 合并同一帧内的多次重绘请求 */
  const requestRender = () => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const r = rendererRef.current, s = sceneRef.current, c = cameraRef.current;
      if (r && s && c) r.render(s, c);
    });
  };

  /* ---------- 相机同步 ---------- */
  // 抽成函数：视口变化、容器尺寸变化、场景同步三处都调用。
  // 只挂在 viewport 上的话，ResizeObserver 首次回调后相机仍停在默认 -1..1，
  // 要等到下一次视口变化才对齐。
  const syncCamera = () => {
    const cam = cameraRef.current;
    const { w, h } = sizeRef.current;
    if (!cam || !w || !h) return;
    const vp = usePcbViewStore.getState().viewport;
    // 板尺寸也从 store 现读：ResizeObserver 是挂载时注册的，闭包里的 doc.board 是首帧的值，
    // 板框改过之后再拖侧栏，会按旧尺寸算相机（60×40 → 80×60 后错位）
    const board = useDesignStore.getState().doc.board;
    const p = orthoCameraParams(w, h, board.widthMm, board.heightMm, vp);
    cam.left = -p.halfWmm; cam.right = p.halfWmm;
    // up 已经取 (0,0,-1)：相机的 y 轴就是世界 -z，屏幕向下 = 板坐标 y 增大。
    // 这里再把 top/bottom 取反等于翻第二次，整张图会上下颠倒（模型飞到板外的根因之一）。
    cam.top = p.halfHmm; cam.bottom = -p.halfHmm;
    cam.near = 0.1; cam.far = 2000;
    cam.position.set(p.centerXmm, 500, p.centerZmm);
    cam.lookAt(p.centerXmm, 0, p.centerZmm);
    cam.updateProjectionMatrix();
    requestRender();
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { syncCamera(); }, [viewport, doc.board.widthMm, doc.board.heightMm]);

  /* ---------- 场景增量同步 ---------- */
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const map = objectsRef.current;
    const seen = new Set<string>();

    for (const comp of doc.components) {
      seen.add(comp.instanceId);
      const key = modelKey(comp, comp.display?.stepUrl ? stepStatusFor(comp.display.stepUrl) : '-');
      let entry = map.get(comp.instanceId);

      // 模型变了（换封装/STEP 加载完成/库更新）才重建，否则只更新位姿
      if (!entry || entry.key !== key) {
        if (entry) scene.remove(entry.obj);
        const obj = buildComponent3D(comp);
        // STEP 模型是从缓存 clone 出来的，geometry/material 仍与缓存共享。
        // 投影层要改 opacity/transparent，必须先把材质按实例克隆，
        // 否则会顺手改掉 3D 全视图和缓存里同一颗料的材质。
        cloneMaterialsForView(obj);
        scene.add(obj);
        entry = { obj, key };
        map.set(comp.instanceId, entry);
      }
      applyComponent3DTransform(entry.obj, comp, doc.board, { boardThicknessMm: BOARD_THK });

      // 可见性：全局开关 → solo → 单独隐藏 → 当前层
      const st = usePcbViewStore.getState();
      const onActiveLayer = comp.placement.side === activeLayer;
      entry.obj.visible = st.is3DVisible(comp.instanceId) && onActiveLayer;
    }

    // 删除已不存在的器件
    for (const [id, entry] of map) {
      if (seen.has(id)) continue;
      scene.remove(entry.obj);
      map.delete(id);
    }
    syncCamera();   // 顺带对齐相机（便宜，且能吸收任何漏掉的视口更新）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.components, doc.board, libVersion, activeLayer, showComponent3D, hidden3dIds, solo3dId, mode]);

  /* ---------- 透明度 ---------- */
  useEffect(() => {
    for (const { obj } of objectsRef.current.values()) {
      obj.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!m) return;
        for (const mat of Array.isArray(m) ? m : [m]) {
          mat.transparent = opacity < 1;
          mat.opacity = opacity;
        }
      });
    }
    requestRender();
  }, [opacity]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2 }} />;
}
