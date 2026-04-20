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

    // ========================================
    // Drawio (mxfile) 导出
    // ========================================
    //
    // 目的：把当前 G6 图一比一输出为 drawio 官方可直接 File -> Open 的 .drawio 文件。
    // 选择直接从 G6 图的"当前状态"抽取节点/边，而不是复用 SVG 导出通路，因为 drawio 需要
    // 结构化的 mxCell（带 vertex/edge/source/target/geometry），而不是扁平 SVG 元素。

    function escapeXml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    // 把样式对象拼成 drawio 的 style 串。drawio 不认 G6 的驼峰键，需要映射。
    function buildVertexStyle(model) {
        const s = model.style || {};
        const fill = s.fill || '#ffffff';
        const stroke = s.stroke || '#000000';
        const strokeWidth = s.lineWidth || 1;
        const dashed = Array.isArray(s.lineDash) && s.lineDash.length ? 'dashed=1;' : '';
        const labelFontColor = (model.labelCfg && model.labelCfg.style && model.labelCfg.style.fill) || '#1e293b';

        // fontStyle 是 bitmask：1=bold, 2=italic, 4=underline
        const lblStyle = (model.labelCfg && model.labelCfg.style) || {};
        let fontStyle = 0;
        if (lblStyle.fontWeight === 'bold' || lblStyle.fontWeight === '700' || lblStyle.fontWeight === 700) fontStyle |= 1;
        if (lblStyle.fontStyle === 'italic') fontStyle |= 2;

        if (model.nodeType === 'entity') {
            return `rounded=0;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};strokeWidth=${strokeWidth};fontSize=16;fontStyle=${fontStyle || 1};fontColor=${labelFontColor};${dashed}`;
        }
        if (model.nodeType === 'attribute') {
            // 主键：加下划线（bit 4），且通常加粗
            if (model.keyType === 'pk') fontStyle |= 4 | 1;
            return `ellipse;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};strokeWidth=${strokeWidth};fontSize=13;fontStyle=${fontStyle};fontColor=${labelFontColor};${dashed}`;
        }
        if (model.nodeType === 'relationship') {
            return `rhombus;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};strokeWidth=${strokeWidth};fontSize=14;fontStyle=${fontStyle};fontColor=${labelFontColor};${dashed}`;
        }
        return `rounded=0;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};strokeWidth=${strokeWidth};`;
    }

    function buildEdgeStyle(model) {
        const s = model.style || {};
        const stroke = s.stroke || '#000000';
        const strokeWidth = s.lineWidth || 1;
        // endArrow=none：Chen 模型里 entity-attribute、entity-relationship 都是无向线
        return `endArrow=none;html=1;rounded=0;edgeStyle=none;strokeColor=${stroke};strokeWidth=${strokeWidth};fontSize=12;`;
    }

    // 生成一个 drawio diagram id（短、仅字母数字下划线，drawio 对 id 没有严格校验但保守一些）
    function makeDiagramId() {
        const t = Date.now().toString(36);
        const r = Math.random().toString(36).slice(2, 8);
        return `sql2er-${t}-${r}`;
    }

    /**
     * 基于当前 G6 图（位置/标签/样式）生成 drawio .drawio (mxfile) XML 字符串。
     * 走节点当前 bbox，保证用户在页面上拖动/布局后的位置会原样带进 drawio。
     */
    function buildDrawioXML(graph) {
        const nodes = graph.getNodes();
        const edges = graph.getEdges();

        const cells = [];
        cells.push('<mxCell id="0" />');
        cells.push('<mxCell id="1" parent="0" />');

        // G6 node id 可能包含点/斜杠等字符，drawio 对 mxCell id 虽然比较宽松，但 source/target
        // 里若出现未转义字符容易踩坑；这里统一重编号成 v0, v1, ...
        const idMap = new Map();
        let vi = 0;

        nodes.forEach((node) => {
            const model = node.getModel();
            const bbox = node.getBBox(); // 图坐标系下的包围盒
            const id = `v${vi++}`;
            idMap.set(model.id, id);

            const style = buildVertexStyle(model);
            const label = escapeXml(model.label || '');

            // 位置四舍五入，避免导出 "123.45678901234" 这种噪声
            const x = Math.round(bbox.minX);
            const y = Math.round(bbox.minY);
            const w = Math.round(bbox.width);
            const h = Math.round(bbox.height);

            cells.push(
                `<mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="1">` +
                `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" />` +
                `</mxCell>`
            );
        });

        let ei = 0;
        edges.forEach((edge) => {
            const model = edge.getModel();
            const source = idMap.get(model.source);
            const target = idMap.get(model.target);
            if (!source || !target) return; // 端点找不到（理论不会发生）时跳过

            const id = `e${ei++}`;
            const style = buildEdgeStyle(model);
            const label = escapeXml(model.label || '');

            cells.push(
                `<mxCell id="${id}" value="${label}" style="${style}" edge="1" parent="1" source="${source}" target="${target}">` +
                `<mxGeometry relative="1" as="geometry" />` +
                `</mxCell>`
            );
        });

        const diagramId = makeDiagramId();
        const xml =
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
            `<mxfile host="app.diagrams.net" agent="sql2er" version="24.0.0" type="device">` +
            `<diagram id="${diagramId}" name="ER">` +
            `<mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="826" math="0" shadow="0">` +
            `<root>${cells.join('')}</root>` +
            `</mxGraphModel>` +
            `</diagram>` +
            `</mxfile>`;

        return xml;
    }

    function downloadDrawio(xmlString, filename) {
        // drawio 默认扩展名为 .drawio，MIME 用 application/xml 最通用
        const blob = new Blob([xmlString], { type: 'application/xml;charset=utf-8' });
        downloadBlob(blob, filename);
    }

    function exportDrawio(options) {
        const { graphRef, hasGraph, onError, onDone, patchRelationshipLinkPoints } = options;

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

        try {
            // 对齐 SVG 导出：先把菱形连线点修正到真实边界，这样导出用的 bbox 与可视一致
            if (patchRelationshipLinkPoints) {
                try { patchRelationshipLinkPoints(graphRef.current); } catch (_) { /* 容错 */ }
            }
            const xml = buildDrawioXML(graphRef.current);
            finishOk(() => downloadDrawio(xml, 'er-diagram.drawio'));
        } catch (err) {
            console.error('导出Drawio失败:', err);
            finishErr('导出Drawio失败: ' + (err.message || err));
        }
    }

    // 导出到全局命名空间
    global.Exporter = {
        exportSVG: exportSVG,
        exportPNG: exportPNG,
        exportDrawio: exportDrawio,
        downloadSVG: downloadSVG
    };

})(window);
