import { describe, expect, it } from "vitest";
import {
  generateChenModelData,
  estimateAttributeHalfSize,
  getTextWidth,
} from "../builder";
import type { ParsedRelationship, ParsedTable } from "../types";

const usersTable: ParsedTable = {
  name: "users",
  columns: [
    { name: "id", type: "int", isPrimaryKey: true, comment: "user id" },
    { name: "name", type: "varchar(50)", isPrimaryKey: false },
  ],
  primaryKeys: ["id"],
  foreignKeys: [],
};

const ordersTable: ParsedTable = {
  name: "orders",
  columns: [
    { name: "id", type: "int", isPrimaryKey: true },
    { name: "user_id", type: "int", isPrimaryKey: false },
  ],
  primaryKeys: ["id"],
  foreignKeys: [
    { column: "user_id", referencedTable: "users", referencedColumn: "id" },
  ],
};

describe("generateChenModelData", () => {
  it("creates an entity node per table and an attribute node per column", () => {
    const data = generateChenModelData([usersTable], []);
    const entities = data.nodes.filter((n) => n.nodeType === "entity");
    const attrs = data.nodes.filter((n) => n.nodeType === "attribute");
    expect(entities).toHaveLength(1);
    expect(entities[0].label).toBe("users");
    expect(attrs.map((a) => a.label)).toEqual(["id", "name"]);
    // Primary key attribute is bolder/highlighted
    expect(attrs[0].keyType).toBe("pk");
    expect(attrs[1].keyType).toBe("normal");
  });

  it("connects every attribute back to its parent entity", () => {
    const data = generateChenModelData([usersTable], []);
    const entityId = data.nodes.find((n) => n.nodeType === "entity")!.id;
    const attrEdges = data.edges.filter(
      (e) => e.edgeType === "entity-attribute",
    );
    expect(attrEdges).toHaveLength(2);
    expect(attrEdges.every((e) => e.source === entityId)).toBe(true);
  });

  it("renders one diamond + two edges (N / 1) for each relationship", () => {
    const rels: ParsedRelationship[] = [
      { from: "orders", to: "users", label: "user_id" },
    ];
    const data = generateChenModelData([usersTable, ordersTable], rels);
    const diamonds = data.nodes.filter((n) => n.nodeType === "relationship");
    expect(diamonds).toHaveLength(1);
    expect(diamonds[0].label).toBe("user_id");

    const erEdges = data.edges.filter(
      (e) =>
        e.edgeType === "entity-relationship" ||
        e.edgeType === "relationship-entity",
    );
    expect(erEdges).toHaveLength(2);
    const labels = erEdges.map((e) => e.label).sort();
    expect(labels).toEqual(["1", "N"]);
  });

  it("creates a dashed placeholder entity for refs to unknown tables", () => {
    const rels: ParsedRelationship[] = [
      { from: "orders", to: "missing", label: "x_id" },
    ];
    const data = generateChenModelData([ordersTable], rels);
    const placeholder = data.nodes.find(
      (n) => n.nodeType === "entity" && n.isPlaceholder,
    );
    expect(placeholder).toBeDefined();
    expect(placeholder!.label).toBe("missing");
    expect(placeholder!.style?.lineDash).toEqual([4, 4]);
  });

  it("marks self-loop relationships with self-loop-arc edge type", () => {
    const selfRel: ParsedRelationship[] = [
      { from: "users", to: "users", label: "manager_id" },
    ];
    const data = generateChenModelData([usersTable], selfRel);
    const erEdges = data.edges.filter(
      (e) =>
        e.edgeType === "entity-relationship" ||
        e.edgeType === "relationship-entity",
    );
    expect(erEdges).toHaveLength(2);
    expect(erEdges.every((e) => e.type === "self-loop-arc")).toBe(true);
    expect(erEdges.every((e) => e.curveOffset === 22)).toBe(true);
  });

  it("hideFields=true skips attribute nodes & their edges", () => {
    const data = generateChenModelData([usersTable], [], true, "name", true);
    expect(data.nodes.filter((n) => n.nodeType === "attribute")).toHaveLength(
      0,
    );
    expect(
      data.edges.filter((e) => e.edgeType === "entity-attribute"),
    ).toHaveLength(0);
  });

  it("isColored=false uses black/white styling", () => {
    const data = generateChenModelData([usersTable], [], false);
    const entity = data.nodes.find((n) => n.nodeType === "entity")!;
    const attr = data.nodes.find((n) => n.nodeType === "attribute")!;
    expect(entity.style?.stroke).toBe("#000000");
    expect(attr.style?.stroke).toBe("#000000");
  });

  it("labelMode='comment' shows column comment instead of name (falls back to name)", () => {
    const data = generateChenModelData([usersTable], [], true, "comment");
    const attrs = data.nodes.filter((n) => n.nodeType === "attribute");
    // id has comment "user id"
    expect(attrs[0].label).toBe("user id");
    // name has no comment → falls back to name
    expect(attrs[1].label).toBe("name");
  });

  it("labelMode='any' prefers comment when present, name otherwise", () => {
    const data = generateChenModelData([usersTable], [], true, "any");
    const attrs = data.nodes.filter((n) => n.nodeType === "attribute");
    expect(attrs[0].label).toBe("user id");
    expect(attrs[1].label).toBe("name");
  });
});

describe("getTextWidth", () => {
  it("counts CJK characters at full font width and ASCII at ~0.6 width", () => {
    const fontSize = 10;
    expect(getTextWidth("ab", fontSize)).toBeCloseTo(12, 5); // 0.6 * 2 * 10
    expect(getTextWidth("中", fontSize)).toBeCloseTo(10, 5);
    expect(getTextWidth("a中", fontSize)).toBeCloseTo(16, 5);
    expect(getTextWidth("", fontSize)).toBe(0);
  });
});

describe("estimateAttributeHalfSize", () => {
  it("never goes below the configured minimum (60 wide / 40 tall halved)", () => {
    const { halfW, halfH } = estimateAttributeHalfSize("");
    expect(halfW).toBeGreaterThanOrEqual(30);
    expect(halfH).toBeGreaterThanOrEqual(20);
  });

  it("grows for longer labels", () => {
    const small = estimateAttributeHalfSize("a");
    const large = estimateAttributeHalfSize(
      "a_very_long_attribute_label_indeed",
    );
    expect(large.halfW).toBeGreaterThan(small.halfW);
  });
});
