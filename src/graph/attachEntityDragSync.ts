import type { GraphLike } from "../types";
import type { HistoryManager } from "../history";
import { animateNodesToTargets } from "../layout/animation";
import {
  computeAttributeRotationTargets,
  computeMovedEntityRelationshipTargets,
  type NodeSize,
} from "./entityMoveSync";

interface DraggableGraph extends GraphLike {
  on(event: string, handler: (e: any) => void): void;
  setItemState(item: unknown, state: string, value: boolean): void;
}

/**
 * 给 G6 graph 装上交互：
 *   1. node hover 高亮
 *   2. 拖任意节点之前压一次撤销快照
 *   3. 拖实体节点时同步带动它的属性节点（共同位移）
 *
 * 由 useGraph 在创建图后调用一次；不需要解绑（图本身 destroy 时事件随之消失）。
 *
 * 当 isForceActive 返回 true 时，跳过 (3) —— 让持续力导向控制器接管属性节点
 * 的位移；否则两者会同时改 attribute 坐标，互相覆盖。
 */
export function attachEntityDragSync(
  graph: DraggableGraph,
  history: HistoryManager,
  isForceActive?: () => boolean,
): void {
  graph.on("node:mouseenter", (e: any) => {
    graph.setItemState(e.item, "hover", true);
  });
  graph.on("node:mouseleave", (e: any) => {
    graph.setItemState(e.item, "hover", false);
  });

  let draggedEntity: any = null;
  let relatedAttributes: any[] = [];
  let affectedEntityIds = new Set<string>();
  const dragStartPositions = new Map<string, { x: number; y: number }>();

  const graphNodeModels = () => graph.getNodes().map((n: any) => n.getModel());
  const graphEdgeModels = () => graph.getEdges().map((e: any) => e.getModel());
  const measureNode = (model: { id?: string; width?: unknown; height?: unknown }): NodeSize => {
    const item = typeof model.id === "string" ? graph.findById(model.id) : null;
    const bbox =
      item && typeof (item as any).getBBox === "function" ? (item as any).getBBox() : null;
    if (bbox) return { width: bbox.width, height: bbox.height };
    return {
      width: typeof model.width === "number" ? model.width : 80,
      height: typeof model.height === "number" ? model.height : 40,
    };
  };

  const syncRelationshipDiamonds = (entityId: string): void => {
    const result = computeMovedEntityRelationshipTargets(
      graphNodeModels(),
      graphEdgeModels(),
      [entityId],
      measureNode,
    );
    affectedEntityIds = result.affectedEntityIds;
    result.relationshipTargets.forEach((target, id) => {
      const item = graph.findById(id);
      if (item) graph.updateItem(item, { x: target.x, y: target.y }, false);
    });
  };

  graph.on("node:dragstart", (e: any) => {
    const node = e.item;
    const nodeModel = node.getModel();

    // 在任何节点开始被拖动前记录一次快照（用于撤销）
    history.record(graph);

    if (nodeModel.type === "entity") {
      draggedEntity = node;
      relatedAttributes = [];
      affectedEntityIds = new Set([nodeModel.id]);
      dragStartPositions.clear();

      dragStartPositions.set(nodeModel.id, {
        x: nodeModel.x,
        y: nodeModel.y,
      });

      graph.getNodes().forEach((n: any) => {
        const model = n.getModel();
        if (model.type === "attribute" && model.parentEntity === nodeModel.id) {
          relatedAttributes.push(n);
          dragStartPositions.set(model.id, { x: model.x, y: model.y });
        }
      });
    }
  });

  graph.on("node:drag", (e: any) => {
    const node = e.item;
    const nodeModel = node.getModel();

    if (nodeModel.type === "entity" && draggedEntity === node) {
      if (isForceActive && isForceActive()) return;
      const startPos = dragStartPositions.get(nodeModel.id);
      if (startPos) {
        const deltaX = nodeModel.x - startPos.x;
        const deltaY = nodeModel.y - startPos.y;

        relatedAttributes.forEach((attrNode) => {
          const attrModel = attrNode.getModel();
          const attrStartPos = dragStartPositions.get(attrModel.id);
          if (attrStartPos) {
            graph.updateItem(attrNode, {
              x: attrStartPos.x + deltaX,
              y: attrStartPos.y + deltaY,
            });
          }
        });
        syncRelationshipDiamonds(nodeModel.id);
      }
    }
  });

  graph.on("node:dragend", (e: any) => {
    const node = e.item;
    const nodeModel = node.getModel();
    if (nodeModel.type === "entity" && draggedEntity === node) {
      if (!isForceActive || !isForceActive()) {
        const attrTargets = computeAttributeRotationTargets(
          graphNodeModels(),
          graphEdgeModels(),
          affectedEntityIds,
          measureNode,
        );
        if (attrTargets.size) animateNodesToTargets(graph, attrTargets, 260);
      }
      draggedEntity = null;
      relatedAttributes = [];
      affectedEntityIds = new Set();
      dragStartPositions.clear();
    }
  });
}
