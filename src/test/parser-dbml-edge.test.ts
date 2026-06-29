import { describe, expect, it } from "vitest";
import { parseDBML } from "../parser/dbml";

// DBML 解析器的边界 / 加固回归测试。重点修复了两类原本会“静默出错”的情况：
//   1. 数组类型后缀 `int[]` 被误当作设置块，导致类型丢 `[]` 且其后的 `[settings]` 丢失。
//   2. 带点的引用标识符 `"my.table"` 被按 `.` 拆开，名字塌成 `table`。
// 修法：列定义改为“最后一个、且前面有头部、内容不像数组后缀”的方括号才算设置块；
// 限定名切分改为引号 / 括号感知。

describe("parseDBML — 边界 / 加固", () => {
  it("数组类型后缀 int[] 保留，且其后的 [note] 设置不丢", () => {
    const r = parseDBML(`
      Table t {
        id int [pk]
        tags int[] [note: 'tag list']
      }
    `);
    const tags = r.tables[0].columns.find((c) => c.name === "tags")!;
    expect(tags.type).toBe("int[]");
    expect(tags.comment).toBe("tag list");
  });

  it("多维数组 int[][] 与带参类型数组 decimal(10,2)[] 完整保留", () => {
    const r = parseDBML(`
      Table t {
        id int [pk]
        grid int[][] [not null]
        m decimal(10,2)[]
      }
    `);
    const types = Object.fromEntries(r.tables[0].columns.map((c) => [c.name, c.type]));
    expect(types.grid).toBe("int[][]");
    expect(types.m).toBe("decimal(10,2)[]");
  });

  it('带点的引用表名 "my.table" 作为单个标识符整体保留', () => {
    const r = parseDBML(`
      Table "my.table" {
        id int [pk]
      }
    `);
    expect(r.tables[0].name).toBe("my.table");
  });

  it('带点的引用列名 "first.name" 整体保留', () => {
    const r = parseDBML(`
      Table t {
        id int [pk]
        "first.name" varchar
      }
    `);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "first.name"]);
  });

  it("Ref 目标里带点的引用表名按整段解析", () => {
    const r = parseDBML(`
      Table a { id int [pk] }
      Ref: "a.b".x > "c.d".y
    `);
    expect(r.relationships).toEqual([
      {
        from: "a.b",
        to: "c.d",
        label: "x",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  it("方括号引用标识符作为列名（行首 [my col]）被正确识别", () => {
    const r = parseDBML(`
      Table t {
        id int [pk]
        [my col] varchar [not null]
      }
    `);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "my col"]);
  });

  it("内联 schema 限定的 ref（取最后两段）", () => {
    const r = parseDBML(`
      Table users {
        id int [pk]
        country_id int [ref: > geo.countries.id]
      }
    `);
    expect(r.relationships).toEqual([
      {
        from: "users",
        to: "countries",
        label: "country_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  it("内联 ref 运算符 <> 紧贴无空格也能解析为多对多", () => {
    const r = parseDBML(`
      Table a { id int [pk] }
      Table b { id int [pk, ref:<>a.id] }
    `);
    const rel = r.relationships[0];
    expect(rel.from).toBe("b");
    expect(rel.to).toBe("a");
    expect(rel.fromCardinality).toBe("N");
    expect(rel.toCardinality).toBe("N");
  });

  it("default 字符串里的逗号不会把设置块切碎，note 完整", () => {
    const r = parseDBML(`
      Table t {
        id int [pk]
        s varchar [default: 'a, b, c', note: 'has, commas']
      }
    `);
    const s = r.tables[0].columns.find((c) => c.name === "s")!;
    expect(s.comment).toBe("has, commas");
  });

  it("带空格的类型（int unsigned）被保留", () => {
    const r = parseDBML(`
      Table t {
        id int unsigned [pk]
      }
    `);
    expect(r.tables[0].columns[0].type).toBe("int unsigned");
  });
});

// indexes { ... } 块里的复合主键与唯一约束（dbdiagram 导出常见写法）
describe("parseDBML — indexes 块约束", () => {
  it("indexes { (a, b) [pk] } 形成复合主键", () => {
    const r = parseDBML(`
      Table t {
        a int
        b int
        c text
        indexes {
          (a, b) [pk]
        }
      }
    `);
    expect(r.tables[0].primaryKeys).toEqual(["a", "b"]);
    // 仍正确解析所有列
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["a", "b", "c"]);
  });

  it("indexes { col [unique] } 让单列唯一并把 FK 推断为 1:1", () => {
    const r = parseDBML(`
      Table orders { id int [pk] }
      Table payments {
        id int [pk]
        order_id int [ref: > orders.id]
        indexes {
          order_id [unique]
        }
      }
    `);
    const payments = r.tables.find((t) => t.name === "payments")!;
    expect(payments.columns.find((c) => c.name === "order_id")?.isUnique).toBe(true);
    const rel = r.relationships.find((x) => x.from === "payments")!;
    expect(rel.fromCardinality).toBe("1");
    expect(rel.toCardinality).toBe("1");
  });

  it("复合唯一 (a, b) [unique] 不会把单列标成唯一；带 name 设置也能解析", () => {
    const r = parseDBML(`
      Table t {
        a int
        b int
        email varchar
        indexes {
          (a, b) [unique, name: 'uq_ab']
          email [unique, name: 'uq_email']
        }
      }
    `);
    const cols = Object.fromEntries(r.tables[0].columns.map((c) => [c.name, c.isUnique]));
    expect(cols.email).toBe(true);
    expect(cols.a).toBeUndefined();
    expect(cols.b).toBeUndefined();
  });

  it("表达式索引与非约束索引设置被安全忽略（不产生幻列/幻主键）", () => {
    const r = parseDBML(`
      Table t {
        id int [pk]
        email varchar
        indexes {
          \`lower(email)\` [unique]
          email [type: btree]
        }
      }
    `);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "email"]);
    expect(r.tables[0].primaryKeys).toEqual(["id"]);
    // email 只有 type 设置、没有 unique，应保持非唯一
    expect(r.tables[0].columns.find((c) => c.name === "email")?.isUnique).toBeUndefined();
  });
});
