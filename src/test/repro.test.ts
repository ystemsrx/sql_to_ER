import { describe, it, expect } from "vitest";
import { parseSQLTables } from "../parser/sql";
import { parseDBML } from "../parser/dbml";
import { generateChenModelData } from "../builder";

describe("user-input repro", () => {
  const inputs = [
    `CREATE TABLE users (id INT PRIMARY KEY) COMMENT='users table';`,
    `CREATE TABLE u (id INT PRIMARY KEY COMMENT 'pk', name VARCHAR(50) COMMENT 'user name');`,
    `CREATE TABLE p (id INT PRIMARY KEY); CREATE TABLE c (id INT PRIMARY KEY, p_id INT COMMENT 'parent', FOREIGN KEY (p_id) REFERENCES p(id));`,
    `Table u { id int [pk] Note: 'a note' }`,
    `Table u { id int [pk] }\nTable p { uid int [ref: > u.id, note: 'belongs'] }`,
    `Table u { id int [pk] }\nTable p { uid int }\nRef: p.uid > u.id [note: 'fk note']`,
  ];
  for (const sql of inputs) {
    it(`parses+builds: ${sql.slice(0,40)}`, () => {
      let parsed = parseSQLTables(sql);
      if (parsed.tables.length === 0) parsed = parseDBML(sql);
      expect(() => generateChenModelData(parsed.tables, parsed.relationships, true, "comment", false)).not.toThrow();
    });
  }
});
