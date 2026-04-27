import { describe, expect, it } from "vitest";
import { buildDrawioXML, escapeXml } from "../exporter";
import type {
  EREdgeModel,
  ERNodeModel,
  GraphEdgeLike,
  GraphLike,
  GraphNodeLike,
} from "../types";

describe("escapeXml", () => {
  it("escapes the five canonical XML entities", () => {
    expect(escapeXml(`<a href="x">x & y</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;x &amp; y&lt;/a&gt;",
    );
    expect(escapeXml("It's")).toBe("It&apos;s");
  });

  it("treats null/undefined as empty string", () => {
    expect(escapeXml(null)).toBe("");
    expect(escapeXml(undefined)).toBe("");
  });

  it("stringifies non-string inputs", () => {
    expect(escapeXml(42)).toBe("42");
    expect(escapeXml(true)).toBe("true");
  });
});

// 构造仅 buildDrawioXML 需要的 GraphLike 子集。
const buildNode = (
  model: ERNodeModel,
  bbox: { minX: number; minY: number; width: number; height: number },
): GraphNodeLike =>
  ({
    getModel: () => model,
    getBBox: () => ({
      ...bbox,
      maxX: bbox.minX + bbox.width,
      maxY: bbox.minY + bbox.height,
      centerX: bbox.minX + bbox.width / 2,
      centerY: bbox.minY + bbox.height / 2,
    }),
  }) as unknown as GraphNodeLike;

const buildEdge = (model: EREdgeModel): GraphEdgeLike =>
  ({ getModel: () => model }) as unknown as GraphEdgeLike;

const buildGraph = (
  nodes: GraphNodeLike[],
  edges: GraphEdgeLike[],
): GraphLike =>
  ({
    destroyed: false,
    getNodes: () => nodes,
    getEdges: () => edges,
    findById: () => null,
    updateItem: () => {},
    setAutoPaint: () => {},
    paint: () => {},
    refreshPositions: () => {},
    get: () => null,
    getZoom: () => 1,
  }) as unknown as GraphLike;

describe("buildDrawioXML", () => {
  it("emits a well-formed mxfile root with one mxCell per node + edge", () => {
    const nodes = [
      buildNode(
        {
          id: "entity-users-0",
          label: "users",
          nodeType: "entity",
          style: { fill: "#ffffff", stroke: "#000000", lineWidth: 2 },
        },
        { minX: 100, minY: 80, width: 120, height: 60 },
      ),
      buildNode(
        {
          id: "attr-users-id-0-0",
          label: "id",
          nodeType: "attribute",
          keyType: "pk",
          style: { fill: "#fffbe6", stroke: "#52c41a", lineWidth: 2 },
        },
        { minX: 200, minY: 200, width: 60, height: 40 },
      ),
    ];
    const edges = [
      buildEdge({
        source: "entity-users-0",
        target: "attr-users-id-0-0",
        edgeType: "entity-attribute",
        style: { stroke: "#000000", lineWidth: 1 },
      }),
    ];

    const xml = buildDrawioXML(buildGraph(nodes, edges));

    // Header / shell
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<mxfile");
    expect(xml).toContain("</mxfile>");
    expect(xml).toMatch(/<diagram id="sql2er-[a-z0-9-]+" name="ER">/);

    // Two vertex cells (renumbered to v0, v1) + one edge cell
    expect((xml.match(/vertex="1"/g) || []).length).toBe(2);
    expect((xml.match(/edge="1"/g) || []).length).toBe(1);
    // Edge endpoints should reference the renumbered vertex ids
    expect(xml).toContain('source="v0"');
    expect(xml).toContain('target="v1"');

    // Geometry uses rounded ints
    expect(xml).toContain('<mxGeometry x="100" y="80" width="120" height="60"');
  });

  it("XML-escapes node and edge labels", () => {
    const xml = buildDrawioXML(
      buildGraph(
        [
          buildNode(
            {
              id: "n",
              label: `<bad & "quoted">`,
              nodeType: "entity",
            },
            { minX: 0, minY: 0, width: 10, height: 10 },
          ),
        ],
        [],
      ),
    );
    expect(xml).toContain(
      'value="&lt;bad &amp; &quot;quoted&quot;&gt;"',
    );
    expect(xml).not.toContain('value="<bad');
  });

  it("uses different style strings for entity / attribute / relationship nodes", () => {
    const xml = buildDrawioXML(
      buildGraph(
        [
          buildNode(
            { id: "e", label: "E", nodeType: "entity" },
            { minX: 0, minY: 0, width: 10, height: 10 },
          ),
          buildNode(
            { id: "a", label: "A", nodeType: "attribute", keyType: "pk" },
            { minX: 0, minY: 0, width: 10, height: 10 },
          ),
          buildNode(
            { id: "r", label: "R", nodeType: "relationship" },
            { minX: 0, minY: 0, width: 10, height: 10 },
          ),
        ],
        [],
      ),
    );
    // Entity: rectangle (no shape prefix), attribute: ellipse, relationship: rhombus
    expect(xml).toMatch(/value="E"[^/]*style="rounded=0/);
    expect(xml).toMatch(/value="A"[^/]*style="ellipse/);
    expect(xml).toMatch(/value="R"[^/]*style="rhombus/);
  });

  it("skips edges whose source or target id is unknown", () => {
    const nodes = [
      buildNode(
        { id: "e1", label: "e1", nodeType: "entity" },
        { minX: 0, minY: 0, width: 10, height: 10 },
      ),
    ];
    const edges = [
      buildEdge({ source: "e1", target: "ghost" }),
      buildEdge({ source: "ghost", target: "e1" }),
    ];
    const xml = buildDrawioXML(buildGraph(nodes, edges));
    expect((xml.match(/edge="1"/g) || []).length).toBe(0);
  });

  it("marks dashed-style nodes with dashed=1", () => {
    const xml = buildDrawioXML(
      buildGraph(
        [
          buildNode(
            {
              id: "p",
              label: "missing",
              nodeType: "entity",
              style: { lineDash: [4, 4] },
            },
            { minX: 0, minY: 0, width: 10, height: 10 },
          ),
        ],
        [],
      ),
    );
    expect(xml).toContain("dashed=1");
  });
});
