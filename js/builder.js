/**
 * ER Builder Module
 * 
 * 包含 Chen 模型 ER 图的数据生成逻辑和 G6 自定义节点注册
 * - generateChenModelData: 生成节点/边数据
 * - G6 自定义节点: entity (矩形), attribute (椭圆), relationship (菱形)
 * - patchRelationshipLinkPoints: 修正菱形节点连线
 */

// 使用全局命名空间，避免与其他模块冲突
window.ERBuilder = (function () {

    /**
     * Generate Chen Model ER diagram data
     * 将数据库表和关系转换为 G6 可用的节点和边数据
     * 
     * @param {Array} tables - 表数据数组
     * @param {Array} relationships - 关系数据数组
     * @param {boolean} isColored - 是否使用彩色样式
     * @returns {Object} - { nodes, edges }
     */
    const generateChenModelData = (tables, relationships, isColored = true) => {
        const nodes = [];
        const edges = [];
        const entityMap = new Map(); // 用于存储表名到实体ID的映射

        // Create entity nodes (rectangles) - 不设置固定位置，让布局算法处理
        tables.forEach((table, tableIndex) => {
            const entityId = `entity-${table.name}-${tableIndex}`;
            entityMap.set(table.name, entityId); // 记录映射关系
            if (table.alias) {
                entityMap.set(table.alias, entityId);
            }

            nodes.push({
                id: entityId,
                type: 'entity',
                label: table.name,
                // 移除固定的x,y坐标，让布局算法自动处理
                style: {
                    fill: '#ffffff',
                    stroke: isColored ? '#595959' : '#000000',
                    lineWidth: 2
                },
                labelCfg: {
                    style: {
                        fill: '#000000',
                        fontWeight: 'bold'
                    }
                },
                // 添加节点分类信息，用于布局算法
                nodeType: 'entity'
            });

            // Create attribute nodes (ellipses) for each column
            table.columns.forEach((column, colIndex) => {
                const attributeId = `attr-${table.name}-${column.name}-${tableIndex}-${colIndex}`;
                const isPrimaryKey = table.primaryKeys.includes(column.name) || column.isPrimaryKey;

                nodes.push({
                    id: attributeId,
                    type: 'attribute',
                    label: column.name,
                    // 移除固定位置
                    keyType: isPrimaryKey ? 'pk' : 'normal',
                    style: {
                        fill: isColored ? (isPrimaryKey ? '#f6ffed' : '#fffbe6') : '#ffffff',
                        stroke: isColored ? (isPrimaryKey ? '#52c41a' : '#faad14') : '#000000',
                        lineWidth: isPrimaryKey ? 2 : 1
                    },
                    labelCfg: {
                        style: {
                            fill: '#000000',
                            fontWeight: isPrimaryKey ? 'bold' : 'normal'
                        }
                    },
                    nodeType: 'attribute',
                    parentEntity: entityId // 标记父实体
                });

                // Connect attribute to entity
                edges.push({
                    id: `edge-${entityId}-${attributeId}-${tableIndex}-${colIndex}`,
                    source: entityId,
                    target: attributeId,
                    style: {
                        stroke: '#000000'
                    },
                    edgeType: 'entity-attribute'
                });
            });
        });

        // Create relationship nodes (diamonds) and connections
        relationships.forEach((rel, relIndex) => {
            const relationshipId = `rel-${rel.from}-${rel.to}-${rel.label}-${relIndex}`;

            nodes.push({
                id: relationshipId,
                type: 'relationship',
                label: rel.label,
                style: {
                    fill: isColored ? '#f9f0ff' : '#ffffff',
                    stroke: isColored ? '#722ed1' : '#000000',
                    lineWidth: 2
                },
                labelCfg: {
                    style: {
                        fill: '#000000'
                    }
                },
                nodeType: 'relationship'
            });

            // Connect source entity (the one with the FK, 'many' side) to relationship
            edges.push({
                id: `edge-entity-${rel.from}-${relationshipId}-${relIndex}-1`,
                source: entityMap.get(rel.from),
                target: relationshipId,
                label: 'N',
                style: {
                    stroke: '#000000',
                    lineWidth: 2
                },
                labelCfg: {
                    style: {
                        fill: '#000000',
                        background: {
                            fill: '#ffffff',
                            padding: [2, 4, 2, 4]
                        }
                    }
                },
                edgeType: 'entity-relationship'
            });

            // Connect relationship to target entity (the one being referenced, 'one' side)
            edges.push({
                id: `edge-${relationshipId}-entity-${rel.to}-${relIndex}-2`,
                source: relationshipId,
                target: entityMap.get(rel.to),
                label: '1',
                style: {
                    stroke: '#000000',
                    lineWidth: 2
                },
                labelCfg: {
                    style: {
                        fill: '#000000',
                        background: {
                            fill: '#ffffff',
                            padding: [2, 4, 2, 4]
                        }
                    }
                },
                edgeType: 'relationship-entity'
            });
        });

        return { nodes, edges };
    };

    // ========================================
    // G6 自定义节点注册
    // ========================================

    /**
     * 计算文字宽度（考虑中文字符）
     * @param {string} text - 文本内容
     * @param {number} fontSize - 字体大小
     * @returns {number} - 文本宽度
     */
    const getTextWidth = (text, fontSize) => {
        let width = 0;
        for (let char of text) {
            // 中文字符宽度约等于字体大小，英文字符约为字体大小的0.6倍
            if (/[\u4e00-\u9fa5]/.test(char)) {
                width += fontSize;
            } else {
                width += fontSize * 0.6;
            }
        }
        return width;
    };

    /**
     * 菱形节点边界计算函数（供 getLinkPoint 使用）
     * @param {Object} point - 目标点坐标 { x, y }
     * @returns {Object} - 边界交点坐标 { x, y }
     */
    const calculateDiamondLinkPoint = function (point) {
        const bbox = this.getBBox();
        const centerX = bbox.centerX;
        const centerY = bbox.centerY;
        const dx = point.x - centerX;
        const dy = point.y - centerY;
        const halfWidth = bbox.width / 2 || 1;
        const halfHeight = bbox.height / 2 || 1;

        // 当目标点与中心重合时直接返回中心，避免除零
        if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
            return { x: centerX, y: centerY };
        }

        // 菱形公式：|x|/a + |y|/b = 1
        const t = 1 / (Math.abs(dx) / halfWidth + Math.abs(dy) / halfHeight);
        return {
            x: centerX + dx * t,
            y: centerY + dy * t
        };
    };

    /**
     * 注册 G6 自定义节点
     * 必须在 G6 加载后调用
     * @param {Object} G6 - G6 库实例
     */
    const registerCustomNodes = (G6) => {
        // 注册实体节点（矩形）
        G6.registerNode('entity', {
            draw(cfg, group) {
                const fontSize = 18;
                const text = cfg.label || '';

                const textWidth = getTextWidth(text, fontSize);
                const padding = 10; // 水平内边距，从20减小到10
                const minWidth = 80; // 最小宽度
                const minHeight = 50; // 最小高度

                const width = Math.max(minWidth, textWidth + padding * 2);
                const height = Math.max(minHeight, fontSize + 20); // 垂直内边距

                const shape = group.addShape('rect', {
                    attrs: {
                        x: -width / 2,
                        y: -height / 2,
                        width: width,
                        height: height,
                        fill: cfg.style?.fill || '#fff',
                        stroke: cfg.style?.stroke || '#000',
                        lineWidth: cfg.style?.lineWidth || 2
                    },
                    name: 'entity-shape'
                });

                if (cfg.label) {
                    group.addShape('text', {
                        attrs: {
                            x: 0,
                            y: 0,
                            text: cfg.label,
                            fontSize: fontSize,
                            textAlign: 'center',
                            textBaseline: 'middle',
                            fill: '#000',
                            fontWeight: 'bold'
                        },
                        name: 'entity-text',
                        capture: false
                    });
                }

                return shape;
            }
        });

        // 注册属性节点（椭圆）
        G6.registerNode('attribute', {
            draw(cfg, group) {
                const fontSize = 15;
                const text = cfg.label || '';

                const textWidth = getTextWidth(text, fontSize);
                const padding = 16; // 水平内边距
                const minWidth = 60; // 最小宽度
                const minHeight = 40; // 最小高度

                const width = Math.max(minWidth, textWidth + padding * 2);
                const height = Math.max(minHeight, fontSize + 16); // 垂直内边距

                const shape = group.addShape('ellipse', {
                    attrs: {
                        x: 0,
                        y: 0,
                        rx: width / 2,
                        ry: height / 2,
                        fill: cfg.style?.fill || '#fff',
                        stroke: cfg.style?.stroke || '#000',
                        lineWidth: cfg.style?.lineWidth || 1
                    },
                    name: 'attribute-shape'
                });

                if (cfg.label) {
                    const isPrimaryKey = cfg.keyType === 'pk';
                    group.addShape('text', {
                        attrs: {
                            x: 0,
                            y: 0,
                            text: cfg.label,
                            fontSize: fontSize,
                            textAlign: 'center',
                            textBaseline: 'middle',
                            fill: '#000',
                            fontWeight: isPrimaryKey ? 'bold' : 'normal'
                        },
                        name: 'attribute-text',
                        capture: false
                    });

                    // Add underline for primary keys
                    if (isPrimaryKey) {
                        const underlineWidth = getTextWidth(text, fontSize); // 使用精确的文字宽度计算
                        group.addShape('line', {
                            attrs: {
                                x1: -underlineWidth / 2,
                                y1: 12, // 下划线位置
                                x2: underlineWidth / 2,
                                y2: 12,
                                stroke: '#000',
                                lineWidth: 1
                            },
                            name: 'attribute-underline'
                        });
                    }
                }

                return shape;
            }
        });

        // 注册关系节点（菱形）
        G6.registerNode('relationship', {
            draw(cfg, group) {
                const fontSize = 16;
                const text = cfg.label || '';

                const textWidth = getTextWidth(text, fontSize);
                const horizontalPadding = 24; // 水平内边距
                const verticalPadding = 16; // 垂直内边距
                const minWidth = 80; // 最小宽度
                const minHeight = 40; // 最小高度

                // 计算菱形的实际宽度和高度
                // 菱形是扁的，宽度要比高度大
                const requiredWidth = textWidth + horizontalPadding * 2;
                const requiredHeight = fontSize + verticalPadding * 2;

                // 菱形的水平半径（宽度的一半）
                const halfWidth = Math.max(minWidth / 2, requiredWidth / 2);
                // 菱形的垂直半径（高度的一半），设置为宽度的0.6倍，让菱形变扁
                const halfHeight = Math.max(minHeight / 2, Math.min(halfWidth * 0.6, requiredHeight / 2));

                const shape = group.addShape('polygon', {
                    attrs: {
                        points: [
                            [0, -halfHeight],        // 上顶点
                            [halfWidth, 0],          // 右顶点  
                            [0, halfHeight],         // 下顶点
                            [-halfWidth, 0]          // 左顶点
                        ],
                        fill: cfg.style?.fill || '#fff',
                        stroke: cfg.style?.stroke || '#000',
                        lineWidth: cfg.style?.lineWidth || 2
                    },
                    name: 'relationship-shape'
                });

                if (cfg.label) {
                    group.addShape('text', {
                        attrs: {
                            x: 0,
                            y: 0,
                            text: cfg.label,
                            fontSize: fontSize,
                            textAlign: 'center',
                            textBaseline: 'middle',
                            fill: '#000'
                        },
                        name: 'relationship-text',
                        capture: false
                    });
                }

                return shape;
            },
            // 自定义连线计算：使用菱形边界而不是外接矩形
            getLinkPoint: calculateDiamondLinkPoint,
            // 关闭锚点吸附，保证连线直接命中菱形边
            getAnchorPoints() {
                return [];
            }
        });
    };

    /**
     * 让菱形连线落在真实边界上（而非外接矩形）
     * @param {Object} graph - G6 图实例
     */
    const patchRelationshipLinkPoints = (graph) => {
        const nodes = graph.getNodes();
        nodes.forEach((n) => {
            const model = n.getModel();
            if (model.nodeType !== 'relationship') return;
            // 覆盖当前节点实例的 getLinkPoint，让所有连接重新计算到菱形边
            n.getLinkPoint = calculateDiamondLinkPoint;
        });

        // 强制边刷新使用新的连线点
        graph.getEdges().forEach((edge) => {
            graph.updateItem(edge, {});
        });
        graph.refresh();
    };

    // 返回公开 API
    return {
        generateChenModelData,
        registerCustomNodes,
        patchRelationshipLinkPoints,
        // 辅助函数也导出，以便需要时使用
        calculateDiamondLinkPoint,
        getTextWidth
    };

})();
