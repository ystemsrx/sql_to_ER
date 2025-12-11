/**
 * SVG Exporter Module
 * 导出 SVG 功能模块
 */
(function (global) {
    'use strict';

    /**
     * 下载 SVG 文件
     * @param {string} svgString - SVG 字符串内容
     * @param {string} filename - 下载文件名
     */
    function downloadSVG(svgString, filename) {
        const blob = new Blob([svgString], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    /**
     * 导出 ER 图为 SVG
     * @param {Object} options - 导出选项
     * @param {Object} options.graphRef - 图形引用 (React ref)
     * @param {boolean} options.hasGraph - 是否已生成图形
     * @param {HTMLElement} options.containerRef - 容器元素引用 (React ref)
     * @param {Function} options.onError - 错误回调函数
     * @param {Function} options.patchRelationshipLinkPoints - 修正菱形连线计算函数
     * @param {Object} options.G6 - G6 库引用
     */
    function exportSVG(options) {
        const { 
            graphRef, 
            hasGraph, 
            containerRef, 
            onError, 
            patchRelationshipLinkPoints,
            G6 
        } = options;

        if (!graphRef.current || !hasGraph) {
            onError && onError('请先生成ER图');
            return;
        }

        try {
            // 获取当前图形数据，包括节点的实际位置
            const data = graphRef.current.save();

            // 创建一个临时容器
            const tempContainer = document.createElement('div');
            tempContainer.style.position = 'absolute';
            tempContainer.style.left = '-9999px';
            tempContainer.style.top = '-9999px';
            document.body.appendChild(tempContainer);

            // 创建临时SVG图形，使用相同的配置
            const tempGraph = new G6.Graph({
                container: tempContainer,
                width: containerRef.current.offsetWidth,
                height: 600,
                renderer: 'svg',
                modes: {
                    default: []
                },
                // 不使用布局，直接使用保存的位置
                layout: null,
                defaultNode: {
                    style: {
                        lineWidth: 2,
                        stroke: '#000',
                        fill: '#fff'
                    },
                    labelCfg: {
                        style: {
                            fill: '#000',
                            fontSize: 16
                        }
                    }
                },
                defaultEdge: {
                    style: {
                        lineWidth: 1,
                        stroke: '#000'
                    },
                    labelCfg: {
                        style: {
                            fill: '#000',
                            fontSize: 14,
                            background: {
                                fill: '#fff',
                                padding: [2, 4, 2, 4]
                            }
                        }
                    }
                },
                edgeStateStyles: {
                    hover: {
                        stroke: '#1890ff',
                        lineWidth: 2
                    }
                },
                defaultEdgeConfig: {
                    type: 'cubic-horizontal',
                    router: {
                        name: 'orthogonal',
                        args: {
                            offset: 25,
                            maxTurns: 5,
                            useMaxTurns: false,
                            gridSize: 1
                        }
                    },
                    connector: {
                        name: 'curve',
                        args: {
                            curveType: 'cubic-horizontal',
                            curveOffset: 50
                        }
                    }
                }
            });

            // 读取当前图形数据（包含节点位置）
            tempGraph.read(data);
            // 让导出的 SVG 也使用菱形真实边界
            patchRelationshipLinkPoints(tempGraph);

            // 等待渲染完成
            setTimeout(() => {
                try {
                    const tempCanvas = tempGraph.get('canvas');
                    const svgElement = tempCanvas.get('el');

                    // 克隆SVG元素以避免修改原始元素
                    const clonedSvg = svgElement.cloneNode(true);

                    // 获取所有图形的边界框
                    const group = tempGraph.getGroup();
                    const bbox = group.getCanvasBBox();

                    // 添加padding
                    const padding = 40;
                    const viewBoxX = bbox.minX - padding;
                    const viewBoxY = bbox.minY - padding;
                    const viewBoxWidth = bbox.width + padding * 2;
                    const viewBoxHeight = bbox.height + padding * 2;

                    // 设置SVG属性以包含完整内容
                    clonedSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                    clonedSvg.setAttribute('width', viewBoxWidth);
                    clonedSvg.setAttribute('height', viewBoxHeight);
                    clonedSvg.setAttribute('viewBox', `${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight}`);

                    // 设置白色背景，使用viewBox的尺寸
                    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                    rect.setAttribute('x', viewBoxX);
                    rect.setAttribute('y', viewBoxY);
                    rect.setAttribute('width', viewBoxWidth);
                    rect.setAttribute('height', viewBoxHeight);
                    rect.setAttribute('fill', '#ffffff');
                    clonedSvg.insertBefore(rect, clonedSvg.firstChild);

                    const svgString = new XMLSerializer().serializeToString(clonedSvg);
                    downloadSVG(svgString, 'er-diagram.svg');

                    // 清理临时图形和容器
                    tempGraph.destroy();
                    document.body.removeChild(tempContainer);
                } catch (innerError) {
                    console.error('SVG生成失败:', innerError);
                    onError && onError('SVG生成失败: ' + innerError.message);
                    tempGraph.destroy();
                    if (tempContainer.parentNode) {
                        document.body.removeChild(tempContainer);
                    }
                }
            }, 1000); // 增加等待时间确保渲染完成
        } catch (error) {
            console.error('导出SVG失败:', error);
            onError && onError('导出SVG失败: ' + error.message);
        }
    }

    // 导出到全局命名空间
    global.Exporter = {
        exportSVG: exportSVG,
        downloadSVG: downloadSVG
    };

})(window);
