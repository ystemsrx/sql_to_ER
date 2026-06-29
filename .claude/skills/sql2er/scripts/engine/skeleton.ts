/**
 * Skeleton layout by stress majorization.
 *
 * Attributes don't drive the layout — the skeleton (entity rectangles + relationship
 * diamonds) does. We model entities as an undirected graph (one edge per binary
 * relationship), give each edge a desired length large enough to hold BOTH entities'
 * attribute rings plus the diamond between them, then run SMACOF stress majorization
 * to realise those distances (uniform-ish edge lengths, few crossings on a planar
 * skeleton), and remove residual node overlaps. Each component is then evened out
 * (degree-2 entities nudged so their two diamond distances move closer, never adding
 * spread/overlap/crossing) and rotated on its own toward a 3:2 box; components stack
 * top-to-bottom, left-aligned. Each diamond then drops on the line between its two
 * entities, and a final safety net slides any diamond off a node it landed on (only
 * diamonds move). Attribute placement (`attrs`) fills the room this reserves — which
 * is why overlaps/crossings disappear.
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

// Crossings that the edges incident to entity `i` participate in. Moving only `i`
// changes only these, so comparing this before/after a move detects any NEW crossing
// in O(E) instead of recounting the whole skeleton.
function crossingsAt(pos: Pt[], myEdges: [number, number][], E: [number, number][]): number {
  let t = 0;
  for (const [a, b] of myEdges) {
    for (const [c, d] of E) {
      if (a === c || a === d || b === c || b === d) continue; // same edge or shared endpoint
      if (segCross(pos[a], pos[b], pos[c], pos[d])) t++;
    }
  }
  return t;
}

// Distance from entity `i` to the diamond on edge i→j, matching the placement
// formula in stressLayout (the diamond sits at ring(i)+dh+gap along the line).
function diamondDist(i: number, j: number, dh: number, pos: Pt[], ring: number[]): number {
  const dist = Math.hypot(pos[j].x - pos[i].x, pos[j].y - pos[i].y) || 1;
  const free = dist - ring[i] - ring[j] - 2 * dh;
  const gap = Math.max(20, free / 2);
  return ring[i] + dh + gap;
}

/**
 * Balance an entity that connects exactly two relationship diamonds (degree-2, two
 * DISTINCT neighbours): nudge it so its two diamond distances move CLOSER to equal —
 * not forced equal. A trial move is taken only if it (a) shrinks the gap, (b) never
 * lengthens the longer of the two distances (so the diagram can't spread), (c) keeps
 * every entity footprint disk clear, and (d) adds no edge crossing. Everything else
 * stays exactly where stress majorization put it.
 */
function balanceTwoDiamondEntities(
  pos: Pt[],
  ring: number[],
  foot: number[],
  incident: Map<number, { nb: number; dh: number }[]>,
  E: [number, number][],
  rounds: number,
): void {
  const cands = [...incident.keys()].filter((i) => {
    const inc = incident.get(i)!;
    return inc.length === 2 && inc[0].nb !== inc[1].nb;
  });
  if (!cands.length) return;
  const overlapFree = (i: number): boolean => {
    for (let j = 0; j < pos.length; j++) {
      if (j === i) continue;
      // same separation removeOverlaps guarantees — no extra slack
      if (Math.hypot(pos[j].x - pos[i].x, pos[j].y - pos[i].y) < foot[i] + foot[j]) return false;
    }
    return true;
  };
  // component footprint box: balancing may even out distances WITHIN it, but a move
  // must never push an entity's footprint outside it (that would spread the diagram).
  let bMinX = Infinity;
  let bMinY = Infinity;
  let bMaxX = -Infinity;
  let bMaxY = -Infinity;
  for (let k = 0; k < pos.length; k++) {
    bMinX = Math.min(bMinX, pos[k].x - foot[k]);
    bMaxX = Math.max(bMaxX, pos[k].x + foot[k]);
    bMinY = Math.min(bMinY, pos[k].y - foot[k]);
    bMaxY = Math.max(bMaxY, pos[k].y + foot[k]);
  }
  const inBox = (i: number): boolean =>
    pos[i].x - foot[i] >= bMinX - 0.5 &&
    pos[i].x + foot[i] <= bMaxX + 0.5 &&
    pos[i].y - foot[i] >= bMinY - 0.5 &&
    pos[i].y + foot[i] <= bMaxY + 0.5;
  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (const i of cands) {
      const [eA, eB] = incident.get(i)!;
      const myEdges: [number, number][] = [
        [i, eA.nb],
        [i, eB.nb],
      ];
      const d1 = diamondDist(i, eA.nb, eA.dh, pos, ring);
      const d2 = diamondDist(i, eB.nb, eB.dh, pos, ring);
      const gap0 = Math.abs(d1 - d2);
      if (gap0 < 8) continue; // already even enough
      const maxOrig = Math.max(d1, d2);
      const ox = pos[i].x;
      const oy = pos[i].y;
      const baseCross = crossingsAt(pos, myEdges, E);
      const DIRS = 24;
      const steps = [gap0 * 0.5, gap0 * 0.25, gap0 * 0.1, 30, 10];
      let bestGap = gap0;
      let bx = ox;
      let by = oy;
      for (let d = 0; d < DIRS; d++) {
        const ux = Math.cos((d / DIRS) * TAU);
        const uy = Math.sin((d / DIRS) * TAU);
        for (const st of steps) {
          pos[i].x = ox + ux * st;
          pos[i].y = oy + uy * st;
          const n1 = diamondDist(i, eA.nb, eA.dh, pos, ring);
          const n2 = diamondDist(i, eB.nb, eB.dh, pos, ring);
          const gap = Math.abs(n1 - n2);
          if (
            gap < bestGap - 0.5 &&
            Math.max(n1, n2) <= maxOrig + 0.5 &&
            inBox(i) &&
            overlapFree(i) &&
            crossingsAt(pos, myEdges, E) <= baseCross
          ) {
            bestGap = gap;
            bx = pos[i].x;
            by = pos[i].y;
          }
        }
      }
      pos[i].x = bx;
      pos[i].y = by;
      if (bx !== ox || by !== oy) moved = true;
    }
    if (!moved) break;
  }
}

/**
 * Rotate a component's entity centres about their centroid to the orientation whose
 * (footprint-disk) bounding box is closest to a 3:2 aspect ratio. Disk radii are
 * rotation-invariant, so the search is exact; ties break toward the smaller box.
 * Shapes stay upright (only centres move), exactly like the `rotate` command.
 */
function rotateToTargetAspect(pos: Pt[], rad: number[], target = 1.5): void {
  const n = pos.length;
  if (n < 2) return;
  let cx = 0;
  let cy = 0;
  for (const p of pos) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  let bestTheta = 0;
  let bestScore = Infinity;
  let bestArea = Infinity;
  for (let deg = 0; deg < 180; deg++) {
    const th = (deg * Math.PI) / 180;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const dx = pos[i].x - cx;
      const dy = pos[i].y - cy;
      const rx = cx + dx * cos - dy * sin;
      const ry = cy + dx * sin + dy * cos;
      minX = Math.min(minX, rx - rad[i]);
      maxX = Math.max(maxX, rx + rad[i]);
      minY = Math.min(minY, ry - rad[i]);
      maxY = Math.max(maxY, ry + rad[i]);
    }
    const w = maxX - minX;
    const h = maxY - minY;
    const aspect = h > 1e-6 ? w / h : Infinity;
    const score = Math.abs(aspect - target);
    const area = w * h;
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) < 1e-9 && area < bestArea)) {
      bestScore = score;
      bestArea = area;
      bestTheta = th;
    }
  }
  if (Math.abs(bestTheta) < 1e-9) return;
  const cos = Math.cos(bestTheta);
  const sin = Math.sin(bestTheta);
  for (let i = 0; i < n; i++) {
    const dx = pos[i].x - cx;
    const dy = pos[i].y - cy;
    pos[i].x = cx + dx * cos - dy * sin;
    pos[i].y = cy + dx * sin + dy * cos;
  }
}

/**
 * @param ringOverride optional per-entity ring radius (centre→attribute-centre). When
 * given (e.g. measured from a compact attribute pass), the skeleton is sized to that
 * instead of the moderate `ringRadiusFor`, so compact diagrams pull in tight rather
 * than reserving moderate-ring room they don't use.
 */
export function stressLayout(
  nodes: ERNodeModel[],
  edges: EREdgeModel[],
  ringOverride?: Map<string, number>,
): void {
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
  const ring = new Map(
    entities.map((e) => [
      e.id,
      ringOverride?.get(e.id) ?? ringRadiusFor(e, attrsByE.get(e.id) ?? []),
    ]),
  );
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

  // lay out + orient each component independently, then stack them vertically
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
    const rads = local.map((e) => footprint.get(e.id)!);
    // local entity↔entity edges + per-entity incidence (neighbour + diamond half-diag)
    const idSet = new Set(ids);
    const edgesLocal: [number, number][] = [];
    const incident = new Map<number, { nb: number; dh: number }[]>();
    binRels.forEach(({ r, es }) => {
      const [a, b] = es;
      if (!idSet.has(a) || !idSet.has(b)) return;
      const ia = li.get(a)!;
      const ib = li.get(b)!;
      edgesLocal.push([ia, ib]);
      const dh = halfDiag(r);
      if (!incident.has(ia)) incident.set(ia, []);
      if (!incident.has(ib)) incident.set(ib, []);
      incident.get(ia)!.push({ nb: ib, dh });
      incident.get(ib)!.push({ nb: ia, dh });
    });
    if (m > 1) {
      smacof(pos, D, 300);
      removeOverlaps(pos, rads, 400);
      // uncross the skeleton (2-opt), then re-separate
      if (edgesLocal.length > 1) {
        reduceCrossings(pos, edgesLocal, m);
        removeOverlaps(pos, rads, 400);
      }
      // even out lopsided degree-2 entities (no spread, no new overlap/crossing)
      const ringLocal = local.map((e) => ring.get(e.id)!);
      balanceTwoDiamondEntities(pos, ringLocal, rads, incident, edgesLocal, 16);
    }
    // orient this component toward a 3:2 box (shapes stay upright)
    rotateToTargetAspect(pos, rads);
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

  // stack components top-to-bottom, left-aligned (each already rotated on its own);
  // largest first so the main diagram leads and stray tables trail below it
  laid.sort((a, b) => b.w * b.h - a.w * a.h);
  const PAD = 80;
  let cy = 0;
  laid.forEach((c) => {
    c.ids.forEach((id) => {
      const p = c.pos.get(id)!;
      entities[eidx.get(id)!].x = p.x; // local minX is 0 → shared left edge
      entities[eidx.get(id)!].y = cy + p.y;
    });
    cy += c.h + PAD;
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

  // ── safety net: nudge relationship diamonds off any node they overlap ──────────
  // Diamonds are dropped geometrically on entity lines (and self-loops straight up),
  // unseen by the per-component overlap removal that ran before they existed. Here we
  // slide ONLY the diamonds — never entities — off any entity or other diamond, by the
  // minimal axis-aligned separation. (A diamond is placed ≥20px clear of its incident
  // entities, so this only fires when another push shoved it onto one.) Entity positions
  // and attribute rings stay put; this keeps `overlaps` at 0 on dense / hub skeletons.
  const MARGIN = 3; // clear describe's 2px overlap tolerance with room to spare
  const entBox = entities.map((e) => {
    const s = measureNodeSize(e);
    return { id: e.id, x: e.x ?? 0, y: e.y ?? 0, hw: s.width / 2, hh: s.height / 2 };
  });
  const relBox = rels.map((r) => {
    const s = measureNodeSize(r);
    return { r, hw: s.width / 2, hh: s.height / 2 };
  });
  for (let iter = 0; iter < 200; iter++) {
    let moved = 0;
    for (let i = 0; i < relBox.length; i++) {
      const bi = relBox[i];
      const ri = bi.r;
      // vs entities (fixed)
      for (const eb of entBox) {
        const dx = (ri.x ?? 0) - eb.x;
        const dy = (ri.y ?? 0) - eb.y;
        const ox = bi.hw + eb.hw + MARGIN - Math.abs(dx);
        const oy = bi.hh + eb.hh + MARGIN - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox <= oy) ri.x = (ri.x ?? 0) + (dx >= 0 ? ox : -ox);
          else ri.y = (ri.y ?? 0) + (dy >= 0 ? oy : -oy);
          moved = Math.max(moved, Math.min(ox, oy));
        }
      }
      // vs other diamonds — split the push between the two
      for (let j = i + 1; j < relBox.length; j++) {
        const bj = relBox[j];
        const rj = bj.r;
        const dx = (ri.x ?? 0) - (rj.x ?? 0);
        const dy = (ri.y ?? 0) - (rj.y ?? 0);
        const ox = bi.hw + bj.hw + MARGIN - Math.abs(dx);
        const oy = bi.hh + bj.hh + MARGIN - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox <= oy) {
            const push = (dx >= 0 ? ox : -ox) / 2;
            ri.x = (ri.x ?? 0) + push;
            rj.x = (rj.x ?? 0) - push;
          } else {
            const push = (dy >= 0 ? oy : -oy) / 2;
            ri.y = (ri.y ?? 0) + push;
            rj.y = (rj.y ?? 0) - push;
          }
          moved = Math.max(moved, Math.min(ox, oy));
        }
      }
    }
    if (moved < 0.3) break;
  }
}
