import { describe, expect, it } from "vitest";
import { parseDBML } from "../parser/dbml";
import { parseSQLTables } from "../parser/sql";

describe("补丁解析修复 — SQL", () => {
  it("复合 UNIQUE 与复合 FK 作为整体参与 1:1 推断", () => {
    const result = parseSQLTables(`
      CREATE TABLE parent (a INT, b INT, PRIMARY KEY (a, b));
      CREATE TABLE child (
        a INT,
        b INT,
        UNIQUE (a, b),
        FOREIGN KEY (a, b) REFERENCES parent (a, b)
      );
    `);
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]).toMatchObject({
      label: "a, b",
      fromCardinality: "1",
      toCardinality: "1",
    });
  });

  it("带逗号的引用标识符仍是一个列", () => {
    const result = parseSQLTables(`
      CREATE TABLE parent ("a,b" INT PRIMARY KEY);
      CREATE TABLE child ("a,b" INT UNIQUE, FOREIGN KEY ("a,b") REFERENCES parent ("a,b"));
    `);
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0].fromCardinality).toBe("1");
  });

  it.each([
    "CREATE UNIQUE INDEX ux ON child(parent_id) WHERE active = true;",
    "CREATE UNIQUE INDEX ux ON child((parent_id + id));",
  ])("partial / expression UNIQUE INDEX 不会误推成 1:1: %s", (indexSql) => {
    const result = parseSQLTables(`
      CREATE TABLE parent (id INT PRIMARY KEY);
      CREATE TABLE child (
        id INT PRIMARY KEY,
        parent_id INT REFERENCES parent(id),
        active BOOLEAN
      );
      ${indexSql}
    `);
    expect(result.relationships[0].fromCardinality).toBe("N");
  });

  it("DDL 按源码顺序应用，前置 ALTER 不会污染后建表", () => {
    const result = parseSQLTables(`
      ALTER TABLE t ADD x INT;
      CREATE TABLE t (id INT PRIMARY KEY);
    `);
    expect(result.tables[0].columns.map((column) => column.name)).toEqual(["id"]);
    expect(result.warnings?.map((warning) => warning.message)).toContain(
      'line 2: ALTER TABLE "t" skipped because the table was not found',
    );
  });

  it("删除命名 FK 后不再生成关系", () => {
    const result = parseSQLTables(`
      CREATE TABLE parent (id INT PRIMARY KEY);
      CREATE TABLE child (
        parent_id INT,
        CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES parent(id)
      );
      ALTER TABLE child DROP CONSTRAINT fk_parent;
    `);
    expect(result.relationships).toEqual([]);
    expect(result.tables.find((table) => table.name === "child")?.foreignKeys).toEqual([]);
  });

  it("MySQL DROP FOREIGN KEY 与 IF EXISTS 形式会删除命名 FK", () => {
    for (const drop of ["DROP FOREIGN KEY fk_parent", "DROP CONSTRAINT IF EXISTS fk_parent"]) {
      const result = parseSQLTables(`
        CREATE TABLE parent (id INT PRIMARY KEY);
        CREATE TABLE child (
          parent_id INT,
          CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES parent(id)
        );
        ALTER TABLE child ${drop};
      `);
      expect(result.relationships).toEqual([]);
    }
  });

  it("表名与被引用列重命名会同步更新 FK 端点", () => {
    const result = parseSQLTables(`
      CREATE TABLE parent (id INT PRIMARY KEY);
      CREATE TABLE child (parent_id INT REFERENCES parent(id));
      ALTER TABLE parent RENAME TO account;
      ALTER TABLE account RENAME COLUMN id TO account_id;
    `);
    expect(result.tables.map((table) => table.name)).toEqual(["account", "child"]);
    expect(result.tables[0].columns.map((column) => column.name)).toEqual(["account_id"]);
    expect(result.relationships).toEqual([
      {
        from: "child",
        to: "account",
        label: "parent_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
    expect(result.tables[1].foreignKeys[0].referencedColumn).toBe("account_id");
  });

  it("删除被引用列会清理陈旧的入向 FK", () => {
    const result = parseSQLTables(`
      CREATE TABLE parent (id INT PRIMARY KEY);
      CREATE TABLE child (parent_id INT REFERENCES parent(id));
      ALTER TABLE parent DROP COLUMN id;
    `);
    expect(result.relationships).toEqual([]);
    expect(result.tables.find((table) => table.name === "child")?.foreignKeys).toEqual([]);
  });

  it("DROP / 重建只留下最终表定义", () => {
    const result = parseSQLTables(`
      CREATE TABLE t (id INT);
      DROP TABLE t;
      CREATE TABLE t (code TEXT PRIMARY KEY);
    `);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].columns.map((column) => column.name)).toEqual(["code"]);
  });

  it("SQL Server 与 Oracle 的多列 ADD 都完整保留", () => {
    const sqlServer = parseSQLTables(`
      CREATE TABLE t (id INT PRIMARY KEY);
      ALTER TABLE t ADD a INT, b VARCHAR(20);
    `);
    expect(sqlServer.tables[0].columns.map((column) => column.name)).toEqual(["id", "a", "b"]);

    const oracle = parseSQLTables(`
      CREATE TABLE t (id NUMBER PRIMARY KEY);
      ALTER TABLE t ADD (a NUMBER, b VARCHAR2(20));
    `);
    expect(oracle.tables[0].columns.map((column) => column.name)).toEqual(["id", "a", "b"]);
  });

  it("Oracle SQL*Plus 的独立 / 不吞掉后续 DDL", () => {
    const result = parseSQLTables(`
      CREATE OR REPLACE PROCEDURE p AS
      BEGIN
        NULL;
      END;
      /
      CREATE TABLE after_block (id NUMBER PRIMARY KEY);
    `);
    expect(result.tables.map((table) => table.name)).toEqual(["after_block"]);
  });

  it("schema 重名导致的无上下文短名歧义不会被猜测", () => {
    const result = parseSQLTables(`
      CREATE TABLE app.account (id INT PRIMARY KEY);
      CREATE TABLE crm.account (id INT PRIMARY KEY);
      CREATE TABLE child (account_id INT REFERENCES account(id));
    `);
    expect(result.relationships).toEqual([]);
    expect(result.warnings?.some((warning) => warning.message.includes("ambiguous table"))).toBe(
      true,
    );
  });

  it("无 schema 的 RENAME TO 保留原 schema", () => {
    const result = parseSQLTables(`
      CREATE TABLE app.users (id INT PRIMARY KEY);
      ALTER TABLE app.users RENAME TO accounts;
    `);
    expect(result.tables[0].name).toBe("app.accounts");
  });
});

describe("补丁解析修复 — DBML", () => {
  it("保留 schema 限定名，重复短名不再碰撞", () => {
    const result = parseDBML(`
      Table app.users { id int [pk] }
      Table audit.users { id int [pk] }
    `);
    expect(result.tables.map((table) => table.name)).toEqual(["app.users", "audit.users"]);
    expect(result.warnings).toBeUndefined();
  });

  it("可选端点运算符被规范解析且不污染表名", () => {
    const rightOptional = parseDBML(`
      Table users { id int [pk] }
      Table posts { user_id int }
      Ref: posts.user_id >? users.id
    `);
    expect(rightOptional.relationships[0]).toMatchObject({
      from: "posts",
      to: "users",
      toOptional: true,
    });

    const leftOptional = parseDBML(`
      Table users { id int [pk] }
      Table posts { user_id int }
      Ref: posts.user_id ?> users.id
    `);
    expect(leftOptional.relationships[0]).toMatchObject({
      from: "posts",
      to: "users",
      fromOptional: true,
    });

    const lessThanOptional = parseDBML(`
      Table users { id int [pk] }
      Table posts { user_id int }
      Ref: users.id ?< posts.user_id
      Ref: users.id <? posts.user_id
    `);
    expect(lessThanOptional.relationships).toEqual([
      {
        from: "users",
        to: "posts",
        label: "user_id",
        fromCardinality: "1",
        toCardinality: "N",
        fromOptional: true,
      },
      {
        from: "users",
        to: "posts",
        label: "user_id",
        fromCardinality: "1",
        toCardinality: "N",
        toOptional: true,
      },
    ]);
  });

  it("顶层一对一关系由第二端持有 FK，内联关系仍由声明列持有", () => {
    const topLevel = parseDBML(`
      Table users { id int [pk] }
      Table profiles { user_id int }
      Ref owns: users.id - profiles.user_id
    `);
    expect(topLevel.tables.find((table) => table.name === "users")?.foreignKeys).toEqual([]);
    expect(topLevel.tables.find((table) => table.name === "profiles")?.foreignKeys).toEqual([
      { column: "user_id", referencedTable: "users", referencedColumn: "id" },
    ]);
    expect(topLevel.relationships[0].name).toBe("owns");

    const inline = parseDBML(`
      Table users { id int [pk] }
      Table profiles { user_id int [ref: - users.id] }
    `);
    expect(inline.tables.find((table) => table.name === "profiles")?.foreignKeys).toHaveLength(1);
  });

  it("TablePartial 递归注入，且本地同名字段覆盖注入字段", () => {
    const result = parseDBML(`
      TablePartial audit_fields {
        tenant_id int
        created_at timestamp
        indexes {
          tenant_id [unique]
        }
      }
      TablePartial nested {
        ~audit_fields
        updated_at timestamp
      }
      Table app.events {
        id int [pk]
        ~nested
        created_at timestamptz
      }
    `);
    const table = result.tables[0];
    expect(table.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "updated_at",
      "id",
      "created_at",
    ]);
    expect(table.columns.find((column) => column.name === "created_at")?.type).toBe("timestamptz");
    expect(table.columns.find((column) => column.name === "tenant_id")?.isUnique).toBe(true);
  });

  it("TablePartial 循环会告警且解析终止", () => {
    const result = parseDBML(`
      TablePartial a { ~b; a_id int }
      TablePartial b { ~a; b_id int }
      Table t { id int [pk]; ~a }
    `);
    expect(result.tables).toHaveLength(1);
    expect(result.warnings?.some((warning) => warning.message.includes("partial cycle"))).toBe(
      true,
    );
  });

  it("关系名、删除/更新动作和 note 都被保留", () => {
    const result = parseDBML(`
      Table merchants { id int [pk] }
      Table products { merchant_id int }
      Ref owns: products.merchant_id > merchants.id [
        delete: cascade,
        update: no action,
        note: 'ownership'
      ]
    `);
    expect(result.relationships[0]).toMatchObject({
      name: "owns",
      onDelete: "cascade",
      onUpdate: "no action",
      comment: "ownership",
    });
  });

  it("复合 UNIQUE 与复合 FK 作为整体推断 1:1", () => {
    const result = parseDBML(`
      Table parent {
        a int
        b int
        indexes { (a, b) [pk] }
      }
      Table child {
        a int
        b int
        indexes { (a, b) [unique] }
      }
      Ref: child.(a, b) > parent.(a, b)
    `);
    expect(result.relationships[0]).toMatchObject({
      label: "a, b",
      fromCardinality: "1",
      toCardinality: "1",
    });
  });

  it("表达式 UNIQUE INDEX 不会证明普通列唯一", () => {
    const result = parseDBML(`
      Table parent { id int [pk] }
      Table child {
        id int [pk]
        parent_id int
        indexes { (parent_id, \`lower(id)\`) [unique] }
      }
      Ref: child.parent_id > parent.id
    `);
    expect(result.relationships[0].fromCardinality).toBe("N");
  });

  it("无上下文的 schema 短名歧义不会误连", () => {
    const result = parseDBML(`
      Table app.users { id int [pk] }
      Table audit.users { id int [pk] }
      Table child { user_id int }
      Ref: child.user_id > users.id
    `);
    expect(result.relationships).toEqual([]);
    expect(result.warnings?.some((warning) => warning.message.includes("ambiguous table"))).toBe(
      true,
    );
  });

  it("alias 解析不丢 schema，表头 note 被保留", () => {
    const result = parseDBML(`
      Table app.users as U [note: 'accounts'] { id int [pk] }
      Table app.posts { user_id int }
      Ref: app.posts.user_id > U.id
    `);
    expect(result.tables[0].comment).toBe("accounts");
    expect(result.relationships[0].to).toBe("app.users");
  });
});
