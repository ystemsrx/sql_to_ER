import { describe, expect, it } from "vitest";
import { parseSQLTables } from "../parser/sql";

// 这些用例是对 SQL 解析器边界场景的回归测试。它们对应一次审计中发现的、
// 旧版基于正则的实现会“静默出错”的情形：丢列、丢表、幻列、幻关系、
// 主键 / 唯一性误判、类型被截断等。重写为基于词法分析（tokenizer）后，
// 字符串 / 引用标识符成为原子 token，关键字只在裸词上匹配，这些场景全部修正。

describe("parseSQLTables — 边界场景", () => {
  const colNames = (sql: string, idx = 0) =>
    parseSQLTables(sql).tables[idx].columns.map((c) => c.name);

  // ---- 引用标识符里的分隔符不再破坏切分 ----

  it("反引号标识符内含 -- 时不被当作注释（整表不丢失）", () => {
    const r = parseSQLTables("CREATE TABLE `we--ird` (id INT PRIMARY KEY, name VARCHAR(10));");
    expect(r.tables.map((t) => t.name)).toEqual(["we--ird"]);
    expect(colNames("CREATE TABLE `we--ird` (id INT PRIMARY KEY, name VARCHAR(10));")).toEqual([
      "id",
      "name",
    ]);
  });

  it("反引号标识符内含 ; 时不被当作语句分隔符", () => {
    const r = parseSQLTables("CREATE TABLE `a;b` (id INT PRIMARY KEY);");
    expect(r.tables.map((t) => t.name)).toEqual(["a;b"]);
  });

  it("方括号标识符内含逗号时不被切碎", () => {
    const r = parseSQLTables("CREATE TABLE t ([a,b] INT PRIMARY KEY, c INT);");
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["a,b", "c"]);
    expect(r.tables[0].primaryKeys).toEqual(["a,b"]);
  });

  it("方括号标识符内含右括号时不破坏括号配对", () => {
    const r = parseSQLTables("CREATE TABLE t ([a)b] INT PRIMARY KEY, c INT);");
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["a)b", "c"]);
  });

  it("PostgreSQL 双引号标识符内含 -- 与 ; 也安全", () => {
    const r = parseSQLTables(`CREATE TABLE "a;b" ("we--ird" INT PRIMARY KEY, name VARCHAR(10));`);
    expect(r.tables[0].name).toBe("a;b");
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["we--ird", "name"]);
    expect(r.tables[0].primaryKeys).toEqual(["we--ird"]);
  });

  // ---- 字符串 / 注释里的关键字不再泄漏 ----

  it("DEFAULT 字符串里出现 'PRIMARY KEY' 不会把列误判为主键", () => {
    const r = parseSQLTables(
      `CREATE TABLE t (id INT, note VARCHAR(50) DEFAULT 'I am the PRIMARY KEY');`,
    );
    expect(r.tables[0].primaryKeys).toEqual([]);
    expect(r.tables[0].columns.find((c) => c.name === "note")?.isPrimaryKey).toBe(false);
  });

  it("COMMENT 里出现 'UNIQUE' 不会把列误判为唯一，基数仍为 N:1", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (
        id INT PRIMARY KEY,
        owner_id INT COMMENT 'must be UNIQUE per row' REFERENCES users(id)
      );
    `);
    const owner = r.tables[0].columns.find((c) => c.name === "owner_id")!;
    expect(owner.isUnique).toBeUndefined();
    expect(r.relationships[0].fromCardinality).toBe("N");
    expect(r.relationships[0].toCardinality).toBe("1");
  });

  it("DEFAULT 字符串里出现 'REFERENCES tbl(col)' 不会生成幻外键", () => {
    const r = parseSQLTables(
      `CREATE TABLE t (id INT, note VARCHAR(80) DEFAULT 'see REFERENCES users(id) for detail');`,
    );
    expect(r.tables[0].foreignKeys).toEqual([]);
    expect(r.relationships).toEqual([]);
  });

  it("MySQL # 行内注释被正确剥离，后续列不丢失", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (
        id INT PRIMARY KEY, # the id column
        name VARCHAR(50)
      );
    `);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "name"]);
  });

  // ---- 类型解析尊重字符串字面量与括号 ----

  it("ENUM/SET 类型里出现空格分隔的关键字不会截断类型", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (
        id INT,
        status ENUM('yes NOT no','x') NOT NULL,
        flags SET('a','DEFAULT VAL') NOT NULL
      );
    `);
    const types = Object.fromEntries(r.tables[0].columns.map((c) => [c.name, c.type]));
    expect(types.status).toBe("ENUM('yes NOT no','x')");
    expect(types.flags).toBe("SET('a','DEFAULT VAL')");
  });

  it("PostgreSQL 数组类型后缀 [] / [][] 被完整保留", () => {
    const r = parseSQLTables(`CREATE TABLE t (id INT PRIMARY KEY, tags TEXT[], grid INT[][]);`);
    const types = Object.fromEntries(r.tables[0].columns.map((c) => [c.name, c.type]));
    expect(types.tags).toBe("TEXT[]");
    expect(types.grid).toBe("INT[][]");
  });

  it("CHARACTER VARYING 保留为类型，而 CHARACTER SET 作为子句被剔除", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (
        a CHARACTER VARYING(255) NOT NULL,
        b VARCHAR(50) CHARACTER SET utf8mb4 NOT NULL
      );
    `);
    const types = Object.fromEntries(r.tables[0].columns.map((c) => [c.name, c.type]));
    expect(types.a).toBe("CHARACTER VARYING(255)");
    expect(types.b).toBe("VARCHAR(50)");
  });

  // ---- 保留字作为（未加引号的）列名 ----

  it("未加引号、名为 key 的列被保留为列而非索引", () => {
    expect(colNames("CREATE TABLE t (id INT PRIMARY KEY, key VARCHAR(20), val INT);")).toEqual([
      "id",
      "key",
      "val",
    ]);
  });

  it("名为 constraint / check / index / unique 的列都被保留", () => {
    expect(
      colNames(
        "CREATE TABLE t (id INT, constraint VARCHAR(10), check INT, index INT, unique INT);",
      ),
    ).toEqual(["id", "constraint", "check", "index", "unique"]);
  });

  // ---- 主键前缀长度 ----

  it("PRIMARY KEY 列带索引前缀长度 name(10) 时取裸列名", () => {
    const r = parseSQLTables("CREATE TABLE t (a VARCHAR(20), b INT, PRIMARY KEY (a(10), b));");
    expect(r.tables[0].primaryKeys).toEqual(["a", "b"]);
  });

  // ---- 复合外键 ----

  it("复合 FOREIGN KEY (a,b) REFERENCES parent(x,y) 被识别为单条关系", () => {
    const r = parseSQLTables(`
      CREATE TABLE child (
        a INT, b INT,
        FOREIGN KEY (a, b) REFERENCES parent (x, y)
      );
    `);
    // 不再出现名为 "FOREIGN" 的幻列
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["a", "b"]);
    expect(r.tables[0].foreignKeys).toEqual([
      { column: "a, b", referencedTable: "parent", referencedColumn: "x, y" },
    ]);
    expect(r.relationships).toEqual([
      {
        from: "child",
        to: "parent",
        label: "a, b",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  // ---- 省略列名的 REFERENCES（PG 简写） ----

  it("内联 REFERENCES users（省略列名）也能生成外键关系", () => {
    const r = parseSQLTables(
      `CREATE TABLE t (id INT PRIMARY KEY, author_id INT REFERENCES users);`,
    );
    expect(r.tables[0].foreignKeys).toEqual([
      { column: "author_id", referencedTable: "users", referencedColumn: "" },
    ]);
    expect(r.relationships).toEqual([
      {
        from: "t",
        to: "users",
        label: "author_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  // ---- CTAS / LIKE ----

  it("CREATE TABLE ... AS SELECT 被干净跳过（不产生幻实体 / 幻列）", () => {
    const r = parseSQLTables(
      `CREATE TABLE summary AS SELECT a, b FROM other WHERE x > (SELECT max(y) FROM z);`,
    );
    expect(r.tables).toEqual([]);
  });

  it("CREATE TABLE copy LIKE original 复制源表的列与主键", () => {
    const r = parseSQLTables(`
      CREATE TABLE original (id INT PRIMARY KEY, name VARCHAR(50));
      CREATE TABLE copy LIKE original;
    `);
    const copy = r.tables.find((t) => t.name === "copy")!;
    expect(copy.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(copy.primaryKeys).toEqual(["id"]);
  });

  it("PostgreSQL 体内 LIKE 形式 (LIKE other INCLUDING ALL) 同样复制结构", () => {
    const r = parseSQLTables(`
      CREATE TABLE base (id INT PRIMARY KEY, label TEXT);
      CREATE TABLE clone (LIKE base INCLUDING ALL);
    `);
    const clone = r.tables.find((t) => t.name === "clone")!;
    expect(clone.columns.map((c) => c.name)).toEqual(["id", "label"]);
    expect(clone.primaryKeys).toEqual(["id"]);
  });

  // ---- 内联约束表达式里的逗号 / 括号 ----

  it("内联 CHECK (col IN (1,2,3)) 不影响相邻列解析", () => {
    const r = parseSQLTables(`
      CREATE TABLE t (
        id INT PRIMARY KEY,
        score INT CHECK (score IN (1,2,3)),
        grade INT
      );
    `);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "score", "grade"]);
  });

  it("字符串默认值里的 ; ) ( { } 不破坏解析", () => {
    const r = parseSQLTables(
      `CREATE TABLE t (id INT, body TEXT DEFAULT 'a; b) c( d {e}', j JSON DEFAULT '{"k":"v;)("}');`,
    );
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(["id", "body", "j"]);
  });

  // ---- 表级单列 UNIQUE 参与 1:1 推断 ----

  it("表级单列 UNIQUE 约束让 FK 关系推断为 1:1", () => {
    const r = parseSQLTables(`
      CREATE TABLE payments (
        id INT PRIMARY KEY,
        order_id INT NOT NULL,
        UNIQUE (order_id),
        FOREIGN KEY (order_id) REFERENCES orders(id)
      );
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

  // ---- 综合：真实 MySQL dump 片段 ----

  it("真实 MySQL dump（AUTO_INCREMENT/UNIQUE KEY/CONSTRAINT FK/表注释）整体解析正确", () => {
    const r = parseSQLTables(`
      CREATE TABLE \`order_item\` (
        \`id\` BIGINT NOT NULL AUTO_INCREMENT,
        \`order_id\` BIGINT NOT NULL,
        \`sku\` VARCHAR(64) NOT NULL,
        \`qty\` INT NOT NULL DEFAULT '1',
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq\` (\`order_id\`,\`sku\`),
        CONSTRAINT \`fk_oi_order\` FOREIGN KEY (\`order_id\`) REFERENCES \`orders\` (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='line items';
    `);
    const t = r.tables[0];
    expect(t.name).toBe("order_item");
    expect(t.columns.map((c) => c.name)).toEqual(["id", "order_id", "sku", "qty"]);
    expect(t.primaryKeys).toEqual(["id"]);
    expect(t.comment).toBe("line items");
    expect(r.relationships).toEqual([
      {
        from: "order_item",
        to: "orders",
        label: "order_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });
});
