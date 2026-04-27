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
      // users.country_id 不是 pk/unique → 默认 N:1
      {
        from: "users",
        to: "countries",
        label: "country_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
      // users.id 是 users 表的单列主键 → 推断升级为 1:1
      {
        from: "users",
        to: "countries",
        label: "id",
        fromCardinality: "1",
        toCardinality: "1",
      },
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
      {
        from: "posts",
        to: "users",
        label: "author_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
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
      {
        from: "a",
        to: "b",
        label: "x",
        fromCardinality: "N",
        toCardinality: "1",
      },
      // 显式 `<` 反向：from 端为 1，to 端为 N
      {
        from: "b",
        to: "a",
        label: "y",
        fromCardinality: "1",
        toCardinality: "N",
      },
    ]);
  });

  it("supports schema-qualified ref targets (uses last two segments)", () => {
    const result = parseDBML(`
      Table users { id int [pk] }
      Table posts { id int [pk]; author_id int }
      Ref: public.posts.author_id > public.users.id
    `);
    expect(result.relationships).toEqual([
      {
        from: "posts",
        to: "users",
        label: "author_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
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
      {
        from: "订单",
        to: "用户",
        label: "用户编号",
        fromCardinality: "N",
        toCardinality: "1",
      },
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
      {
        from: "用户",
        to: "国家",
        label: "属于",
        fromCardinality: "N",
        toCardinality: "1",
      },
      {
        from: "文章",
        to: "用户",
        label: "作者",
        fromCardinality: "N",
        toCardinality: "1",
      },
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

  it("supports schema-qualified table names (Table auth.users)", () => {
    const result = parseDBML(`
      Table auth.users {
        user_id bigint [pk]
      }
      Table catalog.products {
        product_id bigint [pk]
      }
      Ref: catalog.products.user_id > auth.users.user_id
    `);
    expect(result.tables.map((t) => t.name)).toEqual(["users", "products"]);
    expect(result.relationships).toEqual([
      {
        from: "products",
        to: "users",
        label: "user_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  it("parses Ref short statement with multi-line settings block", () => {
    const result = parseDBML(`
      Table users { id int [pk] }
      Table posts { id int [pk]; author_id int }

      Ref: posts.author_id > users.id [
        delete: cascade,
        update: cascade
      ]

      Ref: posts.id > users.id [delete: set null]
    `);
    expect(result.relationships).toEqual([
      {
        from: "posts",
        to: "users",
        label: "author_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
      // posts.id 是 posts 的单列主键 → 推断为 1:1
      {
        from: "posts",
        to: "users",
        label: "id",
        fromCardinality: "1",
        toCardinality: "1",
      },
    ]);
  });

  it("skips checks/records blocks and ~partial injections inside table body", () => {
    const result = parseDBML(`
      Table users {
        id bigint [pk]
        name text
        ~timestamps

        indexes { id [unique] }

        checks {
          \`length(name) > 0\` [name: 'ck_users_name_nonempty']
        }

        records {
          1, 'alice'
          2, 'bob'
        }

        records (id, name) {
          3, 'carol'
        }
      }
    `);
    const cols = result.tables[0].columns.map((c) => c.name);
    expect(cols).toEqual(["id", "name"]);
  });

  it("parses multi-line `Ref name:` short statements with bracket settings", () => {
    const result = parseDBML(`
      Table users { id bigint [pk] }
      Table orders { id bigint [pk]; user_id bigint }

      Ref fk_orders_user:
        orders.user_id > users.id [
          delete: restrict,
          update: cascade,
          color: #e67e22
        ]

      Ref users_orders_mtm:
        users.id <> orders.id [color: #f39c12]
    `);
    expect(result.relationships).toEqual([
      {
        from: "orders",
        to: "users",
        label: "user_id",
        fromCardinality: "N",
        toCardinality: "1",
      },
      // 显式 `<>` 多对多
      {
        from: "users",
        to: "orders",
        label: "id",
        fromCardinality: "N",
        toCardinality: "N",
      },
    ]);
  });

  it("parses composite-column foreign keys (joined column names as label)", () => {
    const result = parseDBML(`
      Table products { id bigint [pk]; code varchar(32) }
      Table order_items {
        product_id bigint
        product_code varchar(32)
      }

      Ref:
        order_items.(product_id, product_code)
          > products.(id, code) [delete: set null]
    `);
    expect(result.relationships).toEqual([
      {
        from: "order_items",
        to: "products",
        label: "product_id, product_code",
        // 复合 FK label 含逗号 → 跳过单列推断，保持默认 N:1
        fromCardinality: "N",
        toCardinality: "1",
      },
    ]);
  });

  it("renders user_profiles as 1:1 via the `-` operator on a pk FK column", () => {
    // 来自实际样例：user_profiles.user_id 既是 pk 又通过 `-` 引用 users.id —
    // 必须渲染成 1:1，不能因为只看到 FK 就退化成 N:1。
    const result = parseDBML(`
      Table users { id bigint [pk] }
      Table user_profiles {
        user_id bigint [pk, ref: - users.id]
        bio text
      }
    `);
    const rel = result.relationships.find(
      (r) => r.from === "user_profiles" && r.to === "users",
    );
    expect(rel).toBeDefined();
    expect(rel!.fromCardinality).toBe("1");
    expect(rel!.toCardinality).toBe("1");
  });

  it("infers 1:1 when the FK column is unique even if operator is `>`", () => {
    // payments.order_id [unique] + Ref `>` orders.id —— `>` 默认 N:1，但 FK 列
    // 是 unique，应推断为 1:1（一个 order 至多一条 payment 记录）。
    const result = parseDBML(`
      Table orders { id bigint [pk] }
      Table payments {
        id bigint [pk]
        order_id bigint [not null, unique]
      }
      Ref: payments.order_id > orders.id
    `);
    const rel = result.relationships.find(
      (r) => r.from === "payments" && r.to === "orders",
    );
    expect(rel).toBeDefined();
    expect(rel!.fromCardinality).toBe("1");
    expect(rel!.toCardinality).toBe("1");
  });

  it("respects explicit `<>` many-to-many even if from-column is pk/unique", () => {
    // 显式 N:N 不被推断覆盖 —— 用户明确表达多对多关系，不应被 unique 倒推回 1:?
    const result = parseDBML(`
      Table users { id bigint [pk] }
      Table groups { id bigint [pk] }
      Ref: users.id <> groups.id
    `);
    const rel = result.relationships[0];
    expect(rel.fromCardinality).toBe("N");
    expect(rel.toCardinality).toBe("N");
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
