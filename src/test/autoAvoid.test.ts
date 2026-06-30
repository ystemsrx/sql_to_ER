import { describe, expect, it } from "vitest";
import { computeAutoAvoidTargets } from "../graph/autoAvoid";
import type { ERNodeModel } from "../types";

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
});
