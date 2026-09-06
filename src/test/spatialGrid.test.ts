import { expect, it } from "vitest";
import { SpatialGrid } from "../layout/spatialGrid";

it("uses a bounded fallback for wide and unsafe cell ranges without losing candidates", () => {
  const grid = new SpatialGrid<string>(64);
  const box = (minX: number, maxX = minX) => ({ minX, maxX, minY: 0, maxY: 1 });
  grid.insert("near", box(0));
  grid.insert("wide", box(-1_000_000, 1_000_000));
  grid.insert("unsafe", box(Number.MAX_VALUE));
  grid.insert("nonfinite", box(Infinity));
  const seen: string[] = [];
  grid.queryRect(box(0), 0, (item) => {
    seen.push(item);
  });
  expect(new Set(seen)).toEqual(new Set(["near", "wide", "unsafe", "nonfinite"]));
  expect(seen).toHaveLength(4);
  grid.remove("wide");
  grid.insert("unsafe", box(10));
  const all: string[] = [];
  grid.querySegment({ x: -Number.MAX_VALUE, y: 0 }, { x: Number.MAX_VALUE, y: 0 }, 0, (item) => {
    all.push(item);
  });
  expect(new Set(all)).toEqual(new Set(["near", "unsafe", "nonfinite"]));
  let visits = 0;
  grid.queryRect(box(-Infinity, Infinity), 0, () => {
    visits++;
    return true;
  });
  expect(visits).toBe(1);
});
