/**
 * SQL Parser - 解析 CREATE TABLE 语句
 */

import type {
  ParseResult,
  ParsedColumn,
  ParsedForeignKey,
  ParsedRelationship,
  ParsedTable,
} from "../types";

const IDENT = String.raw`(?:\`[^\`]+\`|"[^"]+"|\[[^\]]+\]|[\w\u4e00-\u9fa5]+)`;
const QUALIFIED_IDENT = String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`;

const stripSqlComments = (src: string) => {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < src.length) {
        if (src[i] === quote && src[i + 1] === quote) {
          out += quote + quote;
          i += 2;
        } else if (src[i] === "\\" && quote === "'") {
          out += src[i] + (src[i + 1] || "");
          i += 2;
        } else if (src[i] === quote) {
          out += quote;
          i++;
          break;
        } else {
          out += src[i++];
        }
      }
    } else if (ch === "-" && src[i + 1] === "--") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(src.length, i + 2);
    } else {
      out += ch;
      i++;
    }
  }
  return out;
};

const splitStatements = (sql: string) => {
  const statements: string[] = [];
  let part = "";
  let quote: string | null = null;
  let dollarTag: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        part += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
      } else {
        part += ch;
      }
      continue;
    }
    if (quote) {
      part += ch;
      if (ch === quote && sql[i + 1] === quote) {
        part += sql[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    const dollar = sql.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
    if (dollar) {
      dollarTag = dollar[0];
      part += dollarTag;
      i += dollarTag.length - 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      part += ch;
      continue;
    }
    if (ch === ";") {
      if (part.trim()) statements.push(part.trim());
      part = "";
      continue;
    }
    part += ch;
  }
  if (part.trim()) statements.push(part.trim());
  return statements;
};

const cleanIdentifier = (raw: string) => {
  const parts = raw
    .split(".")
    .map((p) => p.trim().replace(/^[`"\[]|[`"\]]$/g, ""))
    .filter(Boolean);
  return parts[parts.length - 1] || raw.trim();
};

const splitTopLevelComma = (body: string) => {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === quote && body[i + 1] === quote) current += body[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
};

const extractMainBody = (statement: string) => {
  const openParenIndex = statement.indexOf("(");
  if (openParenIndex === -1) return null;
  let closeParenIndex = -1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParenIndex + 1; i < statement.length; i++) {
    const ch = statement[i];
    if (quote) {
      if (ch === quote && statement[i + 1] === quote) i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) {
        closeParenIndex = i;
        break;
      }
      depth--;
    }
  }
  return closeParenIndex === -1
    ? null
    : statement.substring(openParenIndex + 1, closeParenIndex);
};

const parseIdentifierList = (text: string) =>
  splitTopLevelComma(text).map((col) => cleanIdentifier(col));

const parseColumnType = (rest: string) => {
  const match = rest.match(
    /\s+(?:CONSTRAINT|PRIMARY|REFERENCES|NOT|NULL|DEFAULT|UNIQUE|CHECK|COLLATE|GENERATED|COMMENT|AUTO_INCREMENT|IDENTITY)\b/i,
  );
  return (match ? rest.slice(0, match.index) : rest).trim();
};

export const parseSQLTables = (sql: string): ParseResult => {
  const tables: ParsedTable[] = [];
  const relationships: ParsedRelationship[] = [];
  const cleanSql = stripSqlComments(sql).trim();

  splitStatements(cleanSql).forEach((statement) => {
    if (!/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE/i.test(statement)) return;

    const tableNameMatch = statement.match(
      new RegExp(
        String.raw`CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED_IDENT})`,
        "i",
      ),
    );
    if (!tableNameMatch) return;
    const tableName = cleanIdentifier(tableNameMatch[1]);
    const tableBody = extractMainBody(statement);
    if (!tableBody) return;

    const columns: ParsedColumn[] = [];
    const primaryKeys: string[] = [];
    const foreignKeys: ParsedForeignKey[] = [];

    splitTopLevelComma(tableBody).forEach((part) => {
      const trimmedPart = part.trim().replace(/,\s*$/, "");
      if (!trimmedPart) return;

      const pkMatch = trimmedPart.match(
        new RegExp(String.raw`^(?:CONSTRAINT\s+${IDENT}\s+)?PRIMARY\s+KEY\s*\((.*)\)`, "i"),
      );
      if (pkMatch) {
        primaryKeys.push(...parseIdentifierList(pkMatch[1]));
        return;
      }

      const fkMatch = trimmedPart.match(
        new RegExp(
          String.raw`^(?:CONSTRAINT\s+${IDENT}\s+)?FOREIGN\s+KEY\s*\(\s*(${IDENT})\s*\)\s+REFERENCES\s+(${QUALIFIED_IDENT})\s*\(\s*(${IDENT})\s*\)`,
          "i",
        ),
      );
      if (fkMatch) {
        foreignKeys.push({
          column: cleanIdentifier(fkMatch[1]),
          referencedTable: cleanIdentifier(fkMatch[2]),
          referencedColumn: cleanIdentifier(fkMatch[3]),
        });
        return;
      }

      if (/^(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+/i.test(trimmedPart)) return;
      if (/^CONSTRAINT\s+/i.test(trimmedPart)) return;
      if (/^CHECK\s*\(/i.test(trimmedPart)) return;

      const columnMatch = trimmedPart.match(new RegExp(String.raw`^(${IDENT})\s+([\s\S]+)$`, "i"));
      if (!columnMatch) return;

      const columnName = cleanIdentifier(columnMatch[1]);
      const rest = columnMatch[2].trim();
      const dataType = parseColumnType(rest);
      const isPrimaryKey = /PRIMARY\s+KEY/i.test(rest);
      if (isPrimaryKey) primaryKeys.push(columnName);
      // 内联 UNIQUE 约束（不与 PRIMARY KEY 等价 —— PK 自动唯一，但这里只看
      // 显式 UNIQUE，用于后面的 1:1 推断）。
      const isUnique = /\bUNIQUE\b/i.test(rest) && !isPrimaryKey;

      const commentMatch = rest.match(/COMMENT\s+'((?:[^'\\]|''|\\.)*)'/i);
      const comment = commentMatch ? commentMatch[1].replace(/''/g, "'") : "";

      const inlineRef = rest.match(
        new RegExp(String.raw`REFERENCES\s+(${QUALIFIED_IDENT})\s*\(\s*(${IDENT})\s*\)`, "i"),
      );
      if (inlineRef) {
        foreignKeys.push({
          column: columnName,
          referencedTable: cleanIdentifier(inlineRef[1]),
          referencedColumn: cleanIdentifier(inlineRef[2]),
        });
      }

      const col: ParsedColumn = {
        name: columnName,
        type: dataType,
        isPrimaryKey,
        comment,
      };
      if (isUnique) col.isUnique = true;
      columns.push(col);
    });

    tables.push({
      name: tableName,
      columns,
      primaryKeys,
      foreignKeys,
    });

    foreignKeys.forEach((fk) => {
      // 默认多对一；若 FK 列在本表上是单列主键 / UNIQUE，推断为 1:1。
      // SQL 没有 DBML 的 `-` / `<>` 写法，全部从约束推断。
      const fkCol = columns.find((c) => c.name === fk.column);
      const isOnlySinglePk =
        primaryKeys.length === 1 && primaryKeys[0] === fk.column;
      const fromCardinality: "1" | "N" =
        fkCol?.isUnique || isOnlySinglePk ? "1" : "N";
      relationships.push({
        from: tableName,
        to: fk.referencedTable,
        label: fk.column,
        fromCardinality,
        toCardinality: "1",
      });
    });
  });

  return { tables, relationships };
};
