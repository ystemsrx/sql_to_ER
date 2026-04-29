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
    } else if (ch === "-" && src[i + 1] === "-") {
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

// 拆解一个可能带 schema 前缀的标识符为各段裸名（去引号 / 去反引号 / 去方括号）。
const splitIdentifierParts = (raw: string) =>
  raw
    .split(".")
    .map((p) => p.trim().replace(/^[`"\[]|[`"\]]$/g, ""))
    .filter(Boolean);

// 仅取最末段的裸名（用于列名 —— 列名不会有 schema 前缀）。
const cleanIdentifier = (raw: string) => {
  const parts = splitIdentifierParts(raw);
  return parts[parts.length - 1] || raw.trim();
};

// 保留 schema 的限定名（用于表名与 FK 目标）：`"app"."customer"` -> `app.customer`。
// 不同 schema 下同名表才不会塌成同一个节点。
const qualifiedIdentifier = (raw: string) => {
  const parts = splitIdentifierParts(raw);
  return parts.length ? parts.join(".") : raw.trim();
};

// T-SQL 批处理分隔符 GO 单独成行时把它换成 `;`，让后续按 `;` 切分能识别两边。
// 必须在去掉块/行注释之后做，否则会误伤注释里的 GO。
const normalizeBatchSeparators = (sql: string) =>
  sql.replace(/^[\t ]*GO[\t ]*(?:\r?\n|$)/gim, ";\n");

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

const extractMainBody = (
  statement: string,
): { body: string; suffix: string } | null => {
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
  if (closeParenIndex === -1) return null;
  return {
    body: statement.substring(openParenIndex + 1, closeParenIndex),
    suffix: statement.substring(closeParenIndex + 1),
  };
};

// 解析 CREATE TABLE 末尾的表级 COMMENT。MySQL 写法 `... ) ENGINE=InnoDB COMMENT='xxx'`
// 或 `COMMENT 'xxx'`；PostgreSQL 用 COMMENT ON TABLE 单独语句，这里不处理。
const extractTableComment = (suffix: string): string | undefined => {
  const m = suffix.match(/\bCOMMENT\s*=?\s*'((?:[^'\\]|''|\\.)*)'/i);
  return m ? m[1].replace(/''/g, "'") : undefined;
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
  const cleanSql = normalizeBatchSeparators(stripSqlComments(sql)).trim();

  splitStatements(cleanSql).forEach((statement) => {
    if (!/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE/i.test(statement)) return;

    const tableNameMatch = statement.match(
      new RegExp(
        String.raw`CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED_IDENT})`,
        "i",
      ),
    );
    if (!tableNameMatch) return;
    const tableName = qualifiedIdentifier(tableNameMatch[1]);

    // PostgreSQL 分区子表（`PARTITION OF parent ...`）不是独立实体 —— 它的列、PK、
    // FK 都继承自父表。强行解析会得到一个空节点漂在图上，干扰阅读。
    if (/\bPARTITION\s+OF\b/i.test(statement)) return;

    const extracted = extractMainBody(statement);
    if (!extracted) return;
    const tableBody = extracted.body;
    const tableComment = extractTableComment(extracted.suffix);

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
          referencedTable: qualifiedIdentifier(fkMatch[2]),
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
          referencedTable: qualifiedIdentifier(inlineRef[1]),
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
      ...(tableComment ? { comment: tableComment } : {}),
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
        // SQL 没有原生关系级注释，但用户的认知里"FK 注释 == 关系注释"是
        // 自然的：用 FK 列上的 COMMENT 'xxx' 作为关系的注释来源。
        ...(fkCol?.comment ? { comment: fkCol.comment } : {}),
      });
    });
  });

  return { tables, relationships };
};
