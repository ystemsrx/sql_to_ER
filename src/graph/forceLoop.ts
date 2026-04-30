import type { GraphLike } from "../types";

interface ForceableGraph extends GraphLike {
  on(event: string, handler: (e: any) => void): void;
}

export interface ForceLoopController {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  destroy(): void;
}

// 持续力导向控制器
// 不依赖 G6 自带 layout tick（首次收敛后就不再跑），而是自写一个轻量
// 物理步骤。开关一旦打开，RAF 循环立刻起跑（不必先拖一下）；拖动期间
// 被拖节点由 drag-node 钉在鼠标上，其余节点在循环里被斥力 + 连边引力
// 推拉；关闭时立即停止。
export function attachForceLoop(graph: ForceableGraph): ForceLoopController {
  let enabled = false;
  let raf: number | null = null;
  let pinnedId: string | null = null;
  // 冷启动 ramp-up：当前布局相对我们这套力参数通常不在平衡点，
  // 直接放力会先把节点推远再拉回（欠阻尼弹簧）。让力 / 速度上限
  // 在前 WARMUP_TOTAL 帧从 0 平滑升到 1，节点就能贴着等势线滑过去。
  const WARMUP_TOTAL = 36;
  let warmupRemaining = 0;
  const velocities = new Map<string, { vx: number; vy: number }>();

  const radius = (m: any): number => {
    const sizes: Record<string, number> = {
      entity: 80,
      relationship: 50,
      attribute: 50,
    };
    return sizes[m?.nodeType] || 50;
  };

  const buildAdj = (): Map<string, Set<string>> => {
    const adj = new Map<string, Set<string>>();
    graph.getEdges().forEach((e) => {
      const m = e.getModel() as any;
      if (!adj.has(m.source)) adj.set(m.source, new Set());
      if (!adj.has(m.target)) adj.set(m.target, new Set());
      adj.get(m.source)!.add(m.target);
      adj.get(m.target)!.add(m.source);
    });
    return adj;
  };

  const step = () => {
    if (!graph || graph.destroyed || !enabled) {
      raf = null;
      return;
    }

    const adj = buildAdj();
    const nodes = graph.getNodes();
    const pos: Record<string, { x: number; y: number }> = {};
    const radii: Record<string, number> = {};
    nodes.forEach((n) => {
      const m = n.getModel() as any;
      pos[m.id] = { x: m.x || 0, y: m.y || 0 };
      radii[m.id] = radius(m);
    });

    const ids = Object.keys(pos);
    const IDEAL = 130;
    const K_ATTRACT = 0.04;
    const K_REPEL = 9000;
    const DAMPING = 0.78;
    const MAX_V = 16;

    // easeOutCubic：第一帧位移≈0，第 WARMUP_TOTAL 帧及之后位移=正常
    const t = warmupRemaining > 0 ? 1 - warmupRemaining / WARMUP_TOTAL : 1;
    const ramp = 1 - Math.pow(1 - t, 3);
    if (warmupRemaining > 0) warmupRemaining--;

    nodes.forEach((n) => {
      const m = n.getModel() as any;
      const id = m.id as string;
      if (id === pinnedId) return;
      const p = pos[id];
      const r = radii[id];
      let fx = 0;
      let fy = 0;

      // 斥力：所有其它节点
      for (let i = 0; i < ids.length; i++) {
        const oid = ids[i];
        if (oid === id) continue;
        const op = pos[oid];
        const orr = radii[oid];
        const dx = p.x - op.x;
        const dy = p.y - op.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) d2 = 1;
        const d = Math.sqrt(d2);
        const minD = r + orr + 8;
        const mag = K_REPEL / d2 + (d < minD ? (minD - d) * 0.8 : 0);
        fx += (dx / d) * mag;
        fy += (dy / d) * mag;
      }

      // 引力：连边邻居
      const nb = adj.get(id);
      if (nb) {
        nb.forEach((nid) => {
          const op = pos[nid];
          if (!op) return;
          const dx = op.x - p.x;
          const dy = op.y - p.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const delta = (d - IDEAL) * K_ATTRACT;
          fx += (dx / d) * delta;
          fy += (dy / d) * delta;
        });
      }

      const v = velocities.get(id) || { vx: 0, vy: 0 };
      // 冷启动阶段把净力按 ramp 缩小：速度积累得慢，等阻尼把过冲压住后
      // 再放开到完整力度。稳态时 ramp=1，行为不变。
      v.vx = (v.vx + fx * ramp) * DAMPING;
      v.vy = (v.vy + fy * ramp) * DAMPING;
      const cap = MAX_V * (0.25 + 0.75 * ramp);
      const sp = Math.sqrt(v.vx * v.vx + v.vy * v.vy);
      if (sp > cap) {
        v.vx = (v.vx / sp) * cap;
        v.vy = (v.vy / sp) * cap;
      }
      velocities.set(id, v);

      if (Math.abs(v.vx) > 0.05 || Math.abs(v.vy) > 0.05) {
        graph.updateItem(n, { x: p.x + v.vx, y: p.y + v.vy }, false);
      }
    });

    raf = requestAnimationFrame(step);
  };

  graph.on("node:dragstart", (e: any) => {
    if (!enabled || !e.item) return;
    pinnedId = e.item.getID ? e.item.getID() : (e.item.getModel() as any).id;
    velocities.clear();
    // 拖动应当走完整力度。若开关刚打开还在 warmup 中，立即收尾，
    // 这样用户从开启 → 立即拖动 的过程中也不会感到"卡顿/迟滞"。
    warmupRemaining = 0;
  });

  graph.on("node:dragend", () => {
    pinnedId = null;
  });

  const stop = () => {
    pinnedId = null;
    warmupRemaining = 0;
    if (raf != null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    velocities.clear();
  };

  return {
    setEnabled(en: boolean) {
      if (en === enabled) return;
      enabled = en;
      if (en) {
        velocities.clear();
        warmupRemaining = WARMUP_TOTAL;
        if (raf == null) raf = requestAnimationFrame(step);
      } else {
        stop();
      }
    },
    isEnabled() {
      return enabled;
    },
    destroy() {
      enabled = false;
      stop();
    },
  };
}
