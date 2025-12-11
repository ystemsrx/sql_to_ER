/**
 * Component Spread Module
 * Contains functions to spread disconnected components:
 * - Distribute disconnected components around the diagram center
 */

(function (exports) {
    'use strict';

    // 获取动画函数
    const getAnimation = () => exports.LayoutAnimation || {};

    /**
     * 将互不相连的组件分散到中心周围
     * @param {Object} graph - G6 图形实例
     * @param {Function} onFinish - 完成回调
     */
    const spreadDisconnectedComponents = (graph, onFinish) => {
        const { animateNodesToTargets } = getAnimation();

        if (!graph || graph.destroyed) {
            if (onFinish) onFinish();
            return;
        }
        const nodes = graph.getNodes();
        if (nodes.length < 2) {
            if (onFinish) onFinish();
            return;
        }

        const adj = new Map();
        graph.getEdges().forEach(edge => {
            const { source, target } = edge.getModel();
            if (!adj.has(source)) adj.set(source, new Set());
            if (!adj.has(target)) adj.set(target, new Set());
            adj.get(source).add(target);
            adj.get(target).add(source);
        });

        const visited = new Set();
        const components = [];
        const sortedNodes = [...nodes].sort((a, b) => a.getModel().id.localeCompare(b.getModel().id));
        sortedNodes.forEach(node => {
            const id = node.getModel().id;
            if (visited.has(id)) return;
            const stack = [id];
            const comp = [];
            visited.add(id);
            while (stack.length) {
                const cur = stack.pop();
                const curNode = graph.findById(cur);
                if (curNode) comp.push(curNode);
                const neighbors = adj.get(cur);
                if (!neighbors) continue;
                const sortedNeighbors = Array.from(neighbors).sort((a, b) => a.localeCompare(b));
                sortedNeighbors.forEach(nid => {
                    if (!visited.has(nid)) {
                        visited.add(nid);
                        stack.push(nid);
                    }
                });
            }
            if (comp.length) components.push(comp);
        });

        if (components.length < 2) {
            if (onFinish) onFinish();
            return;
        }

        const diagramCenter = {
            x: graph.get('width') / 2,
            y: graph.get('height') / 2
        };

        const targets = new Map();

        const compMeta = components.map(comp => {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            let cx = 0, cy = 0;
            comp.forEach(n => {
                const bbox = n.getBBox();
                minX = Math.min(minX, bbox.minX);
                maxX = Math.max(maxX, bbox.maxX);
                minY = Math.min(minY, bbox.minY);
                maxY = Math.max(maxY, bbox.maxY);
                cx += bbox.centerX;
                cy += bbox.centerY;
            });
            const width = Math.max(40, maxX - minX);
            const height = Math.max(40, maxY - minY);
            const radius = Math.sqrt(width * width + height * height) / 2 + 40;
            const center = {
                x: cx / comp.length,
                y: cy / comp.length
            };
            return { comp, radius, center };
        });

        const gap = 50;
        const totalSpan = compMeta.reduce((sum, c) => sum + c.radius * 2 + gap, 0);
        const orbitRadius = Math.min(
            Math.max(
                totalSpan / (2 * Math.PI),
                Math.max(...compMeta.map(c => c.radius)) + gap + 40,
                240
            ),
            520
        );

        let angleCursor = -Math.PI / 2;
        compMeta.forEach(meta => {
            const angleSpan = ((meta.radius * 2 + gap) / totalSpan) * Math.PI * 2;
            const midAngle = angleCursor + angleSpan / 2;

            const targetCenter = {
                x: diagramCenter.x + orbitRadius * Math.cos(midAngle),
                y: diagramCenter.y + orbitRadius * Math.sin(midAngle)
            };
            const rotateAngle = midAngle + Math.PI / 2;
            const cosA = Math.cos(rotateAngle);
            const sinA = Math.sin(rotateAngle);

            meta.comp.forEach(node => {
                const m = node.getModel();
                const relX = m.x - meta.center.x;
                const relY = m.y - meta.center.y;
                const rx = relX * cosA - relY * sinA;
                const ry = relX * sinA + relY * cosA;
                targets.set(m.id, {
                    x: targetCenter.x + rx,
                    y: targetCenter.y + ry
                });
            });

            angleCursor += angleSpan;
        });

        animateNodesToTargets(graph, targets, 450, onFinish);
    };

    // 初始化 LayoutComponentSpread 命名空间
    if (!exports.LayoutComponentSpread) {
        exports.LayoutComponentSpread = {};
    }

    // 导出函数
    Object.assign(exports.LayoutComponentSpread, {
        spreadDisconnectedComponents
    });

})(window);
