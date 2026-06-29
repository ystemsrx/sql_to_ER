import { describe, expect, it } from "vitest";
import { attachEntityDragSync } from "../graph/attachEntityDragSync";
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

    attachEntityDragSync(
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
    Object.assign(entity.getModel(), { x: 160, y: 180 });
    graph.emit("node:drag", { item: entity });

    expectPointOnSegment(relationship.getModel(), entity.getModel(), fixed.getModel());
  });
});
