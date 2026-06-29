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
  onAfterChange?: () => void,
): void {
  graph.on("node:mouseenter", (e: any) => {
    graph.setItemState(e.item, "hover", true);
  });
  graph.on("node:mouseleave", (e: any) => {
    graph.setItemState(e.item, "hover", false);
  });

  let draggedNode: any = null;
  let draggedNodeStart: { x: number; y: number } | null = null;
  let draggedEntity: any = null;
  let relatedAttributes: any[] = [];
  let affectedEntityIds = new Set<string>();
  let relationshipReturnOffsets = new Map<string, { dx: number; dy: number; startTime: number }>();
  let didDragNode = false;
  let didDragEntity = false;
  const dragStartPositions = new Map<string, { x: number; y: number }>();
  const RELATIONSHIP_SMOOTH_THRESHOLD = 2;
  const RELATIONSHIP_RETURN_DURATION = 280;

  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

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
      dragStartPositions,
    );
    affectedEntityIds = result.affectedEntityIds;
    result.relationshipTargets.forEach((target, id) => {
      const item = graph.findById(id);
      if (!item) return;
      const returnOffset = relationshipReturnOffsets.get(id);
      if (!returnOffset) {
        graph.updateItem(item, { x: target.x, y: target.y }, false);
        return;
      }

      const elapsed = performance.now() - returnOffset.startTime;
      const progress = clamp01(elapsed / RELATIONSHIP_RETURN_DURATION);
      if (progress >= 1) {
        relationshipReturnOffsets.delete(id);
        graph.updateItem(item, { x: target.x, y: target.y }, false);
        return;
      }
      const remaining = 1 - easeOutCubic(progress);
      graph.updateItem(
        item,
        {
          x: target.x + returnOffset.dx * remaining,
          y: target.y + returnOffset.dy * remaining,
        },
        false,
      );
    });
  };

  const markRelationshipsNeedingSmoothReturn = (entityId: string): void => {
    relationshipReturnOffsets = new Map();
    const startTime = performance.now();
    const result = computeMovedEntityRelationshipTargets(
      graphNodeModels(),
      graphEdgeModels(),
      [entityId],
      measureNode,
    );
    result.relationshipTargets.forEach((target, id) => {
      const item = graph.findById(id);
      if (!item || typeof (item as any).getModel !== "function") return;
      const model = (item as any).getModel();
      const currentX = typeof model.x === "number" ? model.x : target.x;
      const currentY = typeof model.y === "number" ? model.y : target.y;
      const dx = currentX - target.x;
      const dy = currentY - target.y;
      if (Math.hypot(dx, dy) <= RELATIONSHIP_SMOOTH_THRESHOLD) return;
      relationshipReturnOffsets.set(id, { dx, dy, startTime });
    });
  };

  const markDraggedNodeMoved = (nodeModel: { x?: number; y?: number }): boolean => {
    if (!draggedNodeStart) return false;
    const dx = (nodeModel.x ?? 0) - draggedNodeStart.x;
    const dy = (nodeModel.y ?? 0) - draggedNodeStart.y;
    if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
      didDragNode = true;
      return true;
    }
    return didDragNode;
  };

  const notifyAfterChange = (shouldNotify = didDragNode) => {
    if (!shouldNotify || typeof onAfterChange !== "function") return;
    try {
      onAfterChange();
    } catch (_e) {
      /* ignore persistence callback failures */
    }
  };

  const resetDragState = () => {
    draggedNode = null;
    draggedNodeStart = null;
    draggedEntity = null;
    relatedAttributes = [];
    affectedEntityIds = new Set();
    relationshipReturnOffsets = new Map();
    didDragNode = false;
    didDragEntity = false;
    dragStartPositions.clear();
  };

  graph.on("node:dragstart", (e: any) => {
    const node = e.item;
    const nodeModel = node.getModel();

    // 在任何节点开始被拖动前记录一次快照（用于撤销）
    history.record(graph);
    draggedNode = node;
    draggedNodeStart = {
      x: typeof nodeModel.x === "number" ? nodeModel.x : 0,
      y: typeof nodeModel.y === "number" ? nodeModel.y : 0,
    };
    didDragNode = false;

    if (nodeModel.type === "entity") {
      draggedEntity = node;
      relatedAttributes = [];
      affectedEntityIds = new Set([nodeModel.id]);
      relationshipReturnOffsets = new Map();
      didDragEntity = false;
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
        } else if (model.type === "relationship") {
          dragStartPositions.set(model.id, { x: model.x, y: model.y });
        }
      });
      markRelationshipsNeedingSmoothReturn(nodeModel.id);
    }
  });

  graph.on("node:drag", (e: any) => {
    const node = e.item;
    const nodeModel = node.getModel();
    if (draggedNode === node) {
      markDraggedNodeMoved(nodeModel);
    }

    if (nodeModel.type === "entity" && draggedEntity === node) {
      const startPos = dragStartPositions.get(nodeModel.id);
      if (startPos) {
        const deltaX = nodeModel.x - startPos.x;
        const deltaY = nodeModel.y - startPos.y;
        if (didDragNode || Math.abs(deltaX) > 0.001 || Math.abs(deltaY) > 0.001) {
          didDragEntity = true;
        }

        if (isForceActive && isForceActive()) return;

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
    if (draggedNode === node) {
      markDraggedNodeMoved(nodeModel);
    }
    if (nodeModel.type === "entity" && draggedEntity === node) {
      const shouldNotify = didDragNode;
      const notifyEntityChange = () => notifyAfterChange(shouldNotify);
      if (!isForceActive || !isForceActive()) {
        const relationshipResult = computeMovedEntityRelationshipTargets(
          graphNodeModels(),
          graphEdgeModels(),
          [nodeModel.id],
          measureNode,
          dragStartPositions,
        );
        const finalNodeModels = graphNodeModels().map((model) => {
          const target = relationshipResult.relationshipTargets.get(model.id);
          return target ? { ...model, x: target.x, y: target.y } : model;
        });
        const attrTargets = computeAttributeRotationTargets(
          finalNodeModels,
          graphEdgeModels(),
          relationshipResult.affectedEntityIds.size
            ? relationshipResult.affectedEntityIds
            : affectedEntityIds,
          measureNode,
        );
        const finalTargets = new Map(attrTargets);
        if (didDragEntity) {
          relationshipResult.relationshipTargets.forEach((target, id) => {
            if (relationshipReturnOffsets.has(id)) finalTargets.set(id, target);
          });
        }
        if (finalTargets.size)
          animateNodesToTargets(
            graph,
            finalTargets,
            RELATIONSHIP_RETURN_DURATION,
            notifyEntityChange,
          );
        else notifyEntityChange();
      } else {
        notifyEntityChange();
      }
      resetDragState();
      return;
    }

    if (draggedNode === node) {
      notifyAfterChange();
      resetDragState();
    }
  });
}
