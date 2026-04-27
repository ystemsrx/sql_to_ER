/**
 * Snapshots Module - 持久化生成的 ER 图快照（IndexedDB）
 *
 * 为什么用 IndexedDB 而不是 localStorage：
 *   每张快照都带一份缩略图（PNG dataURL），单条就可能 50–300 KB。
 *   localStorage 总配额一般只有 5 MB，几张图就会撑爆；IndexedDB 没有这个问题，
 *   而且天然异步，不会卡 UI。
 *
 * 公开接口（window.Snapshots）：
 *   - hashInput(text) → 8 位 hex 字符串，作为快照主键
 *   - captureGraphSnapshot(graph) → [{id,x,y,label}]，同步采集
 *   - captureThumbnail(graph, maxWidth?) → Promise<dataURL|null>
 *       源像素同步从 canvas 拷出，缩放/编码异步进行，
 *       这样调用方可以先 capture 再 destroy 旧图而不丢图
 *   - put(record) → Promise<void>
 *   - get(id) → Promise<record|null>
 *   - getAll() → Promise<record[]>
 *   - deleteById(id) → Promise<void>
 */
import type { GraphLike, NodeSnapshot, SnapshotRecord } from "./types";

const DB_NAME = 'sql2er';
const STORE = 'snapshots';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  // 失败的 open 不能粘在 dbPromise 上：IndexedDB 可能因临时错误（隐私模式切换、
  // 配额抖动）首次失败后续可用，缓存 rejected promise 会让后续每次调用都直接拿到
  // 同一个失败结果，必须刷新页面才能恢复。捕获后清掉缓存让下次调用重试。
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise = p.catch((err) => {
    if (dbPromise === p) dbPromise = null;
    throw err;
  });
  return dbPromise;
}

// FNV-1a 32-bit，对纯文本足够稳定且无需引入额外依赖
export function hashInput(text: unknown): string {
  const s = String(text == null ? '' : text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result: T;
        try {
          const req = fn(store);
          req.onsuccess = () => {
            result = req.result;
          };
          req.onerror = () => reject(req.error);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('aborted'));
      }),
  );
}

export function put(record: SnapshotRecord): Promise<IDBValidKey> {
  return withStore('readwrite', (store) => store.put(record));
}

export function get(id: string): Promise<SnapshotRecord | null> {
  return withStore('readonly', (store) =>
    store.get(id) as IDBRequest<SnapshotRecord | undefined>,
  ).then((r) => r || null);
}

export function getAll(): Promise<SnapshotRecord[]> {
  return withStore('readonly', (store) =>
    store.getAll() as IDBRequest<SnapshotRecord[]>,
  ).then((r) => r || []);
}

export function deleteById(id: string): Promise<undefined> {
  return withStore('readwrite', (store) => store.delete(id));
}

// 从图实例采集节点位置/标签快照（同步）。
// 之所以只取 id/x/y/label：恢复时我们会把 inputText 重新 parse 出 nodes/edges，
// 再用这份快照去 override 位置和标签。形状/样式由 isColored 等设置决定。
export function captureGraphSnapshot(graph: GraphLike): NodeSnapshot[] | null {
  if (!graph || graph.destroyed) return null;
  return graph.getNodes().map((node) => {
    const m = node.getModel();
    return { id: m.id, x: m.x, y: m.y, label: m.label };
  });
}

// 缩略图：源像素同步从 canvas 元素读出，再异步缩放编码。
// 同步读源是关键 —— 调用方往往会立刻 destroy 旧图开始构建新图，
// 异步拿源 dataURL 会读到已销毁的画布。
export function captureThumbnail(
  graph: GraphLike,
  maxWidth?: number,
): Promise<string | null> {
  if (!graph || graph.destroyed) return Promise.resolve(null);
  let srcDataUrl: string | undefined;
  try {
    const canvas = graph.get('canvas');
    const el = canvas && canvas.get && canvas.get('el');
    if (!el || typeof el.toDataURL !== 'function') {
      return Promise.resolve(null);
    }
    srcDataUrl = el.toDataURL('image/png');
  } catch (_) {
    return Promise.resolve(null);
  }
  if (!srcDataUrl) return Promise.resolve(null);
  return new Promise((resolve) => {
    const target = maxWidth || 520;
    const img = new Image();
    img.onload = () => {
      const w = Math.min(target, img.width || target);
      const h = Math.max(
        1,
        Math.round((img.height || target) * (w / (img.width || target))),
      );
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) {
        resolve(null);
        return;
      }
      // 不再填白底：导出透明 PNG，让卡片自己的暖色背景透上来。
      // 旧快照里已经烤进去的白底会保留，直到这条记录被重新生成。
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(c.toDataURL('image/png'));
      } catch (_) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = srcDataUrl;
  });
}
