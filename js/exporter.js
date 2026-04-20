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
     * 基于当前图形构建一份独立、完整的导出用 SVG 字符串。
     * 生成过程与 exportSVG 完全一致（临时 SVG graph + 菱形补丁 + viewBox + 白底）。
     * 回调 cb(err, { svgString, width, height })
     */
    function buildExportSVG(options, cb) {
        const { graphRef, containerRef, patchRelationshipLinkPoints, G6 } = options;
        try {
            const data = graphRef.current.save();

            const tempContainer = document.createElement('div');
            tempContainer.style.position = 'absolute';
            tempContainer.style.left = '-9999px';
            tempContainer.style.top = '-9999px';
            document.body.appendChild(tempContainer);

            const tempGraph = new G6.Graph({
                container: tempContainer,
                width: containerRef.current.offsetWidth,
                height: 600,
                renderer: 'svg',
                modes: { default: [] },
                layout: null,
                defaultNode: {
                    style: { lineWidth: 2, stroke: '#000', fill: '#fff' },
                    labelCfg: { style: { fill: '#000', fontSize: 16 } }
                },
                defaultEdge: {
                    style: { lineWidth: 1, stroke: '#000' },
                    labelCfg: {
                        style: {
                            fill: '#000',
                            fontSize: 14,
                            background: { fill: '#fff', padding: [2, 4, 2, 4] }
                        }
                    }
                },
                edgeStateStyles: { hover: { stroke: '#1890ff', lineWidth: 2 } },
                defaultEdgeConfig: {
                    type: 'cubic-horizontal',
                    router: {
                        name: 'orthogonal',
                        args: { offset: 25, maxTurns: 5, useMaxTurns: false, gridSize: 1 }
                    },
                    connector: {
                        name: 'curve',
                        args: { curveType: 'cubic-horizontal', curveOffset: 50 }
                    }
                }
            });

            tempGraph.read(data);
            patchRelationshipLinkPoints(tempGraph);

            setTimeout(() => {
                try {
                    const svgElement = tempGraph.get('canvas').get('el');
                    const clonedSvg = svgElement.cloneNode(true);

                    const bbox = tempGraph.getGroup().getCanvasBBox();
                    const padding = 40;
                    const viewBoxX = bbox.minX - padding;
                    const viewBoxY = bbox.minY - padding;
                    const viewBoxWidth = bbox.width + padding * 2;
                    const viewBoxHeight = bbox.height + padding * 2;

                    clonedSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                    clonedSvg.setAttribute('width', viewBoxWidth);
                    clonedSvg.setAttribute('height', viewBoxHeight);
                    clonedSvg.setAttribute('viewBox', `${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight}`);

                    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                    rect.setAttribute('x', viewBoxX);
                    rect.setAttribute('y', viewBoxY);
                    rect.setAttribute('width', viewBoxWidth);
                    rect.setAttribute('height', viewBoxHeight);
                    rect.setAttribute('fill', '#ffffff');
                    clonedSvg.insertBefore(rect, clonedSvg.firstChild);

                    const svgString = new XMLSerializer().serializeToString(clonedSvg);

                    tempGraph.destroy();
                    document.body.removeChild(tempContainer);

                    cb(null, {
                        svgString,
                        width: viewBoxWidth,
                        height: viewBoxHeight
                    });
                } catch (innerError) {
                    tempGraph.destroy();
                    if (tempContainer.parentNode) {
                        document.body.removeChild(tempContainer);
                    }
                    cb(innerError);
                }
            }, 1000);
        } catch (err) {
            cb(err);
        }
    }

    /**
     * 导出 ER 图为 SVG
     */
    function exportSVG(options) {
        const { graphRef, hasGraph, onError, onDone } = options;

        const finishErr = (err) => {
            onError && onError(err);
            onDone && onDone(err, null);
        };
        const finishOk = (download) => {
            onDone && onDone(null, download);
        };

        if (!graphRef.current || !hasGraph) {
            finishErr('请先生成ER图');
            return;
        }

        buildExportSVG(options, (err, result) => {
            if (err) {
                console.error('SVG生成失败:', err);
                finishErr('SVG生成失败: ' + (err.message || err));
                return;
            }
            finishOk(() => downloadSVG(result.svgString, 'er-diagram.svg'));
        });
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    // 把 SVG 字符串按 scale 倍数光栅化成 PNG Blob。
    // 走这条路而不是 G6 的 toFullDataURL：后者按 CSS 像素 1:1 输出，
    // 在高分屏或放大查看时文字和细线会糊。
    function rasterizeSVGToPNG(svgString, width, height, scale, cb) {
        const svgBlob = new Blob(
            ['<?xml version="1.0" encoding="UTF-8"?>\n' + svgString],
            { type: 'image/svg+xml;charset=utf-8' }
        );
        const url = URL.createObjectURL(svgBlob);
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(width * scale));
                canvas.height = Math.max(1, Math.round(height * scale));
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob) => {
                    URL.revokeObjectURL(url);
                    if (!blob) {
                        cb(new Error('canvas.toBlob 返回空'));
                        return;
                    }
                    cb(null, blob);
                }, 'image/png');
            } catch (e) {
                URL.revokeObjectURL(url);
                cb(e);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            cb(new Error('SVG 加载失败'));
        };
        img.src = url;
    }

    function exportPNG(options) {
        const { graphRef, hasGraph, onError, onDone, scale: scaleOpt } = options;

        const finishErr = (err) => {
            onError && onError(err);
            onDone && onDone(err, null);
        };
        const finishOk = (download) => {
            onDone && onDone(null, download);
        };

        if (!graphRef.current || !hasGraph) {
            finishErr('请先生成ER图');
            return;
        }

        // 默认至少 2x，在高 DPR 屏幕上跟随系统（封顶 3x 以控制文件体积）。
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        const scale = scaleOpt || Math.max(2, Math.min(3, Math.ceil(dpr)));

        buildExportSVG(options, (err, result) => {
            if (err) {
                console.error('导出PNG失败:', err);
                finishErr('导出PNG失败: ' + (err.message || err));
                return;
            }
            rasterizeSVGToPNG(result.svgString, result.width, result.height, scale, (rErr, blob) => {
                if (rErr) {
                    console.error('导出PNG失败:', rErr);
                    finishErr('导出PNG失败: ' + (rErr.message || rErr));
                    return;
                }
                finishOk(() => downloadBlob(blob, 'er-diagram.png'));
            });
        });
    }

    // 导出到全局命名空间
    global.Exporter = {
        exportSVG: exportSVG,
        exportPNG: exportPNG,
        downloadSVG: downloadSVG
    };

})(window);
