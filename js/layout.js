/**
 * Layout Module Loader for ER Diagram Generator
 * Synchronously loads all sub-modules in correct order
 */

(function () {
    'use strict';

    const moduleBasePath = 'js/layout/';
    const modules = [
        'utils.js',
        'animation.js',
        'initialLayout.js',
        'componentSpread.js',
        'forceAlignLayout.js',
        'arrangeLayout.js',
        'index.js'
    ];

    // Synchronous script injection
    modules.forEach(module => {
        document.write(`<script src="${moduleBasePath}${module}"><\/script>`);
    });

})();
