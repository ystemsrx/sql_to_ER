/**
 * Layout Utilities Module
 * Contains common utility functions for layout calculations:
 * - Deterministic hash and random number generation
 * - Angle normalization
 * - Node radius calculation
 */

(function (exports) {
    'use strict';

    /**
     * 基于字符串生成确定性哈希值（用于替代Math.random）
     * @param {string} str - 输入字符串
     * @param {number} extraSeed - 额外的种子值
     * @returns {number} 哈希值
     */
    const deterministicHash = (str, extraSeed = 0) => {
        let hash = extraSeed;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash);
    };

    /**
     * 生成确定性的[-0.5, 0.5)范围内的数值
     * @param {number} seed - 种子值
     * @param {number} extraSeed - 额外的种子值
     * @returns {number} 确定性随机数
     */
    const deterministicRandom = (seed, extraSeed = 0) => {
        const x = Math.sin(seed + extraSeed * 1000) * 10000;
        return (x - Math.floor(x)) - 0.5;
    };

    /**
     * 将角度归一化到 [0, 2π) 范围
     * @param {number} a - 原始角度
     * @returns {number} 归一化后的角度
     */
    const normalizeAngle = (a) => {
        let ang = a % (Math.PI * 2);
        if (ang < 0) ang += Math.PI * 2;
        return ang;
    };

    /**
     * 计算节点的半径（基于边界框的对角线）
     * @param {Object} node - G6 节点实例
     * @returns {number} 节点半径
     */
    const getRadius = (node) => {
        if (!node) return 30;
        const bbox = node.getBBox();
        return Math.sqrt(bbox.width * bbox.width + bbox.height * bbox.height) / 2;
    };

    // 初始化 LayoutUtils 命名空间
    if (!exports.LayoutUtils) {
        exports.LayoutUtils = {};
    }

    // 导出工具函数
    Object.assign(exports.LayoutUtils, {
        deterministicHash,
        deterministicRandom,
        normalizeAngle,
        getRadius
    });

})(window);
