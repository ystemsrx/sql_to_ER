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
(function () {
  'use strict';

  const DB_NAME = 'sql2er';
  const STORE = 'snapshots';
  const DB_VERSION = 1;

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // FNV-1a 32-bit，对纯文本足够稳定且无需引入额外依赖
  function hashInput(text) {
    const s = String(text == null ? '' : text);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function withStore(mode, fn) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(STORE, mode);
          const store = t.objectStore(STORE);
          let result;
          try {
            const r = fn(store);
            if (r && typeof r.then === 'function') {
              r.then((v) => {
                result = v;
              }).catch(reject);
            } else {
              result = r;
            }
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

  function reqAsPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function put(record) {
    return withStore('readwrite', (store) => reqAsPromise(store.put(record)));
  }

  function get(id) {
    return withStore('readonly', (store) =>
      reqAsPromise(store.get(id)).then((r) => r || null),
    );
  }

  function getAll() {
    return withStore('readonly', (store) =>
      reqAsPromise(store.getAll()).then((r) => r || []),
    );
  }

  function deleteById(id) {
    return withStore('readwrite', (store) => reqAsPromise(store.delete(id)));
  }

  // 从图实例采集节点位置/标签快照（同步）。
  // 之所以只取 id/x/y/label：恢复时我们会把 inputText 重新 parse 出 nodes/edges，
  // 再用这份快照去 override 位置和标签。形状/样式由 isColored 等设置决定。
  function captureGraphSnapshot(graph) {
    if (!graph || graph.destroyed) return null;
    return graph.getNodes().map((node) => {
      const m = node.getModel();
      return { id: m.id, x: m.x, y: m.y, label: m.label };
    });
  }

  // 缩略图：源像素同步从 canvas 元素读出，再异步缩放编码。
  // 同步读源是关键 —— 调用方往往会立刻 destroy 旧图开始构建新图，
  // 异步拿源 dataURL 会读到已销毁的画布。
  function captureThumbnail(graph, maxWidth) {
    if (!graph || graph.destroyed) return Promise.resolve(null);
    let srcDataUrl;
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
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
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

  window.Snapshots = {
    hashInput,
    captureGraphSnapshot,
    captureThumbnail,
    put,
    get,
    getAll,
    deleteById,
  };
})();
