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
