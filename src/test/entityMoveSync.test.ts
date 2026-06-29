import { describe, expect, it } from "vitest";
import {
  applyNodePositionTargets,
  computeAttributeRotationTargets,
  computeMovedEntityRelationshipTargets,
} from "../graph/entityMoveSync";
import type { EREdgeModel, ERNodeModel } from "../types";

const sizeOf = (node: ERNodeModel) => {
  if (node.nodeType === "relationship") return { width: 80, height: 48 };
  if (node.nodeType === "attribute") return { width: 60, height: 40 };
  return { width: 100, height: 50 };
};

const distance = (a: { x?: number; y?: number }, b: { x?: number; y?: number }) =>
  Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0));

const overlaps = (
  a: { x?: number; y?: number },
  as: { width: number; height: number },
  b: { x?: number; y?: number },
  bs: { width: number; height: number },
) =>
  Math.abs((a.x ?? 0) - (b.x ?? 0)) < (as.width + bs.width) / 2 + 8 &&
  Math.abs((a.y ?? 0) - (b.y ?? 0)) < (as.height + bs.height) / 2 + 8;

describe("entity move synchronization", () => {
  it("rotates covered attributes away from moved relationship diamonds without changing radius", () => {
    const nodes: ERNodeModel[] = [
      { id: "entity-a", type: "entity", nodeType: "entity", label: "a", x: 160, y: 180 },
      { id: "entity-b", type: "entity", nodeType: "entity", label: "b", x: 300, y: 100 },
      {
        id: "rel-a-b",
        type: "relationship",
        nodeType: "relationship",
        label: "a_b",
        x: 200,
        y: 100,
      },
      {
        id: "attr-b",
        type: "attribute",
        nodeType: "attribute",
        label: "b",
        parentEntity: "entity-b",
        x: 230,
        y: 140,
      },
    ];
    const edges: EREdgeModel[] = [
      {
        id: "edge-a-rel",
        source: "entity-a",
        target: "rel-a-b",
        edgeType: "entity-relationship",
      },
      {
        id: "edge-rel-b",
        source: "rel-a-b",
        target: "entity-b",
        edgeType: "relationship-entity",
      },
      {
        id: "edge-b-attr",
        source: "entity-b",
        target: "attr-b",
        edgeType: "entity-attribute",
      },
    ];
    const beforeRadius = distance(nodes[1], nodes[3]);

    const relTargets = computeMovedEntityRelationshipTargets(nodes, edges, ["entity-a"], sizeOf);
    applyNodePositionTargets(nodes, relTargets.relationshipTargets);
    expect(overlaps(nodes[3], sizeOf(nodes[3]), nodes[2], sizeOf(nodes[2]))).toBe(true);

    const attrTargets = computeAttributeRotationTargets(
      nodes,
      edges,
      relTargets.affectedEntityIds,
      sizeOf,
    );
    applyNodePositionTargets(nodes, attrTargets);

    expect(attrTargets.has("attr-b")).toBe(true);
    expect(distance(nodes[1], nodes[3])).toBeCloseTo(beforeRadius, 6);
    expect(overlaps(nodes[3], sizeOf(nodes[3]), nodes[2], sizeOf(nodes[2]))).toBe(false);
  });

  it("translates single-entity relationship diamonds with the moved entity", () => {
    const nodes: ERNodeModel[] = [
      { id: "entity-a", type: "entity", nodeType: "entity", label: "a", x: 180, y: 160 },
      {
        id: "rel-one-edge",
        type: "relationship",
        nodeType: "relationship",
        label: "single",
        x: 140,
        y: 100,
      },
      {
        id: "rel-loop",
        type: "relationship",
        nodeType: "relationship",
        label: "loop",
        x: 100,
        y: 40,
        isSelfLoop: true,
      },
    ];
    const edges: EREdgeModel[] = [
      {
        id: "edge-a-single",
        source: "entity-a",
        target: "rel-one-edge",
        edgeType: "entity-relationship",
      },
      {
        id: "edge-a-loop",
        source: "entity-a",
        target: "rel-loop",
        edgeType: "entity-relationship",
      },
      {
        id: "edge-loop-a",
        source: "rel-loop",
        target: "entity-a",
        edgeType: "relationship-entity",
      },
    ];
    const startPositions = new Map<string, { x: number; y: number }>([
      ["entity-a", { x: 100, y: 100 }],
      ["rel-one-edge", { x: 140, y: 100 }],
      ["rel-loop", { x: 100, y: 40 }],
    ]);

    const relTargets = computeMovedEntityRelationshipTargets(
      nodes,
      edges,
      ["entity-a"],
      sizeOf,
      startPositions,
    );

    expect(relTargets.relationshipTargets.get("rel-one-edge")).toEqual({ x: 220, y: 160 });
    expect(relTargets.relationshipTargets.get("rel-loop")).toEqual({ x: 180, y: 100 });
    expect(relTargets.affectedEntityIds.has("entity-a")).toBe(true);
  });
});
