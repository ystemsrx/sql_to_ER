import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import G6 from "@antv/g6";
import * as Exporter from "../exporter";
import * as Snapshots from "../snapshots";
import { I18N } from "../i18n";
import { patchRelationshipLinkPoints } from "../builder";
import type { GraphLike, SnapshotRecord } from "../types";

export interface PersistMeta {
  id: string;
  inputText: string;
  isColored: boolean;
  showComment: boolean;
  hideFields: boolean;
}

export interface UseSnapshotPersistenceOptions {
  graphRef: MutableRefObject<GraphLike | null>;
  containerRef: MutableRefObject<HTMLElement | null>;
}

export interface SnapshotPersistence {
  /** 立即把当前图同步元信息一起入库；返回的 Promise 在写库完成后 resolve */
  persistSnapshot: (meta: PersistMeta) => Promise<void>;
  /** 安排一次"等画面安顿后再保存"，会取消之前安排但未触发的那次 */
  schedulePersist: (meta: PersistMeta, delayMs: number) => void;
  /** 把已安排的延迟保存取消（重新生成时调用） */
  cancelPendingPersist: () => void;
}

/**
 * 拍 SVG 缩略图 + 写 IndexedDB 快照的逻辑。从 useGraph 拆出来，
 * 让 useGraph 不再持有 captureSvgThumbnail / persistSnapshot / 保存定时器。
 *
 * 关键约束：buildExportSVG 内部第一行就同步取数据，调用方紧接着 destroy
 * 旧图也不会丢内容（数据快照已被复制）。
 */
export function useSnapshotPersistence({
  graphRef,
  containerRef,
}: UseSnapshotPersistenceOptions): SnapshotPersistence {
  const pendingSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const captureSvgThumbnail = (): Promise<string | null> =>
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
            // 与 --color-bg-overlay 一致；让 SVG 底色矩形和暖色卡片融在一起。
            // 用户下载 SVG/PNG 走另一条 buildExportSVG 调用，仍是默认白底。
            backgroundFill: "#fdfcf8",
          },
          (err, result) => {
            if (err || !result || !result.svgString) {
              resolve(null);
              return;
            }
            // SVG 里中文等多字节字符要先 UTF-8 再 base64
            let dataUrl: string;
            try {
              dataUrl =
                "data:image/svg+xml;base64," +
                btoa(unescape(encodeURIComponent(result.svgString)));
            } catch (_) {
              dataUrl =
                "data:image/svg+xml;charset=utf-8," +
                encodeURIComponent(result.svgString);
            }
            resolve(dataUrl);
          },
        );
      } catch (_) {
        resolve(null);
      }
    });

  const persistSnapshot = (meta: PersistMeta): Promise<void> =>
    new Promise((resolve) => {
      const graph = graphRef.current;
      if (!graph || graph.destroyed) {
        resolve();
        return;
      }
      // 输入框还停留在示例（中/英文均算）时不写入历史 ——
      // 否则首次打开页面什么都没改也会有一条快照。
      const trimmedInput = String(meta.inputText || "").trim();
      if (
        trimmedInput === I18N.zh.sample.trim() ||
        trimmedInput === I18N.en.sample.trim()
      ) {
        resolve();
        return;
      }
      const nodes = Snapshots.captureGraphSnapshot(graph);
      if (!nodes || nodes.length === 0) {
        resolve();
        return;
      }
      const thumbPromise = captureSvgThumbnail();
      thumbPromise.then((thumb) => {
        const writeWith = (existing: SnapshotRecord | null) => {
          // 数据没变化时跳过写入：恢复 / 打开历史面板都会触发一次
          // persistSnapshot，若原封不动也刷新 updatedAt，会让历史排序"乱跳"。
          if (
            existing &&
            existing.isColored === meta.isColored &&
            existing.showComment === meta.showComment &&
            existing.hideFields === meta.hideFields &&
            Array.isArray(existing.nodes) &&
            existing.nodes.length === nodes.length &&
            existing.nodes.every(
              (p, i) =>
                p.id === nodes[i].id &&
                p.x === nodes[i].x &&
                p.y === nodes[i].y &&
                p.label === nodes[i].label,
            )
          ) {
            resolve();
            return;
          }
          Snapshots.put({
            id: meta.id,
            inputText: meta.inputText,
            isColored: meta.isColored,
            showComment: meta.showComment,
            hideFields: meta.hideFields,
            nodes,
            thumbnail: thumb || (existing && existing.thumbnail) || null,
            createdAt:
              existing && existing.createdAt
                ? existing.createdAt
                : Date.now(),
            updatedAt: Date.now(),
          })
            .then(() => resolve())
            .catch((e: unknown) => {
              console.warn("snapshot put failed", e);
              resolve();
            });
        };
        Snapshots.get(meta.id)
          .then(writeWith)
          .catch(() => writeWith(null));
      });
    });

  const cancelPendingPersist = () => {
    if (pendingSaveTimerRef.current) {
      clearTimeout(pendingSaveTimerRef.current);
      pendingSaveTimerRef.current = null;
    }
  };

  const schedulePersist = (meta: PersistMeta, delayMs: number) => {
    cancelPendingPersist();
    pendingSaveTimerRef.current = setTimeout(() => {
      pendingSaveTimerRef.current = null;
      // 触发时若图已被销毁则跳过；下一轮新图会自己安排保存
      if (!graphRef.current || graphRef.current.destroyed) return;
      persistSnapshot(meta);
    }, delayMs);
  };

  // 卸载时取消任何挂起的保存定时器，避免在新图之上意外触发旧 meta 的保存。
  useEffect(() => cancelPendingPersist, []);

  return { persistSnapshot, schedulePersist, cancelPendingPersist };
}
