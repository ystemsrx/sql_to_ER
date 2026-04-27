import { describe, expect, it } from "vitest";
import { parseDBML } from "../parser/dbml";
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
    expect(result.relationships).toEqual([
      { from: "orders", to: "users", label: "user_id" },
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

    expect(result.tables[0].name).toBe("Article");
    expect(result.tables[0].columns.map((c) => [c.name, c.type])).toEqual([
      ["ArticleID", "UUID"],
      ["AuthorID", "UUID"],
      ["PublishedAt", "TIMESTAMP WITH TIME ZONE"],
      ["Title", "CHARACTER VARYING(255)"],
    ]);
    expect(result.relationships).toEqual([
      { from: "Article", to: "User", label: "AuthorID" },
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
      { from: "note", to: "note", label: "parent_id" },
    ]);
  });
});

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
});
