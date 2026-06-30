import type { EREdgeModel, ERNodeModel } from "../types";
import type { NodeSize, NodeSizeResolver, Point } from "./entityMoveSync";

export interface AutoAvoidOptions {
  enabled?: boolean;
  edges?: EREdgeModel[];
  avoidAttributeEdges?: boolean;
  margin?: number;
  maxIterations?: number;
  movableIds?: Iterable<string>;
}

const DEFAULT_SIZE: Record<string, NodeSize> = {
  entity: { width: 120, height: 52 },
  relationship: { width: 82, height: 52 },
  attribute: { width: 90, height: 44 },
};

const FALLBACK_SIZE: NodeSize = { width: 80, height: 40 };
const TAU = Math.PI * 2;

const positionOf = (node: ERNodeModel): Point => ({
  x: typeof node.x === "number" ? node.x : 0,
  y: typeof node.y === "number" ? node.y : 0,
});

const fallbackSize = (node: ERNodeModel): NodeSize =>
  DEFAULT_SIZE[String(node.nodeType ?? node.type ?? "")] ?? FALLBACK_SIZE;

const safeSize = (node: ERNodeModel, sizeOf?: NodeSizeResolver): NodeSize => {
  const fallback = fallbackSize(node);
  const measured = sizeOf?.(node) ?? fallback;
  return {
    width: Number.isFinite(measured.width) && measured.width > 0 ? measured.width : fallback.width,
    height:
      Number.isFinite(measured.height) && measured.height > 0 ? measured.height : fallback.height,
  };
};

const movePriority = (node: ERNodeModel): number => {
  if (node.nodeType === "attribute") return 2;
  if (node.nodeType === "relationship") return 1;
  return 0;
};

const deterministicSign = (a: string, b: string): number => (a < b ? 1 : -1);

interface PositionedNode {
  id: string;
  x: number;
  y: number;
  size: NodeSize;
}

interface EdgeSegment {
  source: string;
  target: string;
  a: Point;
  b: Point;
}

interface LineSearchBudget {
  angleSteps: number;
  radiusSteps: number;
}

const boxOverlapAt = (a: Point, as: NodeSize, b: Point, bs: NodeSize, gap = 0): boolean =>
  Math.abs(a.x - b.x) < (as.width + bs.width) / 2 + gap &&
  Math.abs(a.y - b.y) < (as.height + bs.height) / 2 + gap;

const cross2 = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

const segmentsIntersect = (a: Point, b: Point, c: Point, d: Point): boolean => {
  const d1 = cross2(d.x - c.x, d.y - c.y, a.x - c.x, a.y - c.y);
  const d2 = cross2(d.x - c.x, d.y - c.y, b.x - c.x, b.y - c.y);
  const d3 = cross2(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
  const d4 = cross2(b.x - a.x, b.y - a.y, d.x - a.x, d.y - a.y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};

const segmentHitsBox = (a: Point, b: Point, center: Point, size: NodeSize, inset = 0): boolean => {
  const minX = center.x - size.width / 2 + inset;
  const maxX = center.x + size.width / 2 - inset;
  const minY = center.y - size.height / 2 + inset;
  const maxY = center.y + size.height / 2 - inset;
  if (minX >= maxX || minY >= maxY) return false;
  if (a.x > minX && a.x < maxX && a.y > minY && a.y < maxY) return true;
  if (b.x > minX && b.x < maxX && b.y > minY && b.y < maxY) return true;
  return (
    segmentsIntersect(a, b, { x: minX, y: minY }, { x: maxX, y: minY }) ||
    segmentsIntersect(a, b, { x: maxX, y: minY }, { x: maxX, y: maxY }) ||
    segmentsIntersect(a, b, { x: maxX, y: maxY }, { x: minX, y: maxY }) ||
    segmentsIntersect(a, b, { x: minX, y: maxY }, { x: minX, y: minY })
  );
};

const boundaryPoint = (record: PositionedNode, target: Point): Point => {
  const dx = target.x - record.x;
  const dy = target.y - record.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: record.x, y: record.y };
  const ux = dx / len;
  const uy = dy / len;
  const halfW = record.size.width / 2;
  const halfH = record.size.height / 2;
  const sx = Math.abs(ux) > 1e-9 ? halfW / Math.abs(ux) : Infinity;
  const sy = Math.abs(uy) > 1e-9 ? halfH / Math.abs(uy) : Infinity;
  const extent = Math.min(sx, sy);
  return { x: record.x + ux * extent, y: record.y + uy * extent };
};

const makeRecord = (
  node: ERNodeModel,
  positions: Map<string, Point>,
  sizes: Map<string, NodeSize>,
): PositionedNode => {
  const point = positions.get(node.id) ?? positionOf(node);
  return {
    id: node.id,
    x: point.x,
    y: point.y,
    size: sizes.get(node.id) ?? fallbackSize(node),
  };
};

const segmentForEdge = (
  edge: EREdgeModel,
  nodeById: Map<string, ERNodeModel>,
  positions: Map<string, Point>,
  sizes: Map<string, NodeSize>,
): EdgeSegment | null => {
  const source = nodeById.get(edge.source);
  const target = nodeById.get(edge.target);
  if (!source || !target) return null;
  const s = makeRecord(source, positions, sizes);
  const t = makeRecord(target, positions, sizes);
  return {
    source: edge.source,
    target: edge.target,
    a: boundaryPoint(s, { x: t.x, y: t.y }),
    b: boundaryPoint(t, { x: s.x, y: s.y }),
  };
};

const edgeTouches = (edge: EdgeSegment, id: string): boolean =>
  edge.source === id || edge.target === id;

const edgeTouchesAny = (edge: EdgeSegment, ids: Iterable<string>): boolean => {
  for (const id of ids) {
    if (edgeTouches(edge, id)) return true;
  }
  return false;
};

const connectorForAttribute = (
  entity: ERNodeModel,
  attribute: ERNodeModel,
  point: Point,
  positions: Map<string, Point>,
  sizes: Map<string, NodeSize>,
): EdgeSegment => {
  const entityRecord = makeRecord(entity, positions, sizes);
  const attrRecord: PositionedNode = {
    id: attribute.id,
    x: point.x,
    y: point.y,
    size: sizes.get(attribute.id) ?? fallbackSize(attribute),
  };
  return {
    source: entity.id,
    target: attribute.id,
    a: boundaryPoint(entityRecord, point),
    b: boundaryPoint(attrRecord, { x: entityRecord.x, y: entityRecord.y }),
  };
};

const minAttributeRadius = (
  entity: ERNodeModel,
  attribute: ERNodeModel,
  angle: number,
  sizes: Map<string, NodeSize>,
  gap: number,
): number => {
  const entitySize = sizes.get(entity.id) ?? fallbackSize(entity);
  const attrSize = sizes.get(attribute.id) ?? fallbackSize(attribute);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const entityHalfW = entitySize.width / 2;
  const entityHalfH = entitySize.height / 2;
  const attrHalfW = attrSize.width / 2;
  const attrHalfH = attrSize.height / 2;
  const entityExtent = Math.min(
    Math.abs(ux) > 1e-9 ? entityHalfW / Math.abs(ux) : Infinity,
    Math.abs(uy) > 1e-9 ? entityHalfH / Math.abs(uy) : Infinity,
  );
  const attrExtent = Math.min(
    Math.abs(ux) > 1e-9 ? attrHalfW / Math.abs(ux) : Infinity,
    Math.abs(uy) > 1e-9 ? attrHalfH / Math.abs(uy) : Infinity,
  );
  return entityExtent + attrExtent + gap;
};

function expandMovableIdsForLineIncidents(
  nodes: ERNodeModel[],
  edges: EREdgeModel[],
  positions: Map<string, Point>,
  sizes: Map<string, NodeSize>,
  movableIds: Set<string>,
): void {
  if (!edges.length || !movableIds.size) return;

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edgeSegments = edges
    .map((edge) => segmentForEdge(edge, nodeById, positions, sizes))
    .filter((edge): edge is EdgeSegment => !!edge);
  const movableEdgeSegments = edgeSegments.filter((edge) => edgeTouchesAny(edge, movableIds));
  if (!movableEdgeSegments.length) return;

  nodes.forEach((node) => {
    if (node.nodeType !== "attribute" || typeof node.parentEntity !== "string") return;
    if (movableIds.has(node.id)) return;
    const entity = nodeById.get(node.parentEntity);
    if (!entity) return;
    const point = positions.get(node.id) ?? positionOf(node);
    const attrSize = sizes.get(node.id) ?? fallbackSize(node);
    const connector = connectorForAttribute(entity, node, point, positions, sizes);

    for (const edge of movableEdgeSegments) {
      if (edgeTouches(edge, node.id)) continue;
      if (segmentHitsBox(edge.a, edge.b, point, attrSize, 1)) {
        movableIds.add(node.id);
        return;
      }
      if (
        !edgeTouches(edge, entity.id) &&
        segmentsIntersect(connector.a, connector.b, edge.a, edge.b)
      ) {
        movableIds.add(node.id);
        return;
      }
    }
  });
}

function applyAttributeLineAvoidance(
  nodes: ERNodeModel[],
  edges: EREdgeModel[],
  positions: Map<string, Point>,
  sizes: Map<string, NodeSize>,
  margin: number,
  movableIds?: ReadonlySet<string>,
  searchBudget: LineSearchBudget = { angleSteps: 72, radiusSteps: 120 },
): void {
  if (!edges.length) return;

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const attributes = nodes
    .filter(
      (node) =>
        node.nodeType === "attribute" &&
        typeof node.parentEntity === "string" &&
        (!movableIds || movableIds.has(node.id)),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  const currentEdges = () =>
    edges
      .map((edge) => segmentForEdge(edge, nodeById, positions, sizes))
      .filter((edge): edge is EdgeSegment => !!edge);

  const placementIsClear = (
    attribute: ERNodeModel,
    entity: ERNodeModel,
    point: Point,
    edgeSegments: EdgeSegment[],
  ): boolean => {
    const attrSize = sizes.get(attribute.id) ?? fallbackSize(attribute);
    const connector = connectorForAttribute(entity, attribute, point, positions, sizes);

    for (const other of nodes) {
      if (other.id === attribute.id) continue;
      const otherPoint = positions.get(other.id) ?? positionOf(other);
      const otherSize = sizes.get(other.id) ?? fallbackSize(other);
      if (boxOverlapAt(point, attrSize, otherPoint, otherSize, margin)) return false;
      if (
        other.id !== entity.id &&
        segmentHitsBox(connector.a, connector.b, otherPoint, otherSize, 1)
      ) {
        return false;
      }
    }

    for (const edge of edgeSegments) {
      if (!edgeTouches(edge, entity.id) && !edgeTouches(edge, attribute.id)) {
        if (segmentsIntersect(connector.a, connector.b, edge.a, edge.b)) return false;
      }
      if (!edgeTouches(edge, attribute.id)) {
        if (segmentHitsBox(edge.a, edge.b, point, attrSize, 1)) return false;
      }
    }

    return true;
  };

  const nearestClearPoint = (
    attribute: ERNodeModel,
    entity: ERNodeModel,
    edgeSegments: EdgeSegment[],
  ): Point | null => {
    const entityPoint = positions.get(entity.id) ?? positionOf(entity);
    const current = positions.get(attribute.id) ?? positionOf(attribute);
    const dx = current.x - entityPoint.x;
    const dy = current.y - entityPoint.y;
    const currentRadius = Math.hypot(dx, dy);
    const baseAngle = currentRadius > 1e-6 ? Math.atan2(dy, dx) : 0;
    const baseRadius = Math.max(
      currentRadius,
      minAttributeRadius(entity, attribute, baseAngle, sizes, margin + 10),
    );
    let best: { point: Point; score: number } | null = null;

    const consider = (angle: number, radius: number): void => {
      const minR = minAttributeRadius(entity, attribute, angle, sizes, margin + 10);
      const r = Math.max(radius, minR);
      const point = {
        x: entityPoint.x + r * Math.cos(angle),
        y: entityPoint.y + r * Math.sin(angle),
      };
      if (!placementIsClear(attribute, entity, point, edgeSegments)) return;
      const score = Math.hypot(point.x - current.x, point.y - current.y);
      if (!best || score < best.score) best = { point, score };
    };

    const angleDeltas = [0];
    const angleSteps = searchBudget.angleSteps;
    for (let step = 1; step <= angleSteps / 2; step++) {
      const delta = (step / angleSteps) * TAU;
      angleDeltas.push(delta, -delta);
    }

    const radiusOffsets = [0];
    const radiusStep = 8;
    for (let step = 1; step <= searchBudget.radiusSteps; step++) {
      const offset = step * radiusStep;
      radiusOffsets.push(offset, -offset);
    }

    for (const angleDelta of angleDeltas) {
      const angle = baseAngle + angleDelta;
      for (const radiusOffset of radiusOffsets) {
        consider(angle, baseRadius + radiusOffset);
        if (best && best.score <= radiusStep) return best.point;
      }
    }

    return best?.point ?? null;
  };

  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const attribute of attributes) {
      const entity = nodeById.get(String(attribute.parentEntity));
      if (!entity) continue;
      const edgeSegments = currentEdges();
      const current = positions.get(attribute.id) ?? positionOf(attribute);
      if (placementIsClear(attribute, entity, current, edgeSegments)) continue;
      const target = nearestClearPoint(attribute, entity, edgeSegments);
      if (!target) continue;
      positions.set(attribute.id, target);
      moved = true;
    }
    if (!moved) break;
  }
}

function applyRelationshipLineAvoidance(
  nodes: ERNodeModel[],
  edges: EREdgeModel[],
  positions: Map<string, Point>,
  sizes: Map<string, NodeSize>,
  margin: number,
  movableIds?: ReadonlySet<string>,
  searchBudget: LineSearchBudget = { angleSteps: 36, radiusSteps: 80 },
): void {
  if (!edges.length) return;

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const relationships = nodes
    .filter((node) => node.nodeType === "relationship" && (!movableIds || movableIds.has(node.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!relationships.length) return;

  const attributes = nodes.filter(
    (node) => node.nodeType === "attribute" && typeof node.parentEntity === "string",
  );

  const currentEdges = () =>
    edges
      .map((edge) => segmentForEdge(edge, nodeById, positions, sizes))
      .filter((edge): edge is EdgeSegment => !!edge);

  const currentAttributeConnectors = () =>
    attributes
      .map((attribute) => {
        const entity = nodeById.get(String(attribute.parentEntity));
        if (!entity) return null;
        const point = positions.get(attribute.id) ?? positionOf(attribute);
        return connectorForAttribute(entity, attribute, point, positions, sizes);
      })
      .filter((edge): edge is EdgeSegment => !!edge);

  const projectedEdgeForRelationship = (
    edge: EREdgeModel,
    relationshipId: string,
    point: Point,
  ): EdgeSegment | null => {
    const before = positions.get(relationshipId);
    positions.set(relationshipId, point);
    const segment = segmentForEdge(edge, nodeById, positions, sizes);
    if (before) positions.set(relationshipId, before);
    else positions.delete(relationshipId);
    return segment;
  };

  const placementIsClear = (
    relationship: ERNodeModel,
    point: Point,
    edgeSegments: EdgeSegment[],
    attributeConnectors: EdgeSegment[],
  ): boolean => {
    const relSize = sizes.get(relationship.id) ?? fallbackSize(relationship);

    for (const edge of edgeSegments) {
      if (
        !edgeTouches(edge, relationship.id) &&
        segmentHitsBox(edge.a, edge.b, point, relSize, 1)
      ) {
        return false;
      }
    }

    const touchingEdges = edges
      .filter((edge) => edge.source === relationship.id || edge.target === relationship.id)
      .map((edge) => projectedEdgeForRelationship(edge, relationship.id, point))
      .filter((edge): edge is EdgeSegment => !!edge);

    for (const edge of touchingEdges) {
      for (const attribute of attributes) {
        const attrPoint = positions.get(attribute.id) ?? positionOf(attribute);
        const attrSize = sizes.get(attribute.id) ?? fallbackSize(attribute);
        if (
          !edgeTouches(edge, attribute.id) &&
          segmentHitsBox(edge.a, edge.b, attrPoint, attrSize, 1)
        ) {
          return false;
        }
      }

      for (const connector of attributeConnectors) {
        if (edgeTouchesAny(connector, [edge.source, edge.target])) continue;
        if (segmentsIntersect(edge.a, edge.b, connector.a, connector.b)) return false;
      }
    }

    for (const other of nodes) {
      if (other.id === relationship.id) continue;
      const otherPoint = positions.get(other.id) ?? positionOf(other);
      const otherSize = sizes.get(other.id) ?? fallbackSize(other);
      if (boxOverlapAt(point, relSize, otherPoint, otherSize, margin)) return false;
    }

    return true;
  };

  const nearestClearPoint = (
    relationship: ERNodeModel,
    edgeSegments: EdgeSegment[],
    attributeConnectors: EdgeSegment[],
  ): Point | null => {
    const current = positions.get(relationship.id) ?? positionOf(relationship);
    if (placementIsClear(relationship, current, edgeSegments, attributeConnectors)) return current;

    let best: { point: Point; score: number } | null = null;
    const consider = (angle: number, radius: number): void => {
      const point = {
        x: current.x + radius * Math.cos(angle),
        y: current.y + radius * Math.sin(angle),
      };
      if (!placementIsClear(relationship, point, edgeSegments, attributeConnectors)) return;
      if (!best || radius < best.score) best = { point, score: radius };
    };

    const angleSteps = searchBudget.angleSteps;
    for (let radiusStep = 1; radiusStep <= searchBudget.radiusSteps; radiusStep++) {
      const radius = radiusStep * 8;
      for (let step = 0; step < angleSteps; step++) {
        consider((step / angleSteps) * TAU, radius);
      }
      if (best) return best.point;
    }

    return null;
  };

  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    const edgeSegments = currentEdges();
    const attributeConnectors = currentAttributeConnectors();

    for (const relationship of relationships) {
      const current = positions.get(relationship.id) ?? positionOf(relationship);
      if (placementIsClear(relationship, current, edgeSegments, attributeConnectors)) continue;
      const target = nearestClearPoint(relationship, edgeSegments, attributeConnectors);
      if (!target) continue;
      positions.set(relationship.id, target);
      moved = true;
    }

    if (!moved) break;
  }
}

export function computeAutoAvoidTargets(
  nodes: ERNodeModel[],
  sizeOf?: NodeSizeResolver,
  options: AutoAvoidOptions = {},
): Map<string, Point> {
  if (options.enabled === false) return new Map();

  const margin = options.margin ?? 4;
  const maxIterations = options.maxIterations ?? 120;
  const original = new Map(nodes.map((node) => [node.id, positionOf(node)]));
  const positions = new Map(Array.from(original, ([id, point]) => [id, { ...point }]));
  const sizes = new Map(nodes.map((node) => [node.id, safeSize(node, sizeOf)]));
  const movableIds = options.movableIds ? new Set(options.movableIds) : null;
  if (movableIds) {
    expandMovableIdsForLineIncidents(nodes, options.edges ?? [], positions, sizes, movableIds);
  }
  const canMove = (node: ERNodeModel): boolean =>
    movePriority(node) > 0 && (!movableIds || movableIds.has(node.id));

  for (let iter = 0; iter < maxIterations; iter++) {
    let maxMove = 0;

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const as = sizes.get(a.id) ?? fallbackSize(a);
      const ap = positions.get(a.id) ?? positionOf(a);
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const bs = sizes.get(b.id) ?? fallbackSize(b);
        const bp = positions.get(b.id) ?? positionOf(b);

        const overlapX = (as.width + bs.width) / 2 + margin - Math.abs(bp.x - ap.x);
        const overlapY = (as.height + bs.height) / 2 + margin - Math.abs(bp.y - ap.y);
        if (overlapX <= 0 || overlapY <= 0) continue;

        const aPriority = canMove(a) ? movePriority(a) : 0;
        const bPriority = canMove(b) ? movePriority(b) : 0;
        if (aPriority === 0 && bPriority === 0) continue;

        let moveA = 0;
        let moveB = 0;
        if (aPriority > bPriority) moveA = 1;
        else if (bPriority > aPriority) moveB = 1;
        else {
          moveA = 0.5;
          moveB = 0.5;
        }

        const separateX = overlapX <= overlapY;
        const rawDelta = separateX ? bp.x - ap.x : bp.y - ap.y;
        const sign =
          Math.abs(rawDelta) > 1e-6 ? Math.sign(rawDelta) : deterministicSign(a.id, b.id);
        const amount = (separateX ? overlapX : overlapY) + 0.5;

        if (separateX) {
          ap.x -= sign * amount * moveA;
          bp.x += sign * amount * moveB;
        } else {
          ap.y -= sign * amount * moveA;
          bp.y += sign * amount * moveB;
        }

        positions.set(a.id, ap);
        positions.set(b.id, bp);
        maxMove = Math.max(maxMove, amount);
      }
    }

    if (maxMove < 0.1) break;
  }

  if (options.avoidAttributeEdges !== false) {
    applyAttributeLineAvoidance(
      nodes,
      options.edges ?? [],
      positions,
      sizes,
      margin,
      movableIds,
      movableIds ? { angleSteps: 24, radiusSteps: 36 } : undefined,
    );
    applyRelationshipLineAvoidance(
      nodes,
      options.edges ?? [],
      positions,
      sizes,
      margin,
      movableIds,
      movableIds ? { angleSteps: 24, radiusSteps: 36 } : undefined,
    );
    applyAttributeLineAvoidance(
      nodes,
      options.edges ?? [],
      positions,
      sizes,
      margin,
      movableIds,
      movableIds ? { angleSteps: 24, radiusSteps: 36 } : undefined,
    );
  }

  const targets = new Map<string, Point>();
  nodes.forEach((node) => {
    if (!canMove(node)) return;
    const before = original.get(node.id);
    const after = positions.get(node.id);
    if (!before || !after) return;
    if (Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6) return;
    targets.set(node.id, { x: after.x, y: after.y });
  });
  return targets;
}
