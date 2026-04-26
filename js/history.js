/**
 * History Module - 撤销 / 重做（Undo / Redo）
 *
 * 通过对图中所有节点的 { id, x, y, label } 拍快照实现回退。
 * 能撤销的操作：节点拖拽、双击编辑节点标签、强制对齐、环绕排布、
 * 滚轮旋转。不能撤销的操作（会重置历史）：重新生成图、隐藏/显示属性。
 *
 * 公开接口（window.History）：
 *   - createManager()  → manager 实例
 *   - manager.record(graph)   在变更前调用，把当前状态压入 past 栈
 *   - manager.undo(graph)     回退到上一个快照
 *   - manager.redo(graph)     恢复被撤销的快照
 *   - manager.reset()         清空历史（图被重建或节点集合变化时调用）
 *   - manager.canUndo() / canRedo()
 */
(function () {
  'use strict';

  const MAX_HISTORY = 100;

  function snapshot(graph) {
    if (!graph || graph.destroyed) return null;
    return graph.getNodes().map((node) => {
      const m = node.getModel();
      return { id: m.id, x: m.x, y: m.y, label: m.label };
    });
  }

  function snapshotsEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (x.id !== y.id || x.x !== y.x || x.y !== y.y || x.label !== y.label) {
        return false;
      }
    }
    return true;
  }

  // 撤销/重做时位置以补间动画的形式过渡到目标，标签变更则立即生效
  // （标签是文字内容，不适合做插值）。动画时长保持 280ms，足够看到方向但不拖沓。
  const ANIM_DURATION_MS = 280;

  function applySnapshot(graph, snap, options) {
    if (!graph || graph.destroyed || !snap) return;
    const opts = options || {};
    const animate = opts.animate !== false;
    const onFinish = typeof opts.onFinish === 'function' ? opts.onFinish : null;
    const animator =
      animate && window.Layout && window.Layout.animateNodesToTargets;

    // 标签直接更新；位置先收集成 targets 留给动画函数
    const targets = new Map();
    graph.setAutoPaint(false);
    snap.forEach((s) => {
      const item = graph.findById(s.id);
      if (!item) return;
      const cur = item.getModel();
      if (cur.label !== s.label) {
        graph.updateItem(item, { label: s.label });
      }
      if (cur.x !== s.x || cur.y !== s.y) {
        targets.set(s.id, { x: s.x, y: s.y });
      }
    });
    graph.paint();
    graph.setAutoPaint(true);

    if (targets.size === 0) {
      if (onFinish) onFinish();
      return;
    }

    if (animator) {
      animator(graph, targets, ANIM_DURATION_MS, onFinish);
    } else {
      // 兜底：没有 Layout 模块时直接跳到目标
      graph.setAutoPaint(false);
      targets.forEach((t, id) => {
        const item = graph.findById(id);
        if (item) graph.updateItem(item, { x: t.x, y: t.y });
      });
      graph.refreshPositions();
      graph.paint();
      graph.setAutoPaint(true);
      if (onFinish) onFinish();
    }
  }

  function createManager() {
    const past = [];
    const future = [];

    return {
      record(graph) {
        const snap = snapshot(graph);
        if (!snap) return;
        // 与上一次快照完全相同则不重复入栈
        if (past.length > 0 && snapshotsEqual(past[past.length - 1], snap)) {
          return;
        }
        past.push(snap);
        if (past.length > MAX_HISTORY) past.shift();
        future.length = 0;
      },

      undo(graph, options) {
        if (past.length === 0) return false;
        const cur = snapshot(graph);
        const prev = past.pop();
        if (cur) future.push(cur);
        applySnapshot(graph, prev, options);
        return true;
      },

      redo(graph, options) {
        if (future.length === 0) return false;
        const cur = snapshot(graph);
        const next = future.pop();
        if (cur) past.push(cur);
        applySnapshot(graph, next, options);
        return true;
      },

      reset() {
        past.length = 0;
        future.length = 0;
      },

      canUndo() {
        return past.length > 0;
      },

      canRedo() {
        return future.length > 0;
      },
    };
  }

  window.History = { createManager };
})();
