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
import type { EREdgeModel, ERNodeModel, ParseResult } from "@app/types";
import { createHeadlessGraph } from "./adapter";

export const CANVAS_W = 1200;
export const CANVAS_H = 800;

export type AttrMode = "auto" | "compact" | "moderate";

export interface Settings {
  colored: boolean;
  comment: boolean;
  hideAttrs: boolean;
  fontScale: number;
  // How attribute ellipses orbit their entity:
  //   auto     — whatever the layout (align/arrange) produced
  //   compact  — reuse the app's show-attributes packer (shortest non-overlapping)
  //   moderate — uniform per-entity radius, evenly distributed, non-overlapping
  attrMode: AttrMode;
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
};

export function clampFontScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(1.6, Math.max(0.4, scale));
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
  layout?: "align" | "arrange" | "none";
}

export function generate(opts: GenerateOptions): State {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) };
  settings.fontScale = clampFontScale(settings.fontScale);
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
  const layout = opts.layout ?? "align";
  if (layout !== "none") {
    forceAlignLayout(graph, CANVAS_W); // deterministic structural seed
    if (layout === "arrange") arrangeLayout(graph);
  }
  const state: State = { version: 1, input: opts.input, format, settings, nodes, edges };
  applyAttrMode(state);
  return state;
}

export function runLayout(state: State, kind: "align" | "arrange"): State {
  const graph = styleAndSize(state.nodes, state.edges, state.settings);
  if (kind === "align") forceAlignLayout(graph, CANVAS_W);
  else arrangeLayout(graph);
  applyAttrMode(state);
  return { ...state };
}

export function setFontScale(state: State, delta: number): State {
  const fontScale = deltaToScale(delta);
  const settings = { ...state.settings, fontScale };
  const next: State = { ...state, settings };
  styleAndSize(next.nodes, next.edges, settings); // re-measures + re-styles in place
  applyAttrMode(next); // keep compact/moderate tidy after a size change
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
  return { ...state };
}

export interface EditResult {
  state: State;
  resolved: { id: string; label: string }[];
}

function resolveNode(state: State, arg: string): ERNodeModel | null {
  const byId = state.nodes.find((n) => n.id === arg);
  if (byId) return byId;
  const low = arg.toLowerCase();
  const ents = state.nodes.filter(
    (n) => n.nodeType === "entity" && String(n.label).toLowerCase() === low,
  );
  if (ents.length === 1) return ents[0];
  // nameLabel fallback (table name even when showing comments)
  const byName = state.nodes.filter(
    (n) =>
      n.nodeType === "entity" &&
      String((n as { nameLabel?: string }).nameLabel ?? "").toLowerCase() === low,
  );
  if (byName.length === 1) return byName[0];
  return null;
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

// moderate: one uniform radius per entity, attributes spread evenly around the
// full circle (same distance for all of an entity's attributes). The whole ring is
// rotated to dodge relationship directions; any attribute that still lands on an
// obstacle (a diamond, another entity, an already-placed attribute) is slid along
// the ring — angle changes, radius stays — so the uniform distance is preserved.
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

  attrsByEntity.forEach((attrs, eid) => {
    const ent = entById.get(eid)!;
    const ecx = ent.x ?? 0;
    const ecy = ent.y ?? 0;
    const entR = radiusOf(ent);
    const maxAttrR = Math.max(...attrs.map(radiusOf));
    const n = attrs.length;

    // Even split of the FULL circle keeps the step (and therefore the radius)
    // small. Radius clears the entity and is large enough that neighbours on the
    // ring don't touch. (Allocating only into the gaps between relationships, as a
    // strict-avoid scheme would, can force a tiny step → huge radius → the ring
    // collides with other clusters. We dodge relationships by phase instead.)
    const step = TAU / n;
    const radial = entR + maxAttrR + 12;
    const tangential = n > 1 ? (maxAttrR + 6) / Math.sin(Math.min(Math.PI / 2, step / 2)) : radial;
    const R = Math.max(radial, tangential);

    // keep attributes near their current angular order to minimise visual jumps
    const sorted = attrs
      .slice()
      .sort(
        (a, b) =>
          normAngle(Math.atan2((a.y ?? 0) - ecy, (a.x ?? 0) - ecx)) -
          normAngle(Math.atan2((b.y ?? 0) - ecy, (b.x ?? 0) - ecx)),
      );

    // pick a rotation phase (within one step) that keeps every slot as far as
    // possible from any relationship direction
    const rels = relAngles.get(eid) ?? [];
    let phase = 0;
    if (rels.length) {
      const TRIES = 24;
      let best = -Infinity;
      for (let t = 0; t < TRIES; t++) {
        const ph = (t / TRIES) * step;
        let minGap = Infinity;
        for (let i = 0; i < n; i++) {
          const slot = normAngle(ph + i * step);
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
    } else if (sorted.length) {
      // no relationships: anchor to the first attribute's current angle
      phase = normAngle(Math.atan2((sorted[0].y ?? 0) - ecy, (sorted[0].x ?? 0) - ecx));
    }

    sorted.forEach((at, i) => {
      const baseAng = phase + i * step;
      const s = measureNodeSize(at);
      // try the even slot, then slide ± along the ring (up to half a step) to clear
      // any obstacle while keeping the radius fixed
      const offsets = [0];
      const SLIDE = 8;
      for (let k = 1; k <= SLIDE; k++) {
        const off = (k / SLIDE) * (step / 2);
        offsets.push(off, -off);
      }
      let bx = ecx + R * Math.cos(baseAng);
      let by = ecy + R * Math.sin(baseAng);
      for (const off of offsets) {
        const ang = baseAng + off;
        const x = ecx + R * Math.cos(ang);
        const y = ecy + R * Math.sin(ang);
        if (!hits(x, y, s.width, s.height, eid)) {
          bx = x;
          by = y;
          break;
        }
      }
      at.x = bx;
      at.y = by;
      obstacles.push({ id: at.id, x: bx, y: by, w: s.width, h: s.height });
    });
  });
}

function applyAttrMode(state: State): void {
  if (state.settings.attrMode === "compact") placeAttributesCompact(state);
  else if (state.settings.attrMode === "moderate") placeAttributesModerate(state);
  // "auto" → leave the layout-native placement untouched
}

export function setAttrMode(state: State, mode: AttrMode): State {
  const settings = { ...state.settings, attrMode: mode };
  const next: State = { ...state, settings };
  styleAndSize(next.nodes, next.edges, settings); // ensure label fontSize for sizing
  applyAttrMode(next);
  return next;
}

function settle(state: State) {
  const graph = styleAndSize(state.nodes, state.edges, state.settings);
  arrangeLayout(graph);
  applyAttrMode(state);
}

export function move(state: State, arg: string, x: number, y: number, raw: boolean): EditResult {
  const node = resolveNode(state, arg);
  if (!node) throw new Error(unresolved(state, arg));
  const dx = x - (typeof node.x === "number" ? node.x : 0);
  const dy = y - (typeof node.y === "number" ? node.y : 0);
  translateCluster(state, node, dx, dy);
  if (!raw) settle(state);
  return { state: { ...state }, resolved: [{ id: node.id, label: String(node.label) }] };
}

export function nudge(state: State, arg: string, dx: number, dy: number, raw: boolean): EditResult {
  const node = resolveNode(state, arg);
  if (!node) throw new Error(unresolved(state, arg));
  translateCluster(state, node, dx, dy);
  if (!raw) settle(state);
  return { state: { ...state }, resolved: [{ id: node.id, label: String(node.label) }] };
}

export function swap(state: State, argA: string, argB: string, raw: boolean): EditResult {
  const a = resolveNode(state, argA);
  const b = resolveNode(state, argB);
  if (!a) throw new Error(unresolved(state, argA));
  if (!b) throw new Error(unresolved(state, argB));
  const ax = typeof a.x === "number" ? a.x : 0;
  const ay = typeof a.y === "number" ? a.y : 0;
  const bx = typeof b.x === "number" ? b.x : 0;
  const by = typeof b.y === "number" ? b.y : 0;
  translateCluster(state, a, bx - ax, by - ay);
  translateCluster(state, b, ax - bx, ay - by);
  if (!raw) settle(state);
  return {
    state: { ...state },
    resolved: [
      { id: a.id, label: String(a.label) },
      { id: b.id, label: String(b.label) },
    ],
  };
}

function unresolved(state: State, arg: string): string {
  const ents = state.nodes.filter((n) => n.nodeType === "entity").map((n) => String(n.label));
  return `Could not resolve "${arg}" to a unique node. Entities: ${ents.join(", ")}. Use an exact node id from describe.`;
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
