import type { EREdgeModel, ERNodeModel } from "../types";

export interface Point {
  x: number;
  y: number;
}

export interface NodeSize {
  width: number;
  height: number;
}

export type NodeSizeResolver = (node: ERNodeModel) => NodeSize;

export interface RelationshipSyncResult {
  relationshipTargets: Map<string, Point>;
  affectedEntityIds: Set<string>;
}

const DEFAULT_SIZES: Record<string, NodeSize> = {
  entity: { width: 120, height: 52 },
  relationship: { width: 82, height: 52 },
  attribute: { width: 90, height: 44 },
};

const FALLBACK_SIZE: NodeSize = { width: 80, height: 40 };
const MIN_ENTITY_RELATION_GAP = 28;
const ATTRIBUTE_DIAMOND_GAP = 8;
const TAU = Math.PI * 2;

const positionOf = (node: ERNodeModel): Point => ({
  x: typeof node.x === "number" ? node.x : 0,
  y: typeof node.y === "number" ? node.y : 0,
});

const fallbackSize = (node: ERNodeModel): NodeSize =>
  DEFAULT_SIZES[String(node.nodeType ?? node.type ?? "")] ?? FALLBACK_SIZE;

const safeSize = (node: ERNodeModel, sizeOf?: NodeSizeResolver): NodeSize => {
  const measured = sizeOf?.(node) ?? fallbackSize(node);
  const fallback = fallbackSize(node);
  return {
    width: Number.isFinite(measured.width) && measured.width > 0 ? measured.width : fallback.width,
    height:
      Number.isFinite(measured.height) && measured.height > 0 ? measured.height : fallback.height,
  };
};

const rectBoundary = (rx: number, ry: number, ux: number, uy: number): number => {
  const ax = Math.abs(ux);
  const ay = Math.abs(uy);
  if (ax < 1e-9) return ry;
  if (ay < 1e-9) return rx;
  return Math.min(rx / ax, ry / ay);
};

const diamondBoundary = (rx: number, ry: number, ux: number, uy: number): number => {
  if (rx <= 0 || ry <= 0) return 0;
  const denom = Math.abs(ux) / rx + Math.abs(uy) / ry;
  return denom > 1e-9 ? 1 / denom : 0;
};

const normalizeAngle = (angle: number): number => {
  let x = angle % TAU;
  if (x < 0) x += TAU;
  return x;
};

const centerDistance = (a: ERNodeModel, b: ERNodeModel): number => {
  const pa = positionOf(a);
  const pb = positionOf(b);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
};

const boxesOverlap = (a: Point, as: NodeSize, b: Point, bs: NodeSize, gap = 0): boolean =>
  Math.abs(a.x - b.x) < (as.width + bs.width) / 2 + gap &&
  Math.abs(a.y - b.y) < (as.height + bs.height) / 2 + gap;

function entityIdsForRelationship(
  relId: string,
  nodeById: Map<string, ERNodeModel>,
  edges: EREdgeModel[],
): string[] {
  const ids: string[] = [];
  edges.forEach((edge) => {
    if (edge.edgeType !== "entity-relationship" && edge.edgeType !== "relationship-entity") {
      return;
    }
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return;
    if (source.id === relId && target.nodeType === "entity") ids.push(target.id);
    if (target.id === relId && source.nodeType === "entity") ids.push(source.id);
  });
  return [...new Set(ids)];
}

function computeRelationshipAnchor(
  entityA: ERNodeModel,
  entityB: ERNodeModel,
  relationship: ERNodeModel,
  sizeOf?: NodeSizeResolver,
): Point {
  const a = positionOf(entityA);
  const b = positionOf(entityB);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;

  const sizeA = safeSize(entityA, sizeOf);
  const sizeB = safeSize(entityB, sizeOf);
  const sizeR = safeSize(relationship, sizeOf);
  const aBoundary = rectBoundary(sizeA.width / 2, sizeA.height / 2, ux, uy);
  const bBoundary = rectBoundary(sizeB.width / 2, sizeB.height / 2, -ux, -uy);
  const relTowardA = diamondBoundary(sizeR.width / 2, sizeR.height / 2, -ux, -uy);
  const relTowardB = diamondBoundary(sizeR.width / 2, sizeR.height / 2, ux, uy);
  const free = dist - aBoundary - relTowardA - bBoundary - relTowardB;
  const equalGap = Math.max(MIN_ENTITY_RELATION_GAP, free / 2);
  const minFromA = aBoundary + relTowardA + MIN_ENTITY_RELATION_GAP;
  const maxFromA = dist - bBoundary - relTowardB - MIN_ENTITY_RELATION_GAP;
  const idealFromA = aBoundary + relTowardA + equalGap;
  const fromA = maxFromA > minFromA ? Math.min(Math.max(idealFromA, minFromA), maxFromA) : dist / 2;

  return {
    x: a.x + ux * fromA,
    y: a.y + uy * fromA,
  };
}

export function computeMovedEntityRelationshipTargets(
  nodes: ERNodeModel[],
  edges: EREdgeModel[],
  movedEntityIds: Iterable<string>,
  sizeOf?: NodeSizeResolver,
): RelationshipSyncResult {
  const movedIds = new Set(movedEntityIds);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const relationshipTargets = new Map<string, Point>();
  const affectedEntityIds = new Set<string>();

  nodes.forEach((relationship) => {
    if (relationship.nodeType !== "relationship") return;
    const entityIds = entityIdsForRelationship(relationship.id, nodeById, edges);
    if (entityIds.length !== 2 || !entityIds.some((id) => movedIds.has(id))) return;

    const entityA = nodeById.get(entityIds[0]);
    const entityB = nodeById.get(entityIds[1]);
    if (!entityA || !entityB) return;
    relationshipTargets.set(
      relationship.id,
      computeRelationshipAnchor(entityA, entityB, relationship, sizeOf),
    );
    affectedEntityIds.add(entityA.id);
    affectedEntityIds.add(entityB.id);
  });

  return { relationshipTargets, affectedEntityIds };
}

export function applyNodePositionTargets(nodes: ERNodeModel[], targets: Map<string, Point>): void {
  if (!targets.size) return;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  targets.forEach((target, id) => {
    const node = nodeById.get(id);
    if (!node) return;
    node.x = target.x;
    node.y = target.y;
  });
}

export function computeAttributeRotationTargets(
  nodes: ERNodeModel[],
  edges: EREdgeModel[],
  entityIds: Iterable<string>,
  sizeOf?: NodeSizeResolver,
): Map<string, Point> {
  const targets = new Map<string, Point>();
  const entityIdSet = new Set(entityIds);
  if (!entityIdSet.size) return targets;

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const relationshipIdsByEntity = new Map<string, Set<string>>();
  edges.forEach((edge) => {
    if (edge.edgeType !== "entity-relationship" && edge.edgeType !== "relationship-entity") {
      return;
    }
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return;
    const entity =
      source.nodeType === "entity" ? source : target.nodeType === "entity" ? target : null;
    const relationship =
      source.nodeType === "relationship"
        ? source
        : target.nodeType === "relationship"
          ? target
          : null;
    if (!entity || !relationship || !entityIdSet.has(entity.id)) return;
    if (!relationshipIdsByEntity.has(entity.id)) relationshipIdsByEntity.set(entity.id, new Set());
    relationshipIdsByEntity.get(entity.id)!.add(relationship.id);
  });

  const attrsByEntity = new Map<string, ERNodeModel[]>();
  nodes.forEach((node) => {
    if (
      node.nodeType === "attribute" &&
      typeof node.parentEntity === "string" &&
      entityIdSet.has(node.parentEntity)
    ) {
      if (!attrsByEntity.has(node.parentEntity)) attrsByEntity.set(node.parentEntity, []);
      attrsByEntity.get(node.parentEntity)!.push(node);
    }
  });

  const relationshipObstacles = nodes
    .filter((node) => node.nodeType === "relationship")
    .map((node) => ({ node, pos: positionOf(node), size: safeSize(node, sizeOf) }));

  const attributeObstacles = nodes
    .filter((node) => node.nodeType === "attribute")
    .map((node) => ({
      node,
      pos: positionOf(node),
      size: safeSize(node, sizeOf),
    }));

  const pointFor = (entity: ERNodeModel, radius: number, angle: number): Point => {
    const c = positionOf(entity);
    return {
      x: c.x + radius * Math.cos(angle),
      y: c.y + radius * Math.sin(angle),
    };
  };

  const candidateOverlaps = (
    attr: ERNodeModel,
    point: Point,
    attrSize: NodeSize,
    relatedRelationshipIds: Set<string>,
  ): { hard: number; soft: number } => {
    let hard = 0;
    let soft = 0;
    relationshipObstacles.forEach((obstacle) => {
      const gap = relatedRelationshipIds.has(obstacle.node.id) ? ATTRIBUTE_DIAMOND_GAP : 2;
      if (boxesOverlap(point, attrSize, obstacle.pos, obstacle.size, gap)) hard++;
    });
    attributeObstacles.forEach((obstacle) => {
      if (obstacle.node.id === attr.id) return;
      const target = targets.get(obstacle.node.id);
      const obstaclePos = target ?? obstacle.pos;
      if (boxesOverlap(point, attrSize, obstaclePos, obstacle.size, 4)) soft++;
    });
    return { hard, soft };
  };

  entityIdSet.forEach((entityId) => {
    const entity = nodeById.get(entityId);
    if (!entity) return;
    const attrs = attrsByEntity.get(entityId) ?? [];
    const relatedRelationshipIds = relationshipIdsByEntity.get(entityId) ?? new Set<string>();
    if (!attrs.length || !relatedRelationshipIds.size) return;

    attrs.forEach((attr) => {
      const center = positionOf(entity);
      const current = positionOf(attr);
      const radius = centerDistance(entity, attr);
      if (radius < 1e-6) return;

      const attrSize = safeSize(attr, sizeOf);
      const currentScore = candidateOverlaps(attr, current, attrSize, relatedRelationshipIds);
      if (currentScore.hard === 0) return;

      const currentAngle = normalizeAngle(Math.atan2(current.y - center.y, current.x - center.x));
      let best: { point: Point; score: { hard: number; soft: number }; angleDelta: number } | null =
        null;
      const consider = (angleDelta: number): void => {
        const point = pointFor(entity, radius, currentAngle + angleDelta);
        const score = candidateOverlaps(attr, point, attrSize, relatedRelationshipIds);
        if (
          !best ||
          score.hard < best.score.hard ||
          (score.hard === best.score.hard && score.soft < best.score.soft) ||
          (score.hard === best.score.hard &&
            score.soft === best.score.soft &&
            Math.abs(angleDelta) < Math.abs(best.angleDelta))
        ) {
          best = { point, score, angleDelta };
        }
      };

      consider(0);
      const STEPS = 72;
      for (let step = 1; step <= STEPS / 2; step++) {
        const delta = (step / STEPS) * TAU;
        consider(delta);
        consider(-delta);
        if (best?.score.hard === 0 && best.score.soft === 0) break;
      }

      if (!best || (best.score.hard >= currentScore.hard && best.score.soft >= currentScore.soft)) {
        return;
      }
      targets.set(attr.id, best.point);
    });
  });

  return targets;
}
