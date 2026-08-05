/**
 * modules/board-editor/BoardView3D.tsx
 * 真 3D 板视图 —— Three.js WebGL 渲染。
 * 真实 PCB 板 + 参数化 3D 封装，鼠标拖拽旋转、滚轮缩放。仅查看。
 */
import { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useDesignStore } from '../../state/designStore';
import { buildComponent3D, MAT } from './footprint3d';
import { mountingHoleCenters, HOLE_DIAMETER_MM } from '../../design-core/collision';
import { useLibFileStore } from '../../design-core/geometry/lib-file-registry';
import type { CircuitCanvasDocument } from '../../design-core/document/types';

export function BoardView3D() {
  const doc = useDesignStore((s) => s.doc);
  const libVersion = useLibFileStore((s) => s.version);
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    renderer?: THREE.WebGLRenderer; scene?: THREE.Scene; camera?: THREE.PerspectiveCamera;
    boardGroup?: THREE.Group; raf?: number; updateCamera?: () => void;
    rotX: number; rotY: number; dist: number;
  }>({ rotX: -0.9, rotY: 0.3, dist: 220 });

  // init scene once
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const w = mount.clientWidth, h = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c1520);

    const camera = new THREE.PerspectiveCamera(45, w / h, 1, 2000);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      // WebGL 不可用：显示降级提示，避免白屏
      const msg = document.createElement('div');
      msg.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#86efac;font-size:13px;background:#0c1520';
      msg.textContent = '当前环境不支持 WebGL，无法显示 3D 视图';
      mount.appendChild(msg);
      return;
    }
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    // lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(60, 120, 80); scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.4); fill.position.set(-80, 60, -40); scene.add(fill);

    const boardGroup = new THREE.Group();
    scene.add(boardGroup);

    const st = stateRef.current;
    st.renderer = renderer; st.scene = scene; st.camera = camera; st.boardGroup = boardGroup;

    const updateCamera = () => {
      const { rotX, rotY, dist } = st;
      // 球面坐标：rotX = 俯仰(负=俯视), rotY = 方位
      const cosX = Math.cos(rotX);
      camera.position.set(
        dist * cosX * Math.sin(rotY),
        dist * -Math.sin(rotX),
        dist * cosX * Math.cos(rotY)
      );
      camera.lookAt(0, 0, 0);
    };
    updateCamera();
    st.updateCamera = updateCamera;

    const animate = () => { st.raf = requestAnimationFrame(animate); renderer.render(scene, camera); };
    animate();

    // interactions
    let dragging = false, sx = 0, sy = 0;
    const onDown = (e: MouseEvent) => { dragging = true; sx = e.clientX; sy = e.clientY; };
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      st.rotY += (e.clientX - sx) * 0.008;
      st.rotX = Math.max(-1.45, Math.min(1.45, st.rotX - (e.clientY - sy) * 0.008));
      sx = e.clientX; sy = e.clientY;
      updateCamera();
    };
    const onUp = () => { dragging = false; };
    const onWheel = (e: WheelEvent) => { e.preventDefault(); st.dist = Math.max(80, Math.min(600, st.dist * (e.deltaY > 0 ? 1.1 : 0.9))); updateCamera(); };
    renderer.domElement.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    const onResize = () => {
      if (!mount) return;
      const nw = mount.clientWidth, nh = mount.clientHeight;
      camera.aspect = nw / nh; camera.updateProjectionMatrix(); renderer.setSize(nw, nh);
    };
    window.addEventListener('resize', onResize);

    return () => {
      if (st.raf) cancelAnimationFrame(st.raf);
      renderer.domElement.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // rebuild board + components when doc changes
  useEffect(() => {
    const st = stateRef.current;
    if (!st.boardGroup) return;
    rebuildBoard(st.boardGroup, doc);
  }, [doc.board.widthMm, doc.board.heightMm, doc.board.shape, doc.board.mountingHolesEnabled, doc.components, libVersion]);

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%', cursor: 'grab' }} />
      <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', padding: '5px 14px', borderRadius: 16, background: 'rgba(255,255,255,.08)', border: '1px solid rgba(134,239,172,.25)', color: '#86efac', fontSize: 11, fontWeight: 600, pointerEvents: 'none' }}>
        🖱 拖拽旋转 · 滚轮缩放 · 真实 3D 封装
      </div>
      <div style={{ position: 'absolute', bottom: 12, right: 12, display: 'flex', gap: 6 }}>
        <button onClick={() => { const st = stateRef.current; st.rotX = -1.35; st.rotY = 0; st.dist = 200; st.updateCamera?.(); }}
          style={vbtn}>⬆ 顶视Top</button>
        <button onClick={() => { const st = stateRef.current; st.rotX = 1.35; st.rotY = 0; st.dist = 200; st.updateCamera?.(); }}
          style={vbtn}>⬇ 看Bottom</button>
        <button onClick={() => { const st = stateRef.current; st.rotX = -0.9; st.rotY = 0.3; st.dist = 220; st.updateCamera?.(); }}
          style={vbtn}>⟳ 复位视角</button>
      </div>
    </div>
  );
}

/** 重建板 + 器件。坐标：板中心为原点，x 右、z 下（对应 2D 的 y）、y 上。 */
const vbtn: React.CSSProperties = { padding: '6px 12px', borderRadius: 8, border: '1px solid rgba(134,239,172,.3)', background: 'rgba(255,255,255,.08)', color: '#86efac', fontSize: 11, fontWeight: 700, cursor: 'pointer' };

function rebuildBoard(group: THREE.Group, doc: CircuitCanvasDocument) {
  // clear
  while (group.children.length) { const c = group.children[0]; group.remove(c); disposeObj(c); }

  const W = doc.board.widthMm, H = doc.board.heightMm;
  // PCB 板（厚 1.6mm）
  const boardThk = 1.6;
  let boardMesh: THREE.Mesh;
  if (doc.board.shape === 'circle') {
    const geo = new THREE.CylinderGeometry(Math.min(W, H) / 2, Math.min(W, H) / 2, boardThk, 64);
    boardMesh = new THREE.Mesh(geo, MAT.pcbGreen);
    boardMesh.position.y = -boardThk / 2;
  } else {
    // 用 Shape 构造圆角矩形 / L 形，再挤出厚度
    const shape = new THREE.Shape();
    if (doc.board.shape === 'lshape') {
      const cutW = W * 0.45, cutH = H * 0.4;
      shape.moveTo(-W / 2, -H / 2);
      shape.lineTo(W / 2, -H / 2);
      shape.lineTo(W / 2, H / 2 - cutH);
      shape.lineTo(W / 2 - cutW, H / 2 - cutH);
      shape.lineTo(W / 2 - cutW, H / 2);
      shape.lineTo(-W / 2, H / 2);
      shape.lineTo(-W / 2, -H / 2);
    } else {
      // 矩形 / 圆角矩形
      const r = doc.board.shape === 'rounded' ? Math.min(W, H) * 0.08 : 1.5;
      roundedRectShape(shape, W, H, r);
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: boardThk, bevelEnabled: false });
    geo.rotateX(Math.PI / 2); // 让挤出方向朝 y
    boardMesh = new THREE.Mesh(geo, MAT.pcbGreen);
    boardMesh.position.y = 0;
  }
  group.add(boardMesh);

  // 安装孔（由文档开关控制）
  for (const c of mountingHoleCenters(doc.board)) {
    const hole = new THREE.Mesh(new THREE.CylinderGeometry(HOLE_DIAMETER_MM / 2, HOLE_DIAMETER_MM / 2, boardThk + 0.2, 20), MAT.metalCan);
    hole.position.set(c.x - W / 2, 0, c.y - H / 2);
    group.add(hole);
  }

  // 器件：2D 坐标 (xMm,yMm) 是相对板左上角；转成以板中心为原点
  for (const comp of doc.components) {
    const model = buildComponent3D(comp);
    const localX = comp.placement.xMm - W / 2;
    const localZ = comp.placement.yMm - H / 2;
    if (comp.placement.side === 'BOTTOM') {
      // 底层：翻到板下方（绕 X 轴翻转 180°），旋转取镜像
      model.position.set(localX, -boardThk, localZ);
      model.rotation.x = Math.PI;
      model.rotation.y = -(comp.placement.rotation * Math.PI) / 180;
    } else {
      model.position.set(localX, 0, localZ);
      model.rotation.y = (comp.placement.rotation * Math.PI) / 180;
    }
    group.add(model);
  }
}

function roundedRectShape(s: THREE.Shape, w: number, h: number, r: number) {
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
}

function disposeObj(obj: THREE.Object3D) {
  obj.traverse((o: THREE.Object3D) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
}
