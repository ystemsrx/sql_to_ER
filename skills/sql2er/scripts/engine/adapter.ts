/**
 * Headless GraphLike adapter.
 *
 * The app's layout / styling / export functions all operate on the GraphLike
 * interface (src/types.ts) — never on the DOM directly. This wraps a plain
 * { nodes, edges } model in just enough of that interface to run the *real*
 * forceAlignLayout / arrangeLayout / updateGraphStyles / buildDrawioXML in Node.
 *
 * getBBox() is reproduced from measureNodeSize() in the app builder, so headless
 * node sizes are byte-identical to what the browser renders.
 */
import { measureNodeSize } from "@app/builder";
import type { EREdgeModel, ERNodeModel, GraphLike, GraphNodeLike } from "@app/types";

export interface HeadlessGraph extends GraphLike {
  /** Live model arrays (mutated in place by layout). */
  nodeModels: ERNodeModel[];
  edgeModels: EREdgeModel[];
}

const makeBBox = (model: ERNodeModel) => {
  const { width, height } = measureNodeSize(model);
  const x = typeof model.x === "number" ? model.x : 0;
  const y = typeof model.y === "number" ? model.y : 0;
  const halfW = width / 2;
  const halfH = height / 2;
  return {
    minX: x - halfW,
    minY: y - halfH,
    maxX: x + halfW,
    maxY: y + halfH,
    width,
    height,
    centerX: x,
    centerY: y,
  };
};

export function createHeadlessGraph(
  nodeModels: ERNodeModel[],
  edgeModels: EREdgeModel[],
  width = 1200,
  height = 800,
): HeadlessGraph {
  const nodeObjs = nodeModels.map((model): GraphNodeLike => ({
    getModel: () => model,
    getID: () => model.id,
    getBBox: () => makeBBox(model),
    getContainer: () => ({}),
    destroyed: false,
  }));

  const edgeObjs = edgeModels.map((model) => ({
    getModel: () => model,
    destroyed: false,
  }));

  const byId = new Map<string, GraphNodeLike>(nodeObjs.map((n) => [n.getModel().id, n]));
  const edgeById = new Map<string, { getModel: () => EREdgeModel }>();
  edgeObjs.forEach((e) => {
    const id = e.getModel().id;
    if (id) edgeById.set(id, e);
  });

  const group = {
    getMatrix: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
    setMatrix: () => {},
  };

  let w = width;
  let h = height;

  const graph: HeadlessGraph = {
    nodeModels,
    edgeModels,
    destroyed: false,
    getNodes: () => nodeObjs,
    getEdges: () => edgeObjs as unknown as ReturnType<GraphLike["getEdges"]>,
    findById: (id: string) => byId.get(id) ?? (edgeById.get(id) as never) ?? null,
    updateItem: (item: unknown, model: Record<string, unknown>) => {
      const target = item as { getModel?: () => Record<string, unknown> };
      const m =
        typeof target?.getModel === "function"
          ? target.getModel()
          : (item as Record<string, unknown>);
      if (m && model) Object.assign(m, model);
    },
    setAutoPaint: () => {},
    paint: () => {},
    refresh: () => {},
    refreshPositions: () => {},
    get: (key: string) =>
      key === "width" ? w : key === "height" ? h : key === "group" ? group : undefined,
    getZoom: () => 1,
    zoomTo: () => {},
    fitView: () => {},
    clear: () => {},
    destroy: () => {},
    changeSize: (nextW: number, nextH: number) => {
      w = nextW;
      h = nextH;
    },
  };

  return graph;
}
