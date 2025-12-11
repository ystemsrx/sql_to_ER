/**
 * Editor Module - 编辑器相关逻辑
 * 包括 CodeMirror 代码编辑器组件和 G6 节点双击编辑功能
 */

(function () {
    'use strict';

    // ========================
    // CodeEditor React 组件
    // ========================

    /**
     * 创建 CodeEditor React 组件
     * @param {Object} React - React 对象
     * @returns {Function} CodeEditor 组件
     */
    function createCodeEditorComponent(React) {
        const { useRef, useEffect } = React;

        /**
         * CodeEditor 组件 - 基于 CodeMirror 的代码编辑器
         * @param {Object} props - 组件属性
         * @param {string} props.value - 编辑器内容
         * @param {Function} props.onChange - 内容变化回调
         * @param {string} props.placeholder - 占位提示文本
         */
        const CodeEditor = ({ value, onChange, placeholder }) => {
            const editorRef = useRef(null);
            const cmInstance = useRef(null);

            useEffect(() => {
                if (!editorRef.current) return;

                cmInstance.current = CodeMirror.fromTextArea(editorRef.current, {
                    mode: "text/x-sql",
                    lineNumbers: true,
                    theme: "default",
                    lineWrapping: true,
                    height: "480px",
                    placeholder: placeholder,
                    matchBrackets: true,
                    autoCloseBrackets: true
                });

                cmInstance.current.on('change', (cm) => {
                    const newValue = cm.getValue();
                    onChange(newValue);
                });

                cmInstance.current.setValue(value);

                return () => {
                    if (cmInstance.current) {
                        cmInstance.current.toTextArea();
                    }
                };
            }, []);

            useEffect(() => {
                if (cmInstance.current && cmInstance.current.getValue() !== value) {
                    const cursor = cmInstance.current.getCursor();
                    cmInstance.current.setValue(value);
                    cmInstance.current.setCursor(cursor);
                }
            }, [value]);

            return React.createElement('div', {
                style: {
                    height: '480px',
                    display: 'flex',
                    flexDirection: 'column',
                    border: '1px solid #e2e8f0',
                    borderRadius: '16px',
                    overflow: 'hidden'
                }
            },
                React.createElement('textarea', {
                    ref: editorRef,
                    style: { display: 'none' }
                })
            );
        };

        return CodeEditor;
    }

    // ========================
    // 节点双击编辑功能
    // ========================

    /**
     * 根据节点模型计算输入框的尺寸
     * @param {Object} nodeModel - 节点模型
     * @returns {Object} { width, height, fontSize }
     */
    function getNodeDimensions(nodeModel) {
        const text = nodeModel.label || '';
        const getTextWidth = (text, fontSize) => {
            let width = 0;
            for (let char of text) {
                if (/[\u4e00-\u9fa5]/.test(char)) {
                    width += fontSize;
                } else {
                    width += fontSize * 0.6;
                }
            }
            return width;
        };

        let width, height, fontSize;

        if (nodeModel.type === 'entity') {
            fontSize = 18;
            const textWidth = getTextWidth(text, fontSize);
            width = Math.max(80, textWidth + 20);
            height = Math.max(50, fontSize + 20);
        } else if (nodeModel.type === 'relationship') {
            fontSize = 16;
            const textWidth = getTextWidth(text, fontSize);
            const horizontalPadding = 24;
            const minWidth = 80;
            const requiredWidth = textWidth + horizontalPadding * 2;
            const halfWidth = Math.max(minWidth / 2, requiredWidth / 2);
            width = halfWidth * 2;
            height = Math.max(40, Math.min(halfWidth * 0.6, fontSize + 16) * 2);
        } else { // attribute
            fontSize = 15;
            const textWidth = getTextWidth(text, fontSize);
            width = Math.max(60, textWidth + 32);
            height = Math.max(40, fontSize + 16);
        }

        return { width, height, fontSize };
    }

    /**
     * 根据节点类型获取对应的颜色
     * @param {Object} nodeModel - 节点模型
     * @returns {string} 颜色值
     */
    function getNodeColor(nodeModel) {
        if (nodeModel.type === 'entity') {
            return '#0ea5e9'; // 蓝色
        } else if (nodeModel.type === 'relationship') {
            return '#722ed1'; // 紫色
        } else if (nodeModel.type === 'attribute') {
            return nodeModel.keyType === 'pk' ? '#10b981' : '#94a3b8'; // 绿色或灰色
        }
        return '#ff8a65'; // 默认橙色
    }

    /**
     * 为 G6 图形实例设置节点双击编辑功能
     * @param {Object} graph - G6 图形实例
     * @param {HTMLElement} container - 图形容器元素
     */
    function setupNodeDoubleClickEdit(graph, container) {
        let editingNode = null;
        let editInput = null;

        /**
         * 开始编辑节点
         * @param {Object} node - G6 节点对象
         * @param {Object} model - 节点模型
         */
        const startEditing = (node, model) => {
            editingNode = node;
            // `getCanvasByPoint` 返回的是相对于 G6 画布左上角的坐标
            const canvasPoint = graph.getCanvasByPoint(model.x, model.y);
            // 获取当前缩放比例
            const currentZoom = graph.getZoom();

            const dimensions = getNodeDimensions(model);
            // 应用缩放到输入框尺寸和字体
            const scaledWidth = dimensions.width * currentZoom;
            const scaledHeight = dimensions.height * currentZoom;
            const scaledFontSize = dimensions.fontSize * currentZoom;

            const borderColor = getNodeColor(model);
            const rgbValues = borderColor.substring(1).match(/.{1,2}/g).map(x => parseInt(x, 16));
            const shadowColorRGB = `rgba(${rgbValues.join(', ')}, 0.2)`;

            // 创建输入框
            editInput = document.createElement('input');
            editInput.type = 'text';
            editInput.value = model.label || '';
            editInput.style.position = 'absolute';
            // 定位是相对于 G6 的容器 (container)
            editInput.style.left = (canvasPoint.x - scaledWidth / 2) + 'px';
            editInput.style.top = (canvasPoint.y - scaledHeight / 2) + 'px';
            editInput.style.width = scaledWidth + 'px';
            editInput.style.height = scaledHeight + 'px';
            editInput.style.padding = '0';
            editInput.style.border = `${2 * currentZoom}px solid ${borderColor}`;
            editInput.style.outline = 'none';
            editInput.style.fontSize = scaledFontSize + 'px';
            editInput.style.textAlign = 'center';
            editInput.style.backgroundColor = 'rgba(255, 255, 255, 0.95)';
            editInput.style.zIndex = '1000';
            editInput.style.boxShadow = `0 0 0 ${3 * currentZoom}px ${shadowColorRGB}`;
            editInput.style.fontWeight = (model.type === 'entity' || model.keyType === 'pk') ? 'bold' : 'normal';

            // 根据节点类型设置边框样式
            if (model.type === 'entity') {
                editInput.style.borderRadius = (4 * currentZoom) + 'px';
            } else if (model.type === 'relationship') {
                editInput.style.borderRadius = (8 * currentZoom) + 'px';
                // 菱形节点用矩形输入框，不旋转以便于编辑
            } else { // attribute
                editInput.style.borderRadius = '50%';
            }

            // 将输入框附加到 G6 的容器中
            container.appendChild(editInput);
            editInput.focus();
            editInput.select();

            // 监听键盘事件
            editInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    finishEditing(true);
                    e.preventDefault();
                } else if (e.key === 'Escape') {
                    finishEditing(false);
                    e.preventDefault();
                }
            });

            // 监听失去焦点事件
            editInput.addEventListener('blur', () => {
                setTimeout(() => finishEditing(true), 100);
            });
        };

        /**
         * 完成编辑
         * @param {boolean} save - 是否保存修改
         */
        const finishEditing = (save) => {
            if (!editingNode || !editInput) return;

            if (save && editInput.value.trim()) {
                const newLabel = editInput.value.trim();
                const model = editingNode.getModel();

                // 更新节点标签
                graph.updateItem(editingNode, {
                    label: newLabel
                });

                // 如果是属性节点，可能需要更新相关的数据结构
                if (model.type === 'attribute') {
                    // 可以在这里添加额外的数据同步逻辑
                    console.log(`属性 ${model.label} 已更新为 ${newLabel}`);
                } else if (model.type === 'entity') {
                    console.log(`实体 ${model.label} 已更新为 ${newLabel}`);
                } else if (model.type === 'relationship') {
                    console.log(`关系 ${model.label} 已更新为 ${newLabel}`);
                }
            }

            // 清理编辑状态
            if (editInput && editInput.parentNode) {
                editInput.parentNode.removeChild(editInput);
            }
            editInput = null;
            editingNode = null;
        };

        // 双击节点开始编辑
        graph.on('node:dblclick', (e) => {
            const node = e.item;
            const model = node.getModel();

            // 防止重复编辑
            if (editingNode) {
                finishEditing(false);
            }

            startEditing(node, model);
        });

        // 点击画布其他地方结束编辑
        graph.on('canvas:click', () => {
            if (editingNode) {
                finishEditing(true);
            }
        });

        // 返回控制方法，允许外部调用
        return {
            finishEditing,
            isEditing: () => editingNode !== null
        };
    }

    // ========================
    // 导出模块
    // ========================

    window.Editor = {
        createCodeEditorComponent,
        setupNodeDoubleClickEdit,
        getNodeDimensions,
        getNodeColor
    };

})();
