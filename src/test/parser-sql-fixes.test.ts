import { describe, expect, it } from "vitest";
import { parseSQLTables } from "../parser/sql";

// 针对第二次审计的回归测试：
//   1. SQL Server SSMS 导出的 ALTER TABLE ... WITH CHECK ADD 前缀
//   3. FK 目标表名归一化（大小写 / schema 短名），消除 builder 幽灵实体
//   7. CREATE [UNIQUE] INDEX 写回单列 unique（1:1 推断）
//   9. ALTER 的 DROP COLUMN / RENAME TO 支持与其余动作的警告
//   12. Unicode（日文假名 / 韩文谚文）标识符
//   13. 同名表重复 CREATE TABLE 警告

describe("parseSQLTables — SQL Server WITH CHECK 前缀", () => {
  it("WITH CHECK ADD CONSTRAINT FOREIGN KEY 生成关系", () => {
    const r = parseSQLTables(`
      CREATE TABLE dbo.parent (id INT PRIMARY KEY);
      CREATE TABLE dbo.child (id INT PRIMARY KEY, pid INT);
      ALTER TABLE dbo.child WITH CHECK ADD CONSTRAINT fk_child FOREIGN KEY (pid) REFERENCES dbo.parent (id);
    `);
    expect(r.relationships.map((x) => [x.from, x.to, x.label])).toEqual([
      ["dbo.child", "dbo.parent", "pid"],
    ]);
    expect(r.warnings).toBeUndefined();
  });

  it("WITH NOCHECK ADD 也能识别", () => {
    const r = parseSQLTables(`
      CREATE TABLE p (id INT PRIMARY KEY);
      CREATE TABLE c (id INT PRIMARY KEY, pid INT);
      ALTER TABLE c WITH NOCHECK ADD FOREIGN KEY (pid) REFERENCES p (id);
    `);
    expect(r.relationships.map((x) => [x.from, x.to, x.label])).toEqual([["c", "p", "pid"]]);
  });

  it("CHECK CONSTRAINT / NOCHECK CONSTRAINT 启停语句静默跳过（不告警）", () => {
    const r = parseSQLTables(`
      CREATE TABLE p (id INT PRIMARY KEY);
      CREATE TABLE c (id INT PRIMARY KEY, pid INT);
      ALTER TABLE c WITH CHECK ADD CONSTRAINT fk FOREIGN KEY (pid) REFERENCES p (id);
      ALTER TABLE c CHECK CONSTRAINT fk;
      ALTER TABLE c NOCHECK CONSTRAINT ALL;
    `);
    expect(r.relationships).toHaveLength(1);
    expect(r.warnings).toBeUndefined();
  });

  it("整条 ALTER 无受支持动作时发 statement_skipped 警告而非静默", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (id INT PRIMARY KEY);
      ALTER TABLE t OWNER TO admin;
    `);
    expect(r.warnings?.map((w) => w.message)).toEqual([
      'line 3: ALTER TABLE "t" OWNER action was skipped',
    ]);
  });
});

describe("parseSQLTables — 表名归一化（幽灵实体）", () => {
  it("FK 用短名引用 schema 限定表时归一化为实际表名", () => {
    const r = parseSQLTables(`
      CREATE TABLE public.users (id INT PRIMARY KEY);
      CREATE TABLE public.orders (id INT PRIMARY KEY, user_id INT REFERENCES users(id));
    `);
    expect(r.relationships).toEqual([
      {
        from: "public.orders",
        to: "public.users",
        label: "user_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
    expect(r.warnings).toBeUndefined();
  });

  it("FK 目标大小写不一致时也命中同一张表", () => {
    const r = parseSQLTables(`
      CREATE TABLE users (id INT PRIMARY KEY);
      CREATE TABLE orders (id INT PRIMARY KEY, user_id INT REFERENCES USERS(id));
    `);
    expect(r.relationships[0].to).toBe("users");
    expect(r.warnings).toBeUndefined();
  });

  it("FK 带 schema 而表定义不带时同样命中", () => {
    const r = parseSQLTables(`
      CREATE TABLE users (id INT PRIMARY KEY);
      CREATE TABLE orders (id INT PRIMARY KEY, user_id INT REFERENCES public.users(id));
    `);
    expect(r.relationships[0].to).toBe("users");
    expect(r.warnings).toBeUndefined();
  });

  it("两个都带 schema 的不同限定名不做跨 schema 短名回退", () => {
    const r = parseSQLTables(`
      CREATE TABLE app.account (id INT PRIMARY KEY);
      CREATE TABLE crm.invoice (id INT PRIMARY KEY, account_id INT REFERENCES crm.account(id));
    `);
    // crm.account 不应误命中 app.account
    expect(r.relationships[0].to).toBe("crm.account");
    expect(r.warnings?.map((w) => w.message)).toEqual([
      expect.stringContaining('references missing table "crm.account"'),
    ]);
  });

  it("ALTER 挂接与 FK 校验同口径（短名 / 大小写回退）", () => {
    const r = parseSQLTables(`
      CREATE TABLE users (id INT PRIMARY KEY);
      ALTER TABLE PUBLIC.USERS ADD COLUMN nickname VARCHAR(50);
    `);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "nickname"]);
    expect(r.warnings).toBeUndefined();
  });
});

describe("parseSQLTables — CREATE UNIQUE INDEX", () => {
  it("单列 UNIQUE INDEX 使 FK 推断为 1:1", () => {
    const r = parseSQLTables(`
      CREATE TABLE orders (id INT PRIMARY KEY);
      CREATE TABLE payments (id INT PRIMARY KEY, order_id INT REFERENCES orders(id));
      CREATE UNIQUE INDEX ux_payments_order ON payments (order_id);
    `);
    expect(r.relationships).toEqual([
      {
        from: "payments",
        to: "orders",
        label: "order_id",
        fromCardinality: "1",
        toCardinality: "1",
      },
    ]);
  });

  it("支持省略索引名（PostgreSQL）与 USING 子句", () => {
    const r = parseSQLTables(`
      CREATE TABLE orders (id INT PRIMARY KEY);
      CREATE TABLE payments (id INT PRIMARY KEY, order_id INT REFERENCES orders(id));
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux ON payments USING btree (order_id);
    `);
    expect(r.relationships[0].fromCardinality).toBe("1");
  });

  it("复合 UNIQUE INDEX 与非 UNIQUE INDEX 静默跳过", () => {
    const r = parseSQLTables(`
      CREATE TABLE orders (id INT PRIMARY KEY);
      CREATE TABLE payments (id INT PRIMARY KEY, order_id INT REFERENCES orders(id));
      CREATE UNIQUE INDEX ux ON payments (order_id, id);
      CREATE INDEX ix ON payments (order_id);
    `);
    expect(r.relationships[0].fromCardinality).toBe("N");
    expect(r.warnings).toBeUndefined();
  });
});

describe("parseSQLTables — ALTER 的 DROP / RENAME / 其它动作", () => {
  it("DROP COLUMN 删除列（含主键 / FK 记录）", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (id INT PRIMARY KEY, legacy INT, name VARCHAR(10));
      ALTER TABLE t DROP COLUMN legacy;
    `);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(r.warnings).toBeUndefined();
  });

  it("RENAME TO 改表名，后续 FK 能解析到新名", () => {
    const r = parseSQLTables(`
      CREATE TABLE users (id INT PRIMARY KEY);
      ALTER TABLE users RENAME TO customers;
      CREATE TABLE orders (id INT PRIMARY KEY, uid INT REFERENCES customers(id));
    `);
    expect(r.tables.map((t) => t.name)).toEqual(["customers", "orders"]);
    expect(r.relationships).toEqual([
      {
        from: "orders",
        to: "customers",
        label: "uid",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
    expect(r.warnings).toBeUndefined();
  });

  it("RENAME COLUMN 生效，其余不支持的 ALTER 动作发警告", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (id INT PRIMARY KEY, age INT);
      ALTER TABLE t MODIFY age BIGINT;
      ALTER TABLE t CHANGE age age2 BIGINT;
      ALTER TABLE t ALTER COLUMN age SET NOT NULL;
      ALTER TABLE t RENAME COLUMN age TO years;
      ALTER TABLE t DROP CONSTRAINT some_fk;
    `);
    expect(r.warnings?.map((w) => w.message)).toEqual([
      'line 3: ALTER TABLE "t" MODIFY action was skipped',
      'line 4: ALTER TABLE "t" CHANGE action was skipped',
      'line 5: ALTER TABLE "t" ALTER COLUMN action was skipped',
      'line 7: ALTER TABLE "t" DROP CONSTRAINT action was skipped',
    ]);
    expect(r.warnings?.every((w) => w.code === "statement_skipped")).toBe(true);
    expect(r.tables[0].columns.map((column) => column.name)).toEqual(["id", "years"]);
  });
});

describe("parseSQLTables — Unicode 标识符", () => {
  it("韩文 / 日文假名标识符不再被静默丢弃", () => {
    const r = parseSQLTables(`
      CREATE TABLE 주문 (id INT PRIMARY KEY, データ VARCHAR(50));
      CREATE TABLE 리뷰 (id INT PRIMARY KEY, 주문id INT REFERENCES 주문(id));
    `);
    expect(r.tables.map((t) => t.name)).toEqual(["주문", "리뷰"]);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "データ"]);
    expect(r.relationships.map((x) => [x.from, x.to, x.label])).toEqual([
      ["리뷰", "주문", "주문id"],
    ]);
    expect(r.warnings).toBeUndefined();
  });

  it("原有中文标识符行为不回归", () => {
    const r = parseSQLTables(`CREATE TABLE 用户 (编号 INT PRIMARY KEY, 名称 VARCHAR(20));`);
    expect(r.tables[0].name).toBe("用户");
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["编号", "名称"]);
  });
});

describe("parseSQLTables — 重复表定义", () => {
  it("同名表重复 CREATE TABLE 时发 duplicate_table 警告", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (id INT PRIMARY KEY);
      CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(10));
    `);
    expect(r.tables).toHaveLength(2);
    expect(r.warnings).toEqual([
      {
        code: "duplicate_table",
        message: 'line 3: table "t" is defined more than once',
        line: 3,
      },
    ]);
  });
});
