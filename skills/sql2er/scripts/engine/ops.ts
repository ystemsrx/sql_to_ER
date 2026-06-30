/**
 * Operations — the agent-facing verbs. Each builds a headless graph from state,
 * mutates it via the REAL app layout/styling functions, and returns the new model.
 *
 * Scope is deliberately agent-shaped: no scroll-zoom, no history, no continuous
 * force loop (an agent adjusts once, not by dragging). The "settle after an edit"
 * step is a single arrangeLayout pass — arrangeLayout refines the *current* coords
 * with deadband springs, so it preserves the agent's coarse intent while fixing
 * attributes / diamonds / overlaps.
 */
import { parseSQLTables } from "@app/parser/sql";
import { parseDBML } from "@app/parser/dbml";
import { generateChenModelData, measureNodeSize } from "@app/builder";
import { forceAlignLayout, arrangeLayout } from "@app/layout";
import { computeAttributePositions } from "@app/attributeLayout";
import { updateGraphStyles } from "@app/graph/updateGraphStyles";
import {
  applyNodePositionTargets,
  computeAttributeRotationTargets,
  computeMovedEntityRelationshipTargets,
} from "@app/graph/entityMoveSync";
import { computeAutoAvoidTargets } from "@app/graph/autoAvoid";
import type { EREdgeModel, ERNodeModel, ParseResult } from "@app/types";
import { createHeadlessGraph } from "./adapter";
import { stressLayout, ringRadiusFor } from "./skeleton";

export type LayoutKind = "optimal" | "arrange" | "none";

export const CANVAS_W = 1200;
export const CANVAS_H = 800;

export type AttrMode = "auto" | "compact" | "moderate";

export interface Settings {
  colored: boolean;
  comment: boolean;
  hideAttrs: boolean;
  fontScale: number;
  // How attribute ellipses orbit their entity:
  //   auto     — whatever the active layout produced
  //   compact  — reuse the app's show-attributes packer (shortest non-overlapping)
  //   moderate — one uniform ring (every attribute the same distance from the entity)
  attrMode: AttrMode;
  autoAvoid: boolean;
}

export interface State {
  version: 1;
  input: string;
  format: "sql" | "dbml";
  settings: Settings;
  nodes: ERNodeModel[];
  edges: EREdgeModel[];
}

export const DEFAULT_SETTINGS: Settings = {
  colored: true,
  comment: false,
  hideAttrs: false,
  fontScale: 1,
  attrMode: "auto",
  autoAvoid: true,
};

export function clampFontScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(1.6, Math.max(0.4, scale));
}

function normalizeSettings(settings: Settings): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    fontScale: clampFontScale(settings.fontScale),
    autoAvoid: settings.autoAvoid !== false,
  };
}

/** delta (0 = default) → font scale. ±1 ≈ ±0.1; clamped to the app's 0.4–1.6. */
export function deltaToScale(delta: number): number {
  return clampFontScale(1 + (Number.isFinite(delta) ? delta : 0) * 0.1);
}

export function parseInput(
  text: string,
  format: "sql" | "dbml" | "auto",
): { result: ParseResult; format: "sql" | "dbml" } {
  const trimmed = String(text || "").trim();
  if (format === "sql") return { result: parseSQLTables(trimmed), format: "sql" };
  if (format === "dbml") return { result: parseDBML(trimmed), format: "dbml" };
  const sql = parseSQLTables(trimmed);
  if (sql.tables.length > 0) return { result: sql, format: "sql" };
  return { result: parseDBML(trimmed), format: "dbml" };
}

function styleAndSize(nodes: ERNodeModel[], edges: EREdgeModel[], settings: Settings) {
  const graph = createHeadlessGraph(nodes, edges, CANVAS_W, CANVAS_H);
  updateGraphStyles(graph, settings.colored, clampFontScale(settings.fontScale));
  return graph;
}

export interface GenerateOptions {
  input: string;
  format?: "sql" | "dbml" | "auto";
  settings?: Partial<Settings>;
  layout?: LayoutKind;
}

// Run a layout on a styled graph. `optimal` force-aligns as a deterministic seed,
// then stress-spaces the skeleton (room for attribute rings). `arrange` settles the
// current positions only, so manual edits keep their coarse structure.
function runLayoutOnGraph(
  kind: LayoutKind,
  graph: ReturnType<typeof styleAndSize>,
  nodes: ERNodeModel[],
  edges: EREdgeModel[],
): void {
  if (kind === "none") return;
  if (kind === "optimal") {
    forceAlignLayout(graph, CANVAS_W);
    stressLayout(nodes, edges);
  } else if (kind === "arrange") {
    arrangeLayout(graph);
  }
}

export function generate(opts: GenerateOptions): State {
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) });
  const { result, format } = parseInput(opts.input, opts.format ?? "auto");
  if (!result.tables.length) {
    throw new Error("No tables parsed from input (tried " + (opts.format ?? "auto") + ").");
  }
  const { nodes, edges } = generateChenModelData(
    result.tables,
    result.relationships,
    settings.colored,
    settings.comment ? "comment" : "name",
    settings.hideAttrs,
  );
  const graph = styleAndSize(nodes, edges, settings);
  const layout = opts.layout ?? "optimal";
  runLayoutOnGraph(layout, graph, nodes, edges);
  // `optimal` reserves ring room; fill it with uniform rings unless compact is chosen
  if (layout === "optimal" && settings.attrMode === "auto") settings.attrMode = "moderate";
  const state: State = { version: 1, input: opts.input, format, settings, nodes, edges };
  applyAttrMode(state);
  if (layout === "optimal") tightenCompact(state);
  applyAutoAvoid(state);
  return state;
}

export function runLayout(state: State, kind: LayoutKind): State {
  state.settings = normalizeSettings(state.settings);
  const graph = styleAndSize(state.nodes, state.edges, state.settings);
  runLayoutOnGraph(kind, graph, state.nodes, state.edges);
  if (kind === "optimal" && state.settings.attrMode === "auto")
    state.settings.attrMode = "moderate";
  applyAttrMode(state);
  if (kind === "optimal") tightenCompact(state);
  applyAutoAvoid(state);
  return { ...state };
}

export function setFontScale(state: State, delta: number): State {
  state.settings = normalizeSettings(state.settings);
  const fontScale = deltaToScale(delta);
  const settings = { ...state.settings, fontScale };
  const next: State = { ...state, settings };
  styleAndSize(next.nodes, next.edges, settings); // re-measures + re-styles in place
  applyAttrMode(next); // keep compact/moderate tidy after a size change
  applyAutoAvoid(next);
  return next;
}

function centroid(nodes: ERNodeModel[]): { cx: number; cy: number } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  nodes.forEach((n) => {
    const x = typeof n.x === "number" ? n.x : 0;
    const y = typeof n.y === "number" ? n.y : 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

export function rotate(state: State, degrees: number): State {
  state.settings = normalizeSettings(state.settings);
  const theta = ((Number(degrees) || 0) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const { cx, cy } = centroid(state.nodes);
  state.nodes.forEach((n) => {
    const x = typeof n.x === "number" ? n.x : 0;
    const y = typeof n.y === "number" ? n.y : 0;
    const dx = x - cx;
    const dy = y - cy;
    n.x = cx + dx * cos - dy * sin;
    n.y = cy + dx * sin + dy * cos;
  });
  applyAutoAvoid(state);
  return { ...state };
}

export interface EditResult {
  state: State;
  resolved: { id: string; label: string }[];
  warnings?: string[];
}

export type LabelMode = "name" | "comment";

export interface LabelEditResult {
  state: State;
  resolved: { id: string; label: string }[];
}

type LabelNode = ERNodeModel & {
  nameLabel?: string;
  commentLabel?: string;
  manualLabel?: string;
};

const currentLabelMode = (state: State): LabelMode => (state.settings.comment ? "comment" : "name");

function ensureBaseLabels(node: LabelNode): void {
  const current = String(node.label ?? node.id);
  if (node.nameLabel === undefined) node.nameLabel = current;
  if (node.commentLabel === undefined) node.commentLabel = node.nameLabel;
}

function baseLabelFor(node: LabelNode, mode: LabelMode): string {
  ensureBaseLabels(node);
  if (mode === "comment")
    return String(node.commentLabel || node.nameLabel || node.label || node.id);
  return String(node.nameLabel || node.label || node.id);
}

function applyLabelsByMode(state: State): void {
  const mode = currentLabelMode(state);
  state.nodes.forEach((node) => {
    const n = node as LabelNode;
    n.label = typeof n.manualLabel === "string" ? n.manualLabel : baseLabelFor(n, mode);
  });
}

function restyleAfterLabelEdit(state: State): void {
  state.settings = normalizeSettings(state.settings);
  styleAndSize(state.nodes, state.edges, state.settings);
  applyAttrMode(state);
  applyAutoAvoid(state);
}

function resolveNodeById(state: State, id: string): LabelNode {
  const node = state.nodes.find((n) => n.id === id) as LabelNode | undefined;
  if (!node)
    throw new Error(`Could not resolve "${id}" to a node id. Use an exact id from describe.`);
  return node;
}

function nodeKind(node: ERNodeModel): string {
  if (node.nodeType === "attribute") return "attribute ellipse";
  if (node.nodeType === "relationship") return "relationship diamond";
  if (node.nodeType === "entity") return "entity rectangle";
  return String(node.nodeType ?? "node");
}

export function setLabel(state: State, id: string, label: string): LabelEditResult {
  const node = resolveNodeById(state, id);
  ensureBaseLabels(node);
  node.manualLabel = label;
  node.label = label;
  restyleAfterLabelEdit(state);
  return { state: { ...state }, resolved: [{ id: node.id, label }] };
}

export function setLabels(state: State, labels: Record<string, string>): LabelEditResult {
  const entries = Object.entries(labels);
  if (!entries.length) throw new Error("labels batch requires at least one id:label entry.");
  const nodes = entries.map(([id, label]) => {
    if (typeof label !== "string") throw new Error(`Label for "${id}" must be a string.`);
    return [resolveNodeById(state, id), label] as const;
  });
  nodes.forEach(([node, label]) => {
    ensureBaseLabels(node);
    node.manualLabel = label;
    node.label = label;
  });
  restyleAfterLabelEdit(state);
  return {
    state: { ...state },
    resolved: nodes.map(([node]) => ({ id: node.id, label: String(node.label ?? "") })),
  };
}

export function resetLabels(state: State, idOrAll: string): LabelEditResult {
  const nodes =
    idOrAll === "all" ? (state.nodes as LabelNode[]) : [resolveNodeById(state, idOrAll)];
  nodes.forEach((node) => {
    delete node.manualLabel;
    node.label = baseLabelFor(node, currentLabelMode(state));
  });
  restyleAfterLabelEdit(state);
  return {
    state: { ...state },
    resolved: nodes.map((node) => ({ id: node.id, label: String(node.label ?? "") })),
  };
}

export function setLabelMode(state: State, mode: LabelMode): LabelEditResult {
  state.settings = { ...state.settings, comment: mode === "comment" };
  applyLabelsByMode(state);
  restyleAfterLabelEdit(state);
  return {
    state: { ...state },
    resolved: state.nodes.map((node) => ({ id: node.id, label: String(node.label ?? "") })),
  };
}

function translateCluster(state: State, node: ERNodeModel, dx: number, dy: number) {
  node.x = (typeof node.x === "number" ? node.x : 0) + dx;
  node.y = (typeof node.y === "number" ? node.y : 0) + dy;
  if (node.nodeType === "entity") {
    // keep owned attribute satellites attached during a raw move
    state.nodes.forEach((n) => {
      if (n.nodeType === "attribute" && n.parentEntity === node.id) {
        n.x = (typeof n.x === "number" ? n.x : 0) + dx;
        n.y = (typeof n.y === "number" ? n.y : 0) + dy;
      }
    });
  }
}

function captureNodePositions(nodes: ERNodeModel[]): Map<string, { x: number; y: number }> {
  return new Map(
    nodes.map((node) => [
      node.id,
      {
        x: typeof node.x === "number" ? node.x : 0,
        y: typeof node.y === "number" ? node.y : 0,
      },
    ]),
  );
}

function syncMovedEntities(
  state: State,
  entityIds: string[],
  startPositions: Map<string, { x: number; y: number }>,
): void {
  const { relationshipTargets, affectedEntityIds } = computeMovedEntityRelationshipTargets(
    state.nodes,
    state.edges,
    entityIds,
    measureNodeSize,
    startPositions,
  );
  applyNodePositionTargets(state.nodes, relationshipTargets);
  const attrTargets = computeAttributeRotationTargets(
    state.nodes,
    state.edges,
    affectedEntityIds,
    measureNodeSize,
  );
  applyNodePositionTargets(state.nodes, attrTargets);
}

// ─── Attribute orbit modes ───────────────────────────────────────────────
const TAU = Math.PI * 2;
const normAngle = (a: number): number => {
  let x = a % TAU;
  if (x < 0) x += TAU;
  return x;
};

// compact: reuse the app's show-attributes packer. It places each attribute at
// the shortest radius that avoids every node and edge, hugging the entity. We
// feed it a skeleton-only graph (entities + relationships) as the obstacle set
// and the attribute models as the nodes to place; it writes x/y onto them.
function placeAttributesCompact(state: State): void {
  const attrs = state.nodes.filter((n) => n.nodeType === "attribute");
  if (!attrs.length) return;
  const skeleton = state.nodes.filter((n) => n.nodeType !== "attribute");
  const graph = createHeadlessGraph(skeleton, state.edges, CANVAS_W, CANVAS_H);
  computeAttributePositions(
    graph,
    attrs as unknown as Parameters<typeof computeAttributePositions>[1],
  );
}

// moderate: a single uniform ring per entity — every attribute the same distance
// from the entity (the defining property). The radius is the smallest that fits all
// attributes side by side using variable angular widths (wide ones get more arc), so
// the footprint is as small as a uniform distance allows. The ring is rotated to
// dodge relationship directions, and each attribute slides only WITHIN its own slot
// (angle changes, radius fixed) to clear obstacles and relationship lines.
function placeAttributesModerate(state: State): void {
  const entById = new Map(state.nodes.filter((n) => n.nodeType === "entity").map((e) => [e.id, e]));
  const relById = new Map(
    state.nodes.filter((n) => n.nodeType === "relationship").map((r) => [r.id, r]),
  );

  const attrsByEntity = new Map<string, ERNodeModel[]>();
  state.nodes.forEach((n) => {
    if (
      n.nodeType === "attribute" &&
      typeof n.parentEntity === "string" &&
      entById.has(n.parentEntity)
    ) {
      if (!attrsByEntity.has(n.parentEntity)) attrsByEntity.set(n.parentEntity, []);
      attrsByEntity.get(n.parentEntity)!.push(n);
    }
  });

  // relationship directions to avoid, per entity
  const relAngles = new Map<string, number[]>();
  state.edges.forEach((e) => {
    if (e.edgeType !== "entity-relationship" && e.edgeType !== "relationship-entity") return;
    const entId = entById.has(e.source) ? e.source : entById.has(e.target) ? e.target : null;
    const relId = relById.has(e.source) ? e.source : relById.has(e.target) ? e.target : null;
    if (!entId || !relId) return;
    const en = entById.get(entId)!;
    const rn = relById.get(relId)!;
    const ang = normAngle(Math.atan2((rn.y ?? 0) - (en.y ?? 0), (rn.x ?? 0) - (en.x ?? 0)));
    if (!relAngles.has(entId)) relAngles.set(entId, []);
    relAngles.get(entId)!.push(ang);
  });

  const radiusOf = (m: ERNodeModel) => {
    const s = measureNodeSize(m);
    return Math.hypot(s.width, s.height) / 2;
  };

  // global obstacle set (AABB): entities + relationship diamonds, plus attributes
  // as they are placed. Used to slide an attribute off anything it lands on.
  interface Obstacle {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const obstacles: Obstacle[] = [];
  state.nodes.forEach((n) => {
    if (n.nodeType === "entity" || n.nodeType === "relationship") {
      const s = measureNodeSize(n);
      obstacles.push({ id: n.id, x: n.x ?? 0, y: n.y ?? 0, w: s.width, h: s.height });
    }
  });
  const hits = (x: number, y: number, w: number, h: number, skipId: string) =>
    obstacles.some(
      (o) =>
        o.id !== skipId &&
        Math.abs(x - o.x) < (w + o.w) / 2 - 2 &&
        Math.abs(y - o.y) < (h + o.h) / 2 - 2,
    );

  // relationship edge segments (entity↔diamond, centre-to-centre) so an attribute
  // connector isn't placed across a relationship line.
  const centre = new Map<string, { x: number; y: number }>();
  state.nodes.forEach((n) => {
    if (n.nodeType === "entity" || n.nodeType === "relationship")
      centre.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
  });
  const relSegs: {
    s: { x: number; y: number };
    t: { x: number; y: number };
    a: string;
    b: string;
  }[] = [];
  state.edges.forEach((e) => {
    if (e.edgeType === "entity-relationship" || e.edgeType === "relationship-entity") {
      const s = centre.get(e.source);
      const t = centre.get(e.target);
      if (s && t) relSegs.push({ s, t, a: e.source, b: e.target });
    }
  });
  type P = { x: number; y: number };
  const properCross = (a1: P, a2: P, b1: P, b2: P) => {
    const eq = (p: P, q: P) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
    if (eq(a1, b1) || eq(a1, b2) || eq(a2, b1) || eq(a2, b2)) return false;
    const c = (o: P, p: P, q: P) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
    const d1 = c(b1, b2, a1);
    const d2 = c(b1, b2, a2);
    const d3 = c(a1, a2, b1);
    const d4 = c(a1, a2, b2);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  const connectorCrosses = (ex: number, ey: number, x: number, y: number, eid: string) =>
    relSegs.some(
      (seg) =>
        seg.a !== eid && seg.b !== eid && properCross({ x: ex, y: ey }, { x, y }, seg.s, seg.t),
    );
  // a relationship line passing THROUGH the attribute's box (segment vs AABB, Liang–
  // Barsky). Checks ALL relationship lines, incident ones included: an attribute placed
  // in the direction of its own entity's relationship would be pierced by that line.
  const segHitsBox = (p1: P, p2: P, bx: number, by: number, bw: number, bh: number): boolean => {
    const minx = bx - bw / 2;
    const maxx = bx + bw / 2;
    const miny = by - bh / 2;
    const maxy = by + bh / 2;
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
  const boxPierced = (x: number, y: number, w: number, h: number) =>
    relSegs.some((seg) => segHitsBox(seg.s, seg.t, x, y, w, h));

  const angleOf = (m: ERNodeModel, cx: number, cy: number) =>
    normAngle(Math.atan2((m.y ?? 0) - cy, (m.x ?? 0) - cx));

  // crowded entities first so they claim space before sparse ones
  const order = [...attrsByEntity.keys()].sort(
    (a, b) => (attrsByEntity.get(b)?.length ?? 0) - (attrsByEntity.get(a)?.length ?? 0),
  );

  order.forEach((eid) => {
    const attrs = attrsByEntity.get(eid)!;
    const ent = entById.get(eid)!;
    const ecx = ent.x ?? 0;
    const ecy = ent.y ?? 0;
    const entR = radiusOf(ent);
    const rels = relAngles.get(eid) ?? [];
    const GAP = 8;

    const items = attrs.map((at) => {
      const s = measureNodeSize(at);
      return { at, s, half: Math.max(s.width, s.height) / 2 };
    });
    const n = items.length;
    const maxHalf = Math.max(...items.map((it) => it.half));

    // ONE uniform ring: every attribute the SAME distance R from the entity. Pick
    // the smallest R that fits them side by side, giving each a variable angular
    // width (wide attributes get more arc, narrow ones pack tight) so the radius —
    // and therefore the footprint — is as small as a uniform distance allows.
    const angWidth = (half: number, R: number) =>
      2 * Math.asin(Math.min(0.999, (half + GAP / 2) / R));
    const angularSum = (R: number) => items.reduce((s, it) => s + angWidth(it.half, R), 0);
    const radialMin = entR + maxHalf + GAP;
    const target = TAU * 0.92; // leave slack for relationship gaps / jitter
    let lo = radialMin;
    let hi = radialMin;
    while (angularSum(hi) > target && hi < radialMin + 6000) hi *= 1.5;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (angularSum(mid) <= target) hi = mid;
      else lo = mid;
    }
    const R = hi;

    // order by current angle; give each a centred slot of its angular width plus an
    // even share of the leftover gap
    const ordered = items.slice().sort((a, b) => angleOf(a.at, ecx, ecy) - angleOf(b.at, ecx, ecy));
    const widths = ordered.map((it) => angWidth(it.half, R));
    const slack = Math.max(0, TAU - widths.reduce((s, w) => s + w, 0)) / Math.max(1, n);
    const baseAngles: number[] = [];
    let acc = 0;
    for (let i = 0; i < ordered.length; i++) {
      acc += slack / 2 + widths[i] / 2;
      baseAngles.push(acc);
      acc += widths[i] / 2 + slack / 2;
    }

    // rotate the whole ring to keep attribute centres away from relationship dirs
    let phase = ordered.length ? angleOf(ordered[0].at, ecx, ecy) - baseAngles[0] : 0;
    if (rels.length) {
      const TRIES = 36;
      let best = -Infinity;
      for (let t = 0; t < TRIES; t++) {
        const ph = (t / TRIES) * TAU;
        let minGap = Infinity;
        for (const ba of baseAngles) {
          const slot = normAngle(ph + ba);
          for (const r of rels) {
            let d = Math.abs(slot - r);
            d = Math.min(d, TAU - d);
            if (d < minGap) minGap = d;
          }
        }
        if (minGap > best) {
          best = minGap;
          phase = ph;
        }
      }
    }

    // place at uniform R; slide WITHIN the slot (angle only, R fixed → distance stays
    // uniform) to dodge obstacles and connector-crossings
    ordered.forEach((it, i) => {
      const baseAng = phase + baseAngles[i];
      const win = widths[i] / 2 + slack; // can drift into the adjacent gap
      const offsets = [0];
      const SLIDE = 10;
      for (let k = 1; k <= SLIDE; k++) {
        const off = (k / SLIDE) * win;
        offsets.push(off, -off);
      }
      let bx = ecx + R * Math.cos(baseAng);
      let by = ecy + R * Math.sin(baseAng);
      let placed = false;
      for (const off of offsets) {
        const a2 = baseAng + off;
        const x = ecx + R * Math.cos(a2);
        const y = ecy + R * Math.sin(a2);
        if (
          !hits(x, y, it.s.width, it.s.height, eid) &&
          !connectorCrosses(ecx, ecy, x, y, eid) &&
          !boxPierced(x, y, it.s.width, it.s.height)
        ) {
          bx = x;
          by = y;
          placed = true;
          break;
        }
      }
      // pass 2: settle for clear-of-obstacles, sliding a bit further within the ring
      // (still angle-only, so distance stays uniform)
      if (!placed)
        for (const off of offsets) {
          const a2 = baseAng + off;
          const x = ecx + R * Math.cos(a2);
          const y = ecy + R * Math.sin(a2);
          if (!hits(x, y, it.s.width, it.s.height, eid)) {
            bx = x;
            by = y;
            break;
          }
        }
      it.at.x = bx;
      it.at.y = by;
      obstacles.push({ id: it.at.id, x: bx, y: by, w: it.s.width, h: it.s.height });
    });
  });

  // per-ellipse escape: if a relationship line still passes through an attribute, its
  // connector crosses a relationship line, or it overlaps a node, THAT one ellipse
  // leaves the uniform ring and takes the nearest clear spot. Every other attribute
  // keeps its ring position.
  const obById = new Map(obstacles.map((o) => [o.id, o]));
  state.nodes.forEach((at) => {
    if (at.nodeType !== "attribute" || typeof at.parentEntity !== "string") return;
    const ent = entById.get(at.parentEntity);
    if (!ent) return;
    const s = measureNodeSize(at);
    const cx = at.x ?? 0;
    const cy = at.y ?? 0;
    if (
      !boxPierced(cx, cy, s.width, s.height) &&
      !hits(cx, cy, s.width, s.height, at.id) &&
      !connectorCrosses(ent.x ?? 0, ent.y ?? 0, cx, cy, at.parentEntity)
    )
      return;
    const ecx = ent.x ?? 0;
    const ecy = ent.y ?? 0;
    const half = Math.max(s.width, s.height) / 2;
    const curR = Math.hypot(cx - ecx, cy - ecy) || radiusOf(ent) + half;
    const curAng = normAngle(Math.atan2(cy - ecy, cx - ecx));
    let best: { x: number; y: number; d: number } | null = null;
    const clearCandidate = (x: number, y: number): boolean =>
      !hits(x, y, s.width, s.height, at.id) &&
      !boxPierced(x, y, s.width, s.height) &&
      !connectorCrosses(ecx, ecy, x, y, at.parentEntity);
    const consider = (x: number, y: number): void => {
      if (!clearCandidate(x, y)) return;
      const d = Math.hypot(x - cx, y - cy);
      if (!best || d < best.d) best = { x, y, d };
    };

    const localStep = Math.max(6, Math.min(12, half / 4));
    const localMax = Math.max(220, half * 8);
    for (let r = localStep; r <= localMax; r += localStep) {
      const steps = Math.max(24, Math.ceil((TAU * r) / localStep));
      for (let k = 0; k < steps; k++) {
        const ang = (k / steps) * TAU;
        consider(cx + r * Math.cos(ang), cy + r * Math.sin(ang));
      }
      if (best && best.d + localStep < r) break;
    }

    for (let dr = 0; dr <= 8; dr++) {
      const R2 = curR + dr * (half * 0.6 + 6);
      const steps = Math.max(36, Math.round((TAU * R2) / (half + 6)));
      for (let k = 0; k < steps; k++) {
        const ang = curAng + (k / steps) * TAU;
        const x = ecx + R2 * Math.cos(ang);
        const y = ecy + R2 * Math.sin(ang);
        consider(x, y);
      }
    }
    if (best) {
      at.x = best.x;
      at.y = best.y;
      const ob = obById.get(at.id);
      if (ob) {
        ob.x = best.x;
        ob.y = best.y;
      }
    }
  });
}

function applyAttrMode(state: State): void {
  if (state.settings.attrMode === "compact") placeAttributesCompact(state);
  else if (state.settings.attrMode === "moderate") placeAttributesModerate(state);
  // "auto" → leave the layout-native placement untouched
}

function applyAutoAvoid(state: State): void {
  state.settings = normalizeSettings(state.settings);
  if (!state.settings.autoAvoid) return;
  const targets = computeAutoAvoidTargets(state.nodes, measureNodeSize, { edges: state.edges });
  applyNodePositionTargets(state.nodes, targets);
}

// Per-entity ring radius for the compact re-layout, measured from the CURRENT (compact)
// positions: the farthest attribute centre, but CLAMPED to the moderate ring so the
// override can only ever TIGHTEN the skeleton, never spread it. (Compact greedily pushes
// some attributes out past the moderate uniform ring; reserving that max would enlarge
// the diagram — the opposite of the goal.)
function measuredRingRadii(state: State): Map<string, number> {
  const attrsBy = new Map<string, ERNodeModel[]>();
  state.nodes.forEach((n) => {
    if (n.nodeType === "attribute" && typeof n.parentEntity === "string") {
      if (!attrsBy.has(n.parentEntity)) attrsBy.set(n.parentEntity, []);
      attrsBy.get(n.parentEntity)!.push(n);
    }
  });
  const radii = new Map<string, number>();
  state.nodes.forEach((e) => {
    if (e.nodeType !== "entity") return;
    const ex = e.x ?? 0;
    const ey = e.y ?? 0;
    const es = measureNodeSize(e);
    let maxR = Math.hypot(es.width, es.height) / 2;
    (attrsBy.get(e.id) ?? []).forEach((a) => {
      maxR = Math.max(maxR, Math.hypot((a.x ?? 0) - ex, (a.y ?? 0) - ey));
    });
    const moderateR = ringRadiusFor(e, attrsBy.get(e.id) ?? []);
    radii.set(e.id, Math.min(maxR, moderateR));
  });
  return radii;
}

// Compact diagrams: the skeleton is first sized for the moderate ring, so it leaves big
// gaps (compact hugs the entity). Measure compact's ACTUAL ring, re-lay out the skeleton
// tight to it, and re-place. One extra pass — compact placement is overlap-free by
// construction (the app packer clears nodes and edges), so the tighter skeleton stays clean.
function tightenCompact(state: State): void {
  if (state.settings.attrMode !== "compact") return;
  const radii = measuredRingRadii(state);
  stressLayout(state.nodes, state.edges, radii);
  applyAttrMode(state);
}

export function setAttrMode(state: State, mode: AttrMode): State {
  state.settings = normalizeSettings(state.settings);
  const settings = { ...state.settings, attrMode: mode };
  const next: State = { ...state, settings };
  styleAndSize(next.nodes, next.edges, settings); // ensure label fontSize for sizing
  applyAttrMode(next);
  applyAutoAvoid(next);
  return next;
}

function settle(state: State) {
  state.settings = normalizeSettings(state.settings);
  const graph = styleAndSize(state.nodes, state.edges, state.settings);
  arrangeLayout(graph);
  applyAttrMode(state);
  applyAutoAvoid(state);
}

export function setAutoAvoid(state: State, enabled: boolean): State {
  state.settings = normalizeSettings({ ...state.settings, autoAvoid: enabled });
  if (enabled) applyAutoAvoid(state);
  return { ...state };
}

export function move(state: State, arg: string, x: number, y: number, raw: boolean): EditResult {
  const node = resolveNodeById(state, arg);
  const startPositions = captureNodePositions(state.nodes);
  const dx = x - (typeof node.x === "number" ? node.x : 0);
  const dy = y - (typeof node.y === "number" ? node.y : 0);
  translateCluster(state, node, dx, dy);
  if (node.nodeType === "entity") syncMovedEntities(state, [node.id], startPositions);
  if (!raw) settle(state);
  return { state: { ...state }, resolved: [{ id: node.id, label: String(node.label) }] };
}

export function nudge(state: State, arg: string, dx: number, dy: number, raw: boolean): EditResult {
  const node = resolveNodeById(state, arg);
  const startPositions = captureNodePositions(state.nodes);
  translateCluster(state, node, dx, dy);
  if (node.nodeType === "entity") syncMovedEntities(state, [node.id], startPositions);
  if (!raw) settle(state);
  return { state: { ...state }, resolved: [{ id: node.id, label: String(node.label) }] };
}

export function swap(state: State, argA: string, argB: string, raw: boolean): EditResult {
  const a = resolveNodeById(state, argA);
  const b = resolveNodeById(state, argB);
  const nonEntities = [a, b].filter((node) => node.nodeType !== "entity");
  if (nonEntities.length) {
    const names = nonEntities.map((node) => `${node.id} (${nodeKind(node)})`).join(", ");
    return {
      state: { ...state },
      resolved: [],
      warnings: [`swap only supports entity rectangles; skipped ${names}. No changes made.`],
    };
  }
  const ax = typeof a.x === "number" ? a.x : 0;
  const ay = typeof a.y === "number" ? a.y : 0;
  const bx = typeof b.x === "number" ? b.x : 0;
  const by = typeof b.y === "number" ? b.y : 0;
  const startPositions = captureNodePositions(state.nodes);
  translateCluster(state, a, bx - ax, by - ay);
  translateCluster(state, b, ax - bx, ay - by);
  syncMovedEntities(state, [a.id, b.id], startPositions);
  if (!raw) settle(state);
  return {
    state: { ...state },
    resolved: [
      { id: a.id, label: String(a.label) },
      { id: b.id, label: String(b.label) },
    ],
  };
}

/**
 * Split a graph into one sub-state per connected component (entities linked via
 * relationships). A schema with several unrelated tables/clusters becomes several
 * independent diagrams. Each component keeps its absolute positions, so exporters
 * frame it on its own bbox — no re-layout needed.
 */
export interface Component {
  name: string;
  state: State;
}

export function splitComponents(state: State): Component[] {
  const entities = state.nodes.filter((n) => n.nodeType === "entity");
  const rels = state.nodes.filter((n) => n.nodeType === "relationship");

  // relationship -> the entity ids it connects, from the two ER edges
  const relEnts = new Map<string, string[]>();
  rels.forEach((r) => relEnts.set(r.id, []));
  state.edges.forEach((e) => {
    if (e.edgeType === "entity-relationship" && relEnts.has(e.target))
      relEnts.get(e.target)!.push(e.source);
    if (e.edgeType === "relationship-entity" && relEnts.has(e.source))
      relEnts.get(e.source)!.push(e.target);
  });

  // entity adjacency (binary relationships connect their two entities)
  const adj = new Map<string, Set<string>>();
  entities.forEach((e) => adj.set(e.id, new Set()));
  relEnts.forEach((ids) => {
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        if (adj.has(uniq[i]) && adj.has(uniq[j])) {
          adj.get(uniq[i])!.add(uniq[j]);
          adj.get(uniq[j])!.add(uniq[i]);
        }
      }
    }
  });

  // connected components over entities (stable order)
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

  const usedNames = new Map<string, number>();
  const nameFor = (entIds: string[]): string => {
    // representative = highest-degree entity (tie → alphabetical by table name)
    const labelOf = (id: string) => {
      const n = state.nodes.find((x) => x.id === id);
      return String((n as { nameLabel?: string })?.nameLabel ?? n?.label ?? id);
    };
    const rep = entIds
      .slice()
      .sort(
        (a, b) =>
          (adj.get(b)?.size ?? 0) - (adj.get(a)?.size ?? 0) || labelOf(a).localeCompare(labelOf(b)),
      )[0];
    let base = labelOf(rep)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!base) base = "component";
    const n = usedNames.get(base) ?? 0;
    usedNames.set(base, n + 1);
    return n === 0 ? base : `${base}_${n + 1}`;
  };

  return comps.map((entIds) => {
    const entSet = new Set(entIds);
    // relationships whose connected entities are all within this component
    const relIds = new Set(
      rels
        .filter((r) => {
          const ids = [...new Set(relEnts.get(r.id) ?? [])];
          return ids.length > 0 && ids.every((id) => entSet.has(id));
        })
        .map((r) => r.id),
    );
    const nodeSet = new Set<string>([...entSet, ...relIds]);
    state.nodes.forEach((n) => {
      if (n.nodeType === "attribute" && n.parentEntity && entSet.has(n.parentEntity))
        nodeSet.add(n.id);
    });
    const nodes = state.nodes.filter((n) => nodeSet.has(n.id));
    const edges = state.edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target));
    return { name: nameFor(entIds), state: { ...state, nodes, edges } };
  });
}
