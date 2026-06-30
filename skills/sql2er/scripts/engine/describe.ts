/**
 * Observation layer — turns the current graph into a compact, precise, textual
 * "scene" the agent reasons over (instead of reading a rendered image):
 *   - skeleton: entities + relationship diamonds with positions/sizes (attributes
 *     collapsed to a count; they are mechanical satellites)
 *   - diagnostics: edge crossings, node overlaps, isolated/placeholder entities,
 *     plus metrics — all PRE-COMPUTED so the agent decides policy, not geometry
 *   - an ASCII spatial map for 2D gestalt
 *   - focus(id): zoom into one entity + neighbours + its attributes
 *
 * Every node carries a stable id (builder.ts), so the report round-trips directly
 * to the edit commands (move/nudge/swap by entity id).
 */
import type { ERNodeModel } from "@app/types";
import type { HeadlessGraph } from "./adapter";

interface Pt {
  x: number;
  y: number;
}
interface CoreInfo {
  id: string;
  type: "entity" | "relationship";
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface RelInfo {
  id: string;
  label: string;
  x: number;
  y: number;
  fromId: string | null;
  toId: string | null;
  cardFrom: string;
  cardTo: string;
  selfLoop: boolean;
}
interface PlanarityInfo {
  planar: boolean;
  status: "planar" | "non-planar";
  reason: string;
  vertices: number;
  edges: number;
}
export interface DiagnosticNodeInfo {
  id: string;
  type: "entity" | "relationship" | "attribute";
  label: string;
  parentId?: string;
  parentLabel?: string;
}
export interface DiagnosticEdgeInfo {
  edgeId: string;
  type: string;
  sourceId: string;
  targetId: string;
  sourceLabel: string;
  targetLabel: string;
}
export type AttributeLineCrossingDetail =
  | {
      kind: "edge-crossing";
      a: DiagnosticEdgeInfo;
      b: DiagnosticEdgeInfo;
    }
  | {
      kind: "line-pierces-attribute";
      edge: DiagnosticEdgeInfo;
      attribute: DiagnosticNodeInfo;
    };

const num = (v: unknown, fallback = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const pairKey = (a: string, b: string): string => (a < b ? `${a}\t${b}` : `${b}\t${a}`);
const pairFromKey = (key: string): [string, string] => {
  const [a, b] = key.split("\t");
  return [a, b];
};

// proper segment intersection (shared endpoints don't count) — ported from arrangeLayout
const segCross = (a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean => {
  const eq = (p: Pt, q: Pt) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
  if (eq(a1, b1) || eq(a1, b2) || eq(a2, b1) || eq(a2, b2)) return false;
  const c = (ox: number, oy: number, px: number, py: number, qx: number, qy: number) =>
    (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  const d1 = c(b1.x, b1.y, b2.x, b2.y, a1.x, a1.y);
  const d2 = c(b1.x, b1.y, b2.x, b2.y, a2.x, a2.y);
  const d3 = c(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y);
  const d4 = c(a1.x, a1.y, a2.x, a2.y, b2.x, b2.y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};

function combinations<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  const pick = (start: number, acc: T[]) => {
    if (acc.length === size) {
      result.push([...acc]);
      return;
    }
    for (let i = start; i <= items.length - (size - acc.length); i++) {
      acc.push(items[i]);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return result;
}

function makeAdjacency(vertices: string[], edgeKeys: Iterable<string>): Map<string, Set<string>> {
  const adj = new Map(vertices.map((id) => [id, new Set<string>()]));
  for (const key of edgeKeys) {
    const [a, b] = pairFromKey(key);
    if (a === b || !adj.has(a) || !adj.has(b)) continue;
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  return adj;
}

function edgeKeysFromAdjacency(adj: Map<string, Set<string>>): Set<string> {
  const keys = new Set<string>();
  adj.forEach((neighbors, a) => {
    neighbors.forEach((b) => {
      if (a !== b) keys.add(pairKey(a, b));
    });
  });
  return keys;
}

function reduceSeriesVertices(adj: Map<string, Set<string>>): Map<string, Set<string>> {
  const reduced = new Map<string, Set<string>>();
  adj.forEach((neighbors, id) => reduced.set(id, new Set(neighbors)));

  const removeVertex = (id: string) => {
    const neighbors = reduced.get(id);
    if (!neighbors) return;
    neighbors.forEach((neighbor) => reduced.get(neighbor)?.delete(id));
    reduced.delete(id);
  };
  const addEdge = (a: string, b: string) => {
    if (a === b || !reduced.has(a) || !reduced.has(b)) return;
    reduced.get(a)!.add(b);
    reduced.get(b)!.add(a);
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...reduced.keys()].sort()) {
      const neighbors = [...(reduced.get(id) ?? [])];
      if (neighbors.length <= 1) {
        removeVertex(id);
        changed = true;
        break;
      }
      if (neighbors.length === 2) {
        removeVertex(id);
        addEdge(neighbors[0], neighbors[1]);
        changed = true;
        break;
      }
    }
  }

  return reduced;
}

function connectedComponentsOf(adj: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>();
  const components: string[][] = [];
  [...adj.keys()].sort().forEach((start) => {
    if (seen.has(start)) return;
    const stack = [start];
    const comp: string[] = [];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      (adj.get(cur) ?? []).forEach((neighbor) => {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          stack.push(neighbor);
        }
      });
    }
    components.push(comp.sort());
  });
  return components;
}

function isBipartiteComponent(component: string[], adj: Map<string, Set<string>>): boolean {
  const inComponent = new Set(component);
  const color = new Map<string, number>();
  for (const start of component) {
    if (color.has(start)) continue;
    color.set(start, 0);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      const curColor = color.get(cur)!;
      for (const neighbor of adj.get(cur) ?? []) {
        if (!inComponent.has(neighbor)) continue;
        if (!color.has(neighbor)) {
          color.set(neighbor, 1 - curColor);
          queue.push(neighbor);
        } else if (color.get(neighbor) === curColor) {
          return false;
        }
      }
    }
  }
  return true;
}

function componentEdgeCount(component: string[], edgeKeys: Set<string>): number {
  const ids = new Set(component);
  let count = 0;
  edgeKeys.forEach((key) => {
    const [a, b] = pairFromKey(key);
    if (ids.has(a) && ids.has(b)) count++;
  });
  return count;
}

function hasK5Subgraph(component: string[], edgeKeys: Set<string>): boolean {
  return combinations(component, 5).some((group) => {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (!edgeKeys.has(pairKey(group[i], group[j]))) return false;
      }
    }
    return true;
  });
}

function hasK33Subgraph(component: string[], edgeKeys: Set<string>): boolean {
  for (const left of combinations(component, 3)) {
    const leftSet = new Set(left);
    const remaining = component.filter((id) => !leftSet.has(id));
    for (const right of combinations(remaining, 3)) {
      let complete = true;
      for (const a of left) {
        for (const b of right) {
          if (!edgeKeys.has(pairKey(a, b))) {
            complete = false;
            break;
          }
        }
        if (!complete) break;
      }
      if (complete) return true;
    }
  }
  return false;
}

function analyzePlanarity(entities: CoreInfo[], relationships: RelInfo[]): PlanarityInfo {
  const vertices = entities.map((entity) => entity.id).sort();
  const edgeKeys = new Set<string>();
  relationships.forEach((relationship) => {
    if (!relationship.fromId || !relationship.toId) return;
    if (relationship.selfLoop || relationship.fromId === relationship.toId) return;
    edgeKeys.add(pairKey(relationship.fromId, relationship.toId));
  });

  const originalVertexCount = vertices.length;
  const originalEdgeCount = edgeKeys.size;
  const reducedAdj = reduceSeriesVertices(makeAdjacency(vertices, edgeKeys));
  const reducedEdges = edgeKeysFromAdjacency(reducedAdj);

  for (const component of connectedComponentsOf(reducedAdj)) {
    const v = component.length;
    const e = componentEdgeCount(component, reducedEdges);
    if (v < 3) continue;

    if (e > 3 * v - 6) {
      return {
        planar: false,
        status: "non-planar",
        reason: `component violates planar Euler edge bound (${e} > ${3 * v - 6})`,
        vertices: originalVertexCount,
        edges: originalEdgeCount,
      };
    }
    if (isBipartiteComponent(component, reducedAdj) && e > 2 * v - 4) {
      return {
        planar: false,
        status: "non-planar",
        reason: `component violates bipartite planar edge bound (${e} > ${2 * v - 4})`,
        vertices: originalVertexCount,
        edges: originalEdgeCount,
      };
    }
    if (hasK5Subgraph(component, reducedEdges)) {
      return {
        planar: false,
        status: "non-planar",
        reason: "component contains a K5 subdivision in the abstract skeleton",
        vertices: originalVertexCount,
        edges: originalEdgeCount,
      };
    }
    if (hasK33Subgraph(component, reducedEdges)) {
      return {
        planar: false,
        status: "non-planar",
        reason: "component contains a K3,3 subdivision in the abstract skeleton",
        vertices: originalVertexCount,
        edges: originalEdgeCount,
      };
    }
  }

  return {
    planar: true,
    status: "planar",
    reason: "abstract entity-relationship skeleton has no detected non-planar obstruction",
    vertices: originalVertexCount,
    edges: originalEdgeCount,
  };
}

interface Scene {
  entities: CoreInfo[];
  relationships: RelInfo[];
  core: CoreInfo[];
  attrsByEntity: Map<string, ERNodeModel[]>;
  entityById: Map<string, CoreInfo>;
  components: string[][]; // entity-id groups
  isolated: string[];
  placeholders: Set<string>;
  crossings: Array<[RelInfo, RelInfo]>;
  overlaps: Array<[CoreInfo, CoreInfo]>;
  attrOverlaps: number;
  attrCrossings: number;
  attrOverlapDetails: Array<[DiagnosticNodeInfo, DiagnosticNodeInfo]>;
  attrLineCrossingDetails: AttributeLineCrossingDetail[];
  planarity: PlanarityInfo;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

function buildScene(graph: HeadlessGraph): Scene {
  const nodes = graph.getNodes();
  const edges = graph.getEdges();

  const entities: CoreInfo[] = [];
  const placeholders = new Set<string>();
  const attrsByEntity = new Map<string, ERNodeModel[]>();
  const relNodes: ERNodeModel[] = [];

  nodes.forEach((n) => {
    const m = n.getModel();
    const b = n.getBBox();
    if (m.nodeType === "entity") {
      entities.push({
        id: m.id,
        type: "entity",
        label: String(m.label ?? m.id),
        x: num(m.x),
        y: num(m.y),
        w: b.width,
        h: b.height,
      });
      if (m.isPlaceholder) placeholders.add(m.id);
    } else if (m.nodeType === "relationship") {
      relNodes.push(m);
    } else if (m.nodeType === "attribute") {
      const pid = String(m.parentEntity ?? "");
      if (!attrsByEntity.has(pid)) attrsByEntity.set(pid, []);
      attrsByEntity.get(pid)!.push(m);
    }
  });

  const entityById = new Map(entities.map((e) => [e.id, e]));
  const bboxOf = new Map(nodes.map((n) => [n.getModel().id, n.getBBox()]));

  // relationship -> connected entities + cardinalities, read from its two edges
  const relationships: RelInfo[] = relNodes.map((m) => {
    const rid = m.id;
    let fromId: string | null = null;
    let toId: string | null = null;
    let cardFrom = "N";
    let cardTo = "1";
    edges.forEach((e) => {
      const em = e.getModel();
      if (em.edgeType === "entity-relationship" && em.target === rid) {
        fromId = em.source;
        if (em.label != null) cardFrom = String(em.label);
      } else if (em.edgeType === "relationship-entity" && em.source === rid) {
        toId = em.target;
        if (em.label != null) cardTo = String(em.label);
      }
    });
    const b = bboxOf.get(rid);
    return {
      id: rid,
      label: String(m.label ?? rid),
      x: num(m.x),
      y: num(m.y),
      fromId,
      toId,
      cardFrom,
      cardTo,
      selfLoop: !!m.isSelfLoop || (fromId !== null && fromId === toId),
    };
  });

  // entity adjacency through binary relationships → connected components
  const adj = new Map<string, Set<string>>();
  entities.forEach((e) => adj.set(e.id, new Set()));
  relationships.forEach((r) => {
    if (r.fromId && r.toId && r.fromId !== r.toId && adj.has(r.fromId) && adj.has(r.toId)) {
      adj.get(r.fromId)!.add(r.toId);
      adj.get(r.toId)!.add(r.fromId);
    }
  });
  const seen = new Set<string>();
  const components: string[][] = [];
  [...entities]
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach((e) => {
      if (seen.has(e.id)) return;
      const stack = [e.id];
      const comp: string[] = [];
      seen.add(e.id);
      while (stack.length) {
        const cur = stack.pop()!;
        comp.push(cur);
        (adj.get(cur) ?? []).forEach((nb) => {
          if (!seen.has(nb)) {
            seen.add(nb);
            stack.push(nb);
          }
        });
      }
      components.push(comp.sort());
    });
  // "isolated" = participates in no relationship at all. A self-loop is still a
  // relationship (deg ≥ 1) even though it adds no entity-to-entity adjacency, so
  // it must not be flagged isolated.
  const hasRel = new Set<string>();
  relationships.forEach((r) => {
    if (r.fromId) hasRel.add(r.fromId);
    if (r.toId) hasRel.add(r.toId);
  });
  const isolated = entities.filter((e) => !hasRel.has(e.id)).map((e) => e.id);
  const planarity = analyzePlanarity(entities, relationships);

  // crossings: each binary relationship is a segment entityFrom→entityTo
  const segs = relationships
    .filter((r) => r.fromId && r.toId && !r.selfLoop)
    .map((r) => ({ r, a: entityById.get(r.fromId!)!, b: entityById.get(r.toId!)! }))
    .filter((s) => s.a && s.b);
  const crossings: Array<[RelInfo, RelInfo]> = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const si = segs[i];
      const sj = segs[j];
      const shared =
        si.a.id === sj.a.id || si.a.id === sj.b.id || si.b.id === sj.a.id || si.b.id === sj.b.id;
      if (shared) continue;
      if (segCross(si.a, si.b, sj.a, sj.b)) crossings.push([si.r, sj.r]);
    }
  }

  // overlaps among core nodes (AABB, small tolerance)
  const coreInfos: CoreInfo[] = entities.concat(
    relationships.map((r) => {
      const b = bboxOf.get(r.id)!;
      return {
        id: r.id,
        type: "relationship",
        label: r.label,
        x: r.x,
        y: r.y,
        w: b.width,
        h: b.height,
      };
    }),
  );
  const overlaps: Array<[CoreInfo, CoreInfo]> = [];
  for (let i = 0; i < coreInfos.length; i++) {
    for (let j = i + 1; j < coreInfos.length; j++) {
      const a = coreInfos[i];
      const b = coreInfos[j];
      const gap = 2;
      if (
        Math.abs(a.x - b.x) < a.w / 2 + b.w / 2 - gap &&
        Math.abs(a.y - b.y) < a.h / 2 + b.h / 2 - gap
      ) {
        overlaps.push([a, b]);
      }
    }
  }

  // attribute overlaps (any pair where at least one is an attribute): the metric
  // attribute orbit modes optimize. Skeleton-only `overlaps` above doesn't see these.
  type Box = {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    attr: boolean;
    detail: DiagnosticNodeInfo;
  };
  const boxes: Box[] = coreInfos.map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    attr: false,
    detail: {
      id: c.id,
      type: c.type,
      label: c.label,
    },
  }));
  const attrBoxes: Box[] = [];
  attrsByEntity.forEach((list) =>
    list.forEach((m) => {
      const b = bboxOf.get(m.id);
      const parentId = String(m.parentEntity ?? "");
      const parentLabel = entityById.get(parentId)?.label;
      if (b) {
        const box = {
          id: m.id,
          x: num(m.x),
          y: num(m.y),
          w: b.width,
          h: b.height,
          attr: true,
          detail: {
            id: m.id,
            type: "attribute" as const,
            label: String(m.label ?? m.id),
            parentId: parentId || undefined,
            parentLabel,
          },
        };
        boxes.push(box);
        attrBoxes.push(box);
      }
    }),
  );
  const nodeDetailById = new Map(boxes.map((box) => [box.id, box.detail]));
  let attrOverlaps = 0;
  const attrOverlapDetails: Array<[DiagnosticNodeInfo, DiagnosticNodeInfo]> = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (!a.attr && !b.attr) continue; // core-core already counted in `overlaps`
      if (
        Math.abs(a.x - b.x) < a.w / 2 + b.w / 2 - 2 &&
        Math.abs(a.y - b.y) < a.h / 2 + b.h / 2 - 2
      ) {
        attrOverlaps++;
        const da = a.detail;
        const db = b.detail;
        attrOverlapDetails.push(
          db.type === "attribute" && da.type !== "attribute" ? [db, da] : [da, db],
        );
      }
    }
  }

  // attribute connector crossings: an entity→attribute line crossing a relationship
  // edge or another connector. This is the visual "tangle" that box-overlap misses.
  const centerOf = (id: string): Pt | null => {
    const b = bboxOf.get(id);
    return b ? { x: b.centerX, y: b.centerY } : null;
  };
  const edgeSegs = edges
    .map((e) => {
      const m = e.getModel();
      const s = centerOf(m.source);
      const t = centerOf(m.target);
      const source = nodeDetailById.get(m.source);
      const target = nodeDetailById.get(m.target);
      return s && t
        ? {
            s,
            t,
            source: m.source,
            target: m.target,
            type: String(m.edgeType ?? ""),
            detail: {
              edgeId: String(m.id ?? `${m.source}->${m.target}`),
              type: String(m.edgeType ?? ""),
              sourceId: m.source,
              targetId: m.target,
              sourceLabel: source?.label ?? m.source,
              targetLabel: target?.label ?? m.target,
            },
          }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  let attrCrossings = 0;
  const attrLineCrossingDetails: AttributeLineCrossingDetail[] = [];
  for (let i = 0; i < edgeSegs.length; i++) {
    for (let j = i + 1; j < edgeSegs.length; j++) {
      const a = edgeSegs[i];
      const b = edgeSegs[j];
      if (a.type !== "entity-attribute" && b.type !== "entity-attribute") continue;
      if (
        a.source === b.source ||
        a.source === b.target ||
        a.target === b.source ||
        a.target === b.target
      )
        continue;
      if (segCross(a.s, a.t, b.s, b.t)) {
        attrCrossings++;
        attrLineCrossingDetails.push({ kind: "edge-crossing", a: a.detail, b: b.detail });
      }
    }
  }
  // A line passing THROUGH an attribute ellipse's box. The connector test above
  // misses this: the line doesn't cross another connector, it pierces the node.
  const attributePiercingLineSegs = edgeSegs.filter(
    (s) =>
      s.type === "entity-relationship" ||
      s.type === "relationship-entity" ||
      s.type === "entity-attribute",
  );
  // segment vs AABB (Liang–Barsky), box inset 2px to match the overlap tolerance
  const segHitsBox = (p1: Pt, p2: Pt, bx: number, by: number, bw: number, bh: number): boolean => {
    const inset = 2;
    const minx = bx - bw / 2 + inset;
    const maxx = bx + bw / 2 - inset;
    const miny = by - bh / 2 + inset;
    const maxy = by + bh / 2 - inset;
    if (minx >= maxx || miny >= maxy) return false;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    let t0 = 0;
    let t1 = 1;
    const clip = (p: number, q: number): boolean => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
      return true;
    };
    return (
      clip(-dx, p1.x - minx) &&
      clip(dx, maxx - p1.x) &&
      clip(-dy, p1.y - miny) &&
      clip(dy, maxy - p1.y) &&
      t1 > t0
    );
  };
  for (const seg of attributePiercingLineSegs) {
    for (const ab of attrBoxes) {
      if (seg.source === ab.id || seg.target === ab.id) continue;
      if (segHitsBox(seg.s, seg.t, ab.x, ab.y, ab.w, ab.h)) {
        attrCrossings++;
        attrLineCrossingDetails.push({
          kind: "line-pierces-attribute",
          edge: seg.detail,
          attribute: ab.detail,
        });
      }
    }
  }

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  coreInfos.forEach((c) => {
    minX = Math.min(minX, c.x - c.w / 2);
    minY = Math.min(minY, c.y - c.h / 2);
    maxX = Math.max(maxX, c.x + c.w / 2);
    maxY = Math.max(maxY, c.y + c.h / 2);
  });
  if (!coreInfos.length) {
    minX = minY = 0;
    maxX = maxY = 0;
  }

  return {
    entities,
    relationships,
    core: coreInfos,
    attrsByEntity,
    entityById,
    components,
    isolated,
    placeholders,
    crossings,
    overlaps,
    attrOverlaps,
    attrCrossings,
    attrOverlapDetails,
    attrLineCrossingDetails,
    planarity,
    bbox: { minX, minY, maxX, maxY },
  };
}

function asciiMap(scene: Scene): string[] {
  const nodes = scene.core;
  if (nodes.length === 0) return ["(empty)"];
  const { minX, minY, maxX, maxY } = scene.bbox;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const cols = Math.max(4, Math.min(12, Math.round(Math.sqrt(nodes.length) * 2.2)));
  const rows = Math.max(3, Math.min(14, Math.round(cols * (spanY / spanX)) || 3));
  const grid: (string | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));

  const cell = (c: CoreInfo) => {
    const cx = Math.min(cols - 1, Math.max(0, Math.round(((c.x - minX) / spanX) * (cols - 1))));
    const cy = Math.min(rows - 1, Math.max(0, Math.round(((c.y - minY) / spanY) * (rows - 1))));
    return [cy, cx] as const;
  };
  const place = (r: number, c: number, token: string) => {
    // spiral to nearest free cell on collision
    for (let radius = 0; radius < Math.max(rows, cols); radius++) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
          if (grid[rr][cc] === null) {
            grid[rr][cc] = token;
            return;
          }
        }
      }
    }
  };
  // entities first (priority), then diamonds
  scene.entities.forEach((e) => {
    const [r, c] = cell(e);
    place(r, c, short(e.label, 8));
  });
  scene.relationships.forEach((r) => {
    const info = scene.core.find((c) => c.id === r.id);
    if (!info) return;
    const [rr, cc] = cell(info);
    place(rr, cc, "◇" + short(r.label, 5));
  });

  const cw = 10;
  return grid.map((row) =>
    row
      .map((t) => (t ?? "").padEnd(cw))
      .join("")
      .replace(/\s+$/, ""),
  );
}

function formatDiagnosticNode(n: DiagnosticNodeInfo): string {
  if (n.type === "attribute") {
    const parent = n.parentLabel ? ` (parent=${n.parentLabel})` : "";
    return `${n.id} ${n.label}${parent}`;
  }
  return `${n.id} ${n.label} [${n.type}]`;
}

function formatDiagnosticEdge(e: DiagnosticEdgeInfo): string {
  return `${e.edgeId} ${e.sourceId} ${e.sourceLabel} → ${e.targetId} ${e.targetLabel}`;
}

function pushAttributeDetails(scene: Scene, lines: string[]): void {
  const limit = 12;
  scene.attrOverlapDetails.slice(0, limit).forEach(([a, b]) => {
    lines.push(`  ⚠ attribute overlap: ${formatDiagnosticNode(a)} × ${formatDiagnosticNode(b)}`);
  });
  if (scene.attrOverlapDetails.length > limit) {
    lines.push(`  … +${scene.attrOverlapDetails.length - limit} more attribute overlaps`);
  }

  scene.attrLineCrossingDetails.slice(0, limit).forEach((detail) => {
    if (detail.kind === "edge-crossing") {
      lines.push(
        `  ⚠ attribute-line crossing: ${formatDiagnosticEdge(detail.a)} × ${formatDiagnosticEdge(detail.b)}`,
      );
    } else {
      lines.push(
        `  ⚠ attribute-line crossing: ${formatDiagnosticEdge(detail.edge)} pierces ${formatDiagnosticNode(detail.attribute)}`,
      );
    }
  });
  if (scene.attrLineCrossingDetails.length > limit) {
    lines.push(
      `  … +${scene.attrLineCrossingDetails.length - limit} more attribute-line crossings`,
    );
  }
}

export function describe(
  graph: HeadlessGraph,
  opts: { full?: boolean; focus?: string; details?: boolean } = {},
): string {
  const scene = buildScene(graph);
  const L: string[] = [];

  if (opts.focus) {
    return describeFocus(scene, opts.focus).join("\n");
  }

  // components
  L.push(
    `COMPONENTS: ${scene.components.length}` +
      (scene.isolated.length ? `  (isolated: ${scene.isolated.length})` : ""),
  );
  scene.components.forEach((comp, i) => {
    const labels = comp.map((id) => scene.entityById.get(id)?.label ?? id);
    L.push(`  C${i + 1} {${labels.join(", ")}}`);
  });
  L.push("");

  // entities
  L.push("ENTITIES  (id | label | pos | size | deg | attrs)");
  scene.entities.forEach((e) => {
    const attrs = scene.attrsByEntity.get(e.id) ?? [];
    const pk = attrs.filter((a) => a.keyType === "pk").length;
    const deg = scene.relationships.filter((r) => r.fromId === e.id || r.toId === e.id).length;
    const tag = scene.placeholders.has(e.id) ? " [placeholder]" : "";
    L.push(
      `  ${e.id}  ${e.label}${tag}  (${Math.round(e.x)},${Math.round(e.y)})  ${Math.round(e.w)}×${Math.round(e.h)}  deg=${deg}  attrs=${attrs.length}${pk ? `(${pk}pk)` : ""}`,
    );
  });
  L.push("");

  // relationships
  if (scene.relationships.length) {
    L.push("RELATIONS  (id | label | from→to | card | pos)");
    scene.relationships.forEach((r) => {
      const from = r.fromId ? (scene.entityById.get(r.fromId)?.label ?? r.fromId) : "?";
      const to = r.toId ? (scene.entityById.get(r.toId)?.label ?? r.toId) : "?";
      const self = r.selfLoop ? " [self]" : "";
      L.push(
        `  ${r.id}  ${r.label}  ${from}→${to}${self}  ${r.cardFrom}:${r.cardTo}  (${Math.round(r.x)},${Math.round(r.y)})`,
      );
    });
    L.push("");
  }

  // diagnostics
  L.push("DIAGNOSTICS");
  if (scene.crossings.length) {
    scene.crossings
      .slice(0, 12)
      .forEach(([a, b]) => L.push(`  ⚠ crossing: ${a.label} × ${b.label}`));
    if (scene.crossings.length > 12) L.push(`  … +${scene.crossings.length - 12} more crossings`);
  } else {
    L.push("  ✓ no edge crossings");
  }
  if (scene.overlaps.length) {
    scene.overlaps.slice(0, 12).forEach(([a, b]) => L.push(`  ⚠ overlap: ${a.label} × ${b.label}`));
    if (scene.overlaps.length > 12) L.push(`  … +${scene.overlaps.length - 12} more overlaps`);
  } else {
    L.push("  ✓ no node overlaps");
  }
  scene.isolated.forEach((id) => L.push(`  ⚠ isolated: ${scene.entityById.get(id)?.label ?? id}`));
  if (scene.attrOverlaps > 0)
    L.push(`  ⚠ attribute overlaps: ${scene.attrOverlaps}  (try \`attrs compact\`)`);
  if (scene.attrCrossings > 0)
    L.push(`  ⚠ attribute-line crossings: ${scene.attrCrossings}  (try \`attrs compact\`)`);
  if (opts.details) pushAttributeDetails(scene, L);
  if (scene.planarity.planar) {
    L.push(`  ✓ planarity: planar skeleton (${scene.planarity.reason})`);
  } else {
    L.push(
      `  ⚠ planarity: non-planar skeleton (${scene.planarity.reason}; some relationship crossings are unavoidable)`,
    );
  }

  const w = Math.round(scene.bbox.maxX - scene.bbox.minX);
  const h = Math.round(scene.bbox.maxY - scene.bbox.minY);
  const aspect = h > 0 ? (w / h).toFixed(2) : "—";
  let edgeLen = 0;
  scene.relationships.forEach((r) => {
    if (r.fromId && r.toId) {
      const a = scene.entityById.get(r.fromId);
      const b = scene.entityById.get(r.toId);
      if (a && b) edgeLen += Math.hypot(b.x - a.x, b.y - a.y);
    }
  });
  L.push(
    `  metrics: crossings=${scene.crossings.length} overlaps=${scene.overlaps.length} attrOverlaps=${scene.attrOverlaps} attrCrossings=${scene.attrCrossings} planar=${scene.planarity.planar} bbox=${w}×${h} aspect=${aspect} edgeLen=${Math.round(edgeLen)}`,
  );
  L.push("");

  // ascii map
  L.push("MAP  (coarse 2D placement; authoritative coords above)");
  asciiMap(scene).forEach((row) => L.push("  " + row));

  if (opts.full) {
    L.push("");
    L.push("ATTRIBUTES  (id | label | parent | pos)");
    scene.entities.forEach((e) => {
      (scene.attrsByEntity.get(e.id) ?? []).forEach((a) => {
        L.push(
          `  ${a.id}  ${a.label}${a.keyType === "pk" ? " [pk]" : ""}  ${e.label}  (${Math.round(num(a.x))},${Math.round(num(a.y))})`,
        );
      });
    });
  }

  return L.join("\n");
}

function describeFocus(scene: Scene, focusArg: string): string[] {
  const ent = scene.entityById.get(focusArg);
  if (!ent) return [`focus: no entity id matching "${focusArg}"`];
  const L: string[] = [];
  L.push(
    `FOCUS ${ent.id}  ${ent.label}  (${Math.round(ent.x)},${Math.round(ent.y)})  ${Math.round(ent.w)}×${Math.round(ent.h)}`,
  );
  const rels = scene.relationships.filter((r) => r.fromId === ent.id || r.toId === ent.id);
  L.push(`  relations: ${rels.length}`);
  rels.forEach((r) => {
    // Print the canonical from→to with its cardinality (identical to the main
    // RELATIONS block) so the arrow always means FK direction. Reorienting the
    // arrow to the focused entity without flipping the cardinality misreads the
    // N:1 — keep one consistent convention instead.
    const fromL = r.fromId ? (scene.entityById.get(r.fromId)?.label ?? r.fromId) : "?";
    const toL = r.toId ? (scene.entityById.get(r.toId)?.label ?? r.toId) : "?";
    const self = r.selfLoop ? " [self]" : "";
    L.push(
      `    ${r.id}  ${r.label}  ${fromL}→${toL}${self}  ${r.cardFrom}:${r.cardTo}  (${Math.round(r.x)},${Math.round(r.y)})`,
    );
  });
  const attrs = scene.attrsByEntity.get(ent.id) ?? [];
  L.push(`  attributes: ${attrs.length}`);
  attrs.forEach((a) => {
    L.push(
      `    ${a.id}  ${a.label}${a.keyType === "pk" ? " [pk]" : ""}  (${Math.round(num(a.x))},${Math.round(num(a.y))})`,
    );
  });
  return L;
}

export interface SceneJson {
  entities: Array<{
    id: string;
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
    placeholder: boolean;
  }>;
  relationships: Array<{
    id: string;
    label: string;
    from: string | null;
    to: string | null;
    card: string;
    x: number;
    y: number;
  }>;
  diagnostics: {
    crossings: number;
    overlaps: number;
    attrOverlaps: number;
    attrCrossings: number;
    details?: {
      attributeOverlaps: Array<{
        a: DiagnosticNodeInfo;
        b: DiagnosticNodeInfo;
      }>;
      attributeLineCrossings: AttributeLineCrossingDetail[];
    };
    planarity: PlanarityInfo;
    isolated: string[];
    bbox: { w: number; h: number };
  };
}

export function describeJson(graph: HeadlessGraph, opts: { details?: boolean } = {}): SceneJson {
  const s = buildScene(graph);
  const diagnostics: SceneJson["diagnostics"] = {
    crossings: s.crossings.length,
    overlaps: s.overlaps.length,
    attrOverlaps: s.attrOverlaps,
    attrCrossings: s.attrCrossings,
    planarity: s.planarity,
    isolated: s.isolated.map((id) => s.entityById.get(id)?.label ?? id),
    bbox: { w: Math.round(s.bbox.maxX - s.bbox.minX), h: Math.round(s.bbox.maxY - s.bbox.minY) },
  };
  if (opts.details) {
    diagnostics.details = {
      attributeOverlaps: s.attrOverlapDetails.map(([a, b]) => ({ a, b })),
      attributeLineCrossings: s.attrLineCrossingDetails,
    };
  }
  return {
    entities: s.entities.map((e) => ({
      id: e.id,
      label: e.label,
      x: Math.round(e.x),
      y: Math.round(e.y),
      w: Math.round(e.w),
      h: Math.round(e.h),
      placeholder: s.placeholders.has(e.id),
    })),
    relationships: s.relationships.map((r) => ({
      id: r.id,
      label: r.label,
      from: r.fromId,
      to: r.toId,
      card: `${r.cardFrom}:${r.cardTo}`,
      x: Math.round(r.x),
      y: Math.round(r.y),
    })),
    diagnostics,
  };
}
