/**
 * Snapshots Module - 持久化生成的 ER 图快照（IndexedDB）
 *
 * 为什么用 IndexedDB 而不是 localStorage：
 *   每张快照都带一份光栅缩略图（dataURL），单条几十 KB。
 *   localStorage 总配额一般只有 5 MB，几张图就会撑爆；IndexedDB 配额大得多，
 *   而且天然异步，不会卡 UI。
 *
 * 公开接口：
 *   - hashInput(text) → 8 位 hex 字符串，作为快照主键
 *   - captureGraphSnapshot(graph) → [{id,x,y,label}]，同步采集
 *   - put(record) / upsert(id, merge) / get(id) / getAll() / deleteById(id)
 *   - getMostRecent() → Promise<record|null>（按 updatedAt 取最新，会话恢复用）
 */
import type { GraphLike, NodeSnapshot, SnapshotRecord } from "./types";

const DB_NAME = "sql2er";
const STORE = "snapshots";
const DB_VERSION = 1;

/** 刷新或重新进入应用时，仅自动恢复 6 小时内的内容。 */
export const SESSION_RESTORE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function isWithinSessionRestoreWindow(
  updatedAt: unknown,
  now: number = Date.now(),
): boolean {
  const timestamp = Number(updatedAt);
  return (
    Number.isFinite(timestamp) && timestamp > 0 && now - timestamp <= SESSION_RESTORE_MAX_AGE_MS
  );
}

// 配额兜底：写入触发 QuotaExceededError 时按 updatedAt 淘汰最旧的若干条后重试。
const QUOTA_EVICT_COUNT = 5;

let dbPromise: Promise<IDBDatabase> | null = null;
let persistRequested = false;

/** 首次写库时请求持久化存储，降低浏览器在存储压力下整库驱逐的概率。 */
function requestPersistentStorage(): void {
  if (persistRequested) return;
  persistRequested = true;
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.persist) {
      void navigator.storage.persist().catch(() => {});
    }
  } catch (_) {
    /* 忽略：能力检测失败不影响写入 */
  }
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  // 失败的 open 不能粘在 dbPromise 上：IndexedDB 可能因临时错误（隐私模式切换、
  // 配额抖动）首次失败后续可用，缓存 rejected promise 会让后续每次调用都直接拿到
  // 同一个失败结果，必须刷新页面才能恢复。捕获后清掉缓存让下次调用重试。
  let abandoned = false;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // 版本迁移链：按 oldVersion fall-through，未来加 case 1 / case 2 即可
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    // 其他标签页还开着旧版本连接时 open 会一直挂起；给出明确错误而不是无限等。
    req.onblocked = () => {
      abandoned = true;
      reject(new Error("IndexedDB upgrade blocked by another tab"));
    };
    req.onsuccess = () => {
      const db = req.result;
      if (abandoned) {
        db.close();
        return;
      }
      // 另一个标签页请求升级时主动让路，并清掉缓存让下次调用重新 open。
      db.onversionchange = () => {
        try {
          db.close();
        } catch (_) {}
        if (dbPromise === p) dbPromise = null;
      };
      db.onclose = () => {
        if (dbPromise === p) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  dbPromise = p;
  void p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return dbPromise;
}

// FNV-1a 32-bit，对纯文本足够稳定且无需引入额外依赖
export function hashInput(text: unknown): string {
  const s = String(text == null ? "" : text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

function runInStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let t: IDBTransaction;
        try {
          t = db.transaction(STORE, mode);
        } catch (e) {
          reject(e);
          return;
        }
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
        t.onabort = () => reject(t.error || new Error("aborted"));
      }),
  );
}

const isStaleConnectionError = (e: unknown): boolean =>
  e instanceof DOMException && e.name === "InvalidStateError";

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  // 连接可能在成功打开后被浏览器关闭（存储驱逐、versionchange 等），此时缓存的
  // db 上任何 transaction() 都抛 InvalidStateError。清缓存重开一次再试。
  return runInStore(mode, fn).catch((e) => {
    if (!isStaleConnectionError(e)) throw e;
    dbPromise = null;
    return runInStore(mode, fn);
  });
}

const isQuotaError = (e: unknown): boolean =>
  e instanceof DOMException && e.name === "QuotaExceededError";

/** 按 updatedAt 淘汰最旧的 count 条记录（配额兜底用）。 */
function evictOldest(count: number): Promise<void> {
  return getAll().then((records) => {
    const sorted = records
      .slice()
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
      .slice(0, count);
    return sorted
      .reduce(
        (chain, record) => chain.then(() => deleteById(record.id).then(() => {})),
        Promise.resolve(),
      )
      .then(() => {});
  });
}

export function put(record: SnapshotRecord): Promise<IDBValidKey> {
  requestPersistentStorage();
  return withStore("readwrite", (store) => store.put(record)).catch((e) => {
    if (!isQuotaError(e)) throw e;
    // 配额满：淘汰最旧的几条后重试一次；仍失败则把错误抛给调用方提示用户。
    return evictOldest(QUOTA_EVICT_COUNT).then(() =>
      withStore("readwrite", (store) => store.put(record)),
    );
  });
}

/**
 * 单事务内完成 读取 → 合并 → 写入，避免"读和写跨两个事务"在多标签页
 * 并发时互相覆盖。merge 返回 null 表示无需写入。
 */
export function upsert(
  id: string,
  merge: (existing: SnapshotRecord | null) => SnapshotRecord | null,
): Promise<void> {
  requestPersistentStorage();
  const runOnce = (): Promise<{ written: boolean }> =>
    openDB().then(
      (db) =>
        new Promise<{ written: boolean }>((resolve, reject) => {
          let t: IDBTransaction;
          try {
            t = db.transaction(STORE, "readwrite");
          } catch (e) {
            reject(e);
            return;
          }
          const store = t.objectStore(STORE);
          let written = false;
          const getReq = store.get(id) as IDBRequest<SnapshotRecord | undefined>;
          getReq.onsuccess = () => {
            let next: SnapshotRecord | null = null;
            try {
              next = merge(getReq.result || null);
            } catch (e) {
              reject(e);
              try {
                t.abort();
              } catch (_) {}
              return;
            }
            if (next) {
              written = true;
              store.put(next);
            }
          };
          getReq.onerror = () => reject(getReq.error);
          t.oncomplete = () => resolve({ written });
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error || new Error("aborted"));
        }),
    );
  return runOnce()
    .catch((e) => {
      if (isStaleConnectionError(e)) {
        dbPromise = null;
        return runOnce();
      }
      if (isQuotaError(e)) {
        return evictOldest(QUOTA_EVICT_COUNT).then(runOnce);
      }
      throw e;
    })
    .then(() => {});
}

export function get(id: string): Promise<SnapshotRecord | null> {
  return withStore(
    "readonly",
    (store) => store.get(id) as IDBRequest<SnapshotRecord | undefined>,
  ).then((r) => r || null);
}

export function getAll(): Promise<SnapshotRecord[]> {
  return withStore("readonly", (store) => store.getAll() as IDBRequest<SnapshotRecord[]>).then(
    (r) => r || [],
  );
}

export function deleteById(id: string): Promise<undefined> {
  return withStore("readwrite", (store) => store.delete(id));
}

/** 取 updatedAt 最新且符合筛选条件的快照（会话恢复用）；库空时返回 null。 */
export function getMostRecent(
  predicate: (record: SnapshotRecord) => boolean = () => true,
): Promise<SnapshotRecord | null> {
  return openDB()
    .then(
      (db) =>
        new Promise<SnapshotRecord | null>((resolve, reject) => {
          let t: IDBTransaction;
          try {
            t = db.transaction(STORE, "readonly");
          } catch (e) {
            reject(e);
            return;
          }
          const index = t.objectStore(STORE).index("updatedAt");
          const req = index.openCursor(null, "prev");
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              resolve(null);
              return;
            }
            const record = cursor.value as SnapshotRecord;
            try {
              if (predicate(record)) {
                resolve(record);
                return;
              }
            } catch (error) {
              reject(error);
              return;
            }
            cursor.continue();
          };
          req.onerror = () => reject(req.error);
        }),
    )
    .catch((e) => {
      if (isStaleConnectionError(e)) {
        dbPromise = null;
      }
      return null;
    });
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
