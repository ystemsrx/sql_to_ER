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

    expect(result.tables[0].name).toBe("Article");
    expect(result.tables[0].columns.map((c) => [c.name, c.type])).toEqual([
      ["ArticleID", "UUID"],
      ["AuthorID", "UUID"],
      ["PublishedAt", "TIMESTAMP WITH TIME ZONE"],
      ["Title", "CHARACTER VARYING(255)"],
    ]);
    expect(result.relationships).toEqual([
      {
        from: "Article",
        to: "User",
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
});
