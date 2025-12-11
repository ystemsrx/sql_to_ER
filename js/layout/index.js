/**
 * Layout Module Index - Unified export entry
 */

(function (exports) {
    'use strict';

    const utils = exports.LayoutUtils || {};
    const animation = exports.LayoutAnimation || {};
    const initial = exports.LayoutInitial || {};
    const spread = exports.LayoutComponentSpread || {};
    const forceAlign = exports.LayoutForceAlign || {};
    const arrange = exports.LayoutArrange || {};

    // 保持与原 layout.js 相同的 API 接口
    exports.Layout = {
        // Utils
        deterministicHash: utils.deterministicHash,
        deterministicRandom: utils.deterministicRandom,
        normalizeAngle: utils.normalizeAngle,
        getRadius: utils.getRadius,

        // Animation
        smoothFitView: animation.smoothFitView,
        animateNodesToTargets: animation.animateNodesToTargets,

        // Initial Layout
        applyInitialComponentPositions: initial.applyInitialComponentPositions,

        // Component Spread
        spreadDisconnectedComponents: spread.spreadDisconnectedComponents,

        // Force Align Layout
        forceAlignLayout: forceAlign.forceAlignLayout,

        // Arrange Layout
        arrangeLayout: arrange.arrangeLayout
    };

})(window);
