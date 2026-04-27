/**
 * Attribute Layout Module
 *
 * 隐藏 / 显示"属性"节点时所需的布局与图操作逻辑。
 * 公开接口（window.AttributeLayout）：
 *   - hideAttributes(graph)
 *       从 graph 中移除所有 attribute 节点及其相连的边，
 *       保留 entity / relationship 及其相对位置。
 *   - showAttributes({ graph, tables, labelMode, isColored, updateStyles })
 *       按 tables 数据为图中已有实体重建属性节点，
 *       并用 computeAttributePositions 计算最优位置。
 *   - computeAttributePositions(graph, newAttrNodes)
 *       纯算法：给定"要加入图的属性节点"及其 parentEntity，
 *       在不改动现有节点的前提下，为每个新属性算出不重叠 / 不交叉的 (x,y)。
 *
 * 依赖：ERBuilder 中的
 *   buildAttributeData, estimateAttributeHalfSize, patchRelationshipLinkPoints
 */

import {
  buildAttributeData,
  estimateAttributeHalfSize,
  patchRelationshipLinkPoints,
} from "./builder";
import type { ChenModelData, ERNodeModel, GraphLike, ParsedTable } from "./types";

interface LayoutNodeRecord {
  id: string;
  x: number;
  y: number;
  halfW: number;
  halfH: number;
  nodeType?: string;
}

interface ObstacleEdge {
  source: string;
  target: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

type AttrNode = ERNodeModel & {
  parentEntity: string;
  _halfW?: number;
  _halfH?: number;
};

  const TAU = Math.PI * 2;
  const EDGE_PADDING = 18; // 节点之间的安全间距
  const MAX_R_EXTRA = 220; // 距离实体中心的硬上限（扣除实体半径外）

  // ---------- 几何工具 ----------

  // 将节点中心投影到其 AABB 边界上，方向指向 (tx,ty)。
  // 用这个点作为连线的"视觉端点"，比中心-中心更贴近渲染结果。
  const nodeBorderPoint = (n: LayoutNodeRecord, tx: number, ty: number) => {
    const dx = tx - n.x;
    const dy = ty - n.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return { x: n.x, y: n.y };
    const ux = dx / len;
    const uy = dy / len;
    const extent = Math.abs(ux) * n.halfW + Math.abs(uy) * n.halfH;
    return { x: n.x + extent * ux, y: n.y + extent * uy };
  };

  const rectsOverlap = (ax, ay, ahw, ahh, b, gap) => {
    return (
      Math.abs(ax - b.x) < ahw + b.halfW + gap &&
      Math.abs(ay - b.y) < ahh + b.halfH + gap
    );
  };

  // 严格线段相交（不含端点）。共享端点时 d3/d4 的 cross 为 0，
  // 严格不等号会让共享端点情况判为不相交。
  const cross2 = (ax, ay, bx, by) => ax * by - ay * bx;
  const segmentsIntersect = (
    x1, y1, x2, y2,
    x3, y3, x4, y4,
  ) => {
    const d1 = cross2(x4 - x3, y4 - y3, x1 - x3, y1 - y3);
    const d2 = cross2(x4 - x3, y4 - y3, x2 - x3, y2 - y3);
    const d3 = cross2(x2 - x1, y2 - y1, x3 - x1, y3 - y1);
    const d4 = cross2(x2 - x1, y2 - y1, x4 - x1, y4 - y1);
    return (
      ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
    );
  };

  // 线段是否穿过一个 AABB（端点在矩形内或任一条边相交都算）
  const segmentHitsRect = (
    sx1, sy1, sx2, sy2,
    cx, cy, hw, hh,
  ) => {
    const x1 = cx - hw, x2 = cx + hw;
    const y1 = cy - hh, y2 = cy + hh;
    if (sx1 > x1 && sx1 < x2 && sy1 > y1 && sy1 < y2) return true;
    if (sx2 > x1 && sx2 < x2 && sy2 > y1 && sy2 < y2) return true;
    return (
      segmentsIntersect(sx1, sy1, sx2, sy2, x1, y1, x2, y1) ||
      segmentsIntersect(sx1, sy1, sx2, sy2, x2, y1, x2, y2) ||
      segmentsIntersect(sx1, sy1, sx2, sy2, x2, y2, x1, y2) ||
      segmentsIntersect(sx1, sy1, sx2, sy2, x1, y2, x1, y1)
    );
  };

  // 以关系连线方向作为固定锚点，把 N 个属性槽位插入各弧段，
  // 让 N 个属性 + K 条关系线 的方向在实体四周尽可能均匀分布。
  const distributeAttributeAngles = (N, relAngles) => {
    if (N <= 0) return { angles: [], halfWindows: [] };
    const K = relAngles.length;
    if (K === 0) {
      const step = TAU / N;
      return {
        angles: Array.from({ length: N }, (_, i) => i * step),
        halfWindows: Array.from({ length: N }, () => step * 0.48),
      };
    }
    const sorted = relAngles
      .map((a) => ((a % TAU) + TAU) % TAU)
      .sort((a, b) => a - b);
    const target = TAU / (N + K);
    const arcs = sorted.map((start, i) => {
      const end = sorted[(i + 1) % K];
      let width = end - start;
      if (width <= 1e-9) width += TAU;
      const raw = Math.max(0, width / target - 1);
      return {
        start,
        width,
        raw,
        count: Math.max(0, Math.round(raw)),
      };
    });

    let total = arcs.reduce((s, a) => s + a.count, 0);
    const residual = (a) => a.raw - a.count;
    while (total < N) {
      let best = 0;
      for (let i = 1; i < arcs.length; i++) {
        if (residual(arcs[i]) > residual(arcs[best])) best = i;
      }
      arcs[best].count += 1;
      total += 1;
    }
    while (total > N) {
      let best = -1;
      for (let i = 0; i < arcs.length; i++) {
        if (arcs[i].count <= 0) continue;
        if (best < 0 || residual(arcs[i]) < residual(arcs[best])) best = i;
      }
      if (best < 0) break;
      arcs[best].count -= 1;
      total -= 1;
    }

    const angles = [];
    const halfWindows = [];
    arcs.forEach((arc) => {
      const n = arc.count;
      if (n <= 0) return;
      const step = arc.width / (n + 1);
      // 每个属性的可抖动窗口：取 step 的 48%，给避障一些空间，
      // 又留 4% 的余地不与相邻槽位 / 关系线重合
      const half = step * 0.48;
      for (let j = 0; j < n; j++) {
        angles.push((arc.start + step * (j + 1)) % TAU);
        halfWindows.push(half);
      }
    });
    while (angles.length < N) {
      angles.push((angles.length / N) * TAU);
      halfWindows.push((TAU / N) * 0.48);
    }
    return {
      angles: angles.slice(0, N),
      halfWindows: halfWindows.slice(0, N),
    };
  };

  // ---------- 核心算法：为 newAttrNodes 分配位置 ----------
  //
  // 设计要点：
  // 1. 障碍集合同时包含 **节点矩形** 和 **连线段**（用"边界-边界"坐标存储）。
  // 2. 槽位角度按 distributeAttributeAngles 计算；每个属性有一个
  //    以槽位为中心的抖动窗口（近邻 48% 范围），并可选在整圆范围内再抖。
  // 3. 沿角度从 minR 向 maxR 小步扫半径，返回第一个满足所有启用约束的 R。
  //    约束分四项：
  //      rectNode   - 属性矩形不与任何其它节点重叠
  //      edgeNode   - 新连线不穿过任何其它节点矩形
  //      edgeCross  - 新连线不与任何已有连线相交
  //      rectPierce - 任何已有连线都不穿过新属性矩形
  //    分级放宽：先试全部，再依次砍掉 edgeCross、rectPierce、edgeNode。
  // 4. 每放完一个属性就把它的节点矩形 + 它到实体的连线段加入障碍集合，
  //    后续属性会据此避让。
  // 5. 属性多的实体先排布，防止其被后排实体占掉理想方向。
  export const computeAttributePositions = (graph: GraphLike, newAttrNodes: AttrNode[]) => {
    const byEntity = new Map<string, AttrNode[]>();
    newAttrNodes.forEach((n) => {
      const pid = n.parentEntity;
      if (!byEntity.has(pid)) byEntity.set(pid, []);
      byEntity.get(pid).push(n);
    });

    const existing: LayoutNodeRecord[] = graph.getNodes().map((n) => {
      const m = n.getModel();
      const bbox = n.getBBox();
      return {
        id: m.id,
        x: m.x || 0,
        y: m.y || 0,
        halfW: (bbox.width || 80) / 2,
        halfH: (bbox.height || 40) / 2,
        nodeType: m.nodeType,
      };
    });
    const entityMap = new Map<string, LayoutNodeRecord>(
      existing.filter((n) => n.nodeType === "entity").map((n) => [n.id, n]),
    );
    const nodeById = new Map<string, LayoutNodeRecord>(existing.map((n) => [n.id, n]));

    // 现有连线段，用"边界-边界"坐标保存
    const obstacleEdges: ObstacleEdge[] = [];
    graph.getEdges().forEach((e) => {
      const m = e.getModel();
      const s = nodeById.get(m.source);
      const t = nodeById.get(m.target);
      if (!s || !t) return;
      const p1 = nodeBorderPoint(s, t.x, t.y);
      const p2 = nodeBorderPoint(t, s.x, s.y);
      obstacleEdges.push({
        source: m.source,
        target: m.target,
        x1: p1.x, y1: p1.y,
        x2: p2.x, y2: p2.y,
      });
    });

    // 每个实体连接的关系节点的方向（用于槽位分配）
    const relAnglesByEntity = new Map<string, number[]>();
    graph.getEdges().forEach((e) => {
      const em = e.getModel();
      if (
        em.edgeType !== "entity-relationship" &&
        em.edgeType !== "relationship-entity"
      )
        return;
      let entId: string | null = null;
      let otherId: string | null = null;
      if (entityMap.has(em.source)) {
        entId = em.source;
        otherId = em.target;
      } else if (entityMap.has(em.target)) {
        entId = em.target;
        otherId = em.source;
      } else {
        return;
      }
      const other = nodeById.get(otherId);
      if (!other) return;
      const ent = entityMap.get(entId);
      if (!ent) return;
      const ang = Math.atan2(other.y - ent.y, other.x - ent.x);
      if (!relAnglesByEntity.has(entId)) relAnglesByEntity.set(entId, []);
      relAnglesByEntity.get(entId).push(ang);
    });

    // 属性多的实体先排布
    const entityOrder = Array.from(byEntity.keys()).sort(
      (a, b) => byEntity.get(b).length - byEntity.get(a).length,
    );

    entityOrder.forEach((entityId) => {
      const attrs = byEntity.get(entityId);
      const ent = entityMap.get(entityId);
      if (!ent) return;
      const N = attrs.length;
      if (!N) return;

      attrs.forEach((a) => {
        const sz = estimateAttributeHalfSize(a.label);
        a._halfW = sz.halfW;
        a._halfH = sz.halfH;
      });

      const relAngles = relAnglesByEntity.get(entityId) || [];
      const { angles: slotAngles, halfWindows } = distributeAttributeAngles(
        N,
        relAngles,
      );

      attrs.forEach((attr, i) => {
        const baseAngle = slotAngles[i];
        const halfWindow = halfWindows[i];
        const attrHW = attr._halfW;
        const attrHH = attr._halfH;

        // 属性矩形朝 ent 方向的投影半径（用于取新连线在属性端的视觉端点）
        const attrBorderTowardEnt = (px: number, py: number) => {
          const dx2 = ent.x - px;
          const dy2 = ent.y - py;
          const len = Math.hypot(dx2, dy2);
          if (len < 1e-9) return { x: px, y: py };
          const ux = dx2 / len;
          const uy = dy2 / len;
          const ex = Math.abs(ux) * attrHW + Math.abs(uy) * attrHH;
          return { x: px + ex * ux, y: py + ex * uy };
        };

        const tryAngleWithFlags = (angle: number, flags: any, maxROverride?: number) => {
          const dx = Math.cos(angle);
          const dy = Math.sin(angle);
          const entExtent =
            Math.abs(dx) * ent.halfW + Math.abs(dy) * ent.halfH;
          const attrExtent =
            Math.abs(dx) * attrHW + Math.abs(dy) * attrHH;
          const minR = entExtent + attrExtent + EDGE_PADDING;
          const maxR =
            maxROverride !== undefined
              ? maxROverride
              : entExtent + MAX_R_EXTRA;
          const STEP = 4;

          for (let R = minR; R <= maxR; R += STEP) {
            const px = ent.x + R * dx;
            const py = ent.y + R * dy;

            // 新连线的视觉两端（实体外缘 → 属性外缘）
            const entBorder = nodeBorderPoint(ent, px, py);
            const attrBorder = attrBorderTowardEnt(px, py);
            const nex1 = entBorder.x, ney1 = entBorder.y;
            const nex2 = attrBorder.x, ney2 = attrBorder.y;

            let bad = false;

            if (flags.rectNode) {
              for (let k = 0; k < existing.length; k++) {
                const n = existing[k];
                if (n.id === entityId) continue;
                if (rectsOverlap(px, py, attrHW, attrHH, n, 6)) {
                  bad = true;
                  break;
                }
              }
              if (bad) continue;
            }

            if (flags.edgeNode) {
              for (let k = 0; k < existing.length; k++) {
                const n = existing[k];
                if (n.id === entityId) continue;
                if (
                  segmentHitsRect(
                    nex1, ney1, nex2, ney2,
                    n.x, n.y, n.halfW + 3, n.halfH + 3,
                  )
                ) {
                  bad = true;
                  break;
                }
              }
              if (bad) continue;
            }

            if (flags.edgeCross) {
              for (let k = 0; k < obstacleEdges.length; k++) {
                const e = obstacleEdges[k];
                if (e.source === entityId || e.target === entityId) continue;
                if (
                  segmentsIntersect(
                    nex1, ney1, nex2, ney2,
                    e.x1, e.y1, e.x2, e.y2,
                  )
                ) {
                  bad = true;
                  break;
                }
              }
              if (bad) continue;
            }

            if (flags.rectPierce) {
              for (let k = 0; k < obstacleEdges.length; k++) {
                const e = obstacleEdges[k];
                if (
                  segmentHitsRect(
                    e.x1, e.y1, e.x2, e.y2,
                    px, py, attrHW, attrHH,
                  )
                ) {
                  bad = true;
                  break;
                }
              }
              if (bad) continue;
            }

            return {
              angle, R, dx, dy, minR,
              nex1, ney1, nex2, ney2,
            };
          }
          return null;
        };

        // 主候选：基准槽角 + 在窗口内的较细抖动
        const slotDeltas = [0];
        const SAMPLES = 8;
        for (let k = 1; k <= SAMPLES; k++) {
          const f = (k / SAMPLES) * halfWindow;
          slotDeltas.push(f, -f);
        }
        // 次级候选：整圆均匀抖动（每 20°），仅在严格约束下仍找不到位置时用到
        const circleDeltas = [];
        const CIRCLE_SAMPLES = 18;
        for (let k = 1; k < CIRCLE_SAMPLES; k++) {
          let d = (k / CIRCLE_SAMPLES) * TAU;
          if (d > Math.PI) d -= TAU;
          circleDeltas.push(d);
        }

        // 与基准槽角的最小角度差（归一化到 [0, π]）
        const normDev = (d) => {
          let x = ((d % TAU) + TAU) % TAU;
          if (x > Math.PI) x = TAU - x;
          return x;
        };

        const STRICT = {
          rectNode: true,
          edgeNode: true,
          edgeCross: true,
          rectPierce: true,
        };
        const NO_CROSS = {
          rectNode: true,
          edgeNode: true,
          edgeCross: false,
          rectPierce: true,
        };
        const NO_CROSS_PIERCE = {
          rectNode: true,
          edgeNode: true,
          edgeCross: false,
          rectPierce: false,
        };
        const ONLY_NODES = {
          rectNode: true,
          edgeNode: false,
          edgeCross: false,
          rectPierce: false,
        };

        const DEV_PENALTY = 75; // 每弧度的偏离惩罚
        const findBestInCandidates = (deltas, flags) => {
          let local = null;
          for (const d of deltas) {
            const r = tryAngleWithFlags(baseAngle + d, flags);
            if (!r) continue;
            const score = r.R + normDev(d) * DEV_PENALTY;
            if (!local || score < local.score) local = { ...r, score };
          }
          return local;
        };

        // 严格层：先在槽内精细抖动找最优；找不到再扩展到全圆
        let best = findBestInCandidates(slotDeltas, STRICT);
        if (!best) best = findBestInCandidates(circleDeltas, STRICT);
        // 分级放宽（同样先槽内，再全圆），尽可能保留更多约束
        if (!best) best = findBestInCandidates(slotDeltas, NO_CROSS);
        if (!best) best = findBestInCandidates(circleDeltas, NO_CROSS);
        if (!best) best = findBestInCandidates(slotDeltas, NO_CROSS_PIERCE);
        if (!best) best = findBestInCandidates(circleDeltas, NO_CROSS_PIERCE);
        if (!best) best = findBestInCandidates(slotDeltas, ONLY_NODES);

        // 最后兜底：全部放宽仍没位置时，允许更大半径，只保证不与节点矩形重叠
        if (!best) {
          const hardCap =
            Math.max(ent.halfW, ent.halfH) + MAX_R_EXTRA + 160;
          best = tryAngleWithFlags(baseAngle, ONLY_NODES, hardCap);
        }
        if (!best) {
          const dx = Math.cos(baseAngle);
          const dy = Math.sin(baseAngle);
          const entExtent =
            Math.abs(dx) * ent.halfW + Math.abs(dy) * ent.halfH;
          const attrExtent =
            Math.abs(dx) * attrHW + Math.abs(dy) * attrHH;
          best = {
            angle: baseAngle,
            R: entExtent + attrExtent + EDGE_PADDING,
            dx,
            dy,
          };
        }

        const px = ent.x + best.R * best.dx;
        const py = ent.y + best.R * best.dy;
        attr.x = px;
        attr.y = py;

        // 把这个属性作为后续计算的障碍
        const record = {
          id: attr.id,
          x: px,
          y: py,
          halfW: attrHW,
          halfH: attrHH,
          nodeType: "attribute",
        };
        existing.push(record);
        nodeById.set(attr.id, record);
        // 新连线同样以视觉端点（边界-边界）加入障碍
        const eBorder = nodeBorderPoint(ent, px, py);
        const aBorder = nodeBorderPoint(record, ent.x, ent.y);
        obstacleEdges.push({
          source: entityId,
          target: attr.id,
          x1: eBorder.x, y1: eBorder.y,
          x2: aBorder.x, y2: aBorder.y,
        });
      });
    });
  };

  // ---------- 图操作封装 ----------

  // 本模块用到的少量 G6 方法不在共享 GraphLike 上，这里就近补齐
  interface MutableGraph extends GraphLike {
    removeItem(item: unknown): void;
    addItem(type: "node" | "edge", model: Record<string, unknown>): void;
  }

  export const hideAttributes = (graph: MutableGraph | null | undefined) => {
    if (!graph || graph.destroyed) return;
    graph.setAutoPaint(false);
    const attrNodes = graph
      .getNodes()
      .filter((n) => (n.getModel() as ERNodeModel).nodeType === "attribute")
      .slice();
    const attrIds = new Set(
      attrNodes.map((n) => (n.getModel() as ERNodeModel).id),
    );
    const edgesToRemove = graph
      .getEdges()
      .filter((e) => {
        const m = e.getModel();
        return attrIds.has(m.source) || attrIds.has(m.target);
      })
      .slice();
    edgesToRemove.forEach((e) => graph.removeItem(e));
    attrNodes.forEach((n) => graph.removeItem(n));
    graph.paint();
    graph.setAutoPaint(true);
  };

  export interface ShowAttributesOptions {
    graph: MutableGraph | null | undefined;
    tables: ParsedTable[] | null | undefined;
    labelMode: "name" | "comment" | "any";
    isColored: boolean;
    updateStyles?: (graph: GraphLike, isColored: boolean) => void;
  }

  export const showAttributes = ({
    graph,
    tables,
    labelMode,
    isColored,
    updateStyles,
  }: ShowAttributesOptions) => {
    if (!graph || graph.destroyed || !tables) return;

    const { nodes: attrNodes, edges: attrEdges } = buildAttributeData(
      tables,
      isColored,
      labelMode,
    ) as ChenModelData;

    // 过滤掉：对应实体不存在、或节点/边已存在的情况
    const validAttrs: AttrNode[] = [];
    const validEdges: ChenModelData["edges"] = [];
    attrNodes.forEach((raw) => {
      const n = raw as AttrNode;
      if (!graph.findById(n.parentEntity)) return;
      if (graph.findById(n.id)) return;
      validAttrs.push(n);
    });
    const validIds = new Set(validAttrs.map((n) => n.id));
    attrEdges.forEach((e) => {
      if (!validIds.has(e.target)) return;
      if (e.id && graph.findById(e.id)) return;
      validEdges.push(e);
    });

    if (!validAttrs.length) return;

    // 根据当前图中实体位置计算属性位置
    computeAttributePositions(graph, validAttrs);

    graph.setAutoPaint(false);
    validAttrs.forEach((n) =>
      graph.addItem("node", n as unknown as Record<string, unknown>),
    );
    validEdges.forEach((e) =>
      graph.addItem("edge", e as unknown as Record<string, unknown>),
    );
    graph.paint();
    graph.setAutoPaint(true);

    if (typeof updateStyles === "function") updateStyles(graph, isColored);
    patchRelationshipLinkPoints(graph);
  };

