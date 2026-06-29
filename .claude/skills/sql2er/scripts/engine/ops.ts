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
import { generateChenModelData } from "@app/builder";
import { forceAlignLayout, arrangeLayout } from "@app/layout";
import { updateGraphStyles } from "@app/graph/updateGraphStyles";
import type { EREdgeModel, ERNodeModel, ParseResult } from "@app/types";
import { createHeadlessGraph } from "./adapter";

export const CANVAS_W = 1200;
export const CANVAS_H = 800;

export interface Settings {
  colored: boolean;
  comment: boolean;
  hideAttrs: boolean;
  fontScale: number;
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
  return { version: 1, input: opts.input, format, settings, nodes, edges };
}

export function runLayout(state: State, kind: "align" | "arrange"): State {
  const graph = styleAndSize(state.nodes, state.edges, state.settings);
  if (kind === "align") forceAlignLayout(graph, CANVAS_W);
  else arrangeLayout(graph);
  return { ...state };
}

export function setFontScale(state: State, delta: number): State {
  const fontScale = deltaToScale(delta);
  const settings = { ...state.settings, fontScale };
  styleAndSize(state.nodes, state.edges, settings); // re-measures + re-styles in place
  return { ...state, settings };
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

function settle(state: State) {
  const graph = styleAndSize(state.nodes, state.edges, state.settings);
  arrangeLayout(graph);
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
