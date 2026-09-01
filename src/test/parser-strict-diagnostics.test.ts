import { describe, expect, it } from "vitest";
import { parseDBML } from "../parser/dbml";
import { parseSQLTables } from "../parser/sql";

describe("strict parser diagnostics — SQL", () => {
  it.each([
    "CREATE VIEW v AS SELECT 1",
    "CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW SELECT 1",
    "GRANT SELECT ON t TO app",
    "INSERT INTO t VALUES (1)",
  ])("任何不支持的顶层语句都不会被静默吞掉：%s", (statement) => {
    const result = parseSQLTables(`${statement}; CREATE TABLE t (id INT PRIMARY KEY);`);
    expect(result.tables.map((table) => table.name)).toEqual(["t"]);
    expect(result.warnings?.some((warning) => warning.code === "statement_skipped")).toBe(true);
  });

  it("已识别且与 ER 结构无关的 no-op 不制造误告警", () => {
    const result = parseSQLTables(`
      CREATE TABLE t (id INT PRIMARY KEY, value INT);
      CREATE INDEX ix_t_value ON t (value);
      ALTER TABLE t CHECK CONSTRAINT ALL;
    `);
    expect(result.warnings).toBeUndefined();
  });

  it("目标非候选键和字段类型不兼容都会告警，但保留可展示关系", () => {
    const result = parseSQLTables(`
      CREATE TABLE parent (id INT PRIMARY KEY, code UUID);
      CREATE TABLE child (code INT, FOREIGN KEY (code) REFERENCES parent(code));
    `);
    expect(result.relationships).toHaveLength(1);
    expect(result.warnings?.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("not a primary or unique key"),
        expect.stringContaining('types "INT" and "UUID" are incompatible'),
      ]),
    );
  });

  it("表达式键列清单不会被猜成第一个标识符", () => {
    const result = parseSQLTables("CREATE TABLE t (id INT, PRIMARY KEY (id + 1));");
    expect(result.tables[0].primaryKeys).toEqual([]);
    expect(
      result.warnings?.some((warning) => warning.message.includes("invalid column list")),
    ).toBe(true);
  });

  it("混合 ALTER 中的不支持动作告警且不会生成幻列", () => {
    const result = parseSQLTables(`
      CREATE TABLE t (id INT);
      ALTER TABLE t ADD value INT, OWNER TO admin;
    `);
    expect(result.tables[0].columns.map((column) => column.name)).toEqual(["id", "value"]);
    expect(result.warnings?.some((warning) => warning.message.includes("OWNER action"))).toBe(true);
  });

  it("缺少语句分隔符时不会静默吞掉后续 CREATE", () => {
    const result = parseSQLTables(`
      CREATE TABLE first (id INT)
      CREATE TABLE second (id INT)
    `);
    expect(result.tables.map((table) => table.name)).toEqual(["first"]);
    expect(
      result.warnings?.some((warning) => warning.message.includes("unterminated statement")),
    ).toBe(true);
  });

  it("顺序敏感的复合 ALTER 无法精确归约时必有告警", () => {
    const result = parseSQLTables(`
      CREATE TABLE t (id INT, value INT);
      ALTER TABLE t DROP COLUMN value, ADD value INT;
    `);
    expect(
      result.warnings?.some((warning) => warning.message.includes("order-sensitive action types")),
    ).toBe(true);
  });

  it("无法识别的表体元素不会静默消失", () => {
    const result = parseSQLTables("CREATE TABLE t (id INT, + nonsense);");
    expect(result.tables).toHaveLength(1);
    expect(result.warnings?.some((warning) => warning.message.includes("table element"))).toBe(
      true,
    );
  });

  it("支持的外键动作被完整保留", () => {
    const result = parseSQLTables(`
      CREATE TABLE parent (id INT PRIMARY KEY);
      CREATE TABLE child (
        parent_id INT REFERENCES parent(id) ON DELETE CASCADE ON UPDATE NO ACTION
      );
    `);
    expect(result.relationships[0]).toMatchObject({
      onDelete: "cascade",
      onUpdate: "no action",
    });
    expect(result.warnings).toBeUndefined();
  });

  it("未闭合块注释即使位于有效表之后也会告警", () => {
    const result = parseSQLTables("CREATE TABLE t (id INT); /* unfinished");
    expect(result.tables).toHaveLength(1);
    expect(
      result.warnings?.some((warning) => warning.message.includes("comment was not closed")),
    ).toBe(true);
  });
});

describe("strict parser diagnostics — DBML", () => {
  it("未知块整体跳过，不会把块内 Table 误生成为实体", () => {
    const result = parseDBML(`
      Mystery x { Table fake { id int } }
      Table real { id int [pk] }
    `);
    expect(result.tables.map((table) => table.name)).toEqual(["real"]);
    expect(result.warnings?.some((warning) => warning.code === "statement_skipped")).toBe(true);
  });

  it("Ref 两端不存在的字段都会告警", () => {
    const result = parseDBML(`
      Table a { id int [pk] }
      Table b { id int [pk] }
      Ref: a.missing > b.nope
    `);
    expect(result.relationships).toHaveLength(1);
    expect(result.warnings?.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing column "missing"'),
        expect.stringContaining('missing column "nope"'),
      ]),
    );
  });

  it("Ref 目标非候选键和字段类型不兼容都会告警", () => {
    const result = parseDBML(`
      Table parent { id int [pk]; code uuid }
      Table child { code int }
      Ref: child.code > parent.code
    `);
    expect(result.relationships).toHaveLength(1);
    expect(result.warnings?.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("not a primary or unique key"),
        expect.stringContaining('types "int" and "uuid" are incompatible'),
      ]),
    );
  });

  it("未知的表、列、索引和 Ref 设置都会告警", () => {
    const result = parseDBML(`
      Table parent [mystery: yes] {
        id int [pk, strange]
        indexes { id [unique, custom: value] }
      }
      Table child { parent_id int }
      Ref: child.parent_id > parent.id [unknown: value]
    `);
    const messages = result.warnings?.map((warning) => warning.message) ?? [];
    expect(messages.some((message) => message.includes('table setting "mystery"'))).toBe(true);
    expect(messages.some((message) => message.includes('column setting "strange"'))).toBe(true);
    expect(messages.some((message) => message.includes('index setting "custom"'))).toBe(true);
    expect(messages.some((message) => message.includes('Ref setting "unknown"'))).toBe(true);
  });

  it("已支持或明确无关的 DBML 设置不产生误告警", () => {
    const result = parseDBML(`
      Project demo { database_type: 'PostgreSQL' }
      Enum state { active }
      TableGroup core { users }
      Table users [headercolor: #fff] {
        id bigint [pk, increment, note: 'identifier']
      }
      Table orders {
        id bigint [pk]
        user_id bigint [not null, default: 0]
      }
      Ref: orders.user_id > users.id [delete: cascade, update: no action, color: #fff]
    `);
    expect(result.relationships).toHaveLength(1);
    expect(result.warnings).toBeUndefined();
  });

  it("纯未知输入和未闭合块注释都会产生诊断", () => {
    const unknown = parseDBML("TotallyUnknown thing { mystery value }");
    expect(unknown.warnings?.length).toBeGreaterThan(0);

    const unclosedComment = parseDBML("Table t { id int }\n/* unfinished");
    expect(
      unclosedComment.warnings?.some((warning) =>
        warning.message.includes("comment was not closed"),
      ),
    ).toBe(true);
  });
});
