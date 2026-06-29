import { describe, expect, it } from "vitest";
import { parseSQLTables } from "../parser/sql";

// 针对一次审计中报告的 6 类问题的回归测试：
//   1. SQL Server 临时表名 #temp / ##global（`#` 不再一律当注释）
//   2. ALTER TABLE ... ADD ... FOREIGN KEY ... 抽取外键关系
//   3. CREATE OR REPLACE TABLE
//   4. 标识符里的 `$`（PostgreSQL/Oracle，如 app.order$line）
//   5. 保留字列名 + 用户自定义类型（如 `key account_id_domain`）
//   6. MySQL 默认模式下双引号 COMMENT "..."

describe("parseSQLTables — 报告问题修复", () => {
  it("1a. SQL Server 局部临时表 #temp_orders 能解析", () => {
    const r = parseSQLTables(`CREATE TABLE #temp_orders (id INT PRIMARY KEY, name VARCHAR(50));`);
    expect(r.tables.map((t) => t.name)).toEqual(["#temp_orders"]);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "name"]);
  });

  it("1b. SQL Server 全局临时表 ##global_temp 能解析", () => {
    const r = parseSQLTables(`CREATE TABLE ##global_temp (id INT PRIMARY KEY);`);
    expect(r.tables.map((t) => t.name)).toEqual(["##global_temp"]);
  });

  it("1c. MySQL `#` 行注释仍被正确剥离（不误判为表名）", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (
        id INT PRIMARY KEY, # comment
        name VARCHAR(9)
      );
    `);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "name"]);
  });

  it("2a. ALTER TABLE ADD CONSTRAINT FOREIGN KEY 生成关系", () => {
    const r = parseSQLTables(`
      CREATE TABLE parent (id INT PRIMARY KEY);
      CREATE TABLE child (id INT PRIMARY KEY, pid INT);
      ALTER TABLE child ADD CONSTRAINT fk_child_parent FOREIGN KEY (pid) REFERENCES parent (id);
    `);
    expect(r.relationships).toEqual([
      {
        from: "child",
        to: "parent",
        label: "pid",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  it("2b. ALTER 不带 CONSTRAINT 名的 ADD FOREIGN KEY 也能识别", () => {
    const r = parseSQLTables(`
      CREATE TABLE p (id INT PRIMARY KEY);
      CREATE TABLE c (id INT PRIMARY KEY, pid INT);
      ALTER TABLE c ADD FOREIGN KEY (pid) REFERENCES p (id);
    `);
    expect(r.relationships.map((x) => [x.from, x.to, x.label])).toEqual([["c", "p", "pid"]]);
  });

  it("2c. ALTER 复合外键 + PostgreSQL ALTER TABLE ONLY", () => {
    const r = parseSQLTables(`
      CREATE TABLE p (a INT, b INT, PRIMARY KEY (a, b));
      CREATE TABLE c (x INT, y INT);
      ALTER TABLE ONLY c ADD CONSTRAINT fk FOREIGN KEY (x, y) REFERENCES p (a, b);
    `);
    expect(r.relationships).toEqual([
      {
        from: "c",
        to: "p",
        label: "x, y",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  it("2d. 单条 ALTER 内的多个 ADD FOREIGN KEY 都被收集", () => {
    const r = parseSQLTables(`
      CREATE TABLE a (id INT PRIMARY KEY);
      CREATE TABLE b (id INT PRIMARY KEY);
      CREATE TABLE c (id INT PRIMARY KEY, aid INT, bid INT);
      ALTER TABLE c
        ADD CONSTRAINT f1 FOREIGN KEY (aid) REFERENCES a(id),
        ADD CONSTRAINT f2 FOREIGN KEY (bid) REFERENCES b(id);
    `);
    expect(r.relationships.map((x) => [x.from, x.to, x.label])).toEqual([
      ["c", "a", "aid"],
      ["c", "b", "bid"],
    ]);
  });

  it("2e. ALTER 指向未定义的表时安全丢弃（不产生幻实体）", () => {
    const r = parseSQLTables(
      `ALTER TABLE ghost ADD CONSTRAINT fk FOREIGN KEY (x) REFERENCES y(id);`,
    );
    expect(r.tables).toEqual([]);
    expect(r.relationships).toEqual([]);
  });

  it("3a. CREATE OR REPLACE TABLE 能解析", () => {
    const r = parseSQLTables(`CREATE OR REPLACE TABLE t (id INT PRIMARY KEY, name VARCHAR(20));`);
    expect(r.tables.map((t) => t.name)).toEqual(["t"]);
    expect(r.tables[0].primaryKeys).toEqual(["id"]);
  });

  it("3b. CREATE OR REPLACE TEMPORARY TABLE 能解析", () => {
    const r = parseSQLTables(`CREATE OR REPLACE TEMPORARY TABLE t (id INT PRIMARY KEY);`);
    expect(r.tables.map((t) => t.name)).toEqual(["t"]);
  });

  it("4. 标识符里的 `$`（app.order$line）不被截断", () => {
    const r = parseSQLTables(`CREATE TABLE app.order$line (id INT PRIMARY KEY, qty INT);`);
    expect(r.tables[0].name).toBe("app.order$line");
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "qty"]);
  });

  it("4b. dollar-quote 函数体里的 ; / -- 不破坏其后的 CREATE TABLE", () => {
    const r = parseSQLTables(`
      CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; -- noise
      END; $$ LANGUAGE plpgsql;
      CREATE TABLE keep (id INT PRIMARY KEY);
    `);
    expect(r.tables.map((t) => t.name)).toEqual(["keep"]);
  });

  it("5. 保留字列名 `key` + 用户自定义类型被保留为列", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (
        id INT PRIMARY KEY,
        key account_id_domain NOT NULL,
        val INT
      );
    `);
    const cols = r.tables[0].columns;
    expect(cols.map((c) => c.name)).toEqual(["id", "key", "val"]);
    expect(cols.find((c) => c.name === "key")?.type).toBe("account_id_domain");
  });

  it("5b. 仍正确忽略真正的 KEY / INDEX 索引子句", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (
        id INT PRIMARY KEY,
        email VARCHAR(255),
        KEY idx_email (email),
        INDEX idx_id (id)
      );
    `);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "email"]);
  });

  it('6a. MySQL 列级双引号 COMMENT "..." 被提取', () => {
    const r = parseSQLTables(`CREATE TABLE t (id INT PRIMARY KEY COMMENT "the id", n INT);`);
    expect(r.tables[0].columns[0].comment).toBe("the id");
  });

  it('6b. MySQL 表级双引号 COMMENT="..." 被提取', () => {
    const r = parseSQLTables(`CREATE TABLE t (id INT PRIMARY KEY) COMMENT="my table";`);
    expect(r.tables[0].comment).toBe("my table");
  });

  it("6c. 单引号 COMMENT 仍正常工作（回归保护）", () => {
    const r = parseSQLTables(`CREATE TABLE t (id INT PRIMARY KEY COMMENT 'pk id') COMMENT='tbl';`);
    expect(r.tables[0].columns[0].comment).toBe("pk id");
    expect(r.tables[0].comment).toBe("tbl");
  });
});

// 第二批：COMMENT ON 语句、ALTER ADD COLUMN、ALTER ADD PRIMARY KEY / UNIQUE / CHECK
describe("parseSQLTables — COMMENT ON 与 ALTER 结构变更", () => {
  it("7a. COMMENT ON TABLE / COLUMN 挂到表与列注释", () => {
    const r = parseSQLTables(`
      CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(255));
      COMMENT ON TABLE users IS 'the users table';
      COMMENT ON COLUMN users.email IS 'user email address';
    `);
    const t = r.tables[0];
    expect(t.comment).toBe("the users table");
    expect(t.columns.find((c) => c.name === "email")?.comment).toBe("user email address");
  });

  it("7b. COMMENT ON 支持 schema 限定名，且可出现在建表语句之前", () => {
    const r = parseSQLTables(`
      COMMENT ON TABLE app.orders IS 'orders';
      CREATE TABLE app.orders (id INT PRIMARY KEY, total NUMERIC);
      COMMENT ON COLUMN app.orders.total IS 'order total';
    `);
    const t = r.tables[0];
    expect(t.name).toBe("app.orders");
    expect(t.comment).toBe("orders");
    expect(t.columns.find((c) => c.name === "total")?.comment).toBe("order total");
  });

  it("8a. ALTER TABLE ADD COLUMN ... REFERENCES 新增列且生成关系", () => {
    const r = parseSQLTables(`
      CREATE TABLE parent (id INT PRIMARY KEY);
      CREATE TABLE child (id INT PRIMARY KEY);
      ALTER TABLE child ADD COLUMN parent_id INT REFERENCES parent(id);
    `);
    const child = r.tables.find((t) => t.name === "child")!;
    expect(child.columns.map((c) => c.name)).toEqual(["id", "parent_id"]);
    expect(r.relationships).toEqual([
      {
        from: "child",
        to: "parent",
        label: "parent_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  it("8b. ALTER TABLE ADD COLUMN（含省略 COLUMN 关键字）新增列", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (id INT PRIMARY KEY);
      ALTER TABLE t ADD COLUMN nickname VARCHAR(50);
      ALTER TABLE t ADD email VARCHAR(100);
    `);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "nickname", "email"]);
  });

  it("9a. ALTER TABLE ADD PRIMARY KEY / ADD CONSTRAINT UNIQUE 更新结构", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (id INT NOT NULL, email VARCHAR(255));
      ALTER TABLE t ADD PRIMARY KEY (id);
      ALTER TABLE t ADD CONSTRAINT uq UNIQUE (email);
    `);
    const t = r.tables[0];
    expect(t.primaryKeys).toEqual(["id"]);
    expect(t.columns.find((c) => c.name === "email")?.isUnique).toBe(true);
  });

  it("9b. ALTER ADD UNIQUE 让其后的 FK 推断为 1:1", () => {
    const r = parseSQLTables(`
      CREATE TABLE orders (id INT PRIMARY KEY);
      CREATE TABLE payments (id INT PRIMARY KEY, order_id INT NOT NULL);
      ALTER TABLE payments ADD UNIQUE (order_id);
      ALTER TABLE payments ADD FOREIGN KEY (order_id) REFERENCES orders(id);
    `);
    const rel = r.relationships.find((x) => x.from === "payments")!;
    expect(rel.fromCardinality).toBe("1");
    expect(rel.toCardinality).toBe("1");
  });

  it("9c. ALTER ADD CHECK 被忽略，不产生幻列", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (id INT PRIMARY KEY, age INT);
      ALTER TABLE t ADD CONSTRAINT ck CHECK (age >= 0);
    `);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "age"]);
  });
});
