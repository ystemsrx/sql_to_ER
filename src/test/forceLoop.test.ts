import { describe, expect, it } from "vitest";
import { attachForceLoop } from "../graph/forceLoop";
import type { EREdgeModel, ERNodeModel, GraphEdgeLike, GraphNodeLike } from "../types";

class FakeNode implements GraphNodeLike {
  constructor(private model: ERNodeModel) {}

  getModel(): ERNodeModel {
    return this.model;
  }

  getBBox() {
    const width = 100;
    const height = 56;
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
  destroyed = false;
  private handlers = new Map<string, Array<(e: unknown) => void>>();
  private nodes: FakeNode[];
  private edges: FakeEdge[];

  constructor(nodes: ERNodeModel[], edges: EREdgeModel[]) {
    this.nodes = nodes.map((node) => new FakeNode(node));
    this.edges = edges.map((edge) => new FakeEdge(edge));
  }

  on(event: string, handler: (e: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  getNodes(): FakeNode[] {
    return this.nodes;
  }

  getEdges(): FakeEdge[] {
    return this.edges;
  }

  updateItem(item: unknown, model: Record<string, unknown>): void {
    Object.assign((item as FakeNode).getModel(), model);
  }
}

const runFrames = (count: number, frames: FrameRequestCallback[]): void => {
  for (let i = 0; i < count; i++) {
    const frame = frames.shift();
    if (!frame) return;
    frame(i * 16);
  }
};

describe("force loop", () => {
  it("stops cross-component repulsion after disconnected components are far enough apart", () => {
    const nodes: ERNodeModel[] = [
      { id: "entity-a", type: "entity", nodeType: "entity", label: "a", x: 0, y: 0 },
      { id: "entity-b", type: "entity", nodeType: "entity", label: "b", x: 320, y: 0 },
    ];
    const graph = new FakeGraph(nodes, []);
    const frames: FrameRequestCallback[] = [];
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;

    try {
      const controller = attachForceLoop(graph as any);
      controller.setEnabled(true);
      runFrames(24, frames);
      controller.destroy();

      expect(nodes[0].x).toBeCloseTo(0, 6);
      expect(nodes[1].x).toBeCloseTo(320, 6);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancelRaf;
    }
  });
});
