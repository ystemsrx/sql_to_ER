/**
 * Initial Layout Module
 * Contains functions for initial component positioning:
 * - Position disconnected components around the center before first render
 */

(function (exports) {
    'use strict';

    // 获取工具函数
    const getUtils = () => exports.LayoutUtils || {};

    /**
     * 初始定位：让互不相连的组件一开始就围绕中心分布
     * @param {Array} nodes - 节点数据数组
     * @param {Array} edges - 边数据数组
     * @param {HTMLElement} containerEl - 容器元素
     * @param {number} seed - 随机种子
     */
    const applyInitialComponentPositions = (nodes, edges, containerEl, seed = 0) => {
        const { deterministicHash, deterministicRandom } = getUtils();

        if (!containerEl || !nodes.length) return;
        if (nodes.length < 2) return;

        const width = containerEl.offsetWidth || 1200;
        const height = containerEl.offsetHeight || 800;
        const center = { x: width / 2, y: height / 2 };

        const sizeMap = {
            entity: 140,
            relationship: 90,
            attribute: 90
        };

        const approxRadius = (node) => {
            const size = sizeMap[node.nodeType] || 90;
            return Math.sqrt(size * size * 2) / 2 + 20;
        };

        const adj = new Map();
        edges.forEach(e => {
            const { source, target } = e;
            if (!adj.has(source)) adj.set(source, new Set());
            if (!adj.has(target)) adj.set(target, new Set());
            adj.get(source).add(target);
            adj.get(target).add(source);
        });

        const visited = new Set();
        const components = [];
        const sortedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
        sortedNodes.forEach(n => {
            if (visited.has(n.id)) return;
            const stack = [n.id];
            const comp = [];
            visited.add(n.id);
            while (stack.length) {
                const cur = stack.pop();
                const found = nodes.find(nn => nn.id === cur);
                if (found) comp.push(found);
                const neighbors = adj.get(cur);
                if (!neighbors) continue;
                const sortedNeighbors = Array.from(neighbors).sort((a, b) => a.localeCompare(b));
                sortedNeighbors.forEach(nb => {
                    if (!visited.has(nb)) {
                        visited.add(nb);
                        stack.push(nb);
                    }
                });
            }
            if (comp.length) components.push(comp);
        });

        if (components.length < 2) return;

        const compMeta = components.map(list => {
            const r = list.reduce((max, n) => Math.max(max, approxRadius(n)), 30);
            const extra = Math.max(0, list.length - 6) * 6;
            return { nodes: list, radius: r + extra };
        });

        const perim = compMeta.reduce((sum, c) => sum + c.radius * 2, 0);
        const gap = 100;
        const orbit = Math.min(
            Math.max(240, (perim + gap * compMeta.length) / (2 * Math.PI)),
            520
        );

        let angle = -Math.PI / 2;
        const angleStep = (Math.PI * 2) / compMeta.length;
        compMeta.forEach(meta => {
            const cx = center.x + orbit * Math.cos(angle);
            const cy = center.y + orbit * Math.sin(angle);
            meta.nodes.forEach((n, idx) => {
                const hash = deterministicHash(n.id, seed);
                const offsetX = deterministicRandom(hash, seed) * Math.max(40, meta.radius * 0.4);
                const offsetY = deterministicRandom(hash + 1000, seed) * Math.max(40, meta.radius * 0.4);
                n.x = cx + offsetX;
                n.y = cy + offsetY;
            });
            angle += angleStep;
        });
    };

    // 初始化 LayoutInitial 命名空间
    if (!exports.LayoutInitial) {
        exports.LayoutInitial = {};
    }

    // 导出函数
    Object.assign(exports.LayoutInitial, {
        applyInitialComponentPositions
    });

})(window);
