import { useEffect } from "react";
import type { MutableRefObject } from "react";
import type { GraphLike } from "../types";
import type { HistoryManager } from "../history";
import { patchRelationshipLinkPoints } from "../builder";

interface Options {
  graphRef: MutableRefObject<GraphLike | null>;
  historyRef: MutableRefObject<HistoryManager>;
}

const isEditableTarget = (el: EventTarget | null): boolean => {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  if (el.closest && el.closest(".CodeMirror")) return true;
  return false;
};

// 全局快捷键：Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Y 或 Ctrl/Cmd+Shift+Z 重做。
// 在 CodeMirror、原生 input/textarea、双击编辑框内不拦截（让原生撤销生效）。
export function useUndoRedoShortcuts({ graphRef, historyRef }: Options) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      if (isEditableTarget(e.target)) return;

      const graph = graphRef.current;
      if (!graph || graph.destroyed) return;

      const isRedo = key === "y" || (key === "z" && e.shiftKey);

      e.preventDefault();
      const onFinish = () => {
        // 动画结束后修正菱形连线端点（位置已就绪）
        try {
          patchRelationshipLinkPoints(graph);
        } catch (_) {}
      };
      const action = isRedo ? "redo" : "undo";
      historyRef.current[action](graph, { onFinish });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [graphRef, historyRef]);
}
