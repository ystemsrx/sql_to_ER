import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import G6 from "@antv/g6";
import * as Exporter from "../exporter";
import * as Snapshots from "../snapshots";
import { isInitialSampleInput } from "../i18n";
import { patchRelationshipLinkPoints } from "../builder";
import type { GraphLike, SnapshotRecord } from "../types";

export interface PersistMeta {
  id: string;
  inputText: string;
  isColored: boolean;
  showComment: boolean;
  hideFields: boolean;
  fontScale?: number;
}

export interface PersistOptions {
  skipThumbnail?: boolean;
  /** 恢复历史记录时可刷新快照数据，但沿用原修改时间。 */
  preserveUpdatedAt?: boolean;
}

export interface UseSnapshotPersistenceOptions {
  graphRef: MutableRefObject<GraphLike | null>;
  containerRef: MutableRefObject<HTMLElement | null>;
}

export interface SnapshotPersistence {
  /** 立即把当前图同步元信息一起入库；返回的 Promise 在写库完成后 resolve */
  persistSnapshot: (meta: PersistMeta, options?: PersistOptions) => Promise<void>;
  /** 安排一次"等画面安顿后再保存"，会取消之前安排但未触发的那次 */
  schedulePersist: (meta: PersistMeta, delayMs: number, options?: PersistOptions) => void;
  /** 把已安排的延迟保存取消（重新生成时调用） */
  cancelPendingPersist: () => void;
  /** 立即执行挂起的延迟保存（页面隐藏/关闭前兜底调用） */
  flushPendingPersist: () => void;
}

// 聚焦卡片里的图最大会显示到约 330 CSS px。固定输出 1440px，为高分屏
// 和 3D 放大预留更充足的采样，同时继续使用 WebP 0.8 控制历史记录体积。
const THUMBNAIL_TARGET_WIDTH = 1440;
const THUMBNAIL_VERSION = 3;
let lastCaptureRevision = 0;

export function resolveSnapshotUpdatedAt(
  existing: SnapshotRecord | null,
  preserveUpdatedAt: boolean,
  now: number = Date.now(),
): number {
  if (
    preserveUpdatedAt &&
    existing &&
    Number.isFinite(existing.updatedAt) &&
    existing.updatedAt > 0
  ) {
    return existing.updatedAt;
  }
  return now;
}

/** 把导出 SVG 光栅化成高像素密度的 WebP 0.8 dataURL。 */
function rasterizeSvgThumbnail(
  svgString: string,
  width: number,
  height: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    if (!(width > 0) || !(height > 0)) {
      resolve(null);
      return;
    }
    const svgBlob = new Blob([svgString], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      try {
        const requestedScale = THUMBNAIL_TARGET_WIDTH / width;
        const scale = Exporter.clampExportScale(width, height, requestedScale);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(width * scale));
        c.height = Math.max(1, Math.round(height * scale));
        const ctx = c.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const dataUrl = c.toDataURL("image/webp", 0.8);
        resolve(dataUrl || null);
      } catch (_) {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * 拍缩略图 + 写 IndexedDB 快照的逻辑。从 useGraph 拆出来，
 * 让 useGraph 不再持有缩略图 / persistSnapshot / 保存定时器。
 *
 * 关键约束：buildExportSVG 内部第一行就同步取数据，调用方紧接着 destroy
 * 旧图也不会丢内容（数据快照已被复制）。
 */
export function useSnapshotPersistence({
  graphRef,
  containerRef,
}: UseSnapshotPersistenceOptions): SnapshotPersistence {
  const pendingSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMetaRef = useRef<PersistMeta | null>(null);
  const pendingOptionsRef = useRef<PersistOptions | null>(null);

  const captureThumbnail = (): Promise<string | null> =>
    new Promise((resolve) => {
      const graph = graphRef.current;
      if (!graph || graph.destroyed) {
        resolve(null);
        return;
      }
      try {
        Exporter.buildExportSVG(
          {
            graphRef,
            containerRef,
            patchRelationshipLinkPoints,
            G6,
            // 与 --color-bg-overlay 一致；让缩略图底色和暖色卡片融在一起。
            // 用户下载 SVG/PNG 走另一条 buildExportSVG 调用，仍是默认白底。
            backgroundFill: "#fdfcf8",
          },
          (err, result) => {
            if (err || !result || !result.svgString) {
              resolve(null);
              return;
            }
            rasterizeSvgThumbnail(result.svgString, result.width, result.height).then(resolve);
          },
        );
      } catch (_) {
        resolve(null);
      }
    });

  const persistSnapshot = (meta: PersistMeta, options?: PersistOptions): Promise<void> => {
    const graph = graphRef.current;
    if (!graph || graph.destroyed) return Promise.resolve();
    // 内置示例只是首次体验内容：无论拖拽、缩放、改标签还是切换显示设置，
    // 都不写入历史，也就不会在刷新后恢复用户调整过的位置。
    if (isInitialSampleInput(meta.inputText)) return Promise.resolve();

    const nodes = Snapshots.captureGraphSnapshot(graph);
    if (!nodes || nodes.length === 0) return Promise.resolve();

    const thumbPromise = options?.skipThumbnail
      ? Promise.resolve<string | null>(null)
      : captureThumbnail();
    const capturedAt = Date.now();
    const revision = Math.max(capturedAt, lastCaptureRevision + 1);
    lastCaptureRevision = revision;
    const dataWrite = Snapshots.upsert(meta.id, (existing: SnapshotRecord | null) => {
      // A delayed retry (e.g. quota recovery) must not replace a later capture.
      if (existing?.revision && existing.revision > revision) return null;
      if (existing && existing.inputText !== meta.inputText) {
        throw new Error("Snapshot key collision: refusing to overwrite another input");
      }
      // 数据没变化时保留 updatedAt，但推进 revision 以拒绝更早的缩略图。
      // 恢复 / 打开历史面板不应让历史排序发生变化。
      const dataUnchanged =
        existing &&
        existing.isColored === meta.isColored &&
        existing.showComment === meta.showComment &&
        existing.hideFields === meta.hideFields &&
        (existing.fontScale ?? 1) === (meta.fontScale ?? 1) &&
        Array.isArray(existing.nodes) &&
        existing.nodes.length === nodes.length &&
        existing.nodes.every(
          (p, i) =>
            p.id === nodes[i].id &&
            p.x === nodes[i].x &&
            p.y === nodes[i].y &&
            p.label === nodes[i].label,
        );
      return {
        id: meta.id,
        inputText: meta.inputText,
        isColored: meta.isColored,
        showComment: meta.showComment,
        hideFields: meta.hideFields,
        fontScale: meta.fontScale ?? 1,
        revision,
        nodes,
        thumbnail: existing?.thumbnail ?? null,
        thumbnailVersion: dataUnchanged ? existing?.thumbnailVersion : undefined,
        createdAt: existing?.createdAt || capturedAt,
        updatedAt: resolveSnapshotUpdatedAt(
          existing,
          !!options?.preserveUpdatedAt || !!dataUnchanged,
          capturedAt,
        ),
      };
    });
    // Persist geometry immediately. Rasterization may finish after a newer save,
    // or never finish while the page is hidden; it cannot hold up the data write.
    void dataWrite
      .then(() => thumbPromise)
      .then((thumb) => {
        if (!thumb) return;
        return Snapshots.upsert(meta.id, (existing) => {
          if (!existing || existing.revision !== revision) return null;
          return { ...existing, thumbnail: thumb, thumbnailVersion: THUMBNAIL_VERSION };
        });
      })
      .catch((e: unknown) => console.warn("snapshot thumbnail update failed", e));
    return dataWrite.catch((e: unknown) => console.warn("snapshot upsert failed", e));
  };

  const cancelPendingPersist = () => {
    if (pendingSaveTimerRef.current) {
      clearTimeout(pendingSaveTimerRef.current);
      pendingSaveTimerRef.current = null;
    }
    pendingMetaRef.current = null;
    pendingOptionsRef.current = null;
  };

  const schedulePersist = (meta: PersistMeta, delayMs: number, options?: PersistOptions) => {
    cancelPendingPersist();
    pendingMetaRef.current = meta;
    pendingOptionsRef.current = options ?? null;
    pendingSaveTimerRef.current = setTimeout(() => {
      const pendingOptions = pendingOptionsRef.current ?? undefined;
      pendingSaveTimerRef.current = null;
      pendingMetaRef.current = null;
      pendingOptionsRef.current = null;
      // 触发时若图已被销毁则跳过；下一轮新图会自己安排保存
      if (!graphRef.current || graphRef.current.destroyed) return;
      persistSnapshot(meta, pendingOptions);
    }, delayMs);
  };

  const flushPendingPersist = () => {
    const meta = pendingMetaRef.current;
    const options = pendingOptionsRef.current;
    if (!meta) return;
    cancelPendingPersist();
    if (!graphRef.current || graphRef.current.destroyed) return;
    // 页面即将隐藏/卸载：跳过缩略图（其光栅化依赖 rAF/图片解码，此时
    // 不保证执行），只把节点位置尽快写进库。
    void persistSnapshot(meta, { ...options, skipThumbnail: true });
  };

  const flushRef = useRef(flushPendingPersist);
  flushRef.current = flushPendingPersist;

  // 关标签页 / 切后台时立即兜底保存，否则延迟保存窗口内的操作会丢。
  useEffect(() => {
    const onPageHide = () => flushRef.current();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushRef.current();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // 卸载：先 flush 再清理，而不是直接丢弃挂起的保存
      flushRef.current();
    };
  }, []);

  return {
    persistSnapshot,
    schedulePersist,
    cancelPendingPersist,
    flushPendingPersist,
  };
}
