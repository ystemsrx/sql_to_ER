import { useEffect, useRef, useState } from "react";
import { I18N, isInitialSampleInput, type Language } from "../i18n";
import { detectLang } from "../language";
import { parseSQLTables } from "../parser/sql";
import { parseDBML } from "../parser/dbml";
import { generateChenModelData, measureNodeSize, patchRelationshipLinkPoints } from "../builder";
import {
  applyInitialComponentPositions,
  applySkeletonLayout,
  animateNodesToTargets,
  arrangeLayout,
  cancelNodeAnimation,
  placeAttributesModerate,
  smoothFitView,
  spreadDisconnectedComponents,
} from "../layout";
import { setupNodeDoubleClickEdit } from "../editor";
import { createManager as createHistoryManager } from "../history";
import * as Snapshots from "../snapshots";
import * as AttributeLayout from "../attributeLayout";
import { createERGraph, buildDefaultLayoutCfg } from "../graph/createERGraph";
import { attachEntityDragSync, type DragChangeMeta } from "../graph/attachEntityDragSync";
import { attachForceLoop } from "../graph/forceLoop";
import type { ForceLoopController } from "../graph/forceLoop";
import { applyFontScaleToModels, updateGraphStyles } from "../graph/updateGraphStyles";
import {
  applyLayoutSizeScaleToEdges,
  applySizeChangeToGraph,
  captureGraphGeometry,
  computeLayoutSizeScale,
} from "../graph/sizeAwareGeometry";
import { computeAutoAvoidTargets } from "../graph/autoAvoid";
import { useSnapshotPersistence, type PersistMeta } from "./useSnapshotPersistence";
import { readEditorDraft, writeEditorDraft, type EditorDraft } from "../sessionDraft";
import type {
  EREdgeModel,
  ERNodeModel,
  GraphLike,
  ParsedTable,
  ParserWarning,
  SnapshotRecord,
} from "../types";
import type { HistoryManager } from "../history";

type Translation = (typeof I18N)[keyof typeof I18N];

export interface GenerateOptions {
  inputText?: string;
  isColored?: boolean;
  showComment?: boolean;
  hideFields?: boolean;
  fontScale?: number;
  autoAvoid?: boolean;
  positionMap?: Map<string, { x?: number; y?: number; label?: string }> | null;
}

export interface UseGraphOptions {
  t: Translation;
  initialLang?: Language;
}

export interface UseGraphResult {
  // refs
  containerRef: ReturnType<typeof useRef<HTMLDivElement | null>>;
  graphRef: ReturnType<typeof useRef<GraphLike | null>>;
  historyRef: ReturnType<typeof useRef<HistoryManager>>;
  lastInputRef: ReturnType<typeof useRef<string>>;
  // state
  inputText: string;
  isColored: boolean;
  showComment: boolean;
  hideFields: boolean;
  fontScale: number;
  forceOn: boolean;
  autoAvoid: boolean;
  hasGraph: boolean;
  error: string | null;
  errorVisible: boolean;
  parserWarnings: ParserWarning[];
  parserWarningsVisible: boolean;
  loading: boolean;
  // mutators (combine setState + side effect when applicable)
  setInputText: (next: string) => void;
  setIsColored: (next: boolean) => void;
  setShowComment: (next: boolean) => void;
  setHideFields: (next: boolean) => void;
  setFontScale: (next: number) => void;
  setForceOn: (next: boolean) => void;
  setAutoAvoid: (next: boolean) => void;
  setError: (next: string | null) => void;
  dismissParserWarnings: () => void;
  // commands
  handleGenerate: (opts?: GenerateOptions) => void;
  handleQuickLayout: () => void;
  handleArrangeLayout: () => void;
  restoreFromSnapshot: (snap: SnapshotRecord) => void;
  persistSnapshot: (meta: PersistMeta) => Promise<void>;
  persistCurrentSnapshot: () => Promise<void>;
  scheduleCurrentSnapshotPersist: (delayMs?: number) => void;
  settleAfterRotation: () => void;
}

/**
 * useGraph 拥有图相关的所有可变状态（输入文本 + 三个视觉开关 + 图实例）
 * 并对外暴露 mutator 而非裸 setState。
 *
 * 设计要点：
 *  - 状态变化通过 mutator 同步触发对应图操作；不再用 useEffect 监听 props
 *    然后用 ref 压制重入（旧的 applied*Ref 模式删除）。
 *  - StrictMode dev 下挂载会跑 setup→cleanup→setup 一次，schedulePersist 投递的
 *    延迟保存被 cancelPendingPersist 吞掉，第二次 setup 重建图。生产模式正常一次。
 *  - pendingSaveTimer 卸载时统一被 useSnapshotPersistence 取消。
 */
export function useGraph({ t, initialLang }: UseGraphOptions): UseGraphResult {
  const lang = initialLang ?? (detectLang() as Language);

  const [inputText, setInputTextState] = useState<string>(I18N[lang].sample);
  const [isColored, setIsColoredState] = useState(true);
  const [showComment, setShowCommentState] = useState(false);
  const [hideFields, setHideFieldsState] = useState(false);
  const [fontScale, setFontScaleState] = useState(1);
  const [forceOn, setForceOnState] = useState(false);
  const [autoAvoid, setAutoAvoidState] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);
  const [errorVisible, setErrorVisible] = useState(false);
  const [parserWarnings, setParserWarnings] = useState<ParserWarning[]>([]);
  const [parserWarningsVisible, setParserWarningsVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasGraph, setHasGraph] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<GraphLike | null>(null);
  const lastInputRef = useRef("");
  const tablesDataRef = useRef<ParsedTable[] | null>(null);
  // 撤销快照除节点位置/标签外还带图级设置（字号/注释模式），通过 ref 间接
  // 绑定 capture/apply 回调（真正的实现在下方 mutators 定义完之后赋值）。
  const historyMetaHooksRef = useRef<{
    capture: () => unknown;
    apply: (meta: unknown) => void;
  }>({ capture: () => undefined, apply: () => {} });
  const historyRef = useRef<HistoryManager>(
    createHistoryManager({
      captureMeta: () => historyMetaHooksRef.current.capture(),
      applyMeta: (meta) => historyMetaHooksRef.current.apply(meta),
    }),
  );
  const forceCtrlRef = useRef<ForceLoopController | null>(null);
  const forceOnRef = useRef(false);
  const autoAvoidRef = useRef(false);
  const errorShowFrameRef = useRef<number | null>(null);
  const parserWarningsHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const parserWarningsShowFrameRef = useRef<number | null>(null);

  // 持有最新的 t/state 供 handleGenerate 在 stale closure 之外读到。
  // mutator 同步走 next 显式参数；这个 ref 主要给"用户直接点 Generate 按钮"
  // 这种没有显式 opts 的路径用。
  const stateRef = useRef({
    inputText,
    isColored,
    showComment,
    hideFields,
    fontScale,
    autoAvoid,
    t,
  });
  stateRef.current = {
    inputText,
    isColored,
    showComment,
    hideFields,
    fontScale,
    autoAvoid,
    t,
  };

  const persistence = useSnapshotPersistence({ graphRef, containerRef });
  const { persistSnapshot, schedulePersist, cancelPendingPersist } = persistence;

  const currentPersistMeta = (): PersistMeta | null => {
    const graph = graphRef.current;
    if (!graph || graph.destroyed) return null;
    const input = lastInputRef.current || stateRef.current.inputText;
    const trimmed = String(input || "").trim();
    if (!trimmed || isInitialSampleInput(trimmed)) return null;
    return {
      id: Snapshots.hashInput(trimmed),
      inputText: trimmed,
      isColored: stateRef.current.isColored,
      showComment: stateRef.current.showComment,
      hideFields: stateRef.current.hideFields,
      fontScale: stateRef.current.fontScale,
    };
  };

  const scheduleCurrentSnapshotPersist = (delayMs = 700) => {
    const meta = currentPersistMeta();
    if (!meta) return;
    schedulePersist(meta, delayMs);
  };

  const persistCurrentSnapshot = (): Promise<void> => {
    const meta = currentPersistMeta();
    if (!meta) return Promise.resolve();
    cancelPendingPersist();
    return persistSnapshot(meta);
  };

  const applyGraphStyles = (graph: GraphLike | null, colored: boolean, scale: number) => {
    updateGraphStyles(graph, colored, scale);
    if (graph && !graph.destroyed) patchRelationshipLinkPoints(graph);
  };

  const graphNodeSize = (node: ERNodeModel) => {
    const item = graphRef.current?.findById(node.id);
    if (item && "getBBox" in item) {
      const bbox = item.getBBox();
      return { width: bbox.width, height: bbox.height };
    }
    return measureNodeSize(node);
  };

  const applyGraphAutoAvoid = (duration = 300, onFinish?: () => void): boolean => {
    const graph = graphRef.current;
    if (!graph || graph.destroyed) {
      onFinish?.();
      return false;
    }
    const nodes = graph.getNodes().map((node) => node.getModel() as ERNodeModel);
    const edges = graph.getEdges().map((edge) => edge.getModel());
    const targets = computeAutoAvoidTargets(nodes, graphNodeSize, { edges });
    if (!targets.size) {
      onFinish?.();
      return false;
    }
    animateNodesToTargets(graph, targets, duration, () => {
      patchRelationshipLinkPoints(graph);
      graph.refresh?.();
      onFinish?.();
    });
    return true;
  };

  const persistAfterOptionalAutoAvoid = (delayMs = 0, meta?: DragChangeMeta) => {
    if (autoAvoidRef.current && !meta?.autoAvoidMerged) {
      applyGraphAutoAvoid(300, () => {
        if (delayMs > 0) scheduleCurrentSnapshotPersist(delayMs);
        else void persistCurrentSnapshot();
      });
      return;
    }
    if (delayMs > 0) scheduleCurrentSnapshotPersist(delayMs);
    else void persistCurrentSnapshot();
  };

  // Ctrl+滚轮旋转结束后，开启自动避让时重新检查旋转后的节点/连线几何，
  // 动画完成再保存；未开启时仍沿用原来的立即保存行为。
  const settleAfterRotation = () => {
    persistAfterOptionalAutoAvoid();
  };

  const clearParserWarningHideTimer = () => {
    if (parserWarningsHideTimerRef.current === null) return;
    clearTimeout(parserWarningsHideTimerRef.current);
    parserWarningsHideTimerRef.current = null;
  };

  const cancelParserWarningShowFrame = () => {
    if (parserWarningsShowFrameRef.current === null) return;
    cancelAnimationFrame(parserWarningsShowFrameRef.current);
    parserWarningsShowFrameRef.current = null;
  };

  const scheduleParserWarningFadeIn = () => {
    cancelParserWarningShowFrame();
    parserWarningsShowFrameRef.current = requestAnimationFrame(() => {
      parserWarningsShowFrameRef.current = requestAnimationFrame(() => {
        parserWarningsShowFrameRef.current = null;
        setParserWarningsVisible(true);
      });
    });
  };

  const showParserWarnings = (warnings: ParserWarning[]) => {
    clearParserWarningHideTimer();
    cancelParserWarningShowFrame();
    setParserWarningsVisible(false);
    if (warnings.length === 0) {
      setParserWarnings([]);
      return;
    }
    setParserWarnings(warnings);
    scheduleParserWarningFadeIn();
  };

  const dismissParserWarnings = () => {
    cancelParserWarningShowFrame();
    setParserWarningsVisible(false);
    clearParserWarningHideTimer();
    parserWarningsHideTimerRef.current = setTimeout(() => {
      parserWarningsHideTimerRef.current = null;
      setParserWarnings([]);
    }, 180);
  };

  const cancelErrorShowFrame = () => {
    if (errorShowFrameRef.current === null) return;
    cancelAnimationFrame(errorShowFrameRef.current);
    errorShowFrameRef.current = null;
  };

  const scheduleErrorFadeIn = () => {
    cancelErrorShowFrame();
    errorShowFrameRef.current = requestAnimationFrame(() => {
      errorShowFrameRef.current = requestAnimationFrame(() => {
        errorShowFrameRef.current = null;
        setErrorVisible(true);
      });
    });
  };

  const setError = (next: string | null) => {
    cancelErrorShowFrame();
    setErrorVisible(false);
    if (!next) {
      setErrorState(null);
      return;
    }
    setErrorState(next);
    scheduleErrorFadeIn();
  };

  // 公共关闭：智能调整 / 快速布局 / 切换历史 / 显隐属性 / 重新生成
  // 都会让"持续力导向"复位为关闭。状态、ref、控制器三处同步。
  const disableForceIfOn = () => {
    if (!forceOnRef.current) return;
    forceOnRef.current = false;
    setForceOnState(false);
    forceCtrlRef.current?.setEnabled(false);
  };

  const handleGenerate = (genOpts: GenerateOptions = {}) => {
    const cur = stateRef.current;
    const useInputText = genOpts.inputText ?? cur.inputText;
    const useIsColored = genOpts.isColored ?? cur.isColored;
    const useShowComment = genOpts.showComment ?? cur.showComment;
    const useHideFields = genOpts.hideFields ?? cur.hideFields;
    const useFontScale = genOpts.fontScale ?? cur.fontScale;
    const useAutoAvoid = genOpts.autoAvoid ?? cur.autoAvoid;
    const positionMap = genOpts.positionMap ?? null;

    try {
      setError(null);
      showParserWarnings([]);
      setLoading(true);
      // 重新生成 / 历史恢复都会重建图，先把持续力导向开关复位关闭，避免
      // 旧 controller 的状态意外延续到新图。
      disableForceIfOn();

      const trimmed = String(useInputText || "").trim();
      if (!trimmed) {
        setError(cur.t.errEmpty);
        setLoading(false);
        return;
      }

      // 解析放在保存旧图之前：解析失败时不应触发任何 IndexedDB 写入
      // （既不为新输入排程保存，也不为旧图落档），否则会把"用户随手清空 +
      // 粘错语法"的中间状态固化进历史。
      let parsedData = parseSQLTables(trimmed);
      const sqlAttemptWarnings = parsedData.warnings ?? [];
      if (parsedData.tables.length === 0) {
        parsedData = parseDBML(trimmed);
      }
      const { tables, relationships } = parsedData;

      if (tables.length === 0) {
        // 无有效表：取消任何挂起的保存、清空画布并以遮罩形式呈现错误。
        // 不写 IndexedDB；不更新 lastInputRef，否则后续的"旧图保存"会以损坏
        // 的输入作 key 把上一次的有效图覆盖掉。
        cancelPendingPersist();
        if (graphRef.current) {
          graphRef.current.clear?.();
          graphRef.current.destroy?.();
          graphRef.current = null;
        }
        historyRef.current.reset();
        tablesDataRef.current = null;
        lastInputRef.current = "";
        setHasGraph(false);
        // 解析彻底失败时更要展示带行号的诊断（DBML 尝试的警告优先，
        // 其次是 SQL 尝试的），而不是只留一句"未找到有效的表"。
        const diagnostics = (parsedData.warnings ?? []).length
          ? (parsedData.warnings ?? [])
          : sqlAttemptWarnings;
        showParserWarnings(diagnostics);
        setError(cur.t.errNoTable);
        setLoading(false);
        return;
      }
      showParserWarnings(parsedData.warnings ?? []);

      // === 解析成功后，再把当前图作为旧 input 的快照存起来 ===
      // 这样用户在"上一份输入"上拖动后的位置不会因为重新生成而丢失。
      // 仅当存在旧图且旧 input 已落档（lastInputRef 非空）时才保存。
      if (graphRef.current && lastInputRef.current) {
        cancelPendingPersist();
        persistSnapshot({
          id: Snapshots.hashInput(lastInputRef.current),
          inputText: lastInputRef.current,
          // 保存"旧图当时使用的设置"，因此用 cur 而非新 opts
          isColored: cur.isColored,
          showComment: cur.showComment,
          hideFields: cur.hideFields,
          fontScale: cur.fontScale,
        });
      }

      lastInputRef.current = trimmed;

      tablesDataRef.current = tables;

      const { nodes, edges } = generateChenModelData(
        tables,
        relationships,
        useIsColored,
        useShowComment ? "comment" : "name",
        useHideFields,
      );
      // Font sizes must be present before any seed/force layout measures nodes.
      // Applying them only after graph.render() leaves small-font diagrams spaced
      // with the default-size geometry.
      applyFontScaleToModels(nodes, edges, useFontScale);
      const generatedSizeScale = computeLayoutSizeScale(nodes);
      applyLayoutSizeScaleToEdges(edges, generatedSizeScale);

      if (positionMap) {
        // 恢复历史快照路径：直接按快照位置/标签覆盖
        nodes.forEach((n: ERNodeModel) => {
          const p = positionMap.get(n.id);
          if (p) {
            if (typeof p.x === "number") n.x = p.x;
            if (typeof p.y === "number") n.y = p.y;
            if (p.label !== undefined && p.label !== null) n.label = p.label;
          }
        });
      } else {
        applyInitialComponentPositions(nodes, edges, containerRef.current, 0);
      }

      // Clear previous graph completely
      if (forceCtrlRef.current) {
        forceCtrlRef.current.destroy();
        forceCtrlRef.current = null;
      }
      if (graphRef.current) {
        graphRef.current.clear?.();
        graphRef.current.destroy?.();
        graphRef.current = null;
      }
      historyRef.current.reset();

      const container = containerRef.current as HTMLElement;

      // 恢复路径下不跑力布局；其余使用默认 force2 配置
      let layoutCfg: Record<string, unknown> | undefined;
      if (!positionMap) {
        layoutCfg = buildDefaultLayoutCfg(
          container.offsetWidth,
          {
            tick: () => graph.refreshPositions(),
            onLayoutEnd: () => {
              // 先让互不相连的组件环绕分布，避免十字交叉
              setTimeout(() => {
                if (graphRef.current && !graphRef.current.destroyed) {
                  spreadDisconnectedComponents(graphRef.current, () => {
                    if (autoAvoidRef.current) {
                      applyGraphAutoAvoid(360, () =>
                        smoothFitView(graphRef.current, 800, "easeOutCubic"),
                      );
                    } else {
                      smoothFitView(graphRef.current, 800, "easeOutCubic");
                    }
                  });
                }
              }, 30);
            },
          },
          nodes,
        );
      }

      const graph = createERGraph({
        container,
        data: { nodes, edges },
        layoutCfg,
      }) as GraphLike & {
        data: (d: { nodes: unknown; edges: unknown }) => void;
        render: () => void;
      };

      graphRef.current = graph;
      setHasGraph(true);

      graph.data({ nodes, edges });
      graph.render();

      applyGraphStyles(graph, useIsColored, useFontScale);
      if (useAutoAvoid && positionMap) applyGraphAutoAvoid(0);

      // 恢复快照路径（不跑力布局）才需要这里 fitView；力布局路径交给
      // onLayoutEnd 链统一处理，避免"缩一次 → 节点继续飘 → 再缩一次"。
      if (positionMap) {
        setTimeout(() => smoothFitView(graph, 600, "easeOutQuart"), 200);
      }

      // 等画面安顿好后再为本次输入存一份"初始/恢复后"快照。
      // 恢复动作可以刷新缩略图或重建后的节点数据，但不应被视为一次修改；
      // 后续拖动、编辑或切换设置会取消这次排程，并按正常保存更新时间。
      // 力布局 + smoothFitView 总共 ~1s；2.5s 比较稳妥。
      const restoringSnapshot = positionMap !== null;
      const saveDelay = restoringSnapshot ? 600 : 2500;
      schedulePersist(
        {
          id: Snapshots.hashInput(trimmed),
          inputText: trimmed,
          isColored: useIsColored,
          showComment: useShowComment,
          hideFields: useHideFields,
          fontScale: useFontScale,
        },
        saveDelay,
        restoringSnapshot ? { preserveUpdatedAt: true } : undefined,
      );

      // 双击编辑 + hover/drag 同步
      setupNodeDoubleClickEdit(graph as any, container, {
        onBeforeChange: () => historyRef.current.record(graph),
        onAfterChange: () => {
          persistAfterOptionalAutoAvoid();
        },
      });
      attachEntityDragSync(
        graph as any,
        historyRef.current,
        () => forceOnRef.current,
        (meta) => {
          persistAfterOptionalAutoAvoid(0, meta);
        },
        (projectedNodes, edges) => {
          if (!autoAvoidRef.current) return new Map();
          return computeAutoAvoidTargets(projectedNodes, graphNodeSize, {
            edges,
            movableIds: projectedNodes
              .filter((node) => node.nodeType !== "entity")
              .map((node) => node.id),
          });
        },
      );

      // 持续力导向控制器：拖动期间根据斥力 + 连边引力重排其它节点
      const forceCtrl = attachForceLoop(graph as any);
      forceCtrlRef.current = forceCtrl;
      if (forceOnRef.current) forceCtrl.setEnabled(true);
    } catch (e) {
      console.error("SQL Parsing error:", e);
      const msg = e instanceof Error ? e.message : String(e);
      setError(`${cur.t.errParse}: ${msg}${cur.t.errParseHint}`);
    } finally {
      setLoading(false);
    }
  };

  // ─── 属性节点显隐封装（薄包装） ──────────────────────────
  const hideAttributesInGraph = () => {
    historyRef.current.reset();
    AttributeLayout.hideAttributes(
      graphRef.current as unknown as Parameters<typeof AttributeLayout.hideAttributes>[0],
    );
  };
  const showAttributesInGraph = (showComment: boolean, isColored: boolean, fontScale: number) => {
    historyRef.current.reset();
    AttributeLayout.showAttributes({
      graph: graphRef.current as unknown as AttributeLayout.ShowAttributesOptions["graph"],
      tables: tablesDataRef.current,
      labelMode: showComment ? "comment" : "name",
      isColored,
      fontScale,
      updateStyles: updateGraphStyles,
    });
  };

  // ─── Mutators：setState 与对应图操作绑定到一处 ───────────
  // 不再用 useEffect 监听 props 后用 ref 抑制重入。

  // 输入文本的轻量草稿：即使快照写库失败/来不及，刷新后 SQL 文本也不丢。
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraftRef = useRef<EditorDraft | null>(null);
  const inputEditRevisionRef = useRef(0);
  const flushDraft = () => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    if (pendingDraftRef.current) writeEditorDraft(pendingDraftRef.current);
    pendingDraftRef.current = null;
  };
  const setInputText = (next: string) => {
    inputEditRevisionRef.current++;
    stateRef.current.inputText = next;
    setInputTextState(next);
    pendingDraftRef.current = { text: next, updatedAt: Date.now() };
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(flushDraft, 500);
  };

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      flushDraft();
      window.removeEventListener("pagehide", flushDraft);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const setIsColored = (next: boolean) => {
    stateRef.current.isColored = next;
    setIsColoredState(next);
    if (hasGraph && graphRef.current) {
      applyGraphStyles(graphRef.current, next, stateRef.current.fontScale);
      scheduleCurrentSnapshotPersist();
    }
  };

  const setShowComment = (next: boolean) => {
    const graph = graphRef.current;
    // 标签会整体切换，先记录（含旧的 showComment meta）供 Ctrl+Z 回退
    if (hasGraph && graph && !graph.destroyed) {
      historyRef.current.record(graph);
    }
    stateRef.current.showComment = next;
    setShowCommentState(next);
    if (!hasGraph || !graph || graph.destroyed) return;
    // 不再走 handleGenerate 重建图；直接用每个节点上预先存的 nameLabel /
    // commentLabel 切换 label 字段。布局保持原样，连线在 builder 的 update
    // 里会随节点尺寸变化自动重画（连带的边刷新仍然显式做一次以兜底）。
    graph.setAutoPaint(false);
    graph.getNodes().forEach((node) => {
      const m = node.getModel() as ERNodeModel & {
        nameLabel?: string;
        commentLabel?: string;
      };
      const nameLabel = m.nameLabel;
      const commentLabel = m.commentLabel;
      if (nameLabel === undefined && commentLabel === undefined) return;
      const target = next ? commentLabel || nameLabel || m.label : nameLabel || m.label;
      if (target !== undefined && target !== m.label) {
        graph.updateItem(node, { label: target });
      }
    });
    // 节点尺寸可能因 label 变化而改变，强制让所有边按新 bbox 重算端点。
    graph.getEdges().forEach((edge) => graph.updateItem(edge, {}));
    if (graph.refresh) graph.refresh();
    graph.paint();
    graph.setAutoPaint(true);
    persistAfterOptionalAutoAvoid(700);
  };

  const setHideFields = (next: boolean) => {
    stateRef.current.hideFields = next;
    setHideFieldsState(next);
    if (!hasGraph || !graphRef.current || graphRef.current.destroyed) return;
    // 显隐属性会改变节点集合，持续力导向控制器的速度图会失效，先关掉。
    disableForceIfOn();
    if (next) {
      hideAttributesInGraph();
    } else {
      showAttributesInGraph(
        stateRef.current.showComment,
        stateRef.current.isColored,
        stateRef.current.fontScale,
      );
    }
    persistAfterOptionalAutoAvoid(700);
  };

  // 滑块拖动是连续的 setFontScale 调用；把一次拖动折成一条撤销记录。
  const fontScaleBurstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setFontScale = (next: number) => {
    const safeNext = Math.min(1.6, Math.max(0.4, next));
    disableForceIfOn();
    const graph = graphRef.current;
    const canTouchGraph = hasGraph && graph && !graph.destroyed;
    if (canTouchGraph) {
      // burst 开始时记录（此刻 stateRef 里还是旧值，meta 捕获的是旧字号）
      if (fontScaleBurstTimerRef.current === null) {
        historyRef.current.record(graph);
      } else {
        clearTimeout(fontScaleBurstTimerRef.current);
      }
      fontScaleBurstTimerRef.current = setTimeout(() => {
        fontScaleBurstTimerRef.current = null;
      }, 800);
    }
    stateRef.current.fontScale = safeNext;
    setFontScaleState(safeNext);
    if (!canTouchGraph || !graph) return;
    cancelNodeAnimation(graph);
    const before = captureGraphGeometry(graph);
    updateGraphStyles(graph, stateRef.current.isColored, safeNext);
    applySizeChangeToGraph(graph, before);
    patchRelationshipLinkPoints(graph);
    graph.refresh?.();
    scheduleCurrentSnapshotPersist(700);
  };

  const setForceOn = (next: boolean) => {
    const wasOn = forceOnRef.current;
    // 开启前记录一次：力导向会持续移动节点，Ctrl+Z 可退回开启前的布局
    if (!wasOn && next && graphRef.current && !graphRef.current.destroyed) {
      historyRef.current.record(graphRef.current);
    }
    forceOnRef.current = next;
    setForceOnState(next);
    if (forceCtrlRef.current) forceCtrlRef.current.setEnabled(next);
    if (wasOn && !next) {
      requestAnimationFrame(() => {
        persistAfterOptionalAutoAvoid(700);
      });
    }
  };

  const setAutoAvoid = (next: boolean) => {
    autoAvoidRef.current = next;
    stateRef.current.autoAvoid = next;
    setAutoAvoidState(next);
    if (!next) {
      return;
    }
    if (!hasGraph || !graphRef.current || graphRef.current.destroyed) return;
    historyRef.current.record(graphRef.current);
    applyGraphAutoAvoid(360, () => {
      void persistCurrentSnapshot();
    });
  };

  // 撤销/重做时随节点快照一起回退的图级设置
  historyMetaHooksRef.current = {
    capture: () => ({
      fontScale: stateRef.current.fontScale,
      showComment: stateRef.current.showComment,
    }),
    apply: (meta) => {
      const m = (meta || {}) as { fontScale?: number; showComment?: boolean };
      if (typeof m.showComment === "boolean" && m.showComment !== stateRef.current.showComment) {
        stateRef.current.showComment = m.showComment;
        setShowCommentState(m.showComment);
        // 标签本身由节点快照恢复，这里只同步开关状态
      }
      if (typeof m.fontScale === "number" && m.fontScale !== stateRef.current.fontScale) {
        stateRef.current.fontScale = m.fontScale;
        setFontScaleState(m.fontScale);
        const graph = graphRef.current;
        if (graph && !graph.destroyed) {
          updateGraphStyles(graph, stateRef.current.isColored, m.fontScale);
          graph.refresh?.();
        }
      }
    },
  };

  const restoreFromSnapshot = (snap: SnapshotRecord, automatic = false) => {
    if (!snap || !snap.nodes) return;
    // 直接刷 React 状态 + 用 opts 覆盖触发一次 handleGenerate
    setInputTextState(snap.inputText);
    if (!automatic) {
      setInputText(snap.inputText);
      flushDraft();
    }
    setIsColoredState(!!snap.isColored);
    setShowCommentState(!!snap.showComment);
    setHideFieldsState(!!snap.hideFields);
    const restoredFontScale = snap.fontScale ?? 1;
    setFontScaleState(restoredFontScale);

    const positionMap = new Map<string, { x?: number; y?: number; label?: string }>();
    snap.nodes.forEach((n) => {
      positionMap.set(n.id, { x: n.x, y: n.y, label: n.label });
    });

    handleGenerate({
      inputText: snap.inputText,
      isColored: !!snap.isColored,
      showComment: !!snap.showComment,
      hideFields: !!snap.hideFields,
      fontScale: restoredFontScale,
      positionMap,
    });
  };

  // ─── 生命周期 ────────────────────────────────────────────

  // 初次挂载生成示例图。StrictMode dev 会 mount→cleanup→mount，导致
  // 创建-销毁-再创建一次，这是 React 18 的契约：副作用必须 self-healing。
  // 我们 setup 在 effect 里做、teardown 在 cleanup 里做，期间 schedulePersist
  // 投递的延迟保存被 cancelPendingPersist 取消，不会在新图之上误触发旧 meta。
  // 不要试图用 didInitRef 跳过第二次 mount：refs 跨 StrictMode 持久存在，
  // 那样会让第一次 cleanup 销毁图后第二次 mount 跳过重建，最终右侧示例图
  // 永远不出现。
  useEffect(() => {
    // 会话恢复：仅恢复 6 小时内的最近快照或草稿；更早的内容仍保留在
    // 生成历史中，但刷新/重进时直接回到初始示例。
    let cancelled = false;
    const initialEditRevision = inputEditRevisionRef.current;
    (async () => {
      try {
        // 清理旧版本曾允许写入的示例快照；即使清理失败，下面的游标筛选
        // 也会跳过它，保证刷新后不会恢复示例的上次移动位置。
        const sampleIds = [I18N.zh.sample, I18N.en.sample].map((sample) =>
          Snapshots.hashInput(sample.trim()),
        );
        await Promise.allSettled(
          sampleIds.map(async (id) => {
            const stored = await Snapshots.get(id);
            if (stored && isInitialSampleInput(stored.inputText)) {
              await Snapshots.deleteById(id);
            }
          }),
        );
        const recent = await Snapshots.getMostRecent(
          (snapshot) => !isInitialSampleInput(snapshot.inputText),
        );
        if (
          !cancelled &&
          inputEditRevisionRef.current === initialEditRevision &&
          recent &&
          recent.inputText &&
          Array.isArray(recent.nodes) &&
          recent.nodes.length > 0 &&
          Snapshots.isWithinSessionRestoreWindow(recent.updatedAt)
        ) {
          restoreFromSnapshot(recent, true);
          // Editor text has its own lifecycle. Later graph-only edits must not
          // make an older graph source replace a pending (even empty) draft.
          const draft = readEditorDraft();
          if (draft) {
            stateRef.current.inputText = draft.text;
            setInputTextState(draft.text);
          }
          return;
        }
      } catch (_) {
        /* IndexedDB 不可用时直接走下面的兜底 */
      }
      if (cancelled || inputEditRevisionRef.current !== initialEditRevision) return;
      const draft = readEditorDraft();
      if (draft) {
        stateRef.current.inputText = draft.text;
        setInputTextState(draft.text);
        if (draft.text.trim()) handleGenerate({ inputText: draft.text });
      } else {
        handleGenerate();
      }
    })();
    return () => {
      cancelled = true;
      cancelErrorShowFrame();
      clearParserWarningHideTimer();
      cancelParserWarningShowFrame();
      cancelPendingPersist();
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      if (fontScaleBurstTimerRef.current) {
        clearTimeout(fontScaleBurstTimerRef.current);
        fontScaleBurstTimerRef.current = null;
      }
      forceCtrlRef.current?.destroy();
      forceCtrlRef.current = null;
      graphRef.current?.destroy?.();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 容器/窗口尺寸变化时同步图表大小（rAF 合并，拖动窗口时不再每个
  // resize 事件都触发 canvas 重建；ResizeObserver 还能捕捉侧栏折叠等
  // 非窗口触发的容器变化）
  useEffect(() => {
    let frame: number | null = null;
    const syncSize = () => {
      frame = null;
      const graph = graphRef.current;
      const container = containerRef.current;
      if (!graph || graph.destroyed || !container) return;
      const w = container.offsetWidth;
      const h = container.offsetHeight;
      if (!w || !h) return;
      // 关键防护：尺寸没有实际变化就不 changeSize。canvas 自身的尺寸调整
      // 也会触发 ResizeObserver 回调，若无条件 changeSize 会形成
      // 观察 → 调整 → 再观察的反馈循环（表现为画布高度持续增长）。
      const curW = Number(graph.get?.("width")) || 0;
      const curH = Number(graph.get?.("height")) || 0;
      if (Math.abs(curW - w) <= 1 && Math.abs(curH - h) <= 1) return;
      graph.changeSize?.(w, h);
    };
    const scheduleSync = () => {
      if (frame === null) frame = requestAnimationFrame(syncSize);
    };
    window.addEventListener("resize", scheduleSync);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && containerRef.current) {
      observer = new ResizeObserver(scheduleSync);
      observer.observe(containerRef.current);
    }
    return () => {
      window.removeEventListener("resize", scheduleSync);
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  // ─── 命令 ────────────────────────────────────────────────

  const handleQuickLayout = () => {
    if (!graphRef.current || graphRef.current.destroyed) return;
    disableForceIfOn();
    historyRef.current.record(graphRef.current);
    const graph = graphRef.current;
    const containerWidth = containerRef.current?.offsetWidth || 1200;
    const nodes = graph.getNodes().map((node) => ({ ...(node.getModel() as ERNodeModel) }));
    const edges = graph.getEdges().map((edge) => ({ ...(edge.getModel() as EREdgeModel) }));
    applySkeletonLayout(nodes, edges, { canvasWidth: containerWidth });
    placeAttributesModerate({ nodes, edges });

    const targets = new Map<string, { x?: number; y?: number }>();
    nodes.forEach((node) => targets.set(node.id, { x: node.x, y: node.y }));

    animateNodesToTargets(graph, targets, 850, () => {
      patchRelationshipLinkPoints(graph);
      graph.refresh?.();
      if (autoAvoidRef.current) {
        persistAfterOptionalAutoAvoid();
      } else {
        scheduleCurrentSnapshotPersist(300);
      }
      window.setTimeout(() => smoothFitView(graph, 700, "easeOutCubic"), 80);
    });
  };

  const handleArrangeLayout = () => {
    if (!graphRef.current || graphRef.current.destroyed) return;
    disableForceIfOn();
    historyRef.current.record(graphRef.current);
    arrangeLayout(graphRef.current);
    if (autoAvoidRef.current) {
      window.setTimeout(() => persistAfterOptionalAutoAvoid(), 900);
    } else {
      scheduleCurrentSnapshotPersist(1200);
    }
  };

  return {
    containerRef,
    graphRef,
    historyRef,
    lastInputRef,
    inputText,
    isColored,
    showComment,
    hideFields,
    fontScale,
    forceOn,
    autoAvoid,
    hasGraph,
    error,
    errorVisible,
    parserWarnings,
    parserWarningsVisible,
    loading,
    setInputText,
    setIsColored,
    setShowComment,
    setHideFields,
    setFontScale,
    setForceOn,
    setAutoAvoid,
    setError,
    dismissParserWarnings,
    handleGenerate,
    handleQuickLayout,
    handleArrangeLayout,
    restoreFromSnapshot,
    persistSnapshot,
    persistCurrentSnapshot,
    scheduleCurrentSnapshotPersist,
    settleAfterRotation,
  };
}
