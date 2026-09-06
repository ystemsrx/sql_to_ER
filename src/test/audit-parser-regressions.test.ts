import { describe, it, expect } from "vitest";
import { parseDBML } from "../parser/dbml";
import { parseSQLTables } from "../parser/sql";
import { generateChenModelData, buildAttributeData } from "../builder";

describe("relationship contract regressions", () => {
  it("gives inline < and external < the same FK holder and graph attributes", () => {
    const inline = parseDBML(
      `Table users {\n id int [pk, ref: < posts.user_id]\n}\nTable posts {\n id int [pk]\n user_id int\n}`,
    );
    const external = parseDBML(
      `Table users {\n id int [pk]\n}\nTable posts {\n id int [pk]\n user_id int\n}\nRef: users.id < posts.user_id`,
    );
    expect(inline).toEqual(external);
    expect(inline.warnings).toBeUndefined();
    expect(inline.tables[0].foreignKeys).toEqual([]);
    expect(inline.tables[1].foreignKeys[0].columns).toEqual(["user_id"]);
    expect(
      generateChenModelData(inline.tables, inline.relationships)
        .nodes.filter((n) => n.nodeType === "attribute")
        .map((n) => n.label),
    ).toEqual(["id", "id"]);
  });

  it.each([">", "<"])("infers the unique FK side for %s", (op) => {
    const schema = `Table users { id int [pk] }\nTable profiles {\n id int [pk]\n user_id int [unique]\n}`;
    const ref = op === ">" ? "profiles.user_id > users.id" : "users.id < profiles.user_id";
    expect(parseDBML(`${schema}\nRef: ${ref}`).relationships[0]).toMatchObject({
      fromCardinality: "1",
      toCardinality: "1",
    });
  });

  it("uses unique key subsets for the source, but still checks exact target keys", () => {
    const sql = parseSQLTables(
      `CREATE TABLE p(a INT, b INT, PRIMARY KEY(a,b)); CREATE TABLE c(a INT PRIMARY KEY, b INT, FOREIGN KEY(a,b) REFERENCES p(a,b));`,
    );
    expect(sql.relationships[0].fromCardinality).toBe("1");
    const dbml = parseDBML(
      `Table p {\n a int\n b int\n indexes {\n (a,b) [pk]\n }\n}\nTable c {\n a int [pk]\n b int\n}\nRef: c.(a,b) > p.(a,b)`,
    );
    expect(dbml.relationships[0].fromCardinality).toBe("1");
    expect(dbml.warnings).toBeUndefined();
    const badTarget = parseSQLTables(
      `CREATE TABLE p(a INT PRIMARY KEY, b INT); CREATE TABLE c(a INT, b INT, FOREIGN KEY(a,b) REFERENCES p(a,b));`,
    );
    expect(badTarget.warnings?.some((w) => w.message.includes("not a primary or unique key"))).toBe(
      true,
    );
  });

  it.each([
    `CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c("a,b" INT, a INT, b INT, FOREIGN KEY("a,b") REFERENCES p(id));`,
    `CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c("a,b" INT REFERENCES p(id), a INT, b INT);`,
  ])("keeps comma-bearing identifiers intact through generate and show attributes", (sql) => {
    const parsed = parseSQLTables(sql);
    expect(parsed.warnings).toBeUndefined();
    expect(parsed.tables[1].foreignKeys[0].columns).toEqual(["a,b"]);
    const initial = generateChenModelData(parsed.tables, parsed.relationships);
    const restored = buildAttributeData(parsed.tables);
    for (const result of [initial, restored])
      expect(result.nodes.filter((n) => n.nodeType === "attribute").map((n) => n.label)).toEqual([
        "id",
        "a",
        "b",
      ]);
  });

  it("keeps a local attribute when its invalid FK produced no relationship", () => {
    const parsed = parseSQLTables(
      "CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(pid INT REFERENCES p(missing));",
    );
    expect(parsed.relationships).toEqual([]);
    expect(parsed.warnings?.length).toBeGreaterThan(0);
    for (const result of [
      generateChenModelData(parsed.tables, parsed.relationships),
      buildAttributeData(parsed.tables),
    ]) {
      expect(result.nodes.some((n) => n.nodeType === "attribute" && n.label === "pid")).toBe(true);
    }
  });
});
