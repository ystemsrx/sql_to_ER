/**
 * Headless animation shims — must be imported before any layout runs.
 *
 * The real layout functions (forceAlignLayout / arrangeLayout) finish by tweening
 * node positions through animateNodesToTargets(), which drives requestAnimationFrame
 * + performance.now(). Node has performance but no rAF. We install an rAF that fires
 * synchronously with an ever-growing timestamp far past any animation duration, so
 * `progress` clamps to 1 on the first frame: nodes land exactly on their computed
 * targets and onFinish chains run to completion inside the original layout() call.
 * View-only tweens (smoothFitView) collapse the same way and are harmless.
 */
const g = globalThis as unknown as {
  requestAnimationFrame?: (cb: (t: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
};

let clock = 1e9;
g.requestAnimationFrame = (cb: (t: number) => void): number => {
  clock += 1e9;
  cb(clock);
  return 0;
};
g.cancelAnimationFrame = () => {};

export {};
