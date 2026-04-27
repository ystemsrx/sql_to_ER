import { describe, expect, it } from "vitest";
import { parseDBML } from "../parser/dbml";

describe("parseDBML", () => {
  it("parses tables, aliases, inline refs, and top-level refs", () => {
    const result = parseDBML(`
      Table users as U {
        id int [pk]
        country_id int [ref: > countries.id]
      }

      Table countries {
        id int [pk]
      }

      Ref: users.id > countries.id
    `);

    expect(result.tables).toHaveLength(2);
    expect(result.tables[0].alias).toBe("U");
    expect(result.tables[0].primaryKeys).toEqual(["id"]);
    expect(result.relationships).toEqual([
      { from: "users", to: "countries", label: "country_id" },
      { from: "users", to: "countries", label: "id" },
    ]);
  });

  it("ignores // line comments and /* block */ comments, even inside strings if outside", () => {
    const result = parseDBML(`
      // top-level note
      Table users { /* block */
        id int [pk] // pk column
        name varchar(255) [not null]
      }
    `);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].columns.map((c) => c.name)).toEqual(["id", "name"]);
  });

  it("preserves '//' inside single-quoted defaults", () => {
    const result = parseDBML(`
      Table t {
        id int [pk]
        url varchar(255) [default: 'https://example.com//path']
      }
    `);
    expect(result.tables[0].columns.map((c) => c.name)).toEqual(["id", "url"]);
  });

  it("handles multi-line column attributes", () => {
    const result = parseDBML(`
      Table posts {
        id int [pk]
        author_id int [
          ref: > users.id,
          not null
        ]
      }
      Table users { id int [pk] }
    `);
    expect(result.relationships).toEqual([
      { from: "posts", to: "users", label: "author_id" },
    ]);
  });

  it("captures note attribute as column comment", () => {
    const result = parseDBML(`
      Table t {
        id int [pk, note: 'primary identifier']
      }
    `);
    expect(result.tables[0].columns[0].comment).toBe("primary identifier");
  });

  it("skips nested Note { ... } and indexes { ... } blocks inside a table", () => {
    const result = parseDBML(`
      Table orders {
        id int [pk]
        user_id int
        amount decimal(10, 2)

        indexes {
          (user_id, amount)
        }

        Note: 'order table'
      }
    `);
    expect(result.tables[0].columns.map((c) => c.name)).toEqual([
      "id",
      "user_id",
      "amount",
    ]);
  });

  it("parses multi-line Ref { ... } block with several relationships", () => {
    const result = parseDBML(`
      Table a { id int [pk]; x int }
      Table b { id int [pk]; y int }
      Ref {
        a.x > b.id
        b.y < a.id
      }
    `);
    // 单 Ref 块中的多条关系都被收集
    expect(result.relationships).toEqual([
      { from: "a", to: "b", label: "x" },
      { from: "b", to: "a", label: "y" },
    ]);
  });

  it("supports schema-qualified ref targets (uses last two segments)", () => {
    const result = parseDBML(`
      Table users { id int [pk] }
      Table posts { id int [pk]; author_id int }
      Ref: public.posts.author_id > public.users.id
    `);
    expect(result.relationships).toEqual([
      { from: "posts", to: "users", label: "author_id" },
    ]);
  });

  it("supports primary key written as `[primary key]`", () => {
    const result = parseDBML(`
      Table t {
        id int [primary key]
        name varchar(50)
      }
    `);
    expect(result.tables[0].primaryKeys).toEqual(["id"]);
  });

  it("preserves Chinese identifiers and aliases", () => {
    const result = parseDBML(`
      Table 用户 as U {
        编号 int [pk]
      }
      Table 订单 {
        编号 int [pk]
        用户编号 int [ref: > 用户.编号]
      }
    `);
    expect(result.tables.map((t) => t.name)).toEqual(["用户", "订单"]);
    expect(result.relationships).toEqual([
      { from: "订单", to: "用户", label: "用户编号" },
    ]);
  });

  it("ignores Project, Enum, TableGroup top-level blocks", () => {
    const result = parseDBML(`
      Project demo {
        database_type: 'PostgreSQL'
      }

      Enum status {
        active
        inactive
      }

      TableGroup g {
        users
      }

      Table users { id int [pk] }
    `);
    expect(result.tables.map((t) => t.name)).toEqual(["users"]);
  });

  it("returns empty arrays for blank input", () => {
    expect(parseDBML("")).toEqual({ tables: [], relationships: [] });
    expect(parseDBML("   \n  // nothing here\n")).toEqual({
      tables: [],
      relationships: [],
    });
  });

  it("parses bracket-quoted identifiers and back-tick identifiers", () => {
    const result = parseDBML(`
      Table \`my-table\` {
        id int [pk]
        name varchar(50)
      }
    `);
    expect(result.tables[0].name).toBe("my-table");
  });

  it("parses the in-app DBML sample (with leading -- SQL-style comment)", () => {
    // 这段就是 i18n.ts 里 zh.sample 的副本，回归保护：示例必须能完整解析。
    const sample = `-- 示例 DBML，请在此处粘贴您的 DBML 或 SQL 语句
Table 用户 {
  编号 INT [pk, increment]
  用户名 VARCHAR(255) [not null]
  邮箱 VARCHAR(255) [unique]
  创建时间 TIMESTAMP
}

Table 国家 {
  编号 INT [pk]
  名称 VARCHAR(255) [not null]
}

Table 文章 {
  文章编号 INT [pk]
  内容 TEXT
}

Ref: 用户.属于 > 国家.编号
Ref: 文章.作者 > 用户.编号
`;
    const result = parseDBML(sample);
    expect(result.tables.map((t) => t.name)).toEqual([
      "用户",
      "国家",
      "文章",
    ]);
    expect(result.tables[0].columns.map((c) => c.name)).toEqual([
      "编号",
      "用户名",
      "邮箱",
      "创建时间",
    ]);
    expect(result.tables[0].primaryKeys).toEqual(["编号"]);
    expect(result.relationships).toEqual([
      { from: "用户", to: "国家", label: "属于" },
      { from: "文章", to: "用户", label: "作者" },
    ]);
  });

  it("recovers when unknown lines appear between statements", () => {
    const result = parseDBML(`
      random non-DBML noise here
      Table a { id int [pk] }
      another stray line
      Table b { id int [pk] }
    `);
    expect(result.tables.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("supports composite types with comma in parens (decimal(10, 2))", () => {
    const result = parseDBML(`
      Table t {
        id int [pk]
        price decimal(10, 2)
      }
    `);
    expect(result.tables[0].columns[1]).toMatchObject({
      name: "price",
      type: "decimal(10, 2)",
    });
  });
});
