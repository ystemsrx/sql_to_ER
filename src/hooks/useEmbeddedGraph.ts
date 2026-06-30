import { useCallback, useEffect, useRef, useState } from "react";
import { measureNodeSize, patchRelationshipLinkPoints } from "../builder";
import { setupNodeDoubleClickEdit } from "../editor";
import { createManager as createHistoryManager, type HistoryManager } from "../history";
import { animateNodesToTargets, smoothFitView } from "../layout";
import { createERGraph } from "../graph/createERGraph";
import { attachEntityDragSync, type DragChangeMeta } from "../graph/attachEntityDragSync";
import { attachForceLoop, type ForceLoopController } from "../graph/forceLoop";
import { updateGraphStyles } from "../graph/updateGraphStyles";
import { computeAutoAvoidTargets } from "../graph/autoAvoid";
import * as AttributeLayout from "../attributeLayout";
import type { EmbeddedGraphState, EREdgeModel, ERNodeModel, GraphLike } from "../types";

const clampFontScale = (scale: number): number => {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(1.6, Math.max(0.4, scale));
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const normalizeState = (state: EmbeddedGraphState): EmbeddedGraphState => ({
  version: state.version ?? 1,
  input: state.input ?? "",
  format: state.format ?? "sql",
  settings: {
    colored: state.settings?.colored !== false,
    comment: !!state.settings?.comment,
    hideAttrs: !!state.settings?.hideAttrs,
    fontScale: clampFontScale(Number(state.settings?.fontScale ?? 1)),
    attrMode: state.settings?.attrMode ?? "auto",
    autoAvoid: false,
  },
  nodes: clone(state.nodes ?? []),
  edges: clone(state.edges ?? []),
});

interface RenderableGraph extends GraphLike {
  data(data: { nodes: unknown[]; edges: unknown[] }): void;
  render(): void;
  save?(): { nodes?: unknown[]; edges?: unknown[] };
}

interface MutableRenderableGraph extends RenderableGraph {
  addItem(type: "node" | "edge", model: Record<string, unknown>): void;
  removeItem(item: unknown): void;
}

interface AttributeSnapshot {
  nodes: ERNodeModel[];
  edges: EREdgeModel[];
}

const snapshotAttributes = (
  nodes: ERNodeModel[] | undefined,
  edges: EREdgeModel[] | undefined,
): AttributeSnapshot => {
  const attrNodes = (nodes ?? []).filter((node) => node.nodeType === "attribute");
  const attrIds = new Set(attrNodes.map((node) => node.id));
  return {
    nodes: clone(attrNodes),
    edges: clone(
      (edges ?? []).filter(
        (edge) =>
          edge.edgeType === "entity-attribute" ||
          attrIds.has(edge.source) ||
          attrIds.has(edge.target),
      ),
    ),
  };
};

export interface UseEmbeddedGraphResult {
  containerRef: ReturnType<typeof useRef<HTMLDivElement | null>>;
  graphRef: ReturnType<typeof useRef<GraphLike | null>>;
  historyRef: ReturnType<typeof useRef<HistoryManager>>;
  inputText: string;
  isColored: boolean;
  hideFields: boolean;
  fontScale: number;
  forceOn: boolean;
  autoAvoid: boolean;
  hasGraph: boolean;
  error: string | null;
  setError: (next: string | null) => void;
  setIsColored: (next: boolean) => void;
  setHideFields: (next: boolean) => void;
  setFontScale: (next: number) => void;
  setForceOn: (next: boolean) => void;
  setAutoAvoid: (next: boolean) => void;
  fitView: () => void;
  currentState: () => EmbeddedGraphState;
}

export function useEmbeddedGraph(initialState: EmbeddedGraphState): UseEmbeddedGraphResult {
  const normalizedRef = useRef<EmbeddedGraphState | null>(null);
  if (normalizedRef.current === null) {
    normalizedRef.current = normalizeState(initialState);
  }
  const settings = normalizedRef.current.settings ?? {};

  const [isColored, setIsColoredState] = useState(settings.colored !== false);
  const [hideFields, setHideFieldsState] = useState(settings.hideAttrs === true);
  const [fontScale, setFontScaleState] = useState(clampFontScale(Number(settings.fontScale ?? 1)));
  const [forceOn, setForceOnState] = useState(false);
  const [autoAvoid, setAutoAvoidState] = useState(false);
  const [hasGraph, setHasGraph] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<GraphLike | null>(null);
  const historyRef = useRef<HistoryManager>(createHistoryManager());
  const forceCtrlRef = useRef<ForceLoopController | null>(null);
  const forceOnRef = useRef(false);
  const autoAvoidRef = useRef(false);
  const fontScaleAutoAvoidTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attributeSnapshotRef = useRef<AttributeSnapshot>(
    snapshotAttributes(normalizedRef.current.nodes, normalizedRef.current.edges),
  );

  forceOnRef.current = forceOn;
  autoAvoidRef.current = autoAvoid;

  const disableForceIfOn = useCallback(() => {
    if (!forceOnRef.current) return;
    forceOnRef.current = false;
    setForceOnState(false);
    forceCtrlRef.current?.setEnabled(false);
  }, []);

  const graphNodeSize = useCallback((node: ERNodeModel) => {
    const item = graphRef.current?.findById(node.id);
    if (item && "getBBox" in item) {
      const bbox = item.getBBox();
      return { width: bbox.width, height: bbox.height };
    }
    return measureNodeSize(node);
  }, []);

  const syncGraphSize = useCallback((graph: GraphLike, container: HTMLElement) => {
    const measured = container.parentElement ?? container;
    const rect = measured.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || measured.clientWidth));
    const height = Math.max(1, Math.round(rect.height || measured.clientHeight));
    graph.changeSize?.(width, height);
  }, []);

  const applyGraphAutoAvoid = useCallback(
    (duration = 300, onFinish?: () => void): boolean => {
      const graph = graphRef.current;
      if (!graph || graph.destroyed) {
        onFinish?.();
        return false;
      }
      const nodes = graph.getNodes().map((node) => node.getModel() as ERNodeModel);
      const edges = graph.getEdges().map((edge) => edge.getModel());
      const targets = computeAutoAvoidTargets(nodes, graphNodeSize, { edges });
      if (!targets.size) {
        patchRelationshipLinkPoints(graph);
        graph.refresh?.();
        onFinish?.();
        return false;
      }
      animateNodesToTargets(graph, targets, duration, () => {
        patchRelationshipLinkPoints(graph);
        graph.refresh?.();
        onFinish?.();
      });
      return true;
    },
    [graphNodeSize],
  );

  const cancelScheduledFontScaleAutoAvoid = useCallback(() => {
    if (fontScaleAutoAvoidTimerRef.current === null) return;
    clearTimeout(fontScaleAutoAvoidTimerRef.current);
    fontScaleAutoAvoidTimerRef.current = null;
  }, []);

  const scheduleFontScaleAutoAvoid = useCallback(
    (delayMs = 180) => {
      if (!autoAvoidRef.current) return;
      cancelScheduledFontScaleAutoAvoid();
      fontScaleAutoAvoidTimerRef.current = setTimeout(() => {
        fontScaleAutoAvoidTimerRef.current = null;
        applyGraphAutoAvoid(220);
      }, delayMs);
    },
    [applyGraphAutoAvoid, cancelScheduledFontScaleAutoAvoid],
  );

  const handleAfterGraphChange = useCallback(
    (meta?: DragChangeMeta) => {
      const graph = graphRef.current;
      if (!graph || graph.destroyed) return;
      cancelScheduledFontScaleAutoAvoid();
      if (autoAvoidRef.current && !meta?.autoAvoidMerged) {
        applyGraphAutoAvoid(300);
        return;
      }
      patchRelationshipLinkPoints(graph);
      graph.refresh?.();
    },
    [applyGraphAutoAvoid, cancelScheduledFontScaleAutoAvoid],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const state = normalizeState(initialState);
    normalizedRef.current = state;
    cancelScheduledFontScaleAutoAvoid();
    const nextSettings = state.settings ?? {};
    autoAvoidRef.current = false;
    forceOnRef.current = false;
    setIsColoredState(nextSettings.colored !== false);
    setHideFieldsState(nextSettings.hideAttrs === true);
    setFontScaleState(clampFontScale(Number(nextSettings.fontScale ?? 1)));
    setForceOnState(false);
    setAutoAvoidState(false);
    setError(null);

    const nodes = clone(state.nodes);
    const edges = clone(state.edges);
    attributeSnapshotRef.current = snapshotAttributes(nodes, edges);
    const graph = createERGraph({ container, data: { nodes, edges } }) as RenderableGraph;
    graphRef.current = graph;
    forceCtrlRef.current?.destroy();
    forceCtrlRef.current = null;
    historyRef.current.reset();

    graph.data({ nodes, edges });
    graph.render();
    updateGraphStyles(
      graph,
      nextSettings.colored !== false,
      clampFontScale(Number(nextSettings.fontScale ?? 1)),
    );
    if (nextSettings.hideAttrs === true) {
      AttributeLayout.hideAttributes(graph as MutableRenderableGraph);
    }
    patchRelationshipLinkPoints(graph);
    setHasGraph(true);

    setupNodeDoubleClickEdit(graph as any, container, {
      onBeforeChange: () => historyRef.current.record(graph),
      onAfterChange: handleAfterGraphChange,
    });
    attachEntityDragSync(
      graph as any,
      historyRef.current,
      () => false,
      handleAfterGraphChange,
      (projectedNodes, projectedEdges) => {
        if (!autoAvoidRef.current) return new Map();
        return computeAutoAvoidTargets(projectedNodes, graphNodeSize, {
          edges: projectedEdges,
          movableIds: projectedNodes
            .filter((node) => node.nodeType !== "entity")
            .map((node) => node.id),
        });
      },
    );
    forceCtrlRef.current = attachForceLoop(graph as any);

    requestAnimationFrame(() => syncGraphSize(graph, container));
    window.setTimeout(() => {
      syncGraphSize(graph, container);
      smoothFitView(graph, 500, "easeOutQuart");
    }, 120);

    return () => {
      cancelScheduledFontScaleAutoAvoid();
      forceCtrlRef.current?.destroy();
      forceCtrlRef.current = null;
      graph.destroy?.();
      graphRef.current = null;
      setHasGraph(false);
    };
  }, [initialState, graphNodeSize, handleAfterGraphChange, syncGraphSize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frameId: number | null = null;
    const resize = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        frameId = null;
        if (graphRef.current && containerRef.current) {
          syncGraphSize(graphRef.current, containerRef.current);
        }
      });
    };

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            resize();
          })
        : null;
    observer?.observe(container);
    if (container.parentElement) observer?.observe(container.parentElement);

    const handleResize = () => {
      if (graphRef.current && containerRef.current) {
        resize();
      }
    };
    window.addEventListener("resize", handleResize);
    resize();

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      observer?.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [syncGraphSize]);

  const setIsColored = (next: boolean) => {
    setIsColoredState(next);
    const graph = graphRef.current;
    if (!graph || graph.destroyed) return;
    updateGraphStyles(graph, next, fontScale);
    patchRelationshipLinkPoints(graph);
    graph.refresh?.();
  };

  const setHideFields = (next: boolean) => {
    setHideFieldsState(next);
    const graph = graphRef.current as MutableRenderableGraph | null;
    if (!graph || graph.destroyed) return;
    disableForceIfOn();
    historyRef.current.reset();

    if (next) {
      const saved = typeof graph.save === "function" ? graph.save() : null;
      attributeSnapshotRef.current = snapshotAttributes(
        saved?.nodes as ERNodeModel[] | undefined,
        saved?.edges as EREdgeModel[] | undefined,
      );
      AttributeLayout.hideAttributes(graph);
      handleAfterGraphChange();
      return;
    }

    const attrNodes = clone(attributeSnapshotRef.current.nodes).filter((node) => {
      if (!node.id || graph.findById(node.id)) return false;
      return typeof node.parentEntity === "string" && !!graph.findById(node.parentEntity);
    });
    if (!attrNodes.length) {
      handleAfterGraphChange();
      return;
    }

    AttributeLayout.computeAttributePositions(
      graph,
      attrNodes as Parameters<typeof AttributeLayout.computeAttributePositions>[1],
    );
    const attrIds = new Set(attrNodes.map((node) => node.id));
    const attrEdges = clone(attributeSnapshotRef.current.edges).filter((edge) => {
      if (edge.id && graph.findById(edge.id)) return false;
      const touchesRestoredAttr = attrIds.has(edge.source) || attrIds.has(edge.target);
      if (!touchesRestoredAttr) return false;
      const sourceExists = attrIds.has(edge.source) || !!graph.findById(edge.source);
      const targetExists = attrIds.has(edge.target) || !!graph.findById(edge.target);
      return sourceExists && targetExists;
    });

    graph.setAutoPaint(false);
    attrNodes.forEach((node) => graph.addItem("node", node as unknown as Record<string, unknown>));
    attrEdges.forEach((edge) => graph.addItem("edge", edge as unknown as Record<string, unknown>));
    graph.paint();
    graph.setAutoPaint(true);
    updateGraphStyles(graph, isColored, fontScale);
    handleAfterGraphChange();
  };

  const setFontScale = (next: number) => {
    const safeNext = clampFontScale(next);
    setFontScaleState(safeNext);
    const graph = graphRef.current;
    if (!graph || graph.destroyed) return;
    updateGraphStyles(graph, isColored, safeNext);
    patchRelationshipLinkPoints(graph);
    graph.refresh?.();
    scheduleFontScaleAutoAvoid();
  };

  const setForceOn = (next: boolean) => {
    const wasOn = forceOnRef.current;
    forceOnRef.current = next;
    setForceOnState(next);
    forceCtrlRef.current?.setEnabled(next);
    if (wasOn && !next) {
      requestAnimationFrame(() => {
        handleAfterGraphChange();
      });
    }
  };

  const setAutoAvoid = (next: boolean) => {
    autoAvoidRef.current = next;
    setAutoAvoidState(next);
    const graph = graphRef.current;
    if (!next) {
      cancelScheduledFontScaleAutoAvoid();
      return;
    }
    if (!graph || graph.destroyed) return;
    historyRef.current.record(graph);
    applyGraphAutoAvoid(360);
  };

  const fitView = () => {
    if (!graphRef.current || graphRef.current.destroyed) return;
    smoothFitView(graphRef.current, 500, "easeOutCubic");
  };

  const currentState = (): EmbeddedGraphState => {
    const base = normalizedRef.current ?? normalizeState(initialState);
    const graph = graphRef.current as RenderableGraph | null;
    const saved =
      graph && !graph.destroyed && typeof graph.save === "function" ? graph.save() : null;
    return {
      ...base,
      settings: {
        ...(base.settings ?? {}),
        colored: isColored,
        hideAttrs: hideFields,
        fontScale,
        autoAvoid,
      },
      nodes: clone((saved?.nodes ?? base.nodes) as EmbeddedGraphState["nodes"]),
      edges: clone((saved?.edges ?? base.edges) as EmbeddedGraphState["edges"]),
    };
  };

  return {
    containerRef,
    graphRef,
    historyRef,
    inputText: normalizedRef.current?.input ?? "",
    isColored,
    hideFields,
    fontScale,
    forceOn,
    autoAvoid,
    hasGraph,
    error,
    setError,
    setIsColored,
    setHideFields,
    setFontScale,
    setForceOn,
    setAutoAvoid,
    fitView,
    currentState,
  };
}
