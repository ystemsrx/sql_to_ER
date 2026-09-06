import type { EREdgeModel, ERNodeModel, LabelConfig, ShapeStyle, ParserWarning } from "@app/types";
import type { State } from "./ops";

// Generous canvas bounds, still far below unsafe integer/grid arithmetic.
export const MAX_COORDINATE = 1_000_000;
type ObjectValue = Record<string, unknown>;
const fail = (path: string): never => {
  throw new Error(`Invalid state: ${path}`);
};
const object = (value: unknown, path: string): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path);
  return value as ObjectValue;
};
const text = (value: unknown, path: string, limit = 10_000): string => {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    fail(path);
  return value as string;
};
const number = (value: unknown, path: string, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    fail(`${path} must be a number in [${min}, ${max}]`);
  return value as number;
};
export function assertCoordinate(value: unknown, path: string): asserts value is number {
  number(value, path, -MAX_COORDINATE, MAX_COORDINATE);
}
const bool = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") fail(path);
  return value as boolean;
};
const choice = <T extends string>(value: unknown, path: string, allowed: readonly T[]): T => {
  if (!allowed.includes(value as T)) fail(path);
  return value as T;
};
const array = (value: unknown, path: string, limit: number): unknown[] => {
  if (!Array.isArray(value) || value.length > limit) fail(path);
  return value as unknown[];
};
const color = (value: unknown, path: string): string => {
  const s = text(value, path, 128);
  // Paint servers / URLs and CSS declarations are never part of a graph color.
  if (!/^(?:#[\da-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d.,%+\-\s]+\))$/i.test(s)) fail(path);
  return s;
};
function shape(value: unknown, path: string): ShapeStyle | undefined {
  if (value === undefined) return undefined;
  const v = object(value, path);
  const out: ShapeStyle = {};
  for (const key of ["fill", "stroke", "shadowColor"] as const) {
    if (v[key] !== undefined) out[key] = color(v[key], `${path}.${key}`);
  }
  for (const key of ["lineWidth", "radius", "shadowBlur"] as const) {
    if (v[key] !== undefined) out[key] = number(v[key], `${path}.${key}`, 0, 512);
  }
  if (v.lineDash !== undefined)
    out.lineDash = array(v.lineDash, path, 16).map((n) => number(n, `${path}.lineDash`, 0, 512));
  if (v.endArrow !== undefined) out.endArrow = bool(v.endArrow, `${path}.endArrow`);
  return out;
}
function labelConfig(value: unknown, path: string): LabelConfig | undefined {
  if (value === undefined) return undefined;
  const outer = object(value, path);
  if (outer.style === undefined) return {};
  const v = object(outer.style, `${path}.style`);
  const style: NonNullable<LabelConfig["style"]> = {};
  if (v.fill !== undefined) style.fill = color(v.fill, `${path}.fill`);
  if (v.fontSize !== undefined) style.fontSize = number(v.fontSize, `${path}.fontSize`, 1, 512);
  if (v.fontWeight !== undefined) {
    if (typeof v.fontWeight === "number")
      style.fontWeight = number(v.fontWeight, `${path}.fontWeight`, 1, 1000);
    else {
      const weight = text(v.fontWeight, path, 16);
      if (!/^(?:normal|bold|bolder|lighter|[1-9]\d{0,2}|1000)$/.test(weight))
        fail(`${path}.fontWeight`);
      style.fontWeight = weight;
    }
  }
  if (v.fontStyle !== undefined)
    style.fontStyle = choice(v.fontStyle, path, ["normal", "italic", "oblique"]);
  if (v.fontFamily !== undefined) {
    const family = text(v.fontFamily, `${path}.fontFamily`, 256);
    if (!/^[\p{L}\p{N} _,'"-]+$/u.test(family)) fail(`${path}.fontFamily`);
    style.fontFamily = family;
  }
  if (v.background !== undefined) {
    const bg = object(v.background, `${path}.background`);
    style.background = {};
    if (bg.fill !== undefined) style.background.fill = color(bg.fill, path);
    if (bg.radius !== undefined) style.background.radius = number(bg.radius, path, 0, 512);
    if (bg.padding !== undefined)
      style.background.padding = array(bg.padding, path, 4).map((n) => number(n, path, 0, 512));
  }
  return { style };
}

/** Parse the file boundary into an allowlisted graph; never pass arbitrary G6 options through. */
export function validateState(value: unknown): State {
  const v = object(value, "root");
  if (v.version !== 1) fail("version (expected 1)");
  const settings = object(v.settings, "settings");
  const nodes = array(v.nodes, "nodes", 50_000).map((raw, i): ERNodeModel => {
    const path = `nodes[${i}]`;
    const n = object(raw, path);
    const id = text(n.id, `${path}.id`);
    if (!id) fail(`${path}.id`);
    const nodeType = choice(n.nodeType ?? n.type, `${path}.nodeType`, [
      "entity",
      "attribute",
      "relationship",
    ]);
    const out: ERNodeModel = { id, type: nodeType, nodeType };
    for (const key of [
      "label",
      "nameLabel",
      "commentLabel",
      "manualLabel",
      "parentEntity",
    ] as const) {
      if (n[key] !== undefined) out[key] = text(n[key], `${path}.${key}`);
    }
    for (const key of ["x", "y"] as const)
      if (n[key] !== undefined)
        out[key] = number(n[key], `${path}.${key}`, -MAX_COORDINATE, MAX_COORDINATE);
    for (const key of ["isPlaceholder", "isSelfLoop"] as const)
      if (n[key] !== undefined) out[key] = bool(n[key], `${path}.${key}`);
    if (n.keyType !== undefined) out.keyType = choice(n.keyType, path, ["pk", "normal"]);
    out.style = shape(n.style, `${path}.style`);
    out.labelCfg = labelConfig(n.labelCfg, `${path}.labelCfg`);
    return out;
  });
  const ids = new Set(nodes.map((n) => n.id));
  const entityIds = new Set(nodes.filter((n) => n.nodeType === "entity").map((n) => n.id));
  if (ids.size !== nodes.length) fail("duplicate node id");
  for (const n of nodes) {
    if (n.parentEntity !== undefined && !entityIds.has(n.parentEntity))
      fail(`parentEntity of ${n.id}`);
  }
  const allIds = new Set(ids);
  const edges = array(v.edges, "edges", 100_000).map((raw, i): EREdgeModel => {
    const path = `edges[${i}]`;
    const e = object(raw, path);
    const out: EREdgeModel = { source: text(e.source, path), target: text(e.target, path) };
    if (!ids.has(out.source) || !ids.has(out.target)) fail(`${path} endpoint`);
    if (e.id !== undefined) {
      out.id = text(e.id, `${path}.id`);
      if (!out.id || allIds.has(out.id)) fail(`${path} duplicate/empty id`);
      allIds.add(out.id);
    }
    if (e.label !== undefined) out.label = text(e.label, `${path}.label`);
    if (e.type !== undefined) out.type = choice(e.type, `${path}.type`, ["line", "self-loop-arc"]);
    if (e.edgeType !== undefined)
      out.edgeType = choice(e.edgeType, `${path}.edgeType`, [
        "entity-attribute",
        "entity-relationship",
        "relationship-entity",
      ]);
    if (e.curveOffset !== undefined)
      out.curveOffset = number(e.curveOffset, path, -MAX_COORDINATE, MAX_COORDINATE);
    out.style = shape(e.style, `${path}.style`);
    out.labelCfg = labelConfig(e.labelCfg, `${path}.labelCfg`);
    return out;
  });
  const state: State = {
    version: 1,
    input: text(v.input, "input", 5_000_000),
    format: choice(v.format, "format", ["sql", "dbml"]),
    settings: {
      colored: bool(settings.colored, "settings.colored"),
      comment: bool(settings.comment, "settings.comment"),
      hideAttrs: bool(settings.hideAttrs, "settings.hideAttrs"),
      fontScale: number(settings.fontScale, "settings.fontScale", 0.4, 1.6),
      attrMode: choice(settings.attrMode ?? "auto", "settings.attrMode", [
        "auto",
        "compact",
        "moderate",
      ]),
      autoAvoid:
        settings.autoAvoid === undefined ? true : bool(settings.autoAvoid, "settings.autoAvoid"),
    },
    nodes,
    edges,
  };
  if (v.parserWarnings !== undefined)
    state.parserWarnings = array(v.parserWarnings, "parserWarnings", 50_000).map(
      (raw): ParserWarning => {
        const w = object(raw, "parserWarnings");
        return {
          code: choice(w.code, "warning.code", [
            "statement_skipped",
            "column_type_missing",
            "column_type_invalid",
            "foreign_key_unrecognized",
            "constraint_skipped",
            "table_reference_missing",
            "duplicate_table",
          ]),
          message: text(w.message, "warning.message"),
          ...(w.line !== undefined ? { line: number(w.line, "warning.line", 1, 5_000_000) } : {}),
        };
      },
    );
  return state;
}
