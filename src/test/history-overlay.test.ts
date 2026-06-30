import { describe, expect, it } from "vitest";
import {
  computeHistoryCardVisualState,
  getHistoryRenderRange,
} from "../HistoryOverlay";

describe("HistoryOverlay virtualization", () => {
  it("keeps the existing desktop card transform math", () => {
    const state = computeHistoryCardVisualState({
      index: 3,
      currentScroll: 3.25,
      targetScroll: 3,
      isDragging: false,
      previousShift: 0.5,
      isMobile: false,
      viewportWidth: 1440,
    });

    expect(state.shift).toBeCloseTo(0.55, 6);
    expect(state.x).toBeCloseTo(38.16, 2);
    expect(state.y).toBe(0);
    expect(state.z).toBeCloseTo(127.875, 3);
    expect(state.rotY).toBeCloseTo(-12.15, 2);
    expect(state.scale).toBeCloseTo(0.97, 3);
    expect(state.opacity).toBe(1);
    expect(state.zIndex).toBe(1053);
  });

  it("renders every card that the old opacity formula could show", () => {
    const total = 120;
    for (const currentScroll of [0, 0.4, 5.2, 20.75, 60.4, 118.6]) {
      const range = getHistoryRenderRange(total, currentScroll);
      for (let i = 0; i < total; i++) {
        const state = computeHistoryCardVisualState({
          index: i,
          currentScroll,
          targetScroll: Math.round(currentScroll),
          isDragging: true,
          previousShift: 0,
          isMobile: false,
          viewportWidth: 1440,
        });
        if (state.opacity > 0) {
          expect(i, `index ${i} at scroll ${currentScroll}`).toBeGreaterThanOrEqual(range.start);
          expect(i, `index ${i} at scroll ${currentScroll}`).toBeLessThanOrEqual(range.end);
        }
      }
    }
  });

  it("keeps large histories bounded to a small visible window", () => {
    const range = getHistoryRenderRange(120, 60.4);
    expect(range.end - range.start + 1).toBeLessThanOrEqual(18);
  });
});
