import { describe, expect, it, vi } from "vitest";
import { animateNodesToTargets, smoothFitView } from "../layout/animation";
import type { ERNodeModel, GraphLike, GraphNodeLike } from "../types";

class TestNode implements GraphNodeLike {
  constructor(private model: ERNodeModel) {}

  getModel(): ERNodeModel {
    return this.model;
  }

  getBBox() {
    const x = this.model.x ?? 0;
    const y = this.model.y ?? 0;
    return {
      minX: x - 50,
      minY: y - 50,
      maxX: x + 50,
      maxY: y + 50,
      width: 100,
      height: 100,
      centerX: x,
      centerY: y,
    };
  }
}

class TestGraph implements GraphLike {
  destroyed = false;
  nodes: TestNode[];
  matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  autoPaint = true;

  constructor(models: ERNodeModel[]) {
    this.nodes = models.map((model) => new TestNode(model));
  }

  getNodes(): GraphNodeLike[] {
    return this.nodes;
  }

  getEdges() {
    return [];
  }

  findById(id: string) {
    return this.nodes.find((node) => node.getModel().id === id) ?? null;
  }

  updateItem(item: unknown, model: Record<string, unknown>): void {
    Object.assign((item as TestNode).getModel(), model);
  }

  setAutoPaint(enabled: boolean): void {
    this.autoPaint = enabled;
  }

  paint(): void {}

  refreshPositions(): void {}

  get(key: string): unknown {
    if (key === "width") return 200;
    if (key === "height") return 200;
    if (key === "group") {
      return {
        getMatrix: () => this.matrix,
        setMatrix: (matrix: number[]) => {
          this.matrix = matrix;
        },
      };
    }
    return undefined;
  }

  getZoom(): number {
    return 1;
  }
}

describe("layout animation", () => {
  const withAnimationFrame = (callbacks: FrameRequestCallback[]) => {
    const target = globalThis as typeof globalThis & {
      requestAnimationFrame?: typeof requestAnimationFrame;
    };
    const originalRaf = target.requestAnimationFrame;
    target.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as typeof requestAnimationFrame;
    return () => {
      if (originalRaf) target.requestAnimationFrame = originalRaf;
      else delete target.requestAnimationFrame;
    };
  };

  it("does not move nodes away from their target when the first animation frame timestamp is early", () => {
    const graph = new TestGraph([{ id: "entity-users", x: 0, y: 0 }]);
    const callbacks: FrameRequestCallback[] = [];
    const restoreRaf = withAnimationFrame(callbacks);
    const nowSpy = vi.spyOn(globalThis.performance, "now").mockReturnValue(100);

    try {
      animateNodesToTargets(graph, new Map([["entity-users", { x: 100, y: 100 }]]), 800);
      callbacks[0](90);

      expect(graph.nodes[0].getModel().x).toBeGreaterThanOrEqual(0);
      expect(graph.nodes[0].getModel().y).toBeGreaterThanOrEqual(0);
    } finally {
      restoreRaf();
      nowSpy.mockRestore();
    }
  });

  it("does not zoom or pan backwards when the first fit-view frame timestamp is early", () => {
    const graph = new TestGraph([{ id: "entity-users", x: 0, y: 0 }]);
    const callbacks: FrameRequestCallback[] = [];
    const restoreRaf = withAnimationFrame(callbacks);
    const nowSpy = vi.spyOn(globalThis.performance, "now").mockReturnValue(100);

    try {
      smoothFitView(graph, 800, "easeOutCubic");
      callbacks[0](90);

      expect(graph.matrix[0]).toBeGreaterThanOrEqual(1);
      expect(graph.matrix[4]).toBeGreaterThanOrEqual(1);
      expect(graph.matrix[6]).toBeGreaterThanOrEqual(0);
      expect(graph.matrix[7]).toBeGreaterThanOrEqual(0);
    } finally {
      restoreRaf();
      nowSpy.mockRestore();
    }
  });
});
