/**
 * Layout Animation Module
 * Contains animation functions for smooth layout transitions:
 * - Smooth view fitting with zoom animation
 * - Animated node movement to target positions
 */
import type { GraphLike } from "../types";

const nodeAnimationTokens = new WeakMap<GraphLike, number>();
const fitViewTokens = new WeakMap<GraphLike, number>();

const nextToken = (tokens: WeakMap<GraphLike, number>, graph: GraphLike) => {
  const token = (tokens.get(graph) ?? 0) + 1;
  tokens.set(graph, token);
  return token;
};

const isCurrentToken = (tokens: WeakMap<GraphLike, number>, graph: GraphLike, token: number) =>
  tokens.get(graph) === token;

/**
 * 真正有效的平滑缩放函数
 * @param {Object} graph - G6 图形实例
 * @param {number} duration - 动画持续时间（毫秒）
 * @param {string} easing - 缓动函数类型
 */
export const smoothFitView = (graph: GraphLike, duration = 800, easing = "easeOutCubic") => {
  if (!graph || graph.destroyed) return;

  const token = nextToken(fitViewTokens, graph);

  try {
    const nodes = graph.getNodes();
    if (!nodes || nodes.length === 0) {
      graph.fitView(20);
      return;
    }

    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;

    nodes.forEach((node) => {
      const bbox = node.getBBox();
      minX = Math.min(minX, bbox.minX);
      maxX = Math.max(maxX, bbox.maxX);
      minY = Math.min(minY, bbox.minY);
      maxY = Math.max(maxY, bbox.maxY);
    });

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const contentCenterX = (minX + maxX) / 2;
    const contentCenterY = (minY + maxY) / 2;

    if (contentWidth === 0 || contentHeight === 0) {
      graph.fitView(20);
      return;
    }

    const graphWidth = graph.get("width");
    const graphHeight = graph.get("height");
    const padding = 40;

    const scaleX = (graphWidth - padding * 2) / contentWidth;
    const scaleY = (graphHeight - padding * 2) / contentHeight;
    const targetZoom = Math.min(scaleX, scaleY);

    const targetCenterX = graphWidth / 2 - contentCenterX * targetZoom;
    const targetCenterY = graphHeight / 2 - contentCenterY * targetZoom;

    const currentZoom = graph.getZoom();
    const currentMatrix = graph.get("group").getMatrix();
    const currentCenterX = currentMatrix ? currentMatrix[6] : 0;
    const currentCenterY = currentMatrix ? currentMatrix[7] : 0;

    const startTime = performance.now();

    const animate = (currentTime: number) => {
      if (!graph || graph.destroyed || !isCurrentToken(fitViewTokens, graph, token)) return;

      const elapsed = currentTime - startTime;
      let progress = Math.min(elapsed / duration, 1);

      if (easing === "easeOutQuart") {
        progress = 1 - Math.pow(1 - progress, 4);
      } else {
        progress = 1 - Math.pow(1 - progress, 3);
      }

      const frameZoom = currentZoom + (targetZoom - currentZoom) * progress;
      const frameCenterX = currentCenterX + (targetCenterX - currentCenterX) * progress;
      const frameCenterY = currentCenterY + (targetCenterY - currentCenterY) * progress;

      const groupMatrix = [frameZoom, 0, 0, 0, frameZoom, 0, frameCenterX, frameCenterY, 1];
      graph.get("group").setMatrix(groupMatrix);
      graph.paint();

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
  } catch (error) {
    console.warn("Smooth fit view failed, falling back to instant fit:", error);
    graph.fitView(20);
  }
};

/**
 * 基于目标坐标的节点平滑移动
 * @param {Object} graph - G6 图形实例
 * @param {Map} targets - 目标位置映射 (nodeId -> {x, y})
 * @param {number} duration - 动画持续时间（毫秒）
 * @param {Function} onFinish - 动画完成回调
 */
export const animateNodesToTargets = (
  graph: GraphLike,
  targets: Map<string, { x?: number; y?: number }>,
  duration = 800,
  onFinish?: () => void,
) => {
  if (!graph || graph.destroyed || !targets?.size) {
    if (onFinish) onFinish();
    return;
  }

  const token = nextToken(nodeAnimationTokens, graph);
  nextToken(fitViewTokens, graph);

  const startPositions = new Map<string, { x?: number; y?: number }>();
  graph.getNodes().forEach((node) => {
    const model = node.getModel();
    startPositions.set(model.id, { x: model.x, y: model.y });
  });

  const startTime = performance.now();
  graph.setAutoPaint(false);

  const step = (currentTime: number) => {
    if (!graph || graph.destroyed || !isCurrentToken(nodeAnimationTokens, graph, token)) return;

    const elapsed = currentTime - startTime;
    const rawProgress = Math.min(elapsed / duration, 1);
    const progress = 1 - Math.pow(1 - rawProgress, 3);

    targets.forEach((target, id) => {
      const node = graph.findById(id);
      if (!node) return;
      const start = startPositions.get(id) || target;
      const startX = typeof start.x === "number" ? start.x : 0;
      const startY = typeof start.y === "number" ? start.y : 0;
      const targetX = typeof target.x === "number" ? target.x : startX;
      const targetY = typeof target.y === "number" ? target.y : startY;
      const x = startX + (targetX - startX) * progress;
      const y = startY + (targetY - startY) * progress;
      graph.updateItem(node, { x, y });
    });

    graph.paint();

    if (rawProgress < 1) {
      requestAnimationFrame(step);
    } else {
      graph.setAutoPaint(true);
      if (isCurrentToken(nodeAnimationTokens, graph, token) && onFinish) onFinish();
    }
  };

  requestAnimationFrame(step);
};
