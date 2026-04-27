/**
 * Editor Module - 编辑器相关逻辑
 * 包括 CodeMirror 代码编辑器组件和 G6 节点双击编辑功能
 */
import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { placeholder as placeholderExtension } from "@codemirror/view";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import type { ERNodeModel, GraphLike, GraphNodeLike } from "./types";

// ========================
// CodeEditor React 组件 (CodeMirror 6)
// ========================

export interface CodeEditorProps {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
}

/**
 * SQL/DBML 编辑器。CodeMirror 6 用 EditorView + EditorState 模型，
 * 一次性挂载，外部 value 变化通过 dispatch 同步进 doc。
 */
export const CodeEditor = ({ value, onChange, placeholder }: CodeEditorProps) => {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    // 把最新的 onChange 装进 ref，避免在外部回调变化时重建 EditorView。
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useEffect(() => {
        if (!hostRef.current) return;

        const startState = EditorState.create({
            doc: value,
            extensions: [
                basicSetup,
                sql({ dialect: PostgreSQL, upperCaseKeywords: false }),
                EditorView.lineWrapping,
                placeholderExtension(placeholder ?? ""),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        onChangeRef.current(update.state.doc.toString());
                    }
                }),
            ],
        });
        const view = new EditorView({ state: startState, parent: hostRef.current });
        viewRef.current = view;

        return () => {
            view.destroy();
            viewRef.current = null;
        };
        // 仅初次挂载初始化；后续 value 变化由下方 effect 同步。placeholder 静态。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 外部 value 变化时同步进 doc。等值则跳过，避免 dispatch 把光标重置。
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        const current = view.state.doc.toString();
        if (current === value) return;
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: value },
        });
    }, [value]);

    return <div ref={hostRef} className="cm-host" />;
};

// ========================
// 节点双击编辑功能
// ========================

export interface NodeDimensions {
    width: number;
    height: number;
    fontSize: number;
}

/**
 * 根据节点模型计算输入框的尺寸
 */
export function getNodeDimensions(nodeModel: ERNodeModel): NodeDimensions {
    const text = nodeModel.label || "";
    const getTextWidth = (s: string, fontSize: number) => {
        let width = 0;
        for (const char of s) {
            if (/[一-龥]/.test(char)) {
                width += fontSize;
            } else {
                width += fontSize * 0.6;
            }
        }
        return width;
    };

    let width: number;
    let height: number;
    let fontSize: number;

    if (nodeModel.type === "entity") {
        fontSize = 18;
        const textWidth = getTextWidth(text, fontSize);
        width = Math.max(80, textWidth + 20);
        height = Math.max(50, fontSize + 20);
    } else if (nodeModel.type === "relationship") {
        fontSize = 16;
        const textWidth = getTextWidth(text, fontSize);
        const horizontalPadding = 24;
        const minWidth = 80;
        const requiredWidth = textWidth + horizontalPadding * 2;
        const halfWidth = Math.max(minWidth / 2, requiredWidth / 2);
        width = halfWidth * 2;
        height = Math.max(40, Math.min(halfWidth * 0.6, fontSize + 16) * 2);
    } else {
        // attribute
        fontSize = 15;
        const textWidth = getTextWidth(text, fontSize);
        width = Math.max(60, textWidth + 32);
        height = Math.max(40, fontSize + 16);
    }

    return { width, height, fontSize };
}

/**
 * 根据节点类型获取对应的颜色
 */
export function getNodeColor(nodeModel: ERNodeModel): string {
    if (nodeModel.type === "entity") {
        return "#0ea5e9"; // 蓝色
    } else if (nodeModel.type === "relationship") {
        return "#722ed1"; // 紫色
    } else if (nodeModel.type === "attribute") {
        return nodeModel.keyType === "pk" ? "#10b981" : "#94a3b8"; // 绿色或灰色
    }
    return "#ff8a65"; // 默认橙色
}

export interface NodeDoubleClickEditOptions {
    /**
     * 在节点标签即将被修改前调用，用于上层把当前状态压入撤销栈。
     * 仅在 label 实际变化时触发。
     */
    onBeforeChange?: () => void;
}

export interface NodeDoubleClickEditController {
    finishEditing: (save: boolean) => void;
    isEditing: () => boolean;
}

// G6 4.x 中 graph.on(eventName, fn) 的事件参数没有公开类型，这里只用到 e.item
interface NodeEvent {
    item: GraphNodeLike & {
        getModel(): ERNodeModel;
    };
}

// G6 graph 上本模块用到的额外方法
interface EditableGraph extends GraphLike {
    getCanvasByPoint(x: number, y: number): { x: number; y: number };
    on(eventName: string, handler: (e: NodeEvent) => void): void;
}

/**
 * 为 G6 图形实例设置节点双击编辑功能
 */
export function setupNodeDoubleClickEdit(
    graph: EditableGraph,
    container: HTMLElement,
    options?: NodeDoubleClickEditOptions,
): NodeDoubleClickEditController {
    const onBeforeChange = options && options.onBeforeChange;
    let editingNode: NodeEvent["item"] | null = null;
    let editInput: HTMLInputElement | null = null;

    const startEditing = (node: NodeEvent["item"], model: ERNodeModel) => {
        editingNode = node;
        // `getCanvasByPoint` 返回的是相对于 G6 画布左上角的坐标
        const canvasPoint = graph.getCanvasByPoint(model.x ?? 0, model.y ?? 0);
        const currentZoom = graph.getZoom();

        const dimensions = getNodeDimensions(model);
        const scaledWidth = dimensions.width * currentZoom;
        const scaledHeight = dimensions.height * currentZoom;
        const scaledFontSize = dimensions.fontSize * currentZoom;

        const borderColor = getNodeColor(model);
        const rgbValues = (borderColor.substring(1).match(/.{1,2}/g) || []).map(
            (x) => parseInt(x, 16),
        );
        const shadowColorRGB = `rgba(${rgbValues.join(", ")}, 0.2)`;

        const input = document.createElement("input");
        input.type = "text";
        input.value = model.label || "";
        input.style.position = "absolute";
        // 定位是相对于 G6 的容器 (container)
        input.style.left = canvasPoint.x - scaledWidth / 2 + "px";
        input.style.top = canvasPoint.y - scaledHeight / 2 + "px";
        input.style.width = scaledWidth + "px";
        input.style.height = scaledHeight + "px";
        input.style.padding = "0";
        input.style.border = `${2 * currentZoom}px solid ${borderColor}`;
        input.style.outline = "none";
        input.style.fontSize = scaledFontSize + "px";
        input.style.textAlign = "center";
        input.style.backgroundColor = "rgba(255, 255, 255, 0.95)";
        input.style.zIndex = "1000";
        input.style.boxShadow = `0 0 0 ${3 * currentZoom}px ${shadowColorRGB}`;
        input.style.fontWeight =
            model.type === "entity" || model.keyType === "pk"
                ? "bold"
                : "normal";

        if (model.type === "entity") {
            input.style.borderRadius = 4 * currentZoom + "px";
        } else if (model.type === "relationship") {
            input.style.borderRadius = 8 * currentZoom + "px";
            // 菱形节点用矩形输入框，不旋转以便于编辑
        } else {
            // attribute
            input.style.borderRadius = "50%";
        }

        container.appendChild(input);
        input.focus();
        input.select();

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                finishEditing(true);
                e.preventDefault();
            } else if (e.key === "Escape") {
                finishEditing(false);
                e.preventDefault();
            }
        });

        input.addEventListener("blur", () => {
            setTimeout(() => finishEditing(true), 100);
        });

        editInput = input;
    };

    const finishEditing = (save: boolean) => {
        if (!editingNode || !editInput) return;

        if (save && editInput.value.trim()) {
            const newLabel = editInput.value.trim();
            const model = editingNode.getModel();

            if (newLabel !== model.label) {
                if (typeof onBeforeChange === "function") {
                    try {
                        onBeforeChange();
                    } catch (_e) {
                        /* 忽略上层异常 */
                    }
                }
                graph.updateItem(editingNode, { label: newLabel });
            }
        }

        if (editInput && editInput.parentNode) {
            editInput.parentNode.removeChild(editInput);
        }
        editInput = null;
        editingNode = null;
    };

    graph.on("node:dblclick", (e) => {
        const node = e.item;
        const model = node.getModel();

        if (editingNode) {
            finishEditing(false);
        }

        startEditing(node, model);
    });

    graph.on("canvas:click", () => {
        if (editingNode) {
            finishEditing(true);
        }
    });

    return {
        finishEditing,
        isEditing: () => editingNode !== null,
    };
}
