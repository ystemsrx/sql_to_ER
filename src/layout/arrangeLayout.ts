/**
 * Arrange Layout Module
 * Contains the arrange layout algorithm:
 * - Evenly distribute attributes around entities
 * - Handle relationship positioning between entities
 * - Spring-based collision detection and resolution
 */

import { animateNodesToTargets, smoothFitView } from "./animation";
import type { GraphLike, GraphNodeLike } from "../types";

// ---- Spatial grid helpers (near-linear neighbor queries) ----
const buildGrid = (items, cellSize) => {
  const grid = new Map();
  items.forEach((item) => {
    const cx = Math.floor(item.pos.x / cellSize);
    const cy = Math.floor(item.pos.y / cellSize);
    const key = cx + "," + cy;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(item);
  });
  return grid;
};

const forEachNeighbor = (grid, cellSize, item, cb) => {
  const cx = Math.floor(item.pos.x / cellSize);
  const cy = Math.floor(item.pos.y / cellSize);
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const bucket = grid.get(cx + ox + "," + (cy + oy));
      if (!bucket) continue;
      for (let k = 0; k < bucket.length; k++) cb(bucket[k]);
    }
  }
};

// ---- Segment-intersection test for crossing detection ----
const segmentsCross = (a1, a2, b1, b2) => {
  // Proper-intersection test. Shared endpoints count as not crossing.
  const share = (p, q) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
  if (share(a1, b1) || share(a1, b2) || share(a2, b1) || share(a2, b2)) return false;
  const cross = (ox, oy, px, py, qx, qy) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  const d1 = cross(b1.x, b1.y, b2.x, b2.y, a1.x, a1.y);
  const d2 = cross(b1.x, b1.y, b2.x, b2.y, a2.x, a2.y);
  const d3 = cross(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y);
  const d4 = cross(a1.x, a1.y, a2.x, a2.y, b2.x, b2.y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};

/**
 * 环绕排布布局：让属性均匀围绕实体，同时可移动实体以满足关系距离
 * @param {Object} graph - G6 图形实例
 */
export const arrangeLayout = (graph: GraphLike) => {
  if (!graph || graph.destroyed) return;

  const nodes = graph.getNodes();
  if (!nodes.length) return;

  const targets = new Map<string, { x: number; y: number }>();
  const nodeMap = new Map<string, GraphNodeLike>();
  nodes.forEach((n) => nodeMap.set(n.getModel().id, n));
  const relAnchors = new Map<string, { x: number; y: number }>();
  const relRadii = new Map<string, number>();

  const entityNodes = nodes.filter((n) => n.getModel().nodeType === "entity");
  const attributeNodes = nodes.filter((n) => n.getModel().nodeType === "attribute");
  const relationshipNodes = nodes.filter((n) => n.getModel().nodeType === "relationship");

  const getRadius = (node) => {
    const bbox = node.getBBox();
    return Math.sqrt(bbox.width * bbox.width + bbox.height * bbox.height) / 2;
  };

  // 轴向最大半径：max(width, height) / 2。
  // 用作切向间隔的最坏估计（attr 在轨道任意角度上沿切线最大延伸）。
  const getAxisMax = (node) => {
    const bbox = node.getBBox();
    return Math.max(bbox.width, bbox.height) / 2;
  };

  // 轴对齐矩形在方向 (cosθ, sinθ) 的边界距离。
  // 圆形轨道把矩形当成"半径=对角线"的圆，导致正上方/正下方等
  // 非对角方向白白多算很多空隙。用真实边界后，每个方向都贴得很近。
  const rectBoundary = (rx: number, ry: number, cosT: number, sinT: number) => {
    const ac = Math.abs(cosT);
    const as = Math.abs(sinT);
    if (ac < 1e-9) return ry;
    if (as < 1e-9) return rx;
    return Math.min(rx / ac, ry / as);
  };

  // 轴对齐椭圆在方向 (cosθ, sinθ) 的边界距离。
  const ellipseBoundary = (rx: number, ry: number, cosT: number, sinT: number) => {
    if (rx <= 0 || ry <= 0) return 0;
    const denom = Math.sqrt(ry * ry * cosT * cosT + rx * rx * sinT * sinT);
    return denom > 1e-9 ? (rx * ry) / denom : 0;
  };

  // 菱形 |x|/rx + |y|/ry = 1 在方向 (cosθ, sinθ) 上的边界距离。
  const diamondBoundary = (rx: number, ry: number, cosT: number, sinT: number) => {
    if (rx <= 0 || ry <= 0) return 0;
    const denom = Math.abs(cosT) / rx + Math.abs(sinT) / ry;
    return denom > 1e-9 ? 1 / denom : 0;
  };

  const normalizeAngle = (a) => {
    let angle = a % (Math.PI * 2);
    if (angle < 0) angle += Math.PI * 2;
    return angle;
  };

  // 建立关系节点与实体节点的对应
  const relationshipConnections = new Map<string, Set<GraphNodeLike>>();
  graph.getEdges().forEach((edge) => {
    const { source, target } = edge.getModel();
    const sourceNode = nodeMap.get(source);
    const targetNode = nodeMap.get(target);
    if (!sourceNode || !targetNode) return;
    const sType = sourceNode.getModel().nodeType;
    const tType = targetNode.getModel().nodeType;
    if (sType === "relationship" && tType === "entity") {
      if (!relationshipConnections.has(source)) relationshipConnections.set(source, new Set());
      relationshipConnections.get(source).add(targetNode);
    } else if (tType === "relationship" && sType === "entity") {
      if (!relationshipConnections.has(target)) relationshipConnections.set(target, new Set());
      relationshipConnections.get(target).add(sourceNode);
    }
  });

  // 按实体收集属性与关系
  const entityInfo = new Map();
  entityNodes.forEach((e) =>
    entityInfo.set(e.getModel().id, { node: e, attrs: [], rels: [], satellites: [] }),
  );
  attributeNodes.forEach((a) => {
    const pid = a.getModel().parentEntity;
    const info = entityInfo.get(pid);
    if (info) {
      info.attrs.push(a);
      info.satellites.push({ node: a, type: "attr" });
    }
  });
  relationshipNodes.forEach((r) => {
    const set = relationshipConnections.get(r.getModel().id);
    if (set) {
      const connected = Array.from(set);
      connected.forEach((entityNode) => {
        const info = entityInfo.get(entityNode.getModel().id);
        if (!info) return;
        const other = connected.find((n) => n !== entityNode) || null;
        info.rels.push({ relNode: r, otherEntity: other });
        info.satellites.push({ node: r, type: "rel", otherEntity: other });
      });
    }
  });

  // 当前实体坐标
  const entityPositions = new Map();
  entityNodes.forEach((n) => {
    const m = n.getModel();
    entityPositions.set(m.id, { x: m.x, y: m.y });
  });

  // 与属性放置阶段共用的"避让扇形"宽度。
  // 默认值 1.3（≈75°）是为典型 1 binRel 场景标定的。当一个实体有许多
  // binRel（例如 4 个，构成十字形拓扑）时，4 × 1.3 = 5.2 rad 会吃掉
  // 大半个轨道，只剩 1.08 rad 给属性，强制把属性顶到极远。
  // 用 adaptiveGap 把所有避让扇形加起来上限为 π rad（半个轨道），
  // 给属性至少 π rad 的可用角度。
  const gapAngle = 1.3;
  const adaptiveGap = (K: number) => (K > 0 ? Math.min(gapAngle, Math.PI / K) : gapAngle);
  const halfGap = gapAngle / 2; // 仅作为 1-binRel 默认；实际放置使用 entity 自己的

  // 计算每个实体的统一环绕半径
  const baseRing = new Map<string, number>();
  const systemRadius = new Map<string, number>();
  const entityRadii = new Map<string, number>();
  const maxSatelliteRadii = new Map<string, number>();
  const orbitalCounts = new Map<string, number>();
  const binRelCounts = new Map<string, number>();
  // 记录实体与轨道的轴向半径 (rx, ry)，用于变量轨道与 clearance 计算
  const entityHalfX = new Map<string, number>();
  const entityHalfY = new Map<string, number>();
  const orbitHalfX = new Map<string, number>();
  const orbitHalfY = new Map<string, number>();
  const tangentialFloors = new Map<string, number>();

  entityInfo.forEach((info) => {
    const id = info.node.getModel().id;
    const entityRadius = getRadius(info.node); // bbox 圆，仅用于 collision 估计
    const entityAxisMax = getAxisMax(info.node); // 轴向半径
    const ebbox = info.node.getBBox();
    const ehx = ebbox.width / 2;
    const ehy = ebbox.height / 2;
    entityHalfX.set(id, ehx);
    entityHalfY.set(id, ehy);
    entityRadii.set(id, entityRadius);

    // 二元关系节点不放在轨道上，因此不应参与 maxSatelliteRadius 与 baseRing。
    // 真正占用轨道的只有 attr + 单端关系。
    const orbitalSatellites = info.satellites.filter((s) => s.type === "attr" || !s.otherEntity);
    const orbitalCount = orbitalSatellites.length;
    const binRelCount = info.satellites.length - orbitalCount;
    orbitalCounts.set(id, orbitalCount);
    binRelCounts.set(id, binRelCount);

    const maxSatelliteRadius =
      orbitalCount > 0 ? Math.max(...orbitalSatellites.map((s) => getRadius(s.node))) : 0;
    const maxSatAxisMax =
      orbitalCount > 0 ? Math.max(...orbitalSatellites.map((s) => getAxisMax(s.node))) : 0;
    // 轨道半径用 *最大* 卫星的 (rx, ry)；同一实体内不同卫星共享 r(θ) 的"形状"
    let ohx = 0,
      ohy = 0;
    orbitalSatellites.forEach((s) => {
      const sb = s.node.getBBox();
      if (sb.width / 2 > ohx) ohx = sb.width / 2;
      if (sb.height / 2 > ohy) ohy = sb.height / 2;
    });
    orbitHalfX.set(id, ohx);
    orbitHalfY.set(id, ohy);
    maxSatelliteRadii.set(id, maxSatelliteRadius);

    // 切向 floor：保证沿轨道相邻属性不重叠。
    // 用 max-per-segment 而不是 sum/usableAngle——后者假设属性均匀
    // 分布在 *整圈*，但实际上属性必须落在 binRel 之间的 segment 内，
    // 最稠密 segment 决定 r 下界。
    const eg = adaptiveGap(binRelCount);
    const usableAngle = Math.max(2 * Math.PI - binRelCount * eg, Math.PI / 2);
    const sumExtents = orbitalSatellites.reduce((sum, s) => {
      const sb = s.node.getBBox();
      return sum + Math.max(sb.width, sb.height) + 8;
    }, 0);
    let tangentialFloor = 0;
    if (orbitalCount > 0) {
      if (binRelCount > 0) {
        const segmentSize = usableAngle / binRelCount;
        const maxPerSegment = Math.max(1, Math.ceil(orbitalCount / binRelCount));
        const avgExtent = sumExtents / orbitalCount;
        tangentialFloor = (avgExtent * maxPerSegment) / segmentSize;
      } else {
        // 无 binRel：属性散布在整圈
        tangentialFloor = sumExtents / (2 * Math.PI);
      }
    }
    tangentialFloors.set(id, tangentialFloor);

    // baseRing：变量轨道下沿轴向 (θ=0 或 π/2) 的最大半径。
    // 也作为其它模块（relAnchors 等）的 fallback 单值。
    let ringR =
      orbitalCount > 0 ? Math.max(ehx + ohx + 8, ehy + ohy + 8, tangentialFloor) : entityRadius;

    baseRing.set(id, ringR);
    systemRadius.set(id, ringR + maxSatelliteRadius);
  });

  const clearanceGap = 12;
  const minEntityRelationGap = 28;

  // 在变量轨道下计算指定角度处的实际属性中心距实体中心的距离。
  // r_geom(θ) = rect_boundary + ellipse_boundary + 8，再受 tangentialFloor 限制。
  const orbitR = (
    ehx: number,
    ehy: number,
    ohx: number,
    ohy: number,
    cosT: number,
    sinT: number,
    floor: number,
  ) => {
    const eOut = rectBoundary(ehx, ehy, cosT, sinT);
    const oIn = ellipseBoundary(ohx, ohy, cosT, sinT);
    return Math.max(eOut + oIn + 8, floor);
  };

  // 计算实体在 BA 方向上"最近属性的角度"。
  // 使用 adaptive gapAngle + max-per-segment 步长（与放置阶段一致）。
  const computeClosestAngle = (id: string) => {
    const N = orbitalCounts.get(id) ?? 0;
    const K = binRelCounts.get(id) ?? 0;
    if (N <= 0 || K <= 0) return Math.PI / 2;
    const eg = adaptiveGap(K);
    const usable = Math.max(2 * Math.PI - K * eg, Math.PI / 2);
    const segmentSize = usable / K;
    const maxPerSegment = Math.max(1, Math.ceil(N / K));
    return eg / 2 + segmentSize / (2 * maxPerSegment);
  };

  const getRelHalfSize = (relNode: GraphNodeLike) => {
    const b = relNode.getBBox();
    return { x: b.width / 2, y: b.height / 2 };
  };

  const computeEntityRelMinCenterDistance = (
    id: string,
    relNode: GraphNodeLike,
    ux: number,
    uy: number,
  ) => {
    const ehx = entityHalfX.get(id) ?? 30;
    const ehy = entityHalfY.get(id) ?? 30;
    const rh = getRelHalfSize(relNode);
    return (
      rectBoundary(ehx, ehy, ux, uy) + diamondBoundary(rh.x, rh.y, ux, uy) + minEntityRelationGap
    );
  };

  const computePairGeometryMinDistance = (
    idA: string,
    idB: string,
    relNode: GraphNodeLike,
    posA: { x: number; y: number },
    posB: { x: number; y: number },
  ) => {
    const dx = posB.x - posA.x;
    const dy = posB.y - posA.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    return (
      computeEntityRelMinCenterDistance(idA, relNode, ux, uy) +
      computeEntityRelMinCenterDistance(idB, relNode, -ux, -uy)
    );
  };

  // 二元关系菱形沿实体连线放置，并让菱形到两个实体矩形边界的可视空隙相等。
  const computeEqualGapRelationshipAnchor = (
    idA: string,
    idB: string,
    relNode: GraphNodeLike,
    posA: { x: number; y: number },
    posB: { x: number; y: number },
  ) => {
    const dx = posB.x - posA.x;
    const dy = posB.y - posA.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;

    const aEntity = rectBoundary(entityHalfX.get(idA) ?? 30, entityHalfY.get(idA) ?? 30, ux, uy);
    const bEntity = rectBoundary(entityHalfX.get(idB) ?? 30, entityHalfY.get(idB) ?? 30, -ux, -uy);
    const rh = getRelHalfSize(relNode);
    const relToA = diamondBoundary(rh.x, rh.y, -ux, -uy);
    const relToB = diamondBoundary(rh.x, rh.y, ux, uy);
    const free = dist - aEntity - relToA - bEntity - relToB;
    const gap = Math.max(minEntityRelationGap, free / 2);
    const minFromA = aEntity + relToA + minEntityRelationGap;
    const maxFromA = dist - bEntity - relToB - minEntityRelationGap;
    const idealFromA = aEntity + relToA + gap;
    const distFromA = Math.min(Math.max(idealFromA, minFromA), Math.max(minFromA, maxFromA));

    return {
      x: posA.x + ux * distFromA,
      y: posA.y + uy * distFromA,
    };
  };

  // 属性之间的连通对距离约束。只处理属性-属性，菱形到实体的距离由
  // computeEntityRelMinCenterDistance 在当前方向上精确计算。
  const computeLegacyAttributeClearance = (id: string, relR: number) => {
    const ehx = entityHalfX.get(id) ?? 30;
    const ehy = entityHalfY.get(id) ?? 30;
    const ohx = orbitHalfX.get(id) ?? 0;
    const ohy = orbitHalfY.get(id) ?? 0;
    const orbitalCount = orbitalCounts.get(id) ?? 0;
    const binRelCount = binRelCounts.get(id) ?? 0;
    const floor = tangentialFloors.get(id) ?? 0;
    const maxSatR = maxSatelliteRadii.get(id) ?? 0;
    const entityR = entityRadii.get(id) ?? 30;

    const entityTerm = entityR + relR + clearanceGap;
    if (maxSatR <= 0 || orbitalCount <= 0 || binRelCount <= 0) return entityTerm;
    const blockR = maxSatR + relR + clearanceGap;
    const closestAngle = computeClosestAngle(id);
    const cosA = Math.cos(closestAngle);
    const sinA = Math.sin(closestAngle);
    const r = orbitR(ehx, ehy, ohx, ohy, cosA, sinA, floor);
    const perp = sinA * r;
    const along = cosA * r;
    if (blockR <= perp) return entityTerm;
    const attrTerm = along + Math.sqrt(blockR * blockR - perp * perp);
    return Math.max(entityTerm, attrTerm);
  };

  // 连接对的"最近属性互不重叠"约束。
  const computePairAttrAttrSum = (idA: string, idB: string) => {
    const orbA = orbitalCounts.get(idA) ?? 0;
    const orbB = orbitalCounts.get(idB) ?? 0;
    const brA = binRelCounts.get(idA) ?? 0;
    const brB = binRelCounts.get(idB) ?? 0;
    const msA = maxSatelliteRadii.get(idA) ?? 0;
    const msB = maxSatelliteRadii.get(idB) ?? 0;
    if (msA <= 0 || msB <= 0 || orbA <= 0 || orbB <= 0 || brA <= 0 || brB <= 0) return 0;
    const thetaA = computeClosestAngle(idA);
    const thetaB = computeClosestAngle(idB);
    const cosA = Math.cos(thetaA),
      sinA = Math.sin(thetaA);
    const cosB = Math.cos(thetaB),
      sinB = Math.sin(thetaB);
    const rA = orbitR(
      entityHalfX.get(idA) ?? 30,
      entityHalfY.get(idA) ?? 30,
      orbitHalfX.get(idA) ?? 0,
      orbitHalfY.get(idA) ?? 0,
      cosA,
      sinA,
      tangentialFloors.get(idA) ?? 0,
    );
    const rB = orbitR(
      entityHalfX.get(idB) ?? 30,
      entityHalfY.get(idB) ?? 30,
      orbitHalfX.get(idB) ?? 0,
      orbitHalfY.get(idB) ?? 0,
      cosB,
      sinB,
      tangentialFloors.get(idB) ?? 0,
    );
    const blockR = msA + msB + 8;
    const alongA = cosA * rA;
    const alongB = cosB * rB;
    const perpDiff = sinA * rA - sinB * rB;
    const radial = Math.sqrt(Math.max(0, blockR * blockR - perpDiff * perpDiff));
    return alongA + alongB + radial;
  };

  // 构建双实体关系对(用于弹簧吸引 + 交叉检测)
  const relationshipPairs = [];
  relationshipNodes.forEach((relNode) => {
    const set = relationshipConnections.get(relNode.getModel().id);
    if (!set || set.size !== 2) return;
    const [entityA, entityB] = Array.from(set.values());
    relationshipPairs.push({
      idA: entityA.getModel().id,
      idB: entityB.getModel().id,
      relNode,
    });
  });

  // 关系连接对的"目标距离" = max(当前方向的实体-菱形最小间距,
  // 两边最近属性互不重叠所需距离)。
  const pairKey = (idA: string, idB: string) => (idA < idB ? idA + "|" + idB : idB + "|" + idA);
  const connectedPairKeys = new Set<string>();
  const pairDesired = new Map<string, number>();
  relationshipPairs.forEach((p) => {
    const attrAttr = computePairAttrAttrSum(p.idA, p.idB);
    const posA = entityPositions.get(p.idA);
    const posB = entityPositions.get(p.idB);
    const geometryMin =
      posA && posB
        ? computePairGeometryMinDistance(p.idA, p.idB, p.relNode, posA, posB)
        : computeLegacyAttributeClearance(p.idA, getRadius(p.relNode)) +
          computeLegacyAttributeClearance(p.idB, getRadius(p.relNode));

    const want = Math.max(geometryMin, attrAttr);
    const k = pairKey(p.idA, p.idB);
    connectedPairKeys.add(k);
    const prev = pairDesired.get(k) ?? 0;
    if (want > prev) pairDesired.set(k, want);
  });

  // 邻接表：用于角度均分力
  const entityNeighbors = new Map();
  entityNodes.forEach((n) => entityNeighbors.set(n.getModel().id, new Set()));
  relationshipPairs.forEach((pair) => {
    entityNeighbors.get(pair.idA)?.add(pair.idB);
    entityNeighbors.get(pair.idB)?.add(pair.idA);
  });

  // 全局斥力的最小间距（仅作用于未连通的实体对）。连通对由 pairDesired
  // 双向弹簧处理；这里只防止毫无关联的实体彼此重叠。
  const safeGap = 35;
  const entityIds = Array.from(entityPositions.keys());
  const maxSysR = entityIds.length
    ? Math.max(...entityIds.map((id) => systemRadius.get(id) || 60))
    : 80;
  const entityCellSize = Math.max(120, maxSysR * 2 + safeGap);

  for (let iter = 0; iter < 300; iter++) {
    let maxMove = 0;

    // 1. 带死区的双向弹簧：
    //    - dist < desired           → 强力推开到 desired（消除重叠）
    //    - dist ∈ [desired, 1.5·D] → 死区，完全保留（微调区）
    //    - dist > 1.5·desired       → 弱力拉回到 1.5·desired（不是 desired）
    //
    //    死区的 1.5x 上限给用户充足的微调空间；超过 1.5x 才视为"过度
    //    漂移"做软纠正，而且目标是死区上限本身，**不是 desired**——
    //    保留用户拖远的部分意图，只削掉过分的那截，避免"几乎回到原位"。
    const deadbandRatio = 1.5;
    relationshipPairs.forEach((pair) => {
      const posA = entityPositions.get(pair.idA);
      const posB = entityPositions.get(pair.idB);
      if (!posA || !posB) return;

      const dx = posB.x - posA.x;
      const dy = posB.y - posA.y;
      const dist = Math.hypot(dx, dy) || 1;

      const desired = pairDesired.get(pairKey(pair.idA, pair.idB)) ?? 0;
      if (!desired) return;

      const upperLimit = desired * deadbandRatio;
      let target: number;
      let factor: number;
      if (dist < desired - 1) {
        target = desired;
        factor = 0.2;
      } else if (dist > upperLimit + 1) {
        target = upperLimit;
        factor = 0.05;
      } else {
        return; // 死区
      }

      const diff = target - dist;
      const nx = dx / dist;
      const ny = dy / dist;
      const move = (diff * factor) / 2;
      posA.x -= nx * move;
      posA.y -= ny * move;
      posB.x += nx * move;
      posB.y += ny * move;
      maxMove = Math.max(maxMove, Math.abs(move));
    });

    // 2. 全局斥力：网格近邻查找，O(n) 期望
    const entityItems = entityIds.map((id) => ({
      id,
      pos: entityPositions.get(id),
      r: systemRadius.get(id),
    }));
    const grid = buildGrid(entityItems, entityCellSize);

    for (let i = 0; i < entityItems.length; i++) {
      const a = entityItems[i];
      forEachNeighbor(grid, entityCellSize, a, (b) => {
        if (b.id <= a.id) return; // 避免重复处理 & 自身
        // 已被关系约束直接处理的连接对，不再用 systemRadius+safeGap 推开，
        // 否则会和上面更紧凑的 pairDesired 互相打架，把连接对推得过远。
        if (connectedPairKeys.has(pairKey(a.id, b.id))) return;
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const dist = Math.hypot(dx, dy) || 1;
        const minDesc = a.r + b.r + safeGap;
        if (dist < minDesc) {
          const overlap = minDesc - dist;
          const nx = dx / dist;
          const ny = dy / dist;
          const move = overlap * 0.25;
          a.pos.x -= nx * move;
          a.pos.y -= ny * move;
          b.pos.x += nx * move;
          b.pos.y += ny * move;
          if (move > maxMove) maxMove = move;
        }
      });
    }

    // 3. 角度均分力：仅在严重聚集时绕中心实体做小幅旋转，避免成环图 (A-B-C 三角)
    //    持续聚拢。旋转保半径不变，不再引入径向漂移。
    entityIds.forEach((centerId) => {
      const neighbors = entityNeighbors.get(centerId);
      if (!neighbors || neighbors.size < 2) return;
      const centerPos = entityPositions.get(centerId);
      if (!centerPos) return;

      const nArr = Array.from(neighbors);
      const idealStep = (Math.PI * 2) / nArr.length;
      // 仅在两邻居的夹角 < 理想间隔的一半时才视为严重聚集
      const activation = idealStep * 0.5;

      for (let i = 0; i < nArr.length; i++) {
        const pi = entityPositions.get(nArr[i]);
        if (!pi) continue;
        const dxi = pi.x - centerPos.x;
        const dyi = pi.y - centerPos.y;
        const di = Math.hypot(dxi, dyi) || 1;
        const ai = Math.atan2(dyi, dxi);

        for (let j = i + 1; j < nArr.length; j++) {
          const pj = entityPositions.get(nArr[j]);
          if (!pj) continue;
          // 三角形 (中心 + 两个互相连通的邻居) 内的角度无法增大到 idealStep
          //（三个内角之和必为 π），但本力没有"停止条件"，会让三条边持
          // 续被旋转拉长——这是反复点击布局越扩越大的根因之一。
          // 当两邻居本身已经直连时，几何已经无解，不再施力。
          if (connectedPairKeys.has(pairKey(nArr[i] as string, nArr[j] as string))) continue;
          const dxj = pj.x - centerPos.x;
          const dyj = pj.y - centerPos.y;
          const dj = Math.hypot(dxj, dyj) || 1;
          const aj = Math.atan2(dyj, dxj);

          let diff = aj - ai;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff <= -Math.PI) diff += Math.PI * 2;

          const absDiff = Math.abs(diff);
          if (absDiff >= activation) continue;

          const shortfall = activation - absDiff;
          const sign = diff >= 0 ? 1 : -1;
          // 用绕中心的精确旋转代替切向平移：切向平移会让半径每步
          // 增大为 sqrt(d^2+arc^2)，反复点击布局时不断把节点向外推。
          // 旋转保持到中心实体的距离不变，使该力幂等。
          let arc = shortfall * Math.min(di, dj) * 0.02;
          if (arc > 2.5) arc = 2.5; // 硬上限：防止单步过冲
          const dai = (arc / di) * -sign;
          const daj = (arc / dj) * sign;
          const cosI = Math.cos(dai),
            sinI = Math.sin(dai);
          const newDxi = dxi * cosI - dyi * sinI;
          const newDyi = dxi * sinI + dyi * cosI;
          pi.x = centerPos.x + newDxi;
          pi.y = centerPos.y + newDyi;
          const cosJ = Math.cos(daj),
            sinJ = Math.sin(daj);
          const newDxj = dxj * cosJ - dyj * sinJ;
          const newDyj = dxj * sinJ + dyj * cosJ;
          pj.x = centerPos.x + newDxj;
          pj.y = centerPos.y + newDyj;
          if (arc > maxMove) maxMove = arc;
        }
      }
    });

    if (maxMove < 0.5) break;
  }

  // ---- 2-opt 交叉消除：交换实体位置以减少关系边交叉 ----
  // 逻辑图：每个二元关系视为实体A→实体B的一条段；只关注段对的真相交。
  const countCrossings = () => {
    let total = 0;
    for (let i = 0; i < relationshipPairs.length; i++) {
      const pi = relationshipPairs[i];
      const a1 = entityPositions.get(pi.idA);
      const a2 = entityPositions.get(pi.idB);
      if (!a1 || !a2) continue;
      for (let j = i + 1; j < relationshipPairs.length; j++) {
        const pj = relationshipPairs[j];
        // 共享端点则不算交叉 (正常相交会在关系节点处汇合)
        if (pi.idA === pj.idA || pi.idA === pj.idB || pi.idB === pj.idA || pi.idB === pj.idB)
          continue;
        const b1 = entityPositions.get(pj.idA);
        const b2 = entityPositions.get(pj.idB);
        if (!b1 || !b2) continue;
        if (segmentsCross(a1, a2, b1, b2)) total++;
      }
    }
    return total;
  };

  if (relationshipPairs.length >= 2 && entityIds.length >= 2) {
    let currentCrossings = countCrossings();
    if (currentCrossings > 0) {
      const maxSwapPasses = 8;
      for (let pass = 0; pass < maxSwapPasses && currentCrossings > 0; pass++) {
        let improved = false;
        for (let i = 0; i < entityIds.length && currentCrossings > 0; i++) {
          for (let j = i + 1; j < entityIds.length; j++) {
            const idA = entityIds[i];
            const idB = entityIds[j];
            const pa = entityPositions.get(idA);
            const pb = entityPositions.get(idB);
            if (!pa || !pb) continue;
            // 试交换
            const tmpX = pa.x,
              tmpY = pa.y;
            pa.x = pb.x;
            pa.y = pb.y;
            pb.x = tmpX;
            pb.y = tmpY;
            const newCrossings = countCrossings();
            if (newCrossings < currentCrossings) {
              currentCrossings = newCrossings;
              improved = true;
              if (currentCrossings === 0) break;
            } else {
              // 回滚
              pb.x = pa.x;
              pb.y = pa.y;
              pa.x = tmpX;
              pa.y = tmpY;
            }
          }
        }
        if (!improved) break;
      }
    }
  }

  // 调整实体间距：作为迭代力的兜底，使用与 pairDesired 同一套间距常量
  const ensureRelationshipClearance = () => {
    relationshipNodes.forEach((relNode) => {
      const relId = relNode.getModel().id;
      const connected = relationshipConnections.get(relId);
      if (!connected || connected.size !== 2) return;

      const [entityA, entityB] = Array.from(connected.values());
      const idA = entityA.getModel().id;
      const idB = entityB.getModel().id;
      const posA = entityPositions.get(idA);
      const posB = entityPositions.get(idB);
      if (!posA || !posB) return;

      const dx = posB.x - posA.x;
      const dy = posB.y - posA.y;
      const dist = Math.hypot(dx, dy) || 1;

      const requiredDist = Math.max(
        pairDesired.get(pairKey(idA, idB)) ?? 0,
        computePairGeometryMinDistance(idA, idB, relNode, posA, posB),
      );
      if (!requiredDist || dist >= requiredDist) return;

      const missing = requiredDist - dist;
      const nx = dx / dist;
      const ny = dy / dist;

      posA.x -= (nx * missing) / 2;
      posA.y -= (ny * missing) / 2;
      posB.x += (nx * missing) / 2;
      posB.y += (ny * missing) / 2;
    });
  };

  ensureRelationshipClearance();
  ensureRelationshipClearance();
  ensureRelationshipClearance();

  // 实体目标位置
  entityPositions.forEach((pos, id) => targets.set(id, { ...pos }));

  const entityOrbitRadius = new Map();

  // 统一布局所有卫星节点
  entityInfo.forEach((info) => {
    const { node, satellites } = info;
    const model = node.getModel();
    const center = entityPositions.get(model.id) || { x: model.x, y: model.y };

    const ringRadius = baseRing.get(model.id);
    entityOrbitRadius.set(model.id, ringRadius);

    if (!satellites.length) return;

    const avoidAngles = [];
    satellites.forEach((s) => {
      if (s.type === "rel" && s.otherEntity) {
        const otherPos = entityPositions.get(s.otherEntity.getModel().id);
        if (otherPos) {
          const angle = normalizeAngle(Math.atan2(otherPos.y - center.y, otherPos.x - center.x));
          avoidAngles.push(angle);
        }
      }
    });

    // 用本实体自己的 adaptive halfGap，让多 binRel 实体不被默认 1.3 撑爆轨道
    const halfGapEntity = adaptiveGap(avoidAngles.length) / 2;
    let segments = [];

    if (!avoidAngles.length) {
      segments.push({ start: 0, end: Math.PI * 2 });
    } else {
      const sortedAngles = avoidAngles.slice().sort((a, b) => a - b);
      const total = Math.PI * 2;
      for (let i = 0; i < sortedAngles.length; i++) {
        const curr = sortedAngles[i];
        const next =
          sortedAngles[(i + 1) % sortedAngles.length] + (i === sortedAngles.length - 1 ? total : 0);
        const start = curr + halfGapEntity;
        const end = next - halfGapEntity;
        if (end > start) segments.push({ start, end });
      }
    }

    const totalFree = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
    if (totalFree <= 0) {
      segments = [{ start: 0, end: Math.PI * 2 }];
    }

    const orbitalSatellites = satellites.filter(
      (s) => s.type === "attr" || (s.type === "rel" && !s.otherEntity),
    );

    if (!orbitalSatellites.length) return;

    const sortedSatellites = orbitalSatellites.slice().sort((a, b) => {
      const ma = a.node.getModel();
      const mb = b.node.getModel();
      const angleA = normalizeAngle(Math.atan2(ma.y - center.y, ma.x - center.x));
      const angleB = normalizeAngle(Math.atan2(mb.y - center.y, mb.x - center.x));
      return angleA - angleB;
    });

    const totalCount = sortedSatellites.length;
    const totalAngle = segments.reduce((sum, s) => sum + (s.end - s.start), 0);

    const segCounts = segments.map((s) =>
      Math.max(0, Math.round((totalCount * (s.end - s.start)) / totalAngle)),
    );

    let allocated = segCounts.reduce((sum, c) => sum + c, 0);
    while (allocated < totalCount) {
      let maxIdx = 0;
      let maxLen = -Infinity;
      segments.forEach((s, idx) => {
        if (s.end - s.start > maxLen) {
          maxLen = s.end - s.start;
          maxIdx = idx;
        }
      });
      segCounts[maxIdx]++;
      allocated++;
    }
    while (allocated > totalCount) {
      for (let i = segCounts.length - 1; i >= 0; i--) {
        if (segCounts[i] > 0) {
          segCounts[i]--;
          allocated--;
          break;
        }
      }
    }

    // 变量轨道：每个属性放在 max(r_geometric(θ), tangentialFloor) 处，
    // 其中 r_geometric(θ) = 矩形(θ)边界 + 椭圆(θ)边界 + 8。
    // 这让水平、垂直、对角方向的可视连线都接近 8 px，不再被圆形轨道
    // 强制顶到 bbox 外接圆远端。
    const ehx = entityHalfX.get(model.id) ?? 30;
    const ehy = entityHalfY.get(model.id) ?? 30;
    const floor = tangentialFloors.get(model.id) ?? 0;

    let nodeIdx = 0;
    segments.forEach((s, idx) => {
      const count = segCounts[idx];
      if (!count) return;

      const step = (s.end - s.start) / count;

      for (let i = 0; i < count; i++) {
        const angle = s.start + step * (i + 0.5);
        const useAngle = normalizeAngle(angle);
        const cosA = Math.cos(useAngle);
        const sinA = Math.sin(useAngle);

        const satellite = sortedSatellites[nodeIdx++];
        if (!satellite) continue;
        const sb = satellite.node.getBBox();
        const shx = sb.width / 2;
        const shy = sb.height / 2;

        const eOut = rectBoundary(ehx, ehy, cosA, sinA);
        const sIn = ellipseBoundary(shx, shy, cosA, sinA);
        const r = Math.max(eOut + sIn + 8, floor);

        const targetX = center.x + r * cosA;
        const targetY = center.y + r * sinA;
        targets.set(satellite.node.getModel().id, { x: targetX, y: targetY });
      }
    });

    // 将实体自身目标刷新为最终位置
    targets.set(model.id, { x: center.x, y: center.y });
  });

  // 双实体关系节点：菱形锚点按两侧可视空隙相等放置。
  relationshipNodes.forEach((relNode) => {
    const relId = relNode.getModel().id;
    const connectedEntities = relationshipConnections.get(relId);

    if (connectedEntities && connectedEntities.size === 2) {
      const [entityA, entityB] = Array.from(connectedEntities.values());
      const idA = entityA.getModel().id;
      const idB = entityB.getModel().id;
      const posA = entityPositions.get(idA);
      const posB = entityPositions.get(idB);
      if (!posA || !posB) return;

      const relR = getRadius(relNode);
      const anchorPos = computeEqualGapRelationshipAnchor(idA, idB, relNode, posA, posB);
      targets.set(relId, anchorPos);
      relAnchors.set(relId, anchorPos);
      relRadii.set(relId, relR);
    }
  });

  // 同一实体对之间的多个关系菱形分布
  const groupedRelations = new Map();
  relationshipNodes.forEach((relNode) => {
    const relId = relNode.getModel().id;
    const connected = relationshipConnections.get(relId);
    if (!connected || connected.size !== 2) return;
    const [entityA, entityB] = Array.from(connected.values());
    const idA = entityA.getModel().id;
    const idB = entityB.getModel().id;
    const key = idA < idB ? `${idA}__${idB}` : `${idB}__${idA}`;
    if (!groupedRelations.has(key)) groupedRelations.set(key, []);
    groupedRelations.get(key).push({
      relNode,
      relRadius: getRadius(relNode),
      entities: [entityA, entityB],
    });
  });

  groupedRelations.forEach((list) => {
    if (list.length <= 1) return;
    const sample = list[0];
    const [entityA, entityB] = sample.entities;
    const idA = entityA.getModel().id;
    const idB = entityB.getModel().id;
    const posA = entityPositions.get(idA);
    const posB = entityPositions.get(idB);
    if (!posA || !posB) return;
    const dx = posB.x - posA.x;
    const dy = posB.y - posA.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist;
    const ny = dy / dist;
    const px = -ny;
    const py = nx;

    const baseX = targets.get(sample.relNode.getModel().id)?.x || (posA.x + posB.x) / 2;
    const baseY = targets.get(sample.relNode.getModel().id)?.y || (posA.y + posB.y) / 2;
    const maxRadius = Math.max(...list.map((item) => item.relRadius));
    const offsetStep = maxRadius * 2 + 16;

    const sorted = list
      .slice()
      .sort((a, b) => a.relNode.getModel().id.localeCompare(b.relNode.getModel().id));
    const mid = (sorted.length - 1) / 2;
    sorted.forEach((item, idx) => {
      const offsetIndex = idx - mid;
      const ox = px * offsetIndex * offsetStep;
      const oy = py * offsetIndex * offsetStep;
      const newPos = { x: baseX + ox, y: baseY + oy };
      const rid = item.relNode.getModel().id;
      targets.set(rid, newPos);
      relAnchors.set(rid, newPos);
    });
  });

  // 关系节点额外防重叠修正 (网格加速)
  if (relAnchors.size) {
    const relPositions = new Map();
    relAnchors.forEach((anchor, id) => {
      const t = targets.get(id);
      relPositions.set(id, t ? { ...t } : { ...anchor });
    });

    // 实体与菱形的最小允许距离按 (实体, 关系) 动态计算，与 pairDesired 同源；
    // 这样属性多的实体不会用一个虚高的 ring+20 把菱形顶得过远。

    const relIdArr = [];
    relPositions.forEach((_, id) => relIdArr.push(id));
    const maxRelR = relIdArr.length
      ? Math.max(...relIdArr.map((id) => relRadii.get(id) || 30))
      : 30;
    const relCellSize = Math.max(60, maxRelR * 2 + 14);

    for (let iter = 0; iter < 80; iter++) {
      let moved = 0;

      const relItems = relIdArr.map((id) => ({
        id,
        pos: relPositions.get(id),
        r: relRadii.get(id) || 30,
      }));
      const relGrid = buildGrid(relItems, relCellSize);

      for (let i = 0; i < relItems.length; i++) {
        const a = relItems[i];
        forEachNeighbor(relGrid, relCellSize, a, (b) => {
          if (b.id <= a.id) return;
          const dx = b.pos.x - a.pos.x;
          const dy = b.pos.y - a.pos.y;
          let dist = Math.hypot(dx, dy);
          if (dist === 0) dist = 0.01;
          const minDist = a.r + b.r + 14;
          if (dist < minDist) {
            const push = (minDist - dist) / 2;
            const nx = dx / dist;
            const ny = dy / dist;
            a.pos.x -= nx * push;
            a.pos.y -= ny * push;
            b.pos.x += nx * push;
            b.pos.y += ny * push;
            if (push > moved) moved = push;
          }
        });
      }

      relPositions.forEach((pos, rid) => {
        const relNode = graph.findById(rid);
        const connected = relNode ? relationshipConnections.get(rid) : null;
        if (!connected) return;
        const relR = relRadii.get(rid) || 30;

        connected.forEach((entNode) => {
          const em = entNode.getModel();
          const center = entityPositions.get(em.id) || { x: em.x, y: em.y };
          const dx = pos.x - center.x;
          const dy = pos.y - center.y;
          let dist = Math.hypot(dx, dy);
          if (dist === 0) dist = 0.01;
          const limit = computeEntityRelMinCenterDistance(
            em.id,
            relNode as GraphNodeLike,
            dx / dist,
            dy / dist,
          );
          if (dist < limit) {
            const push = limit - dist;
            const nx = dx / dist;
            const ny = dy / dist;
            pos.x += nx * push;
            pos.y += ny * push;
            if (push > moved) moved = push;
          }
        });
      });

      relPositions.forEach((pos, id) => {
        const anchor = relAnchors.get(id);
        if (!anchor) return;
        pos.x = pos.x * 0.85 + anchor.x * 0.15;
        pos.y = pos.y * 0.85 + anchor.y * 0.15;
      });

      if (moved < 0.3) break;
    }

    relPositions.forEach((pos, id) => {
      targets.set(id, { ...pos });
    });
  }

  // 全局防重叠 (网格加速)
  const applyGlobalSeparation = () => {
    const allNodes = graph.getNodes();
    const lockedCoreIds = new Set([
      ...entityNodes.map((n) => n.getModel().id),
      ...relationshipNodes.map((n) => n.getModel().id),
    ]);
    const metaArr = allNodes.map((n) => ({
      id: n.getModel().id,
      r: getRadius(n),
    }));
    metaArr.forEach((m) => {
      if (!targets.has(m.id)) {
        const model = graph.findById(m.id)?.getModel();
        targets.set(m.id, {
          x: typeof model?.x === "number" ? model.x : 0,
          y: typeof model?.y === "number" ? model.y : 0,
        });
      }
    });

    const maxR = metaArr.length ? Math.max(...metaArr.map((m) => m.r)) : 30;
    const cellSize = Math.max(40, maxR * 2 + 8);

    for (let iter = 0; iter < 400; iter++) {
      let maxMove = 0;

      const items = metaArr.map((m) => ({
        id: m.id,
        r: m.r,
        pos: targets.get(m.id),
      }));
      const grid = buildGrid(items, cellSize);

      for (let i = 0; i < items.length; i++) {
        const a = items[i];
        forEachNeighbor(grid, cellSize, a, (b) => {
          if (b.id <= a.id) return;
          const dx = b.pos.x - a.pos.x;
          const dy = b.pos.y - a.pos.y;
          let dist = Math.hypot(dx, dy);
          if (dist === 0) dist = 0.01;
          const minDist = a.r + b.r + 8;
          if (dist < minDist) {
            const overlap = minDist - dist;
            const aLocked = lockedCoreIds.has(a.id);
            const bLocked = lockedCoreIds.has(b.id);
            if (aLocked && bLocked) return;
            const pushA = aLocked ? 0 : overlap / (bLocked ? 1 : 2);
            const pushB = bLocked ? 0 : overlap / (aLocked ? 1 : 2);
            const nx = dx / dist;
            const ny = dy / dist;
            a.pos.x -= nx * pushA;
            a.pos.y -= ny * pushA;
            b.pos.x += nx * pushB;
            b.pos.y += ny * pushB;
            const push = Math.max(pushA, pushB);
            if (push > maxMove) maxMove = push;
          }
        });
      }
      if (maxMove < 0.3) break;
    }
  };

  applyGlobalSeparation();

  animateNodesToTargets(graph, targets, 850, () => {
    smoothFitView(graph, 800, "easeOutCubic");
  });
};
