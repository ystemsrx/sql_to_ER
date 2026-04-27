import { describe, expect, it } from "vitest";
import { parseSQLTables } from "../parser/sql";

describe("parseSQLTables", () => {
  it("parses MySQL-style DDL with comments, composite primary key, and table-level FK", () => {
    const result = parseSQLTables(`
      CREATE TABLE \`orders\` (
        \`id\` BIGINT PRIMARY KEY COMMENT 'order id',
        \`user_id\` BIGINT NOT NULL,
        \`amount\` DECIMAL(10, 2) DEFAULT 0,
        KEY \`idx_user\` (\`user_id\`),
        CONSTRAINT \`fk_orders_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`)
      ) ENGINE=InnoDB;
    `);

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe("orders");
    expect(result.tables[0].columns.map((c) => c.name)).toEqual([
      "id",
      "user_id",
      "amount",
    ]);
    expect(result.tables[0].primaryKeys).toContain("id");
    expect(result.tables[0].columns[0].comment).toBe("order id");
    expect(result.relationships).toEqual([
      {
        from: "orders",
        to: "users",
        label: "user_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  it("parses PostgreSQL quoted identifiers, schemas, multi-word types, and inline REFERENCES", () => {
    const result = parseSQLTables(`
      CREATE TABLE IF NOT EXISTS public."Article" (
        "ArticleID" UUID PRIMARY KEY,
        "AuthorID" UUID REFERENCES public."User"("ID"),
        "PublishedAt" TIMESTAMP WITH TIME ZONE,
        "Title" CHARACTER VARYING(255) NOT NULL
      );
    `);

    expect(result.tables[0].name).toBe("public.Article");
    expect(result.tables[0].columns.map((c) => [c.name, c.type])).toEqual([
      ["ArticleID", "UUID"],
      ["AuthorID", "UUID"],
      ["PublishedAt", "TIMESTAMP WITH TIME ZONE"],
      ["Title", "CHARACTER VARYING(255)"],
    ]);
    expect(result.relationships).toEqual([
      {
        from: "public.Article",
        to: "public.User",
        label: "AuthorID",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  it("parses SQLite-style bracket identifiers and ignores semicolons inside string defaults", () => {
    const result = parseSQLTables(`
      CREATE TABLE [note] (
        [id] INTEGER PRIMARY KEY,
        [body] TEXT DEFAULT 'hello; world',
        [parent_id] INTEGER,
        FOREIGN KEY ([parent_id]) REFERENCES [note]([id])
      );
    `);

    expect(result.tables[0].columns.map((c) => c.name)).toEqual([
      "id",
      "body",
      "parent_id",
    ]);
    expect(result.relationships).toEqual([
      {
        from: "note",
        to: "note",
        label: "parent_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  it("ignores non-CREATE-TABLE statements (CREATE INDEX, ALTER, comments)", () => {
    const result = parseSQLTables(`
      -- prelude
      CREATE INDEX idx_users_email ON users (email);
      ALTER TABLE users ADD COLUMN nickname VARCHAR(50);
      /* block
         comment */
      CREATE TABLE t (id INT PRIMARY KEY);
    `);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe("t");
  });

  it("handles a composite PRIMARY KEY constraint", () => {
    const result = parseSQLTables(`
      CREATE TABLE enrollment (
        student_id INT NOT NULL,
        course_id INT NOT NULL,
        PRIMARY KEY (student_id, course_id)
      );
    `);
    expect(result.tables[0].primaryKeys).toEqual(["student_id", "course_id"]);
  });

  it("supports CREATE TEMPORARY TABLE and trims trailing options", () => {
    const result = parseSQLTables(`
      CREATE TEMPORARY TABLE tmp_users (
        id INT PRIMARY KEY,
        name VARCHAR(50)
      );
    `);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe("tmp_users");
  });

  it("preserves Chinese identifiers", () => {
    const result = parseSQLTables(`
      CREATE TABLE 用户 (
        编号 INT PRIMARY KEY,
        姓名 VARCHAR(50)
      );
    `);
    expect(result.tables[0].name).toBe("用户");
    expect(result.tables[0].columns.map((c) => c.name)).toEqual([
      "编号",
      "姓名",
    ]);
  });

  it("returns an empty result for blank input", () => {
    expect(parseSQLTables("")).toEqual({ tables: [], relationships: [] });
    expect(parseSQLTables("   \n  -- only comments\n")).toEqual({
      tables: [],
      relationships: [],
    });
  });

  it("ignores UNIQUE / KEY / INDEX clauses but keeps regular columns", () => {
    const result = parseSQLTables(`
      CREATE TABLE t (
        id INT PRIMARY KEY,
        email VARCHAR(255),
        UNIQUE KEY uq_email (email),
        INDEX idx_email (email)
      );
    `);
    expect(result.tables[0].columns.map((c) => c.name)).toEqual([
      "id",
      "email",
    ]);
  });

  // Regression: 之前 stripSqlComments 把 `--` 误写成 `--`-vs-`--` 的双字符比较，
  // 导致行注释从未被剥离，最终行注释后面紧跟的 CREATE TABLE 整体被拒。
  it("strips -- line comments so trailing CREATE TABLE is parsed", () => {
    const result = parseSQLTables(`
      -- prelude noise
      -- another line that mentions CREATE TABLE on the side
      CREATE TABLE solo (
        id INT PRIMARY KEY
      );
    `);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe("solo");
  });

  // Regression: 引号包裹的保留字在前一段以 `--` 注释结尾时会丢失。
  it("parses quoted reserved-word identifiers (\"select\", \"from\", \"primary\")", () => {
    const result = parseSQLTables(`
      -- Reserved-ish identifiers
      CREATE TABLE "select" (
        "from" INTEGER NOT NULL,
        "where" TEXT,
        "group" TEXT,
        CONSTRAINT "primary" PRIMARY KEY ("from")
      );
    `);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe("select");
    expect(result.tables[0].columns.map((c) => c.name)).toEqual([
      "from",
      "where",
      "group",
    ]);
    expect(result.tables[0].primaryKeys).toEqual(["from"]);
  });

  // T-SQL 批处理分隔符 GO 不是合法的 ANSI SQL token，但在 SQL Server 脚本里
  // 极常见。如果 splitter 不识别，GO 之后的 CREATE TABLE 会被并入上一条语句、
  // 整段被丢弃 —— 之前 crm.Account / crm.Invoice 就是这样消失的。
  it("treats SQL Server GO as a batch separator", () => {
    const result = parseSQLTables(`
      IF SCHEMA_ID(N'crm') IS NULL
          EXEC(N'CREATE SCHEMA crm');
      GO

      CREATE TABLE crm.[Account] (
          account_id BIGINT NOT NULL,
          [name] NVARCHAR(200) NOT NULL,
          CONSTRAINT pk_account PRIMARY KEY CLUSTERED (account_id)
      );
      GO

      CREATE TABLE crm.Invoice (
          invoice_id BIGINT NOT NULL,
          account_id BIGINT NOT NULL,
          CONSTRAINT pk_invoice PRIMARY KEY (invoice_id),
          CONSTRAINT fk_invoice_account
              FOREIGN KEY (account_id)
              REFERENCES crm.[Account] (account_id)
      );
      GO
    `);
    expect(result.tables.map((t) => t.name)).toEqual([
      "crm.Account",
      "crm.Invoice",
    ]);
    expect(result.relationships).toEqual([
      {
        from: "crm.Invoice",
        to: "crm.Account",
        label: "account_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  // PG 的分区子表只是父表的物理分片，没有自己的列定义。强行解析会得到一个
  // 空节点漂在图上 —— 直接跳过。
  it("skips PostgreSQL PARTITION OF child tables", () => {
    const result = parseSQLTables(`
      CREATE TABLE app.pg_orders (
        order_id BIGINT NOT NULL,
        placed_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT pk_pg_orders PRIMARY KEY (order_id)
      ) PARTITION BY RANGE (placed_at);

      CREATE TABLE app.pg_orders_2026_q1
          PARTITION OF app.pg_orders
          FOR VALUES FROM ('2026-01-01') TO ('2026-04-01');

      CREATE TABLE app.pg_orders_default
          PARTITION OF app.pg_orders
          DEFAULT;
    `);
    expect(result.tables.map((t) => t.name)).toEqual(["app.pg_orders"]);
  });

  // schema 必须留在表名里，否则 app.customer 与 crm.customer 会塌成同一节点。
  // FK 目标也得带 schema，连线才能命中正确的实体。
  it("preserves schema on table names and FK targets to disambiguate same-named tables", () => {
    const result = parseSQLTables(`
      CREATE TABLE app.customer (
        customer_id BIGINT PRIMARY KEY,
        email VARCHAR(320)
      );

      CREATE TABLE crm.customer (
        customer_id BIGINT PRIMARY KEY,
        account_id BIGINT NOT NULL,
        CONSTRAINT fk_crm_customer_account
          FOREIGN KEY (account_id) REFERENCES crm.account (account_id)
      );

      CREATE TABLE app.address (
        address_id BIGINT PRIMARY KEY,
        customer_id BIGINT NOT NULL,
        CONSTRAINT fk_address_customer
          FOREIGN KEY (customer_id) REFERENCES "app"."customer" (customer_id)
      );
    `);
    expect(result.tables.map((t) => t.name)).toEqual([
      "app.customer",
      "crm.customer",
      "app.address",
    ]);
    expect(result.relationships).toEqual([
      {
        from: "crm.customer",
        to: "crm.account",
        label: "account_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
      {
        from: "app.address",
        to: "app.customer",
        label: "customer_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  // GENERATED ALWAYS AS (...) STORED 的表达式可能含逗号 / 括号，splitTopLevelComma
  // 必须按括号深度走，否则一列会被切成多片然后丢失。
  it("parses generated columns with comma-bearing expressions", () => {
    const result = parseSQLTables(`
      CREATE TABLE app.pg_order_items (
        order_id BIGINT NOT NULL,
        line_no INT NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        unit_price NUMERIC(12, 2) NOT NULL,
        discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
        line_total NUMERIC(12, 2)
          GENERATED ALWAYS AS ((quantity * unit_price) - discount) STORED,
        CONSTRAINT pk_pg_order_items PRIMARY KEY (order_id, line_no)
      );
    `);
    expect(result.tables[0].columns.map((c) => c.name)).toEqual([
      "order_id",
      "line_no",
      "quantity",
      "unit_price",
      "discount",
      "line_total",
    ]);
    expect(result.tables[0].primaryKeys).toEqual(["order_id", "line_no"]);
  });

  // SQLite 的 inline `REFERENCES` + 单列 PK 应当推断为 1:1（FK 列即整张表的
  // 唯一主键 -> 关系两端都是 "1"）。这是 sql.ts 里的“单列 PK 自动 1:1”规则。
  it("infers 1:1 from a single-column PK that is also the FK", () => {
    const result = parseSQLTables(`
      CREATE TABLE user_profiles (
        user_id INTEGER PRIMARY KEY REFERENCES users (id),
        bio TEXT
      );
    `);
    expect(result.relationships).toEqual([
      {
        from: "user_profiles",
        to: "users",
        label: "user_id",
        fromCardinality: "1",
        toCardinality: "1",
      },
    ]);
  });
});
