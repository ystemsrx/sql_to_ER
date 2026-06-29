/**
 * Skeleton layout by stress majorization.
 *
 * Attributes don't drive the layout — the skeleton (entity rectangles + relationship
 * diamonds) does. We model entities as an undirected graph (one edge per binary
 * relationship), give each edge a desired length large enough to hold BOTH entities'
 * attribute rings plus the diamond between them, then run SMACOF stress majorization
 * to realise those distances (uniform-ish edge lengths, few crossings on a planar
 * skeleton), remove residual node overlaps, pack disconnected components, and drop
 * each diamond on the line between its two entities. Attribute placement (`attrs`)
 * then fills the room this reserves — which is why overlaps/crossings disappear.
 */
import { measureNodeSize } from "@app/builder";
import type { EREdgeModel, ERNodeModel } from "@app/types";

const TAU = Math.PI * 2;
const GAP = 8;

const halfDiag = (m: ERNodeModel) => {
  const s = measureNodeSize(m);
  return Math.hypot(s.width, s.height) / 2;
};
const maxHalfOf = (m: ERNodeModel) => {
  const s = measureNodeSize(m);
  return Math.max(s.width, s.height) / 2;
};

/**
 * Smallest ring radius that fits an entity's attributes side by side (variable
 * angular width). Shared with the `moderate` attribute placer so the room reserved
 * here matches the ring drawn there.
 */
export function ringRadiusFor(entity: ERNodeModel, attrs: ERNodeModel[]): number {
  const entR = halfDiag(entity);
  if (!attrs.length) return entR;
  const halves = attrs.map(maxHalfOf);
  const maxHalf = Math.max(...halves);
  const radialMin = entR + maxHalf + GAP;
  const target = TAU * 0.92;
  const sum = (R: number) =>
    halves.reduce((s, h) => s + 2 * Math.asin(Math.min(0.999, (h + GAP / 2) / R)), 0);
  let lo = radialMin;
  let hi = radialMin;
  while (sum(hi) > target && hi < radialMin + 6000) hi *= 1.5;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (sum(mid) <= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

interface Pt {
  x: number;
  y: number;
}

// SMACOF (Guttman transform, Gauss–Seidel) for one component given target distances.
function smacof(pos: Pt[], D: number[][], iters: number): void {
  const n = pos.length;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let nx = 0;
      let ny = 0;
      let den = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dij = D[i][j];
        const w = 1 / (dij * dij);
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const dist = Math.hypot(dx, dy) || 1e-4;
        nx += w * (pos[j].x + (dij * dx) / dist);
        ny += w * (pos[j].y + (dij * dy) / dist);
        den += w;
      }
      if (den > 0) {
        pos[i].x = nx / den;
        pos[i].y = ny / den;
      }
    }
  }
}

// push disks apart until none overlap
function removeOverlaps(pos: Pt[], rad: number[], iters = 400): void {
  const n = pos.length;
  for (let it = 0; it < iters; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const dist = Math.hypot(dx, dy) || 1e-4;
        const min = rad[i] + rad[j];
        if (dist < min) {
          const push = (min - dist) / 2;
          const ux = dx / dist;
          const uy = dy / dist;
          pos[i].x -= ux * push;
          pos[i].y -= uy * push;
          pos[j].x += ux * push;
          pos[j].y += uy * push;
          moved = Math.max(moved, push);
        }
      }
    }
    if (moved < 0.3) break;
  }
}

// proper segment intersection (shared endpoints don't count)
function segCross(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const eq = (p: Pt, q: Pt) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
  if (eq(a1, b1) || eq(a1, b2) || eq(a2, b1) || eq(a2, b2)) return false;
  const c = (o: Pt, p: Pt, q: Pt) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = c(b1, b2, a1);
  const d2 = c(b1, b2, a2);
  const d3 = c(a1, a2, b1);
  const d4 = c(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function countCrossings(pos: Pt[], E: [number, number][]): number {
  let total = 0;
  for (let i = 0; i < E.length; i++) {
    for (let j = i + 1; j < E.length; j++) {
      const [a, b] = E[i];
      const [c, d] = E[j];
      if (a === c || a === d || b === c || b === d) continue;
      if (segCross(pos[a], pos[b], pos[c], pos[d])) total++;
    }
  }
  return total;
}

// 2-opt: swap entity positions to reduce skeleton edge crossings (the skeleton is
// planar, so a crossing-free arrangement usually exists). Overlap removal runs after.
function reduceCrossings(pos: Pt[], E: [number, number][], n: number): void {
  let cur = countCrossings(pos, E);
  for (let pass = 0; pass < 8 && cur > 0; pass++) {
    let improved = false;
    for (let i = 0; i < n && cur > 0; i++) {
      for (let j = i + 1; j < n; j++) {
        const tmp = pos[i];
        pos[i] = pos[j];
        pos[j] = tmp;
        const nc = countCrossings(pos, E);
        if (nc < cur) {
          cur = nc;
          improved = true;
        } else {
          const t2 = pos[i];
          pos[i] = pos[j];
          pos[j] = t2;
        }
      }
    }
    if (!improved) break;
  }
}

export function stressLayout(nodes: ERNodeModel[], edges: EREdgeModel[]): void {
  const entities = nodes.filter((n) => n.nodeType === "entity");
  const rels = nodes.filter((n) => n.nodeType === "relationship");
  if (!entities.length) return;

  const attrsByE = new Map<string, ERNodeModel[]>();
  nodes.forEach((n) => {
    if (n.nodeType === "attribute" && typeof n.parentEntity === "string") {
      if (!attrsByE.has(n.parentEntity)) attrsByE.set(n.parentEntity, []);
      attrsByE.get(n.parentEntity)!.push(n);
    }
  });
  const ring = new Map(entities.map((e) => [e.id, ringRadiusFor(e, attrsByE.get(e.id) ?? [])]));
  const footprint = new Map(
    entities.map((e) => {
      const attrs = attrsByE.get(e.id) ?? [];
      const maxAttr = attrs.length ? Math.max(...attrs.map(maxHalfOf)) : 0;
      return [e.id, ring.get(e.id)! + maxAttr + 6];
    }),
  );

  // relationship -> its two (or one) entities
  const relEnts = new Map<string, string[]>();
  rels.forEach((r) => relEnts.set(r.id, []));
  edges.forEach((e) => {
    if (e.edgeType === "entity-relationship") relEnts.get(e.target)?.push(e.source);
    else if (e.edgeType === "relationship-entity") relEnts.get(e.source)?.push(e.target);
  });
  const binRels = rels
    .map((r) => ({ r, es: [...new Set(relEnts.get(r.id) ?? [])] }))
    .filter((x) => x.es.length === 2);

  // entity adjacency + per-edge desired length (room for both rings + the diamond)
  const eidx = new Map(entities.map((e, i) => [e.id, i]));
  const N = entities.length;
  const desired = new Map<string, number>();
  const adj = new Map<string, Set<string>>();
  entities.forEach((e) => adj.set(e.id, new Set()));
  const key = (a: string, b: string) => (a < b ? a + "|" + b : b + "|" + a);
  binRels.forEach(({ r, es }) => {
    const [a, b] = es;
    const d = ring.get(a)! + ring.get(b)! + 2 * halfDiag(r) + 2 * 20;
    const k = key(a, b);
    if (!desired.has(k) || d < desired.get(k)!) desired.set(k, d);
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  });

  // connected components of entities
  const seen = new Set<string>();
  const comps: string[][] = [];
  entities
    .map((e) => e.id)
    .sort()
    .forEach((id) => {
      if (seen.has(id)) return;
      const stack = [id];
      const comp: string[] = [];
      seen.add(id);
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
      comps.push(comp);
    });

  // lay out each component independently, then pack the components into rows
  interface Laid {
    ids: string[];
    pos: Map<string, Pt>;
    w: number;
    h: number;
  }
  const laid: Laid[] = comps.map((ids) => {
    const local = ids.map((id) => entities[eidx.get(id)!]);
    const m = local.length;
    // target distances: weighted all-pairs shortest path within the component
    const li = new Map(ids.map((id, i) => [id, i]));
    const INF = 1e9;
    const D: number[][] = Array.from({ length: m }, () => new Array(m).fill(INF));
    for (let i = 0; i < m; i++) D[i][i] = 0;
    ids.forEach((a) =>
      (adj.get(a) ?? []).forEach((b) => {
        if (!li.has(b)) return;
        const d = desired.get(key(a, b)) ?? 300;
        const ia = li.get(a)!;
        const ib = li.get(b)!;
        D[ia][ib] = Math.min(D[ia][ib], d);
        D[ib][ia] = Math.min(D[ib][ia], d);
      }),
    );
    for (let k = 0; k < m; k++)
      for (let i = 0; i < m; i++)
        for (let j = 0; j < m; j++) if (D[i][k] + D[k][j] < D[i][j]) D[i][j] = D[i][k] + D[k][j];
    // single node: trivial
    const pos: Pt[] = local.map((e, i) => ({
      x: typeof e.x === "number" ? e.x : Math.cos((i / m) * TAU) * 200,
      y: typeof e.y === "number" ? e.y : Math.sin((i / m) * TAU) * 200,
    }));
    if (m > 1) {
      smacof(pos, D, 300);
      const rads = local.map((e) => footprint.get(e.id)!);
      removeOverlaps(pos, rads, 400);
      // uncross the skeleton (2-opt), then re-separate
      const idSet = new Set(ids);
      const edgesLocal: [number, number][] = [];
      binRels.forEach(({ es }) => {
        const [a, b] = es;
        if (idSet.has(a) && idSet.has(b)) edgesLocal.push([li.get(a)!, li.get(b)!]);
      });
      if (edgesLocal.length > 1) {
        reduceCrossings(pos, edgesLocal, m);
        removeOverlaps(pos, rads, 400);
      }
    }
    // normalise to local origin, record bbox incl. footprints
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    local.forEach((e, i) => {
      const r = footprint.get(e.id)!;
      minX = Math.min(minX, pos[i].x - r);
      minY = Math.min(minY, pos[i].y - r);
      maxX = Math.max(maxX, pos[i].x + r);
      maxY = Math.max(maxY, pos[i].y + r);
    });
    const map = new Map<string, Pt>();
    local.forEach((e, i) => map.set(e.id, { x: pos[i].x - minX, y: pos[i].y - minY }));
    return { ids, pos: map, w: maxX - minX, h: maxY - minY };
  });

  // pack components left-to-right, wrapping into rows
  laid.sort((a, b) => b.h - a.h);
  const totalW = laid.reduce((s, c) => s + c.w, 0);
  const rowMax = Math.max(900, Math.sqrt(totalW * (laid[0]?.h ?? 400)) * 1.3);
  const PAD = 80;
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  laid.forEach((c) => {
    if (cx > 0 && cx + c.w > rowMax) {
      cx = 0;
      cy += rowH + PAD;
      rowH = 0;
    }
    c.ids.forEach((id) => {
      const p = c.pos.get(id)!;
      entities[eidx.get(id)!].x = cx + p.x;
      entities[eidx.get(id)!].y = cy + p.y;
    });
    cx += c.w + PAD;
    rowH = Math.max(rowH, c.h);
  });

  // diamonds: equal-gap point on the line between the two entities; self-loops offset
  const epos = new Map(entities.map((e) => [e.id, { x: e.x ?? 0, y: e.y ?? 0 }]));
  // group multiple relationships between the same pair to fan them perpendicular
  const groups = new Map<string, { r: ERNodeModel; es: string[] }[]>();
  binRels.forEach((br) => {
    const k = key(br.es[0], br.es[1]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(br);
  });
  groups.forEach((list) => {
    const [a, b] = list[0].es;
    const pa = epos.get(a)!;
    const pb = epos.get(b)!;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const px = -uy;
    const py = ux;
    const mid = (list.length - 1) / 2;
    list.forEach((br, i) => {
      const dh = halfDiag(br.r);
      const free = dist - ring.get(a)! - ring.get(b)! - 2 * dh;
      const gap = Math.max(20, free / 2);
      const fromA = ring.get(a)! + dh + gap;
      const off = (i - mid) * (dh * 2 + 16);
      br.r.x = pa.x + ux * fromA + px * off;
      br.r.y = pa.y + uy * fromA + py * off;
    });
  });
  rels.forEach((r) => {
    const es = [...new Set(relEnts.get(r.id) ?? [])];
    if (es.length === 1) {
      const a = epos.get(es[0]);
      if (a) {
        r.x = a.x;
        r.y = a.y - (ring.get(es[0])! + 40);
      }
    }
  });
}
