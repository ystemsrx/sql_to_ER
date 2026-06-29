/**
 * Exporters. drawio reuses the app's buildDrawioXML (same mxCell output the web
 * app produces). SVG + JSON are written headlessly for a quick visual check and
 * for machine round-trip.
 */
import { spawnSync } from "node:child_process";
import { buildDrawioXML } from "@app/exporter";
import { measureNodeSize, getTextWidth } from "@app/builder";
import type { ERNodeModel, GraphLike } from "@app/types";
import { createHeadlessGraph } from "./adapter";
import type { State } from "./ops";

const esc = (s: unknown): string =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function exportDrawio(state: State): string {
  const graph = createHeadlessGraph(state.nodes, state.edges);
  return buildDrawioXML(graph as unknown as GraphLike);
}

export function exportJson(state: State): string {
  const sized = new Map(state.nodes.map((n) => [n.id, measureNodeSize(n)]));
  const out = {
    nodes: state.nodes.map((n) => {
      const s = sized.get(n.id)!;
      return {
        id: n.id,
        type: n.nodeType,
        label: n.label,
        x: Math.round(typeof n.x === "number" ? n.x : 0),
        y: Math.round(typeof n.y === "number" ? n.y : 0),
        w: Math.round(s.width),
        h: Math.round(s.height),
        ...(n.keyType === "pk" ? { pk: true } : {}),
        ...(n.parentEntity ? { parent: n.parentEntity } : {}),
        ...(n.isPlaceholder ? { placeholder: true } : {}),
      };
    }),
    edges: state.edges.map((e) => ({
      source: e.source,
      target: e.target,
      label: e.label ?? "",
      type: e.edgeType ?? "",
    })),
  };
  return JSON.stringify(out, null, 2);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function exportPng(state: State): Buffer {
  const svg = exportSvg(state);
  const candidates = [process.env.SQL2ER_RSVG_CONVERT, "rsvg-convert", "rsvg-convert.exe"].filter(
    (cmd): cmd is string => !!cmd,
  );
  const missing: string[] = [];

  for (const cmd of candidates) {
    const result = spawnSync(cmd, ["--format", "png", "-"], {
      input: svg,
      maxBuffer: 200 * 1024 * 1024,
    });
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(cmd);
        continue;
      }
      throw new Error(`PNG export failed using ${cmd}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.toString("utf8").trim();
      throw new Error(`PNG export failed using ${cmd}: ${stderr || `exit ${result.status}`}`);
    }
    const png = result.stdout ?? Buffer.alloc(0);
    if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error(`PNG export failed using ${cmd}: converter did not return PNG data`);
    }
    return png;
  }

  throw new Error(
    `PNG export requires rsvg-convert on PATH or SQL2ER_RSVG_CONVERT. Tried: ${missing.join(", ") || "none"}.`,
  );
}

interface Sized {
  cx: number;
  cy: number;
  w: number;
  h: number;
  m: ERNodeModel;
}

export function exportSvg(state: State): string {
  const sized = new Map<string, Sized>();
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  state.nodes.forEach((n) => {
    const { width, height } = measureNodeSize(n);
    const cx = typeof n.x === "number" ? n.x : 0;
    const cy = typeof n.y === "number" ? n.y : 0;
    sized.set(n.id, { cx, cy, w: width, h: height, m: n });
    minX = Math.min(minX, cx - width / 2);
    minY = Math.min(minY, cy - height / 2);
    maxX = Math.max(maxX, cx + width / 2);
    maxY = Math.max(maxY, cy + height / 2);
  });
  if (!state.nodes.length) {
    minX = minY = 0;
    maxX = maxY = 100;
  }
  const pad = 40;
  const vbX = minX - pad;
  const vbY = minY - pad;
  const vbW = maxX - minX + pad * 2;
  const vbH = maxY - minY + pad * 2;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(vbW)}" height="${Math.round(vbH)}" viewBox="${Math.round(vbX)} ${Math.round(vbY)} ${Math.round(vbW)} ${Math.round(vbH)}" font-family="sans-serif">`,
  );
  parts.push(
    `<rect x="${Math.round(vbX)}" y="${Math.round(vbY)}" width="${Math.round(vbW)}" height="${Math.round(vbH)}" fill="#ffffff"/>`,
  );

  // edges first (center-to-center), node fills hide the overlap. A self-loop's two
  // edges share both endpoints, so as straight lines they collapse onto one. Bow each
  // to a quadratic control point (same math as the app's self-loop-arc edge) — the two
  // edges flip source/target, so the perpendicular flips and they form a lens/loop.
  const selfLoopControl = (s: Sized, t: Sized, off: number) => {
    const dx = t.cx - s.cx;
    const dy = t.cy - s.cy;
    const dist = Math.hypot(dx, dy) || 1;
    return { x: (s.cx + t.cx) / 2 + (-dy / dist) * off, y: (s.cy + t.cy) / 2 + (dx / dist) * off };
  };
  const isArc = (e: State["edges"][number]) =>
    e.type === "self-loop-arc" && typeof e.curveOffset === "number" && e.curveOffset !== 0;
  state.edges.forEach((e) => {
    const s = sized.get(e.source);
    const t = sized.get(e.target);
    if (!s || !t) return;
    if (isArc(e)) {
      const c = selfLoopControl(s, t, e.curveOffset as number);
      parts.push(
        `<path d="M ${s.cx.toFixed(1)} ${s.cy.toFixed(1)} Q ${c.x.toFixed(1)} ${c.y.toFixed(1)} ${t.cx.toFixed(1)} ${t.cy.toFixed(1)}" fill="none" stroke="#000" stroke-width="1.5"/>`,
      );
    } else {
      parts.push(
        `<line x1="${s.cx.toFixed(1)}" y1="${s.cy.toFixed(1)}" x2="${t.cx.toFixed(1)}" y2="${t.cy.toFixed(1)}" stroke="#000" stroke-width="1.5"/>`,
      );
    }
  });

  // nodes
  state.nodes.forEach((n) => {
    const s = sized.get(n.id)!;
    const fill = n.style?.fill ?? "#fff";
    const stroke = n.style?.stroke ?? "#000";
    const lw = n.style?.lineWidth ?? 1.5;
    const dash =
      Array.isArray(n.style?.lineDash) && n.style?.lineDash.length ? ` stroke-dasharray="4 4"` : "";
    const fontFill = n.labelCfg?.style?.fill ?? "#000";
    const fontSize =
      n.labelCfg?.style?.fontSize ??
      (n.nodeType === "entity" ? 18 : n.nodeType === "relationship" ? 16 : 15);
    const bold =
      n.labelCfg?.style?.fontWeight === "bold" ||
      n.labelCfg?.style?.fontWeight === "700" ||
      n.labelCfg?.style?.fontWeight === 700;
    const fw = bold ? ` font-weight="bold"` : "";
    const { cx, cy, w, h } = s;
    if (n.nodeType === "entity") {
      parts.push(
        `<rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${lw}"${dash}/>`,
      );
    } else if (n.nodeType === "relationship") {
      const pts = `${cx},${(cy - h / 2).toFixed(1)} ${(cx + w / 2).toFixed(1)},${cy} ${cx},${(cy + h / 2).toFixed(1)} ${(cx - w / 2).toFixed(1)},${cy}`;
      parts.push(
        `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="${lw}"${dash}/>`,
      );
    } else {
      parts.push(
        `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(w / 2).toFixed(1)}" ry="${(h / 2).toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${lw}"${dash}/>`,
      );
    }
    const label = esc(n.label ?? "");
    parts.push(
      `<text x="${cx.toFixed(1)}" y="${(cy + Number(fontSize) * 0.34).toFixed(1)}" font-size="${fontSize}" fill="${fontFill}"${fw} text-anchor="middle">${label}</text>`,
    );
    if (n.nodeType === "attribute" && n.keyType === "pk") {
      const tw = getTextWidth(String(n.label ?? ""), Number(fontSize));
      const uy = cy + Number(fontSize) * 0.62;
      parts.push(
        `<line x1="${(cx - tw / 2).toFixed(1)}" y1="${uy.toFixed(1)}" x2="${(cx + tw / 2).toFixed(1)}" y2="${uy.toFixed(1)}" stroke="${fontFill}" stroke-width="1"/>`,
      );
    }
  });

  // edge labels (cardinality) on top, with a white halo
  state.edges.forEach((e) => {
    if (e.label == null || e.label === "") return;
    const s = sized.get(e.source);
    const t = sized.get(e.target);
    if (!s || !t) return;
    let mx = (s.cx + t.cx) / 2;
    let my = (s.cy + t.cy) / 2;
    if (isArc(e)) {
      // sit on the arc's peak (quadratic midpoint) so the two cardinalities separate
      const c = selfLoopControl(s, t, e.curveOffset as number);
      mx = (mx + c.x) / 2;
      my = (my + c.y) / 2;
    }
    parts.push(
      `<rect x="${(mx - 7).toFixed(1)}" y="${(my - 8).toFixed(1)}" width="14" height="14" fill="#fff"/>`,
    );
    parts.push(
      `<text x="${mx.toFixed(1)}" y="${(my + 4).toFixed(1)}" font-size="12" fill="#000" text-anchor="middle">${esc(e.label)}</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("\n");
}
