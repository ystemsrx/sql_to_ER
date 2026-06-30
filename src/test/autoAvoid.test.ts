import { describe, expect, it } from "vitest";
import { computeAutoAvoidTargets } from "../graph/autoAvoid";
import type { EREdgeModel, ERNodeModel } from "../types";

const sizeOf = (node: ERNodeModel) => {
  if (node.nodeType === "entity") return { width: 100, height: 56 };
  if (node.nodeType === "relationship") return { width: 80, height: 52 };
  return { width: 70, height: 42 };
};

const applyTargets = (nodes: ERNodeModel[], targets: Map<string, { x: number; y: number }>) => {
  targets.forEach((target, id) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    node.x = target.x;
    node.y = target.y;
  });
};

const overlaps = (a: ERNodeModel, b: ERNodeModel, margin = 4) => {
  const as = sizeOf(a);
  const bs = sizeOf(b);
  return (
    Math.abs((a.x ?? 0) - (b.x ?? 0)) < (as.width + bs.width) / 2 + margin &&
    Math.abs((a.y ?? 0) - (b.y ?? 0)) < (as.height + bs.height) / 2 + margin
  );
};

const cross2 = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

const segmentsIntersect = (
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number },
): boolean => {
  const d1 = cross2(d.x - c.x, d.y - c.y, a.x - c.x, a.y - c.y);
  const d2 = cross2(d.x - c.x, d.y - c.y, b.x - c.x, b.y - c.y);
  const d3 = cross2(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
  const d4 = cross2(b.x - a.x, b.y - a.y, d.x - a.x, d.y - a.y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};

describe("auto avoidance targets", () => {
  it("does nothing when disabled", () => {
    const nodes: ERNodeModel[] = [
      { id: "entity-users", nodeType: "entity", type: "entity", label: "users", x: 0, y: 0 },
      {
        id: "attr-users-name",
        nodeType: "attribute",
        type: "attribute",
        label: "name",
        parentEntity: "entity-users",
        x: 10,
        y: 0,
      },
    ];

    const targets = computeAutoAvoidTargets(nodes, sizeOf, { enabled: false });

    expect(targets.size).toBe(0);
  });

  it("moves an attribute away from an overlapping entity without moving the entity", () => {
    const nodes: ERNodeModel[] = [
      { id: "entity-users", nodeType: "entity", type: "entity", label: "users", x: 0, y: 0 },
      {
        id: "attr-users-name",
        nodeType: "attribute",
        type: "attribute",
        label: "name",
        parentEntity: "entity-users",
        x: 8,
        y: 0,
      },
    ];

    const targets = computeAutoAvoidTargets(nodes, sizeOf);
    applyTargets(nodes, targets);

    expect(targets.has("attr-users-name")).toBe(true);
    expect(targets.has("entity-users")).toBe(false);
    expect(nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(overlaps(nodes[0], nodes[1])).toBe(false);
  });

  it("moves an attribute before moving a relationship diamond", () => {
    const nodes: ERNodeModel[] = [
      {
        id: "rel-orders-users",
        nodeType: "relationship",
        type: "relationship",
        label: "placed by",
        x: 0,
        y: 0,
      },
      {
        id: "attr-users-name",
        nodeType: "attribute",
        type: "attribute",
        label: "name",
        parentEntity: "entity-users",
        x: 8,
        y: 0,
      },
    ];

    const targets = computeAutoAvoidTargets(nodes, sizeOf);
    applyTargets(nodes, targets);

    expect(targets.has("attr-users-name")).toBe(true);
    expect(targets.has("rel-orders-users")).toBe(false);
    expect(overlaps(nodes[0], nodes[1])).toBe(false);
  });

  it("moves a relationship diamond away from an overlapping entity", () => {
    const nodes: ERNodeModel[] = [
      { id: "entity-users", nodeType: "entity", type: "entity", label: "users", x: 0, y: 0 },
      {
        id: "rel-orders-users",
        nodeType: "relationship",
        type: "relationship",
        label: "placed by",
        x: 6,
        y: 0,
      },
    ];

    const targets = computeAutoAvoidTargets(nodes, sizeOf);
    applyTargets(nodes, targets);

    expect(targets.has("rel-orders-users")).toBe(true);
    expect(targets.has("entity-users")).toBe(false);
    expect(nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(overlaps(nodes[0], nodes[1])).toBe(false);
  });

  it("moves an attribute whose connector crosses a relationship line even when boxes do not overlap", () => {
    const nodes: ERNodeModel[] = [
      { id: "entity-users", nodeType: "entity", type: "entity", label: "users", x: 0, y: 0 },
      {
        id: "attr-users-name",
        nodeType: "attribute",
        type: "attribute",
        label: "name",
        parentEntity: "entity-users",
        x: 160,
        y: 0,
      },
      {
        id: "entity-orders",
        nodeType: "entity",
        type: "entity",
        label: "orders",
        x: 80,
        y: -140,
      },
      {
        id: "rel-orders-users",
        nodeType: "relationship",
        type: "relationship",
        label: "placed by",
        x: 80,
        y: 140,
      },
    ];
    const edges: EREdgeModel[] = [
      {
        id: "edge-users-name",
        source: "entity-users",
        target: "attr-users-name",
        edgeType: "entity-attribute",
      },
      {
        id: "edge-orders-rel",
        source: "entity-orders",
        target: "rel-orders-users",
        edgeType: "entity-relationship",
      },
    ];

    expect(
      segmentsIntersect(
        { x: nodes[0].x!, y: nodes[0].y! },
        { x: nodes[1].x!, y: nodes[1].y! },
        { x: nodes[2].x!, y: nodes[2].y! },
        { x: nodes[3].x!, y: nodes[3].y! },
      ),
    ).toBe(true);
    nodes.slice(1).forEach((node) => {
      expect(overlaps(nodes[1], node)).toBe(node.id === "attr-users-name");
    });

    const targets = computeAutoAvoidTargets(nodes, sizeOf, { edges });
    applyTargets(nodes, targets);

    expect(targets.has("attr-users-name")).toBe(true);
    expect(targets.has("entity-users")).toBe(false);
    expect(
      segmentsIntersect(
        { x: nodes[0].x!, y: nodes[0].y! },
        { x: nodes[1].x!, y: nodes[1].y! },
        { x: nodes[2].x!, y: nodes[2].y! },
        { x: nodes[3].x!, y: nodes[3].y! },
      ),
    ).toBe(false);
    expect(nodes.slice(2).some((node) => overlaps(nodes[1], node))).toBe(false);
  });
});
