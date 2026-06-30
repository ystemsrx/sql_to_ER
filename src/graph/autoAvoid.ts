import type { ERNodeModel } from "../types";
import type { NodeSize, NodeSizeResolver, Point } from "./entityMoveSync";

export interface AutoAvoidOptions {
  enabled?: boolean;
  margin?: number;
  maxIterations?: number;
}

const DEFAULT_SIZE: Record<string, NodeSize> = {
  entity: { width: 120, height: 52 },
  relationship: { width: 82, height: 52 },
  attribute: { width: 90, height: 44 },
};

const FALLBACK_SIZE: NodeSize = { width: 80, height: 40 };

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

        const aPriority = movePriority(a);
        const bPriority = movePriority(b);
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

  const targets = new Map<string, Point>();
  nodes.forEach((node) => {
    if (movePriority(node) === 0) return;
    const before = original.get(node.id);
    const after = positions.get(node.id);
    if (!before || !after) return;
    if (Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6) return;
    targets.set(node.id, { x: after.x, y: after.y });
  });
  return targets;
}
