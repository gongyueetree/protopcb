/**
 * modules/board-editor/step-loader.ts
 * 真实 STEP 3D 模型加载 —— OpenCascade WASM (occt-import-js) 浏览器端转换。
 *
 * - 懒加载：只在 3D 视图遇到带 stepUrl 的器件时才加载 WASM（~11MB，一次）
 * - STEP 经 /api/ezplm?path=file 代理拉取（CORS 规避）
 * - 转换成功注册缓存并 bump 版本 → BoardView3D 重建时替换参数化模型
 * - 任一环节失败 → 静默回退参数化模型（不影响使用）
 */
import * as THREE from 'three';
import { useLibFileStore } from '../../design-core/geometry/lib-file-registry';

type OcctModule = {
  ReadStepFile: (content: Uint8Array, params: null) => {
    success: boolean;
    meshes: {
      attributes: { position: { array: number[] }; normal?: { array: number[] } };
      index?: { array: number[] };
      color?: number[];
    }[];
  };
};

let occtPromise: Promise<OcctModule> | null = null;

async function getOcct(): Promise<OcctModule> {
  if (!occtPromise) {
    occtPromise = (async () => {
      const [{ default: occtimportjs }, wasmMod] = await Promise.all([
        import('occt-import-js'),
        import('occt-import-js/dist/occt-import-js.wasm?url'),
      ]);
      return (await occtimportjs({ locateFile: () => wasmMod.default })) as OcctModule;
    })();
  }
  return occtPromise;
}

const modelCache = new Map<string, THREE.Group>(); // key: stepUrl
const bytesCache = new Map<string, Uint8Array>();   // 预取的文件字节（规避签名链接过期）
const inflight = new Set<string>();
const failed = new Set<string>();
const failReason = new Map<string, string>();
const failAt = new Map<string, number>();
/** 拉取类失败 60s 可重试（部署修复/网络恢复后无需刷新页面）；解析类失败永久 */
function failExpired(url: string): boolean {
  const at = failAt.get(url);
  const reason = failReason.get(url) ?? '';
  return at != null && !reason.includes('解析') && Date.now() - at > 60_000;
}
export function stepFailReasonFor(url: string | undefined): string | undefined {
  return url ? failReason.get(url) : undefined;
}
let lastError = '';

/** 单个 STEP 链接的状态（详情面板 3D 预览用） */
export function stepStatusFor(url: string | undefined): 'ready' | 'loading' | 'failed' | 'idle' {
  if (!url) return 'idle';
  if (modelCache.has(url)) return 'ready';
  if (inflight.has(url)) return 'loading';
  if (failed.has(url)) return 'failed';
  return 'idle';
}

/** 3D 视图悬浮提示用的汇总状态 */
export function stepStats() {
  return { ready: modelCache.size, loading: inflight.size, failed: failed.size, lastError };
}

/** 器件上画布时预取 STEP 文件字节（签名链接约半小时过期，趁新鲜先拿字节；转换仍懒执行） */
export function ensureStepBytes(url: string | undefined) {
  if (!url || bytesCache.has(url) || modelCache.has(url) || inflight.has(url) || failed.has(url)) return;
  fetch(url.startsWith('/') ? url : `/api/ezplm?path=file&url=${encodeURIComponent(url)}`).then(async (r) => {
    if (!r.ok) return; // 预取失败不算失败，转换时会重试并报错
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 16 && buf[0] !== 0x7b) bytesCache.set(url, buf); // 0x7b='{' 代理 JSON 错误
  }).catch(() => { /* 预取失败静默 */ });
}

export function stepModelFor(url: string | undefined): THREE.Group | undefined {
  if (!url) return undefined;
  const g = modelCache.get(url);
  return g ? (g.clone() as THREE.Group) : undefined;
}

/** 按需拉取并转换 STEP（幂等）；完成后 bump 版本触发 3D 重建 */
export function ensureStepModel(url: string | undefined) {
  if (!url || modelCache.has(url) || inflight.has(url)) return;
  if (failed.has(url)) {
    if (!failExpired(url)) return;
    failed.delete(url); failReason.delete(url); failAt.delete(url); // 到期重试
  }
  inflight.add(url);
  useLibFileStore.getState().bump(); // 让「转换中」状态可见
  (async () => {
    try {
      let buf = bytesCache.get(url);
      if (!buf) {
        const resp = await fetch(url.startsWith('/') ? url : `/api/ezplm?path=file&url=${encodeURIComponent(url)}`);
        if (!resp.ok) {
          // 透传服务端详情（如「3D 库中无匹配模型（Connector_USB.3dshapes 共 N 个）」）
          let detail = '';
          try { detail = String((await resp.json())?.error ?? ''); } catch { /* 非 JSON */ }
          const hint = url.startsWith('/') ? '' : '（签名链接可能已过期，重新搜索该器件可刷新）';
          throw new Error(detail ? `HTTP ${resp.status} · ${detail}` : `文件拉取失败 HTTP ${resp.status}${hint}`);
        }
        buf = new Uint8Array(await resp.arrayBuffer());
        if (buf.length > 0 && buf[0] === 0x7b) throw new Error('代理返回错误: ' + new TextDecoder().decode(buf.slice(0, 120)));
      }
      {
        const head = new TextDecoder().decode(buf.slice(0, 60));
        if (head.startsWith('version https://git-lfs')) throw new Error('拿到的是 Git LFS 指针而非模型——服务端代理未部署最新版（api/kicadlib.js 的 LFS 解析）');
        if (!/ISO-10303/.test(head)) throw new Error('内容不是 STEP 格式（' + head.slice(0, 30).replace(/\s+/g, ' ') + '…）');
      }
      const occt = await getOcct().catch((e) => {
        const msg = String(e);
        if (/EvalError|Content Security Policy|unsafe-eval/i.test(msg)) {
          throw new Error('3D 引擎被 CSP 拦截——vercel.json 的 script-src 需含 unsafe-eval（该修复需部署 vercel.json 才生效）');
        }
        throw new Error('WASM 引擎加载失败: ' + msg.slice(0, 120));
      });
      const result = occt.ReadStepFile(buf, null);
      if (!result?.success || !result.meshes?.length) throw new Error('STEP 解析失败（文件格式异常）');

      // ── 材质分配 ──
      // STEP 里 OCCT 给的颜色常缺省/纯黑；按几何特征区分：
      // 薄而扁的网格 = 引脚(亮银金属)，大体积 = 塑封体(深灰哑光)，其余按原色
      const group = new THREE.Group();
      const meshInfos = result.meshes.map((m) => {
        const pos = m.attributes.position.array;
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < pos.length; i += 3) {
          minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
          minY = Math.min(minY, pos[i + 1]); maxY = Math.max(maxY, pos[i + 1]);
          minZ = Math.min(minZ, pos[i + 2]); maxZ = Math.max(maxZ, pos[i + 2]);
        }
        const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
        return { m, vol: Math.max(dx, 0.01) * Math.max(dy, 0.01) * Math.max(dz, 0.01), dz, maxZ, minZ };
      });
      const maxVol = Math.max(...meshInfos.map((i) => i.vol), 0.001);
      const topZ = Math.max(...meshInfos.map((i) => i.maxZ));
      const botZ = Math.min(...meshInfos.map((i) => i.minZ));
      const height = Math.max(topZ - botZ, 0.001);

      for (const info of meshInfos) {
        const m = info.m;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
        if (m.attributes.normal) geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
        else geo.computeVertexNormals();
        if (m.index) geo.setIndex(m.index.array);

        // STEP 原色（作者指定且有意义时尊重）
        const raw = Array.isArray(m.color) && m.color.length >= 3 ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : null;
        const sum = raw ? raw.r + raw.g + raw.b : 0;
        const rawIsMeaningful = raw ? (sum > 0.25 && sum < 2.7 && (Math.max(raw.r, raw.g, raw.b) - Math.min(raw.r, raw.g, raw.b) > 0.04 || sum < 1.2)) : false;

        // 形态特征
        const volRatio = info.vol / maxVol;
        const nearBottom = info.minZ < botZ + height * 0.5;
        const spansHeight = info.dz > height * 0.62;
        const thin = info.dz < height * 0.5;
        const isLead = (volRatio < 0.35 && nearBottom && !spansHeight) || (thin && nearBottom && volRatio < 0.45);

        // 配色与参数化模型统一：深色塑封本体 + 金色引脚（STEP 自带有效颜色时仍尊重原色）
        let mat: THREE.MeshStandardMaterial;
        if (rawIsMeaningful) {
          mat = new THREE.MeshStandardMaterial({ color: raw!, metalness: 0.35, roughness: 0.55 });
        } else if (isLead) {
          mat = new THREE.MeshStandardMaterial({ color: 0xe6c66a, metalness: 0.95, roughness: 0.22, envMapIntensity: 1.6 }); // 金脚
        } else {
          mat = new THREE.MeshStandardMaterial({ color: 0x22252b, metalness: 0.12, roughness: 0.6, envMapIntensity: 1.0 }); // 深色塑封（与参数化一致）
        }
        group.add(new THREE.Mesh(geo, mat));
      }

      // KiCad 3D 模型约定 Z 轴朝上；场景 Y 轴朝上 → 绕 X 轴 -90°
      group.rotation.x = -Math.PI / 2;
      const box = new THREE.Box3().setFromObject(group);
      group.position.y = -box.min.y;
      const wrapper = new THREE.Group();
      wrapper.add(group);
      modelCache.set(url, wrapper);
      useLibFileStore.getState().bump();
    } catch (e) {
      failed.add(url);
      lastError = String(e instanceof Error ? e.message : e).slice(0, 160);
      failReason.set(url, lastError);
      failAt.set(url, Date.now());
      console.warn('[step] STEP 模型加载失败，使用参数化模型:', url.slice(0, 80), lastError);
      useLibFileStore.getState().bump(); // 失败状态也要驱动 UI 更新
    } finally {
      inflight.delete(url);
    }
  })();
}
