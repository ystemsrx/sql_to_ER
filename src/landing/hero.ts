// ─────────────────────────────────────────────────
//  落地页 Hero 真实 ER 图（G6 force2，与 sql2er.html 同款示例）
//  —— 该模块通过动态 import 懒加载：G6 + 布局代码（~1.5MB）不会
//     阻塞落地页首屏。拖动时实时重跑轻量物理模拟：其他节点被挤开或拉过来。
// ─────────────────────────────────────────────────
import G6 from "@antv/g6";
import { parseSQLTables } from "../parser/sql";
import { parseDBML } from "../parser/dbml";
import * as ERBuilder from "../builder";
import * as Layout from "../layout";

const HERO_SOURCES: Record<string, string> = {
  zh: `Table 用户 {
  编号 INT [pk, increment]
  用户名 VARCHAR(255) [not null]
  邮箱 VARCHAR(255) [unique]
  创建时间 TIMESTAMP
  国家编号 INT [not null]
}

Table 国家 {
  编号 INT [pk]
  名称 VARCHAR(255) [not null]
}

Table 文章 {
  文章编号 INT [pk]
  内容 TEXT
  作者编号 INT [not null]
}

Ref 属于: 用户.国家编号 > 国家.编号
Ref 作者: 文章.作者编号 > 用户.编号`,
  en: `Table users {
  id INT [pk, increment]
  username VARCHAR(255) [not null]
  email VARCHAR(255) [unique]
  created_at TIMESTAMP
  country_id INT [not null]
}

Table countries {
  id INT [pk]
  name VARCHAR(255) [not null]
}

Table posts {
  post_id INT [pk]
  content TEXT
  author_id INT [not null]
}

Ref belongs_to: users.country_id > countries.id
Ref author: posts.author_id > users.id`,
};

let heroGraph: any = null;
let heroResetLayout: (() => void) | null = null;
let heroWheelCleanup: (() => void) | null = null;
let heroInited = false;
const heroState: {
  pinnedId: string | null;
  dragging: boolean;
  initialPositions: Map<string, { x: number; y: number }> | null;
  initialMatrix: number[] | null;
} = {
  pinnedId: null,
  dragging: false,
  initialPositions: null,
  initialMatrix: null,
};

function attachHeroSmoothZoom(graph: any, mount: HTMLElement) {
  const ZOOM_STEP = 1.12;
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 10;
  const SMOOTHING = 0.22;
  const MIN_ZOOM_DELTA = 0.0015;
  let targetZoom: number | null = null;
  let zoomPivot: { x: number; y: number } | null = null;
  let rafId: number | null = null;

  const tick = () => {
    rafId = null;
    if (!graph || graph.destroyed || targetZoom === null || !zoomPivot) {
      targetZoom = null;
      zoomPivot = null;
      return;
    }
    const cur = graph.getZoom();
    const diff = targetZoom - cur;
    if (Math.abs(diff) < MIN_ZOOM_DELTA) {
      graph.zoomTo(targetZoom, zoomPivot);
      targetZoom = null;
      zoomPivot = null;
      return;
    }
    graph.zoomTo(cur + diff * SMOOTHING, zoomPivot);
    rafId = requestAnimationFrame(tick);
  };

  const onWheel = (e: WheelEvent) => {
    if (!graph || graph.destroyed) return;
    e.preventDefault();
    e.stopPropagation();
    const canvas = graph.get("canvas");
    const p = canvas.getPointByClient(e.clientX, e.clientY);
    zoomPivot = { x: p.x, y: p.y };
    const base = targetZoom !== null ? targetZoom : graph.getZoom();
    const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
    targetZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, base * factor));
    if (rafId === null) rafId = requestAnimationFrame(tick);
  };

  mount.addEventListener("wheel", onWheel, {
    capture: true,
    passive: false,
  });
  return () => {
    mount.removeEventListener("wheel", onWheel, { capture: true });
    if (rafId !== null) cancelAnimationFrame(rafId);
  };
}

function buildHeroGraph() {
  const stage = document.getElementById("erStage");
  const mount = document.getElementById("hero-er");
  if (!stage || !mount) return;
  // 构建期间瞬时隐藏，防止用户看到未 fit 的大图一闪
  stage.classList.add("is-building");
  stage.classList.remove("is-loading");
  if (
    !G6 ||
    !ERBuilder ||
    !Layout ||
    typeof parseSQLTables !== "function" ||
    typeof parseDBML !== "function"
  ) {
    stage.classList.add("is-failed");
    return;
  }
  ERBuilder.registerCustomNodes(G6);

  const lang = (document.documentElement.getAttribute("lang") || "zh").startsWith("zh")
    ? "zh"
    : "en";
  const SRC = HERO_SOURCES[lang] || HERO_SOURCES.zh;
  const HERO_STROKE_WIDTH = 1.8;

  let parsed = parseSQLTables(SRC);
  if (!parsed.tables.length) parsed = parseDBML(SRC);
  const { tables, relationships } = parsed;
  if (!tables.length) {
    stage.classList.add("is-failed");
    return;
  }

  const { nodes, edges } = (ERBuilder as any).generateChenModelData(
    tables,
    relationships,
    true,
    "name",
  );
  (Layout as any).applyInitialComponentPositions(nodes, edges, mount, 0);

  if (heroGraph && !heroGraph.destroyed) {
    heroGraph.destroy();
    heroGraph = null;
  }

  const W = mount.offsetWidth,
    H = mount.offsetHeight;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const CANVAS_BG = getComputedStyle(stage).backgroundColor || (isDark ? "#222119" : "#f5f3ec");
  if (heroWheelCleanup) {
    heroWheelCleanup();
    heroWheelCleanup = null;
  }

  const graph = new (G6 as any).Graph({
    container: mount,
    width: W,
    height: H,
    renderer: "canvas",
    background: CANVAS_BG,
    fitView: false, // 自己在 onLayoutEnd 用 smoothFitView，避免双重 fit 的抖动
    // 关键：drag-canvas 必须 allowDragOnItem:true 且在节点上 shouldBegin 返回 false，
    // 否则画布拖动会吃掉节点上的 mousedown，drag-node 永远触发不了。
    modes: {
      default: [
        { type: "drag-node", enableDelegate: false },
        {
          type: "drag-canvas",
          allowDragOnItem: true,
          enableOptimize: false,
          shouldBegin(e: any) {
            return !e.item || e.item.getType() !== "node";
          },
        },
      ],
    },
    // —— 初始布局：force2 同步跑完（animate:false），避免渲染时看到过程 ——
    layout: {
      type: "force2",
      preventOverlap: true,
      nodeSize: (node: any) =>
        ({ entity: 120, relationship: 80, attribute: 80 })[node.nodeType as string] || 80,
      nodeSpacing: 16,
      linkDistance: 100,
      coulombDisScale: 0.005,
      damping: 0.9,
      maxSpeed: 1000,
      minMovement: 0.4,
      interval: 0.02,
      factor: 1,
      maxIteration: 600,
      animate: false, // 关键：同步收敛，不再边跑边渲染
      center: [W / 2, H / 2],
      onLayoutEnd: () => {
        // 只处理多个不连通分量的情况（单分量时 onFinish 立即触发）
        // fitView 不放这里——放在 buildHeroGraph 最后统一调，避免被后续
        // applyWarmTheme / patchRelationshipLinkPoints / paint 盖掉。
        if (heroGraph && !heroGraph.destroyed) {
          (Layout as any).spreadDisconnectedComponents(heroGraph, () => {});
        }
      },
    },
    defaultNode: {
      style: { lineWidth: HERO_STROKE_WIDTH, stroke: "#141413", fill: "#ffffff" },
      labelCfg: {
        style: {
          fill: "#141413",
          fontSize: 13,
          fontFamily: "Poppins, system-ui, sans-serif",
        },
      },
    },
    defaultEdge: {
      style: { lineWidth: HERO_STROKE_WIDTH, stroke: "#6B6860" },
      labelCfg: {
        style: {
          fill: "#141413",
          fontSize: 12,
          fontFamily: "Poppins, system-ui, sans-serif",
          background: {
            fill: CANVAS_BG,
            padding: [2, 4, 2, 4],
            radius: 2,
          },
        },
      },
    },
  });

  heroGraph = graph;
  graph.data({
    nodes: JSON.parse(JSON.stringify(nodes)),
    edges: JSON.parse(JSON.stringify(edges)),
  });
  graph.render();
  heroWheelCleanup = attachHeroSmoothZoom(graph, mount);

  // 暖调配色：light / dark 分别一套，保持 Chen 模型可读
  // 暗色模式：边框 & 连线 & 文字全白；菱形保持橙色
  const T = isDark
    ? {
        entityFill: "#1b1a16",
        entityStroke: "#ffffff",
        entityText: "#ffffff",
        relFill: "#3a261c",
        relStroke: "#D97757",
        relText: "#ffffff",
        pkFill: "#1b1a16",
        pkStroke: "#ffffff",
        pkText: "#ffffff",
        attrFill: "#1b1a16",
        attrStroke: "#ffffff",
        attrText: "#ffffff",
        edgeStroke: "#ffffff",
        edgeLabelFill: "#ffffff",
      }
    : {
        entityFill: "#FDFCF8",
        entityStroke: "#141413",
        entityText: "#141413",
        relFill: "#FCEEE4",
        relStroke: "#D97757",
        relText: "#C96442",
        pkFill: "#FDFCF8",
        pkStroke: "#141413",
        pkText: "#141413",
        attrFill: "#FDFCF8",
        attrStroke: "#141413",
        attrText: "#141413",
        edgeStroke: "#141413",
        edgeLabelFill: "#141413",
      };

  // ⚠️ builder.js 里 attribute/relationship 的 draw() 把 text fill 写死为 '#000'，
  // 而且这两个自定义节点没有 update() 方法 —— G6 对没 update 的节点执行
  // updateItem 时会重新调用 draw()，把硬编码的黑色文字又刷回来。
  // 我们必须在 updateItem 之后绕开 G6，直接拿到底层 text/line shape 改 attr。
  const repaintNodeText = () => {
    if (!graph || graph.destroyed) return;
    graph.getNodes().forEach((node: any) => {
      const m = node.getModel();
      let textFill: string | undefined;
      if (m.nodeType === "entity") textFill = T.entityText;
      else if (m.nodeType === "relationship") textFill = T.relText;
      else if (m.nodeType === "attribute") textFill = m.keyType === "pk" ? T.pkText : T.attrText;
      if (!textFill) return;

      const group = node.getContainer && node.getContainer();
      const children =
        group && (group.getChildren ? group.getChildren() : group.get && group.get("children"));
      if (!children || !children.forEach) return;

      children.forEach((child: any) => {
        const name = child.get ? child.get("name") : child.cfg && child.cfg.name;
        if (name === "entity-text" || name === "attribute-text" || name === "relationship-text") {
          child.attr("fill", textFill);
        } else if (name === "attribute-underline") {
          child.attr({ stroke: textFill, lineWidth: HERO_STROKE_WIDTH });
        }
      });
    });
  };

  const applyWarmTheme = () => {
    if (!graph || graph.destroyed) return;
    graph.setAutoPaint(false);
    graph.getNodes().forEach((node: any) => {
      const m = node.getModel();
      const styles: any = {};
      if (m.nodeType === "entity") {
        styles.style = {
          fill: T.entityFill,
          stroke: T.entityStroke,
          lineWidth: HERO_STROKE_WIDTH,
        };
        styles.labelCfg = {
          style: {
            fill: T.entityText,
            fontWeight: "600",
            fontFamily: "Poppins, sans-serif",
          },
        };
      } else if (m.nodeType === "relationship") {
        styles.style = {
          fill: T.relFill,
          stroke: T.relStroke,
          lineWidth: HERO_STROKE_WIDTH,
        };
        styles.labelCfg = {
          style: { fill: T.relText, fontFamily: "Poppins, sans-serif" },
        };
      } else if (m.nodeType === "attribute") {
        if (m.keyType === "pk") {
          styles.style = {
            fill: T.pkFill,
            stroke: T.pkStroke,
            lineWidth: HERO_STROKE_WIDTH,
          };
          styles.labelCfg = {
            style: {
              fill: T.pkText,
              fontWeight: "600",
              fontFamily: "Poppins, sans-serif",
            },
          };
        } else {
          styles.style = {
            fill: T.attrFill,
            stroke: T.attrStroke,
            lineWidth: HERO_STROKE_WIDTH,
          };
          styles.labelCfg = {
            style: {
              fill: T.attrText,
              fontFamily: "Poppins, sans-serif",
            },
          };
        }
      }
      graph.updateItem(node, styles);
    });
    graph.getEdges().forEach((edge: any) => {
      graph.updateItem(edge, {
        style: { stroke: T.edgeStroke, lineWidth: HERO_STROKE_WIDTH, endArrow: false },
        labelCfg: {
          style: {
            fill: T.edgeLabelFill,
            fontSize: 12,
            background: {
              fill: CANVAS_BG,
              padding: [2, 4, 2, 4],
              radius: 2,
            },
          },
        },
      });
    });
    repaintNodeText(); // 放在 updateItem 之后
    graph.paint();
    graph.setAutoPaint(true);
  };

  // 先 patch 菱形连线再上色；patchRelationshipLinkPoints 里的 graph.refresh()
  // 如果触发重绘，也会把 draw() 里的 '#000' 刷回来，所以颜色覆盖必须放最后。
  (ERBuilder as any).patchRelationshipLinkPoints(graph);
  applyWarmTheme();
  // 再兜底一次：保证 text fill 是最终态
  repaintNodeText();
  graph.paint();

  // 最后一步：等所有 paint / refresh 都稳定了，再 fit 到画布大小
  // 用 RAF 推迟一帧，避开当前 paint 周期内的任何视口重置；
  // fit 完成后再 RAF 一帧才撤掉 is-building，让浏览器先画出 fit 后的状态
  requestAnimationFrame(() => {
    if (heroGraph && !heroGraph.destroyed) heroGraph.fitView(20);
    requestAnimationFrame(() => {
      stage.classList.remove("is-building");
      // 快照初始收敛位置 + 视口矩阵，供「重置布局」按钮平滑还原
      if (heroGraph && !heroGraph.destroyed) {
        const snap = new Map<string, { x: number; y: number }>();
        heroGraph.getNodes().forEach((n: any) => {
          const m = n.getModel();
          snap.set(m.id, { x: m.x, y: m.y });
        });
        heroState.initialPositions = snap;
        const rootGroup = heroGraph.get("group");
        const mat = rootGroup && rootGroup.getMatrix();
        heroState.initialMatrix = mat ? [...mat] : null;
      }
    });
  });

  // ─────────────────────────────────────────────
  //  实时拖拽：自写轻量物理模拟（force2 思路）
  //  —— 不依赖 G6 的 layout tick（它 animate:false 初始后就不再跑）
  //  —— drag-node 会把被拖节点同步到鼠标，其余节点在 sim loop 里被斥力/引力推拉
  // ─────────────────────────────────────────────
  const radius = (m: any) =>
    ({ entity: 70, relationship: 45, attribute: 45 })[m.nodeType as string] || 45;
  const adj = new Map<string, Set<string>>();
  graph.getEdges().forEach((e: any) => {
    const m = e.getModel();
    if (!adj.has(m.source)) adj.set(m.source, new Set());
    if (!adj.has(m.target)) adj.set(m.target, new Set());
    adj.get(m.source)!.add(m.target);
    adj.get(m.target)!.add(m.source);
  });

  const velocities = new Map<string, { vx: number; vy: number }>();
  let simRaf: number | null = null;
  let settleFrames = 0; // 松手后继续跑的帧数，让画面自然收敛

  const simStep = () => {
    if (!heroGraph || heroGraph.destroyed) {
      simRaf = null;
      return;
    }
    const simNodes = heroGraph.getNodes();
    const pos: Record<string, { x: number; y: number }> = {};
    const radii: Record<string, number> = {};
    simNodes.forEach((n: any) => {
      const m = n.getModel();
      pos[m.id] = { x: m.x || 0, y: m.y || 0 };
      radii[m.id] = radius(m);
    });

    const ids = Object.keys(pos);
    const IDEAL = 95,
      K_ATTRACT = 0.04,
      K_REPEL = 5500,
      DAMPING = 0.75,
      MAX_V = 14;

    simNodes.forEach((n: any) => {
      const id = n.getID();
      if (id === heroState.pinnedId) return; // 被拖节点由 G6 drag-node 负责，不算力
      const p = pos[id],
        r = radii[id];
      let fx = 0,
        fy = 0;

      // 斥力：所有其它节点
      for (let i = 0; i < ids.length; i++) {
        const oid = ids[i];
        if (oid === id) continue;
        const op = pos[oid],
          orr = radii[oid];
        const dx = p.x - op.x,
          dy = p.y - op.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) d2 = 1;
        const d = Math.sqrt(d2);
        const minD = r + orr + 8;
        // 近程重斥 + 远程弱斥
        const mag = K_REPEL / d2 + (d < minD ? (minD - d) * 0.8 : 0);
        fx += (dx / d) * mag;
        fy += (dy / d) * mag;
      }

      // 引力：连边邻居
      const nb = adj.get(id);
      if (nb)
        nb.forEach((nid) => {
          const op = pos[nid];
          if (!op) return;
          const dx = op.x - p.x,
            dy = op.y - p.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const delta = (d - IDEAL) * K_ATTRACT;
          fx += (dx / d) * delta;
          fy += (dy / d) * delta;
        });

      // 速度 + 阻尼 + 速度上限
      const v = velocities.get(id) || { vx: 0, vy: 0 };
      v.vx = (v.vx + fx) * DAMPING;
      v.vy = (v.vy + fy) * DAMPING;
      const sp = Math.sqrt(v.vx * v.vx + v.vy * v.vy);
      if (sp > MAX_V) {
        v.vx = (v.vx / sp) * MAX_V;
        v.vy = (v.vy / sp) * MAX_V;
      }
      velocities.set(id, v);

      if (Math.abs(v.vx) > 0.05 || Math.abs(v.vy) > 0.05) {
        heroGraph.updateItem(n, { x: p.x + v.vx, y: p.y + v.vy }, false);
      }
    });

    // 是否继续
    if (heroState.dragging) {
      simRaf = requestAnimationFrame(simStep);
    } else if (settleFrames-- > 0) {
      simRaf = requestAnimationFrame(simStep);
    } else {
      simRaf = null;
    }
  };

  const startSim = () => {
    if (!simRaf) simRaf = requestAnimationFrame(simStep);
  };

  graph.on("node:dragstart", (e: any) => {
    if (!e.item) return;
    heroState.dragging = true;
    heroState.pinnedId = e.item.getID();
    velocities.clear();
    startSim();
  });

  // 跟 sql2er.html 一致：drag-node 已经把节点 model.x/y 同步到鼠标了，
  // 我们只【读取】model，不要手动 updateItem 去覆盖——否则会把节点甩到错误坐标
  graph.on("node:drag", () => {
    startSim();
  });

  graph.on("node:dragend", () => {
    heroState.dragging = false;
    heroState.pinnedId = null;
    settleFrames = 40; // 松手后再跑 ~0.6s 让画面自然停下来
    startSim();
  });

  // 「重置布局」平滑回到初始收敛位置 —— 不销毁重建，只 tween 坐标
  let resetRaf: number | null = null;
  heroResetLayout = () => {
    if (!heroGraph || heroGraph.destroyed || !heroState.initialPositions) return;
    // 停掉物理模拟和上一次未结束的 reset 动画
    if (simRaf) {
      cancelAnimationFrame(simRaf);
      simRaf = null;
    }
    if (resetRaf) {
      cancelAnimationFrame(resetRaf);
      resetRaf = null;
    }
    heroState.dragging = false;
    heroState.pinnedId = null;
    velocities.clear();
    settleFrames = 0;

    const resetNodes = heroGraph.getNodes();
    const starts = new Map<string, { x: number; y: number }>();
    resetNodes.forEach((n: any) => {
      const m = n.getModel();
      starts.set(m.id, { x: m.x || 0, y: m.y || 0 });
    });

    // 视口矩阵也一起 tween：起点为当前矩阵，终点为初始 fit 后的快照
    const rootGroup = heroGraph.get("group");
    const startMatrix = rootGroup && rootGroup.getMatrix() ? [...rootGroup.getMatrix()] : null;
    const endMatrix = heroState.initialMatrix;
    const canTweenMatrix = startMatrix && endMatrix && startMatrix.length === endMatrix.length;

    const DURATION = 520;
    const t0 = performance.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic

    const tick = () => {
      if (!heroGraph || heroGraph.destroyed) {
        resetRaf = null;
        return;
      }
      const t = Math.min(1, (performance.now() - t0) / DURATION);
      const k = ease(t);
      resetNodes.forEach((n: any) => {
        const id = n.getID();
        const s = starts.get(id);
        const e = heroState.initialPositions!.get(id);
        if (!s || !e) return;
        heroGraph.updateItem(n, { x: s.x + (e.x - s.x) * k, y: s.y + (e.y - s.y) * k }, false);
      });
      if (canTweenMatrix && rootGroup) {
        const m = startMatrix!.map((v, i) => v + (endMatrix![i] - v) * k);
        rootGroup.setMatrix(m);
      }
      heroGraph.paint();
      if (t < 1) {
        resetRaf = requestAnimationFrame(tick);
      } else {
        resetRaf = null;
      }
    };
    resetRaf = requestAnimationFrame(tick);
  };
}

/** 语言 / 主题切换后重建（配色 + 画布背景都会跟着换） */
export function rebuildHero() {
  if (heroInited) buildHeroGraph();
}

/** 「重置布局」：平滑回到初始 force2 收敛位置（不销毁重建） */
export function resetHeroLayout() {
  if (typeof heroResetLayout === "function") heroResetLayout();
}

/** 首次初始化：构建图 + 注册响应式重建。幂等，可安全多次调用。 */
export function initHero() {
  if (heroInited) return;
  heroInited = true;
  buildHeroGraph();

  // 响应式：显著宽度变化才重建
  const mount = document.getElementById("hero-er");
  if (!mount) return;
  let lastW = mount.offsetWidth;
  const ro = new ResizeObserver(() => {
    const w = mount.offsetWidth;
    if (Math.abs(w - lastW) > 60) {
      lastW = w;
      buildHeroGraph();
    } else if (heroGraph && !heroGraph.destroyed) {
      heroGraph.changeSize(mount.offsetWidth, mount.offsetHeight);
    }
  });
  ro.observe(mount);
}
