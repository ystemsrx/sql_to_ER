/**
 * Editor Module - 编辑器相关逻辑
 * 包括 CodeMirror 代码编辑器组件和 G6 节点双击编辑功能
 */
import CodeMirror from "codemirror";
import "codemirror/mode/sql/sql";
import "codemirror/mode/javascript/javascript";
import "codemirror/addon/display/placeholder";
import "codemirror/addon/edit/matchbrackets";
import "codemirror/addon/edit/closebrackets";
import type * as ReactNS from "react";
import type { ERNodeModel, GraphLike, GraphNodeLike } from "./types";

// ========================
// CodeEditor React 组件
// ========================

export interface CodeEditorProps {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
}

export type CodeEditorComponent = (props: CodeEditorProps) => ReactNS.ReactElement;

/**
 * 创建 CodeEditor React 组件 —— 通过参数注入 React，避免本模块直接 import
 * 触发非 jsx 文件的依赖。
 */
export function createCodeEditorComponent(React: typeof ReactNS): CodeEditorComponent {
    const { useRef, useEffect } = React;

    const CodeEditor: CodeEditorComponent = ({ value, onChange, placeholder }) => {
        const editorRef = useRef<HTMLTextAreaElement | null>(null);
        const cmInstance = useRef<CodeMirror.EditorFromTextArea | null>(null);

        useEffect(() => {
            if (!editorRef.current) return;

            const cm = CodeMirror.fromTextArea(editorRef.current, {
                mode: "text/x-pgsql",
                lineNumbers: true,
                theme: "default",
                lineWrapping: true,
                placeholder,
                matchBrackets: true,
                autoCloseBrackets: true,
            } as CodeMirror.EditorConfiguration);
            cmInstance.current = cm;
            cm.setSize(null, "480px");

            cm.on("change", (instance) => {
                onChange(instance.getValue());
            });

            cm.setValue(value);

            return () => {
                cm.toTextArea();
                cmInstance.current = null;
            };
        }, []);

        useEffect(() => {
            const cm = cmInstance.current;
            if (cm && cm.getValue() !== value) {
                const cursor = cm.getCursor();
                cm.setValue(value);
                cm.setCursor(cursor);
            }
        }, [value]);

        return React.createElement(
            "div",
            {
                style: {
                    height: "480px",
                    display: "flex",
                    flexDirection: "column",
                    border: "1px solid #e2e8f0",
                    borderRadius: "16px",
                    overflow: "hidden",
                },
            },
            React.createElement("textarea", {
                ref: editorRef,
                style: { display: "none" },
            }),
        );
    };

    return CodeEditor;
}

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

            if (model.type === "attribute") {
                console.log(`属性 ${model.label} 已更新为 ${newLabel}`);
            } else if (model.type === "entity") {
                console.log(`实体 ${model.label} 已更新为 ${newLabel}`);
            } else if (model.type === "relationship") {
                console.log(`关系 ${model.label} 已更新为 ${newLabel}`);
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
