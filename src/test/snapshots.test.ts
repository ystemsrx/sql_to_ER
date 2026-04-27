import { describe, expect, it } from "vitest";
import { captureGraphSnapshot, hashInput } from "../snapshots";
import type { GraphLike, GraphEdgeLike, GraphNodeLike } from "../types";

describe("hashInput", () => {
  it("returns an 8-char lowercase hex string", () => {
    const h = hashInput("hello world");
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic for the same input", () => {
    expect(hashInput("CREATE TABLE t (id INT)")).toBe(
      hashInput("CREATE TABLE t (id INT)"),
    );
  });

  it("changes when the input changes", () => {
    expect(hashInput("a")).not.toBe(hashInput("b"));
    expect(hashInput("Table users { id int }")).not.toBe(
      hashInput("Table users { id INT }"),
    );
  });

  it("handles empty / nullish input without crashing", () => {
    expect(hashInput("")).toMatch(/^[0-9a-f]{8}$/);
    expect(hashInput(null)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashInput(undefined)).toMatch(/^[0-9a-f]{8}$/);
    // null and undefined are both stringified to ""
    expect(hashInput(null)).toBe(hashInput(""));
    expect(hashInput(undefined)).toBe(hashInput(""));
  });

  it("works on Chinese / unicode input", () => {
    const a = hashInput("用户");
    const b = hashInput("订单");
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(b).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});

// 构造一个最小可用的 GraphLike，仅暴露 captureGraphSnapshot 用到的接口。
const fakeNode = (
  id: string,
  x: number,
  y: number,
  label: string,
): GraphNodeLike =>
  ({
    getModel: () => ({ id, x, y, label }),
    getBBox: () => ({
      minX: x,
      minY: y,
      maxX: x,
      maxY: y,
      width: 0,
      height: 0,
      centerX: x,
      centerY: y,
    }),
  }) as unknown as GraphNodeLike;

const fakeGraph = (
  nodes: GraphNodeLike[],
  destroyed = false,
): GraphLike =>
  ({
    destroyed,
    getNodes: () => nodes,
    getEdges: () => [] as GraphEdgeLike[],
    findById: () => null,
    updateItem: () => {},
    setAutoPaint: () => {},
    paint: () => {},
    refreshPositions: () => {},
    get: () => null,
    getZoom: () => 1,
  }) as unknown as GraphLike;

describe("captureGraphSnapshot", () => {
  it("returns id/x/y/label for every node", () => {
    const g = fakeGraph([
      fakeNode("a", 10, 20, "Users"),
      fakeNode("b", 30, 40, "Orders"),
    ]);
    expect(captureGraphSnapshot(g)).toEqual([
      { id: "a", x: 10, y: 20, label: "Users" },
      { id: "b", x: 30, y: 40, label: "Orders" },
    ]);
  });

  it("returns null when the graph is destroyed", () => {
    const g = fakeGraph([fakeNode("a", 0, 0, "x")], true);
    expect(captureGraphSnapshot(g)).toBeNull();
  });
});
