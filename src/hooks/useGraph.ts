import { useEffect, useRef, useState } from "react";
import G6 from "@antv/g6";
import { I18N } from "../i18n";
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
import * as Exporter from "../exporter";
import * as Snapshots from "../snapshots";
import * as AttributeLayout from "../attributeLayout";
import type { ERNodeModel, GraphLike, ParsedTable, SnapshotRecord } from "../types";
import type { HistoryManager } from "../history";

type Translation = (typeof I18N)[keyof typeof I18N];

export interface GenerateOptions {
  inputText?: string;
  isColored?: boolean;
  showComment?: boolean;
  hideFields?: boolean;
  positionMap?: Map<string, { x?: number; y?: number; label?: string }> | null;
}

interface PersistMeta {
  id: string;
  inputText: string;
  isColored: boolean;
  showComment: boolean;
  hideFields: boolean;
}

export interface UseGraphOptions {
  t: Translation;
  inputText: string;
  isColored: boolean;
  showComment: boolean;
  hideFields: boolean;
  setInputText: (text: string) => void;
  setIsColored: (v: boolean) => void;
  setShowComment: (v: boolean) => void;
  setHideFields: (v: boolean) => void;
}

// 更新图表样式 —— 黑白/彩色样式批量切换
const updateGraphStyles = (
  graphInstance: GraphLike | null,
  colored: boolean,
) => {
  if (!graphInstance || graphInstance.destroyed) return;

  graphInstance.setAutoPaint(false);

  const nodes = graphInstance.getNodes();
  nodes.forEach((node) => {
    const model = node.getModel();
    // styles 是给 G6 updateItem 的"上层 props"，字段名/类型很灵活，
    // 这里就是装填样式属性的字典，保留宽松类型。
    interface StylesUpdate {
      style?: Record<string, unknown>;
      labelCfg?: { style?: Record<string, unknown> };
      [key: string]: unknown;
    }
    const styles: StylesUpdate = {};

    if (colored) {
      if (model.nodeType === "entity") {
        if (model.isPlaceholder) {
          styles.style = {
            fill: "#e0f2fe",
            stroke: "#0ea5e9",
            lineWidth: 2,
            lineDash: [4, 4],
            shadowColor: "rgba(14, 165, 233, 0.2)",
            shadowBlur: 10,
          };
          styles.labelCfg = {
            style: {
              fill: "#0f172a",
              fontWeight: "700",
              fontFamily: "Poppins",
              fontStyle: "italic",
            },
          };
        } else {
          styles.style = {
            fill: "#e0f2fe",
            stroke: "#0ea5e9",
            lineWidth: 2,
            shadowColor: "rgba(14, 165, 233, 0.2)",
            shadowBlur: 10,
          };
          styles.labelCfg = {
            style: {
              fill: "#0f172a",
              fontWeight: "700",
              fontFamily: "Poppins",
            },
          };
        }
      } else if (model.nodeType === "relationship") {
        styles.style = {
          fill: "#f5f3ff",
          stroke: "#8b5cf6",
          lineWidth: 2,
          shadowColor: "rgba(139, 92, 246, 0.2)",
          shadowBlur: 10,
        };
        styles.labelCfg = {
          style: { fill: "#0f172a", fontFamily: "Poppins" },
        };
      } else if (model.nodeType === "attribute") {
        if (model.keyType === "pk") {
          styles.style = {
            fill: "#ecfdf5",
            stroke: "#10b981",
            lineWidth: 2,
            shadowColor: "rgba(16, 185, 129, 0.2)",
            shadowBlur: 5,
          };
          styles.labelCfg = {
            style: {
              fill: "#0f172a",
              fontWeight: "700",
              fontFamily: "Poppins",
            },
          };
        } else {
          styles.style = {
            fill: "#ffffff",
            stroke: "#94a3b8",
            lineWidth: 2,
          };
          styles.labelCfg = {
            style: {
              fill: "#475569",
              fontWeight: "normal",
              fontFamily: "Poppins",
            },
          };
        }
      }
    } else {
      styles.style = {
        fill: "#ffffff",
        stroke: "#1e293b",
        lineWidth:
          model.keyType === "pk" ||
          model.nodeType === "entity" ||
          model.nodeType === "relationship"
            ? 2
            : 1,
        shadowBlur: 0,
      };
      if (model.isPlaceholder) {
        styles.style.lineDash = [4, 4];
        styles.style.stroke = "#64748b";
        styles.labelCfg = {
          style: {
            fill: "#64748b",
            fontWeight: "bold",
            fontStyle: "italic",
            fontFamily: "Poppins",
          },
        };
      } else {
        styles.labelCfg = {
          style: {
            fill: "#1e293b",
            fontWeight:
              model.nodeType === "entity" || model.keyType === "pk"
                ? "bold"
                : "normal",
            fontFamily: "Poppins",
          },
        };
      }
    }

    graphInstance.updateItem(node, styles);
  });

  const edges = graphInstance.getEdges();
  edges.forEach((edge) => {
    graphInstance.updateItem(edge, {
      style: {
        stroke: "#000000",
        lineWidth: 1.5,
        endArrow: false,
      },
      labelCfg: {
        style: {
          fill: "#000000",
          fontSize: 12,
          background: {
            fill: "#ffffff",
            padding: [2, 4, 2, 4],
            radius: 2,
          },
        },
      },
    });
  });

  graphInstance.paint();
  graphInstance.setAutoPaint(true);
};

export function useGraph(opts: UseGraphOptions) {
  const {
    t,
    inputText,
    isColored,
    showComment,
    hideFields,
    setInputText,
    setIsColored,
    setShowComment,
    setHideFields,
  } = opts;

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasGraph, setHasGraph] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<GraphLike | null>(null);
  const lastInputRef = useRef(""); // 记录上次生成时的输入
  const tablesDataRef = useRef<ParsedTable[] | null>(null);
  // 撤销/重做管理器：每次重新生成图后清空历史
  const historyRef = useRef<HistoryManager>(createHistoryManager());
  // 恢复快照时用于压制 showComment / hideFields / isColored 的 useEffect
  // 让它们看到状态值与"已应用值"一致从而跳过自动重新生成。
  const appliedShowCommentRef = useRef(showComment);
  const appliedHideFieldsRef = useRef(hideFields);
  const appliedIsColoredRef = useRef(isColored);
  // 上一次 saveSnapshotForCurrentGraph 投递的延迟保存定时器
  const pendingSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // 持有最新的 React 状态供 handleGenerate 在闭包外引用
  const stateRef = useRef({ inputText, isColored, showComment, hideFields, t });
  stateRef.current = { inputText, isColored, showComment, hideFields, t };

  // 用 Exporter.buildExportSVG 拍一张矢量缩略图。
  // buildExportSVG 内部第一行就 graphRef.current.save() 同步取数据，
  // 之后才在临时 G6 中渲染并 setTimeout 1s 序列化 SVG —— 所以即使
  // 调用方紧接着 destroy 掉旧图，这条流水线已经持有数据副本，不会丢内容。
  const captureSvgThumbnail = (): Promise<string | null> =>
    new Promise((resolve) => {
      const graph = graphRef.current;
      if (!graph || graph.destroyed) {
        resolve(null);
        return;
      }
      try {
        Exporter.buildExportSVG(
          {
            graphRef,
            containerRef,
            patchRelationshipLinkPoints,
            G6,
            // 与 --color-bg-overlay 一致；让 SVG 底色矩形和暖色卡片融在一起。
            // 用户下载 SVG/PNG 走另一条 buildExportSVG 调用，仍是默认白底。
            backgroundFill: "#fdfcf8",
          },
          (err, result) => {
            if (err || !result || !result.svgString) {
              resolve(null);
              return;
            }
            // SVG 里中文等多字节字符要先 UTF-8 再 base64
            let dataUrl: string;
            try {
              dataUrl =
                "data:image/svg+xml;base64," +
                btoa(unescape(encodeURIComponent(result.svgString)));
            } catch (_) {
              dataUrl =
                "data:image/svg+xml;charset=utf-8," +
                encodeURIComponent(result.svgString);
            }
            resolve(dataUrl);
          },
        );
      } catch (_) {
        resolve(null);
      }
    });

  // 把当前图（可能即将被销毁）连同元信息一起入库。
  const persistSnapshot = (meta: PersistMeta): Promise<void> =>
    new Promise((resolve) => {
      const graph = graphRef.current;
      if (!graph || graph.destroyed) {
        resolve();
        return;
      }
      // 输入框还停留在示例（中/英文均算）时不写入历史 ——
      // 否则首次打开页面什么都没改也会有一条快照。
      const trimmedInput = String((meta && meta.inputText) || "").trim();
      if (
        trimmedInput === I18N.zh.sample.trim() ||
        trimmedInput === I18N.en.sample.trim()
      ) {
        resolve();
        return;
      }
      const nodes = Snapshots.captureGraphSnapshot(graph);
      if (!nodes || nodes.length === 0) {
        resolve();
        return;
      }
      // 关键：在调用方还没 destroy 当前图之前同步触发 SVG 数据采集
      const thumbPromise = captureSvgThumbnail();
      thumbPromise.then((thumb) => {
        const writeWith = (existing: SnapshotRecord | null) => {
          // 数据没变化时跳过写入：恢复 / 打开历史面板都会触发一次
          // persistSnapshot，若原封不动也刷新 updatedAt，会让历史排序
          // 反复"乱跳"，用户感觉是 bug。
          if (
            existing &&
            existing.isColored === !!meta.isColored &&
            existing.showComment === !!meta.showComment &&
            existing.hideFields === !!meta.hideFields &&
            Array.isArray(existing.nodes) &&
            existing.nodes.length === nodes.length &&
            existing.nodes.every(
              (p, i) =>
                p.id === nodes[i].id &&
                p.x === nodes[i].x &&
                p.y === nodes[i].y &&
                p.label === nodes[i].label,
            )
          ) {
            resolve();
            return;
          }
          Snapshots.put({
            id: meta.id,
            inputText: meta.inputText,
            isColored: !!meta.isColored,
            showComment: !!meta.showComment,
            hideFields: !!meta.hideFields,
            nodes,
            thumbnail: thumb || (existing && existing.thumbnail) || null,
            createdAt:
              existing && existing.createdAt ? existing.createdAt : Date.now(),
            updatedAt: Date.now(),
          })
            .then(() => resolve())
            .catch((e: unknown) => {
              console.warn("snapshot put failed", e);
              resolve();
            });
        };
        Snapshots.get(meta.id)
          .then(writeWith)
          .catch(() => writeWith(null));
      });
    });

  const handleGenerate = (genOpts: GenerateOptions = {}) => {
    const cur = stateRef.current;
    const useInputText =
      genOpts.inputText !== undefined ? genOpts.inputText : cur.inputText;
    const useIsColored =
      genOpts.isColored !== undefined ? genOpts.isColored : cur.isColored;
    const useShowComment =
      genOpts.showComment !== undefined ? genOpts.showComment : cur.showComment;
    const useHideFields =
      genOpts.hideFields !== undefined ? genOpts.hideFields : cur.hideFields;
    const positionMap = genOpts.positionMap || null;

    try {
      setError(null);
      setLoading(true);

      const trimmed = String(useInputText || "").trim();
      if (!trimmed) {
        setError(cur.t.errEmpty);
        setLoading(false);
        return;
      }

      // === 销毁旧图前，先把当前图作为旧 input 的快照存起来 ===
      // 这样用户在"上一份输入"上拖动后的位置不会因为重新生成而丢失。
      // 仅当存在旧图且旧 input 已落档（lastInputRef 非空）时才保存。
      if (graphRef.current && lastInputRef.current) {
        if (pendingSaveTimerRef.current) {
          clearTimeout(pendingSaveTimerRef.current);
          pendingSaveTimerRef.current = null;
        }
        persistSnapshot({
          id: Snapshots.hashInput(lastInputRef.current),
          inputText: lastInputRef.current,
          // 保存"旧图当时使用的设置"，所以这里用当前 React 状态
          isColored: cur.isColored,
          showComment: cur.showComment,
          hideFields: cur.hideFields,
        });
      }

      lastInputRef.current = trimmed;

      // Try parsing as SQL first, if it fails (no tables), try DBML.
      let parsedData = parseSQLTables(trimmed);
      if (parsedData.tables.length === 0) {
        parsedData = parseDBML(trimmed);
      }
      const { tables, relationships } = parsedData;

      if (tables.length === 0) {
        setError(cur.t.errNoTable);
        setLoading(false);
        return;
      }

      // 缓存表数据，供隐藏/显示属性时无需重新生成图表即可重建属性
      tablesDataRef.current = tables;

      const { nodes, edges } = generateChenModelData(
        tables,
        relationships,
        useIsColored,
        useShowComment ? "comment" : "name",
        useHideFields,
      );

      if (positionMap) {
        nodes.forEach((n: ERNodeModel) => {
          const p = positionMap.get(n.id);
          if (p) {
            if (typeof p.x === "number") n.x = p.x;
            if (typeof p.y === "number") n.y = p.y;
            if (p.label !== undefined && p.label !== null) {
              n.label = p.label;
            }
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
      // 重新生成图意味着节点集合可能完全不同，旧的快照不再适用
      historyRef.current.reset();

      // 恢复路径下不跑力布局（节点位置已经从快照里来）。
      const layoutCfg = positionMap
        ? undefined
        : {
            type: "force2",
            preventOverlap: true,
            nodeSize: (node: any) => {
              const uniformSizes: Record<string, number> = {
                entity: 140,
                relationship: 90,
                attribute: 90,
              };
              return uniformSizes[node.nodeType] || 90;
            },
            nodeSpacing: 20,
            linkDistance: 120,
            coulombDisScale: 0.005,
            damping: 0.9,
            maxSpeed: 1000,
            minMovement: 0.5,
            interval: 0.02,
            factor: 1,
            maxIteration: 800,
            animate: true,
            center: [(containerRef.current as HTMLElement).offsetWidth / 2, 300],
            clustering: false,
            tick: () => {
              graph.refreshPositions();
            },
            onLayoutEnd: () => {
              setTimeout(() => {
                if (graphRef.current && !graphRef.current.destroyed) {
                  spreadDisconnectedComponents(graphRef.current, () => {
                    smoothFitView(graphRef.current, 800, "easeOutCubic");
                  });
                }
              }, 30);
            },
          };
      const container = containerRef.current as HTMLElement;
      const graph = new (G6 as any).Graph({
        container,
        width: container.offsetWidth,
        height: container.offsetHeight,
        renderer: "canvas",
        background: "#ffffff",
        modes: {
          default: [
            "drag-node",
            {
              type: "drag-canvas",
              allowDragOnItem: true,
              enableOptimize: false,
              shouldBegin(e: any) {
                return !e.item || e.item.getType() !== "node";
              },
            },
            // 注：滚轮缩放 / Ctrl+滚轮旋转由 useWheelZoomRotate 接管
          ],
        },
        layout: layoutCfg,
        defaultNode: {
          style: { lineWidth: 2, stroke: "#000", fill: "#fff" },
          labelCfg: { style: { fill: "#000", fontSize: 16 } },
        },
        defaultEdge: {
          style: { lineWidth: 1, stroke: "#000000" },
          labelCfg: {
            style: {
              fill: "#000000",
              fontSize: 14,
              background: { fill: "#fff", padding: [2, 4, 2, 4] },
            },
          },
        },
        edgeStateStyles: {
          hover: { stroke: "#1890ff", lineWidth: 2 },
        },
        defaultEdgeConfig: { type: "line" },
        nodeStateStyles: {
          hover: { fill: "#e6f7ff", stroke: "#1890ff" },
        },
      });

      graphRef.current = graph;
      setHasGraph(true);

      graph.data({ nodes, edges });
      graph.render();

      updateGraphStyles(graph, useIsColored);
      patchRelationshipLinkPoints(graph);

      // 初始渲染后使用平滑动画调整视图
      setTimeout(() => {
        smoothFitView(graph, 600, "easeOutQuart");
      }, 200);

      // 等画面安顿好后再为本次输入存一份"初始/恢复后"快照。
      // 力布局有动画 + smoothFitView 总共 ~1s；这里给到 2.5s 比较稳妥。
      // 如果同一份输入的"销毁前"快照已经写过，会被这次覆盖（按主键 id）。
      if (pendingSaveTimerRef.current) {
        clearTimeout(pendingSaveTimerRef.current);
      }
      const saveDelay = positionMap ? 600 : 2500;
      const snapInputText = trimmed;
      const snapId = Snapshots.hashInput(snapInputText);
      pendingSaveTimerRef.current = setTimeout(() => {
        pendingSaveTimerRef.current = null;
        if (!graphRef.current || graphRef.current.destroyed) return;
        persistSnapshot({
          id: snapId,
          inputText: snapInputText,
          isColored: useIsColored,
          showComment: useShowComment,
          hideFields: useHideFields,
        });
      }, saveDelay);

      // Enable interactions
      graph.on("node:mouseenter", (e: any) => {
        graph.setItemState(e.item, "hover", true);
      });
      graph.on("node:mouseleave", (e: any) => {
        graph.setItemState(e.item, "hover", false);
      });

      // 设置节点双击编辑功能（使用 Editor 模块）
      // 标签即将改变前先把当前状态推入撤销栈
      setupNodeDoubleClickEdit(graph, container, {
        onBeforeChange: () => historyRef.current.record(graph),
      });

      // 自定义拖拽逻辑：拖动实体时带动相关属性一起移动
      let draggedEntity: any = null;
      let relatedAttributes: any[] = [];
      const dragStartPositions = new Map<string, { x: number; y: number }>();

      graph.on("node:dragstart", (e: any) => {
        const node = e.item;
        const nodeModel = node.getModel();

        // 在任何节点开始被拖动前记录一次快照（用于撤销）
        historyRef.current.record(graph);

        if (nodeModel.type === "entity") {
          draggedEntity = node;
          relatedAttributes = [];
          dragStartPositions.clear();

          dragStartPositions.set(nodeModel.id, {
            x: nodeModel.x,
            y: nodeModel.y,
          });

          const allNodes = graph.getNodes();
          allNodes.forEach((n: any) => {
            const model = n.getModel();
            if (
              model.type === "attribute" &&
              model.parentEntity === nodeModel.id
            ) {
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
          }
        }
      });

      graph.on("node:dragend", (e: any) => {
        const node = e.item;
        const nodeModel = node.getModel();

        if (nodeModel.type === "entity" && draggedEntity === node) {
          draggedEntity = null;
          relatedAttributes = [];
          dragStartPositions.clear();
        }
      });
    } catch (e) {
      console.error("SQL Parsing error:", e);
      const msg = e instanceof Error ? e.message : String(e);
      setError(`${cur.t.errParse}: ${msg}${cur.t.errParseHint}`);
    } finally {
      setLoading(false);
    }
  };

  // 属性节点的隐藏 / 显示以及"加回来时的位置计算"封装在 attributeLayout。
  // 这里只保留绑定 React 状态 / ref 的薄包装。
  const hideAttributesInGraph = () => {
    historyRef.current.reset();
    AttributeLayout.hideAttributes(
      graphRef.current as unknown as Parameters<
        typeof AttributeLayout.hideAttributes
      >[0],
    );
  };
  const showAttributesInGraph = () => {
    historyRef.current.reset();
    AttributeLayout.showAttributes({
      graph: graphRef.current as unknown as AttributeLayout.ShowAttributesOptions["graph"],
      tables: tablesDataRef.current,
      labelMode: stateRef.current.showComment ? "comment" : "name",
      isColored: stateRef.current.isColored,
      updateStyles: updateGraphStyles,
    });
  };

  // 监听着色状态变化
  useEffect(() => {
    if (appliedIsColoredRef.current === isColored) return;
    appliedIsColoredRef.current = isColored;
    if (hasGraph && graphRef.current) {
      updateGraphStyles(graphRef.current, isColored);
    }
  }, [isColored, hasGraph]);

  // 监听 showComment 变化，重新生成图表（标签内容需要重渲染）
  useEffect(() => {
    if (appliedShowCommentRef.current === showComment) return;
    appliedShowCommentRef.current = showComment;
    if (hasGraph && lastInputRef.current) {
      handleGenerate();
    }
  }, [showComment]);

  // 监听 hideFields 变化：隐藏时直接移除属性节点，显示时根据
  // 当前实体位置计算最优属性位置后再加入，避免重新生成整张图
  useEffect(() => {
    if (appliedHideFieldsRef.current === hideFields) return;
    appliedHideFieldsRef.current = hideFields;
    if (!hasGraph || !graphRef.current || graphRef.current.destroyed) return;
    if (hideFields) {
      hideAttributesInGraph();
    } else {
      showAttributesInGraph();
    }
  }, [hideFields]);

  // 初次挂载生成 + 卸载销毁
  useEffect(() => {
    handleGenerate();
    return () => {
      graphRef.current?.destroy?.();
    };
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

  // 强制对齐：忽略椭圆，主链水平，支线递归均分
  const handleForceAlign = () => {
    if (!graphRef.current || graphRef.current.destroyed) return;
    historyRef.current.record(graphRef.current);
    const containerWidth = containerRef.current?.offsetWidth || 1200;
    forceAlignLayout(graphRef.current, containerWidth);
  };

  // 环绕排布：让属性均匀围绕实体，同时可移动实体以满足关系距离
  const handleArrangeLayout = () => {
    if (!graphRef.current || graphRef.current.destroyed) return;
    historyRef.current.record(graphRef.current);
    arrangeLayout(graphRef.current);
  };

  const restoreFromSnapshot = (snap: SnapshotRecord) => {
    if (!snap || !snap.nodes) return;
    // 同步把 applied refs 推到目标值，让 useEffect 看到"无变化"从而不会
    // 触发自动重新生成 / 样式刷新。
    appliedShowCommentRef.current = !!snap.showComment;
    appliedHideFieldsRef.current = !!snap.hideFields;
    appliedIsColoredRef.current = !!snap.isColored;

    setInputText(snap.inputText);
    setIsColored(!!snap.isColored);
    setShowComment(!!snap.showComment);
    setHideFields(!!snap.hideFields);

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

  return {
    containerRef,
    graphRef,
    historyRef,
    lastInputRef,
    hasGraph,
    error,
    loading,
    setError,
    handleGenerate,
    handleForceAlign,
    handleArrangeLayout,
    restoreFromSnapshot,
    persistSnapshot,
  };
}
