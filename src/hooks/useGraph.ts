import { useEffect, useRef, useState } from "react";
import { I18N, type Language } from "../i18n";
import { detectLang } from "../language";
import { parseSQLTables } from "../parser/sql";
import { parseDBML } from "../parser/dbml";
import {
  generateChenModelData,
  patchRelationshipLinkPoints,
} from "../builder";
import {
  applyInitialComponentPositions,
  arrangeLayout,
  forceAlignLayout,
  smoothFitView,
  spreadDisconnectedComponents,
} from "../layout";
import { setupNodeDoubleClickEdit } from "../editor";
import { createManager as createHistoryManager } from "../history";
import * as Snapshots from "../snapshots";
import * as AttributeLayout from "../attributeLayout";
import {
  createERGraph,
  buildDefaultLayoutCfg,
} from "../graph/createERGraph";
import { attachEntityDragSync } from "../graph/attachEntityDragSync";
import { updateGraphStyles } from "../graph/updateGraphStyles";
import { useSnapshotPersistence } from "./useSnapshotPersistence";
import type {
  ERNodeModel,
  GraphLike,
  ParsedTable,
  SnapshotRecord,
} from "../types";
import type { HistoryManager } from "../history";

type Translation = (typeof I18N)[keyof typeof I18N];

export interface GenerateOptions {
  inputText?: string;
  isColored?: boolean;
  showComment?: boolean;
  hideFields?: boolean;
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
  hasGraph: boolean;
  error: string | null;
  loading: boolean;
  // mutators (combine setState + side effect when applicable)
  setInputText: (next: string) => void;
  setIsColored: (next: boolean) => void;
  setShowComment: (next: boolean) => void;
  setHideFields: (next: boolean) => void;
  setError: (next: string | null) => void;
  // commands
  handleGenerate: (opts?: GenerateOptions) => void;
  handleForceAlign: () => void;
  handleArrangeLayout: () => void;
  restoreFromSnapshot: (snap: SnapshotRecord) => void;
  persistSnapshot: (meta: {
    id: string;
    inputText: string;
    isColored: boolean;
    showComment: boolean;
    hideFields: boolean;
  }) => Promise<void>;
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasGraph, setHasGraph] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<GraphLike | null>(null);
  const lastInputRef = useRef("");
  const tablesDataRef = useRef<ParsedTable[] | null>(null);
  const historyRef = useRef<HistoryManager>(createHistoryManager());

  // 持有最新的 t/state 供 handleGenerate 在 stale closure 之外读到。
  // mutator 同步走 next 显式参数；这个 ref 主要给"用户直接点 Generate 按钮"
  // 这种没有显式 opts 的路径用。
  const stateRef = useRef({ inputText, isColored, showComment, hideFields, t });
  stateRef.current = { inputText, isColored, showComment, hideFields, t };

  const persistence = useSnapshotPersistence({ graphRef, containerRef });
  const { persistSnapshot, schedulePersist, cancelPendingPersist } = persistence;

  const handleGenerate = (genOpts: GenerateOptions = {}) => {
    const cur = stateRef.current;
    const useInputText = genOpts.inputText ?? cur.inputText;
    const useIsColored = genOpts.isColored ?? cur.isColored;
    const useShowComment = genOpts.showComment ?? cur.showComment;
    const useHideFields = genOpts.hideFields ?? cur.hideFields;
    const positionMap = genOpts.positionMap ?? null;

    try {
      setError(null);
      setLoading(true);

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
        setError(cur.t.errNoTable);
        setLoading(false);
        return;
      }

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
        applyInitialComponentPositions(
          nodes,
          edges,
          containerRef.current,
          0,
        );
      }

      // Clear previous graph completely
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
        layoutCfg = buildDefaultLayoutCfg(container.offsetWidth, {
          tick: () => graph.refreshPositions(),
          onLayoutEnd: () => {
            // 先让互不相连的组件环绕分布，避免十字交叉
            setTimeout(() => {
              if (graphRef.current && !graphRef.current.destroyed) {
                spreadDisconnectedComponents(graphRef.current, () => {
                  smoothFitView(graphRef.current, 800, "easeOutCubic");
                });
              }
            }, 30);
          },
        });
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

      updateGraphStyles(graph, useIsColored);
      patchRelationshipLinkPoints(graph);

      // 初始渲染后使用平滑动画调整视图
      setTimeout(() => smoothFitView(graph, 600, "easeOutQuart"), 200);

      // 等画面安顿好后再为本次输入存一份"初始/恢复后"快照。
      // 力布局 + smoothFitView 总共 ~1s；2.5s 比较稳妥。
      const saveDelay = positionMap ? 600 : 2500;
      schedulePersist(
        {
          id: Snapshots.hashInput(trimmed),
          inputText: trimmed,
          isColored: useIsColored,
          showComment: useShowComment,
          hideFields: useHideFields,
        },
        saveDelay,
      );

      // 双击编辑 + hover/drag 同步
      setupNodeDoubleClickEdit(graph as any, container, {
        onBeforeChange: () => historyRef.current.record(graph),
      });
      attachEntityDragSync(graph as any, historyRef.current);
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
      graphRef.current as unknown as Parameters<
        typeof AttributeLayout.hideAttributes
      >[0],
    );
  };
  const showAttributesInGraph = (
    showComment: boolean,
    isColored: boolean,
  ) => {
    historyRef.current.reset();
    AttributeLayout.showAttributes({
      graph: graphRef.current as unknown as AttributeLayout.ShowAttributesOptions["graph"],
      tables: tablesDataRef.current,
      labelMode: showComment ? "comment" : "name",
      isColored,
      updateStyles: updateGraphStyles,
    });
  };

  // ─── Mutators：setState 与对应图操作绑定到一处 ───────────
  // 不再用 useEffect 监听 props 后用 ref 抑制重入。

  const setInputText = (next: string) => setInputTextState(next);

  const setIsColored = (next: boolean) => {
    setIsColoredState(next);
    if (hasGraph && graphRef.current) {
      updateGraphStyles(graphRef.current, next);
    }
  };

  const setShowComment = (next: boolean) => {
    setShowCommentState(next);
    if (hasGraph && lastInputRef.current) {
      // 标签内容变化需要重新生成（节点 label 不可热更新）
      handleGenerate({ showComment: next });
    }
  };

  const setHideFields = (next: boolean) => {
    setHideFieldsState(next);
    if (!hasGraph || !graphRef.current || graphRef.current.destroyed) return;
    if (next) {
      hideAttributesInGraph();
    } else {
      showAttributesInGraph(stateRef.current.showComment, stateRef.current.isColored);
    }
  };

  const restoreFromSnapshot = (snap: SnapshotRecord) => {
    if (!snap || !snap.nodes) return;
    // 直接刷 React 状态 + 用 opts 覆盖触发一次 handleGenerate
    setInputTextState(snap.inputText);
    setIsColoredState(!!snap.isColored);
    setShowCommentState(!!snap.showComment);
    setHideFieldsState(!!snap.hideFields);

    const positionMap = new Map<
      string,
      { x?: number; y?: number; label?: string }
    >();
    snap.nodes.forEach((n) => {
      positionMap.set(n.id, { x: n.x, y: n.y, label: n.label });
    });

    handleGenerate({
      inputText: snap.inputText,
      isColored: !!snap.isColored,
      showComment: !!snap.showComment,
      hideFields: !!snap.hideFields,
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
    handleGenerate();
    return () => {
      cancelPendingPersist();
      graphRef.current?.destroy?.();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 窗口尺寸变化时同步图表大小
  useEffect(() => {
    const handleResize = () => {
      if (graphRef.current && containerRef.current) {
        graphRef.current.changeSize?.(
          containerRef.current.offsetWidth,
          containerRef.current.offsetHeight,
        );
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // ─── 命令 ────────────────────────────────────────────────

  const handleForceAlign = () => {
    if (!graphRef.current || graphRef.current.destroyed) return;
    historyRef.current.record(graphRef.current);
    const containerWidth = containerRef.current?.offsetWidth || 1200;
    forceAlignLayout(graphRef.current, containerWidth);
  };

  const handleArrangeLayout = () => {
    if (!graphRef.current || graphRef.current.destroyed) return;
    historyRef.current.record(graphRef.current);
    arrangeLayout(graphRef.current);
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
    hasGraph,
    error,
    loading,
    setInputText,
    setIsColored,
    setShowComment,
    setHideFields,
    setError,
    handleGenerate,
    handleForceAlign,
    handleArrangeLayout,
    restoreFromSnapshot,
    persistSnapshot,
  };
}
