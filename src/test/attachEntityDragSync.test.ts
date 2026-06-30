import { describe, expect, it, vi } from "vitest";
import { attachEntityDragSync } from "../graph/attachEntityDragSync";
import { computeMovedEntityRelationshipTargets } from "../graph/entityMoveSync";
import type { EREdgeModel, ERNodeModel, GraphEdgeLike, GraphNodeLike } from "../types";

class FakeNode implements GraphNodeLike {
  constructor(private model: ERNodeModel) {}

  getModel(): ERNodeModel {
    return this.model;
  }

  getBBox() {
    const width = typeof this.model.width === "number" ? this.model.width : 80;
    const height = typeof this.model.height === "number" ? this.model.height : 40;
    const x = this.model.x ?? 0;
    const y = this.model.y ?? 0;
    return {
      minX: x - width / 2,
      minY: y - height / 2,
      maxX: x + width / 2,
      maxY: y + height / 2,
      width,
      height,
      centerX: x,
      centerY: y,
    };
  }
}

class FakeEdge implements GraphEdgeLike {
  constructor(private model: EREdgeModel) {}

  getModel(): EREdgeModel {
    return this.model;
  }
}

class FakeGraph {
  private handlers = new Map<string, Array<(e: unknown) => void>>();
  private nodes: FakeNode[];
  private edges: FakeEdge[];

  constructor(nodes: ERNodeModel[], edges: EREdgeModel[]) {
    this.nodes = nodes.map((n) => new FakeNode(n));
    this.edges = edges.map((e) => new FakeEdge(e));
  }

  on(event: string, handler: (e: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  emit(event: string, e: unknown): void {
    (this.handlers.get(event) ?? []).forEach((handler) => handler(e));
  }

  getNodes(): FakeNode[] {
    return this.nodes;
  }

  getEdges(): FakeEdge[] {
    return this.edges;
  }

  findById(id: string): FakeNode | FakeEdge | null {
    return (
      this.nodes.find((n) => n.getModel().id === id) ??
      this.edges.find((e) => e.getModel().id === id) ??
      null
    );
  }

  updateItem(item: unknown, model: Record<string, unknown>): void {
    Object.assign((item as FakeNode).getModel(), model);
  }

  setItemState(): void {}
  setAutoPaint(): void {}
  paint(): void {}
  refreshPositions(): void {}
  get(): unknown {
    return undefined;
  }
  getZoom(): number {
    return 1;
  }
}

function expectPointOnSegment(
  point: { x?: number; y?: number },
  a: { x?: number; y?: number },
  b: { x?: number; y?: number },
) {
  const px = point.x ?? 0;
  const py = point.y ?? 0;
  const ax = a.x ?? 0;
  const ay = a.y ?? 0;
  const bx = b.x ?? 0;
  const by = b.y ?? 0;
  const dx = bx - ax;
  const dy = by - ay;
  const area2 = (px - ax) * dy - (py - ay) * dx;
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);

  expect(Math.abs(area2)).toBeLessThan(1e-6);
  expect(t).toBeGreaterThan(0);
  expect(t).toBeLessThan(1);
}

const distance = (a: { x?: number; y?: number }, b: { x?: number; y?: number }): number =>
  Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0));

describe("attachEntityDragSync", () => {
  it("moves relationship diamonds onto the line between the dragged entity and the other entity", () => {
    const graph = new FakeGraph(
      [
        { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 100, y: 100 },
        { id: "entity-b", type: "entity", label: "b", nodeType: "entity", x: 300, y: 100 },
        {
          id: "rel-a-b",
          type: "relationship",
          label: "a_b",
          nodeType: "relationship",
          x: 200,
          y: 100,
        },
      ],
      [
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
      ],
    );
    const entity = graph.findById("entity-a") as FakeNode;
    const fixed = graph.findById("entity-b") as FakeNode;
    const relationship = graph.findById("rel-a-b") as FakeNode;
    const onAfterChange = vi.fn();

    (attachEntityDragSync as any)(
      graph,
      {
        record: () => undefined,
        undo: () => false,
        redo: () => false,
        reset: () => undefined,
        canUndo: () => false,
        canRedo: () => false,
      },
      () => false,
      onAfterChange,
    );

    graph.emit("node:dragstart", { item: entity });
    Object.assign(entity.getModel(), { x: 160, y: 180 });
    graph.emit("node:drag", { item: entity });
    graph.emit("node:dragend", { item: entity });

    expectPointOnSegment(relationship.getModel(), entity.getModel(), fixed.getModel());
    expect(onAfterChange).toHaveBeenCalledTimes(1);
  });

  it("uses one drag-start relationship return offset instead of re-easing on every drag", () => {
    const graph = new FakeGraph(
      [
        { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 100, y: 100 },
        { id: "entity-b", type: "entity", label: "b", nodeType: "entity", x: 300, y: 100 },
        {
          id: "rel-a-b",
          type: "relationship",
          label: "a_b",
          nodeType: "relationship",
          x: 200,
          y: 220,
        },
      ],
      [
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
      ],
    );
    const entity = graph.findById("entity-a") as FakeNode;
    const relationship = graph.findById("rel-a-b") as FakeNode;
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(0);

    try {
      (attachEntityDragSync as any)(
        graph,
        {
          record: () => undefined,
          undo: () => false,
          redo: () => false,
          reset: () => undefined,
          canUndo: () => false,
          canRedo: () => false,
        },
        () => false,
      );

      const initialTarget = computeMovedEntityRelationshipTargets(
        graph.getNodes().map((n) => n.getModel()),
        graph.getEdges().map((e) => e.getModel()),
        ["entity-a"],
        (node) => {
          const item = graph.findById(node.id);
          const bbox = item && "getBBox" in item ? item.getBBox() : null;
          return { width: bbox?.width ?? 80, height: bbox?.height ?? 40 };
        },
      ).relationshipTargets.get("rel-a-b")!;
      const startOffset = {
        x: (relationship.getModel().x ?? 0) - initialTarget.x,
        y: (relationship.getModel().y ?? 0) - initialTarget.y,
      };

      graph.emit("node:dragstart", { item: entity });

      Object.assign(entity.getModel(), { x: 160, y: 180 });
      graph.emit("node:drag", { item: entity });
      const firstTarget = computeMovedEntityRelationshipTargets(
        graph.getNodes().map((n) => n.getModel()),
        graph.getEdges().map((e) => e.getModel()),
        ["entity-a"],
        (node) => {
          const item = graph.findById(node.id);
          const bbox = item && "getBBox" in item ? item.getBBox() : null;
          return { width: bbox?.width ?? 80, height: bbox?.height ?? 40 };
        },
      ).relationshipTargets.get("rel-a-b")!;
      expect(relationship.getModel().x).toBeCloseTo(firstTarget.x + startOffset.x, 6);
      expect(relationship.getModel().y).toBeCloseTo(firstTarget.y + startOffset.y, 6);

      Object.assign(entity.getModel(), { x: 190, y: 210 });
      graph.emit("node:drag", { item: entity });
      const secondTarget = computeMovedEntityRelationshipTargets(
        graph.getNodes().map((n) => n.getModel()),
        graph.getEdges().map((e) => e.getModel()),
        ["entity-a"],
        (node) => {
          const item = graph.findById(node.id);
          const bbox = item && "getBBox" in item ? item.getBBox() : null;
          return { width: bbox?.width ?? 80, height: bbox?.height ?? 40 };
        },
      ).relationshipTargets.get("rel-a-b")!;
      expect(relationship.getModel().x).toBeCloseTo(secondTarget.x + startOffset.x, 6);
      expect(relationship.getModel().y).toBeCloseTo(secondTarget.y + startOffset.y, 6);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("finishes the drag-start relationship return after 280ms", () => {
    const graph = new FakeGraph(
      [
        { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 100, y: 100 },
        { id: "entity-b", type: "entity", label: "b", nodeType: "entity", x: 300, y: 100 },
        {
          id: "rel-a-b",
          type: "relationship",
          label: "a_b",
          nodeType: "relationship",
          x: 200,
          y: 220,
        },
      ],
      [
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
      ],
    );
    const entity = graph.findById("entity-a") as FakeNode;
    const relationship = graph.findById("rel-a-b") as FakeNode;
    let now = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);

    try {
      (attachEntityDragSync as any)(
        graph,
        {
          record: () => undefined,
          undo: () => false,
          redo: () => false,
          reset: () => undefined,
          canUndo: () => false,
          canRedo: () => false,
        },
        () => false,
      );

      graph.emit("node:dragstart", { item: entity });
      now = 280;
      Object.assign(entity.getModel(), { x: 160, y: 180 });
      const target = computeMovedEntityRelationshipTargets(
        graph.getNodes().map((n) => n.getModel()),
        graph.getEdges().map((e) => e.getModel()),
        ["entity-a"],
        (node) => {
          const item = graph.findById(node.id);
          const bbox = item && "getBBox" in item ? item.getBBox() : null;
          return { width: bbox?.width ?? 80, height: bbox?.height ?? 40 };
        },
      ).relationshipTargets.get("rel-a-b")!;

      graph.emit("node:drag", { item: entity });

      expect(relationship.getModel().x).toBeCloseTo(target.x, 6);
      expect(relationship.getModel().y).toBeCloseTo(target.y, 6);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("moves single-entity relationship diamonds with the dragged entity", () => {
    const graph = new FakeGraph(
      [
        { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 100, y: 100 },
        {
          id: "rel-one-edge",
          type: "relationship",
          label: "single",
          nodeType: "relationship",
          x: 150,
          y: 100,
        },
        {
          id: "rel-loop",
          type: "relationship",
          label: "loop",
          nodeType: "relationship",
          x: 100,
          y: 40,
          isSelfLoop: true,
        },
      ],
      [
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
      ],
    );
    const entity = graph.findById("entity-a") as FakeNode;
    const oneEdge = graph.findById("rel-one-edge") as FakeNode;
    const loop = graph.findById("rel-loop") as FakeNode;

    (attachEntityDragSync as any)(
      graph,
      {
        record: () => undefined,
        undo: () => false,
        redo: () => false,
        reset: () => undefined,
        canUndo: () => false,
        canRedo: () => false,
      },
      () => false,
    );

    graph.emit("node:dragstart", { item: entity });
    Object.assign(entity.getModel(), { x: 180, y: 160 });
    graph.emit("node:drag", { item: entity });

    expect(oneEdge.getModel().x).toBe(230);
    expect(oneEdge.getModel().y).toBe(160);
    expect(loop.getModel().x).toBe(180);
    expect(loop.getModel().y).toBe(100);
  });

  it("fires the canvas-change callback after dragging a non-entity node", () => {
    const graph = new FakeGraph(
      [
        { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 100, y: 100 },
        {
          id: "rel-a",
          type: "relationship",
          label: "r",
          nodeType: "relationship",
          x: 180,
          y: 100,
        },
      ],
      [
        {
          id: "edge-a-rel",
          source: "entity-a",
          target: "rel-a",
          edgeType: "entity-relationship",
        },
      ],
    );
    const relationship = graph.findById("rel-a") as FakeNode;
    const onAfterChange = vi.fn();

    (attachEntityDragSync as any)(
      graph,
      {
        record: () => undefined,
        undo: () => false,
        redo: () => false,
        reset: () => undefined,
        canUndo: () => false,
        canRedo: () => false,
      },
      () => false,
      onAfterChange,
    );

    graph.emit("node:dragstart", { item: relationship });
    Object.assign(relationship.getModel(), { x: 220, y: 140 });
    graph.emit("node:drag", { item: relationship });
    graph.emit("node:dragend", { item: relationship });

    expect(onAfterChange).toHaveBeenCalledTimes(1);
  });

  it("fires the canvas-change callback after smooth relationship return reaches its final state", () => {
    const graph = new FakeGraph(
      [
        { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 100, y: 100 },
        { id: "entity-b", type: "entity", label: "b", nodeType: "entity", x: 300, y: 100 },
        {
          id: "rel-a-b",
          type: "relationship",
          label: "a_b",
          nodeType: "relationship",
          x: 200,
          y: 220,
        },
      ],
      [
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
      ],
    );
    const entity = graph.findById("entity-a") as FakeNode;
    const relationship = graph.findById("rel-a-b") as FakeNode;
    const persistedPositions: Array<{ x?: number; y?: number }> = [];
    const onAfterChange = vi.fn(() => {
      persistedPositions.push({ x: relationship.getModel().x, y: relationship.getModel().y });
    });
    const rafCallbacks: FrameRequestCallback[] = [];
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(0);
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;

    try {
      (attachEntityDragSync as any)(
        graph,
        {
          record: () => undefined,
          undo: () => false,
          redo: () => false,
          reset: () => undefined,
          canUndo: () => false,
          canRedo: () => false,
        },
        () => false,
        onAfterChange,
      );

      graph.emit("node:dragstart", { item: entity });
      Object.assign(entity.getModel(), { x: 160, y: 180 });
      const target = computeMovedEntityRelationshipTargets(
        graph.getNodes().map((n) => n.getModel()),
        graph.getEdges().map((e) => e.getModel()),
        ["entity-a"],
        (node) => {
          const item = graph.findById(node.id);
          const bbox = item && "getBBox" in item ? item.getBBox() : null;
          return { width: bbox?.width ?? 80, height: bbox?.height ?? 40 };
        },
      ).relationshipTargets.get("rel-a-b")!;

      graph.emit("node:drag", { item: entity });
      graph.emit("node:dragend", { item: entity });

      expect(onAfterChange).not.toHaveBeenCalled();
      const first = rafCallbacks.shift();
      expect(first).toBeDefined();
      first?.(0);
      const last = rafCallbacks.shift();
      expect(last).toBeDefined();
      last?.(280);

      expect(onAfterChange).toHaveBeenCalledTimes(1);
      expect(persistedPositions[0].x).toBeCloseTo(target.x!, 6);
      expect(persistedPositions[0].y).toBeCloseTo(target.y!, 6);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancelRaf;
      nowSpy.mockRestore();
    }
  });

  it("merges auto-avoid targets into the same drag-end return animation", () => {
    const graph = new FakeGraph(
      [
        { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 100, y: 100 },
        { id: "entity-b", type: "entity", label: "b", nodeType: "entity", x: 300, y: 100 },
        {
          id: "attr-a-name",
          type: "attribute",
          label: "name",
          nodeType: "attribute",
          parentEntity: "entity-a",
          x: 150,
          y: 100,
        },
        {
          id: "rel-a-b",
          type: "relationship",
          label: "a_b",
          nodeType: "relationship",
          x: 200,
          y: 220,
        },
      ],
      [
        {
          id: "edge-a-attr",
          source: "entity-a",
          target: "attr-a-name",
          edgeType: "entity-attribute",
        },
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
      ],
    );
    const entity = graph.findById("entity-a") as FakeNode;
    const attr = graph.findById("attr-a-name") as FakeNode;
    const onAfterChange = vi.fn();
    const completeDragTargets = vi.fn(() => new Map([["attr-a-name", { x: 260, y: 180 }]]));
    const rafCallbacks: FrameRequestCallback[] = [];
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(0);
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;

    try {
      (attachEntityDragSync as any)(
        graph,
        {
          record: () => undefined,
          undo: () => false,
          redo: () => false,
          reset: () => undefined,
          canUndo: () => false,
          canRedo: () => false,
        },
        () => false,
        onAfterChange,
        completeDragTargets,
      );

      graph.emit("node:dragstart", { item: entity });
      Object.assign(entity.getModel(), { x: 160, y: 180 });
      graph.emit("node:drag", { item: entity });
      graph.emit("node:dragend", { item: entity });

      expect(completeDragTargets).toHaveBeenCalledTimes(1);
      expect(onAfterChange).not.toHaveBeenCalled();
      const first = rafCallbacks.shift();
      expect(first).toBeDefined();
      first?.(0);
      const last = rafCallbacks.shift();
      expect(last).toBeDefined();
      last?.(280);

      expect(attr.getModel().x).toBeCloseTo(260, 6);
      expect(attr.getModel().y).toBeCloseTo(180, 6);
      expect(onAfterChange).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancelRaf;
      nowSpy.mockRestore();
    }
  });
});
