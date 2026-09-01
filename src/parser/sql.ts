/**
 * SQL Parser - 解析 CREATE TABLE 语句
 *
 * 基于词法分析器（tokenizer）的实现，而不是堆叠正则。关键设计：
 *   1. 先把源码里的注释（`--` / `#` / `/* *\/`）替换成等长空白（保留偏移），
 *      字符串字面量 / 反引号 / 双引号 / 方括号 / dollar-quote 原样保留。
 *      => 反引号 / 方括号标识符里的 `-- ; ( ) ,` 不再破坏切分。
 *   2. 把语句切成 token 流：字符串与引用标识符都是“原子 token”，
 *      因此任何分隔符 / 关键字出现在字符串或引用标识符内部都不会泄漏出来。
 *      => DEFAULT 'PRIMARY KEY' / COMMENT 'must be UNIQUE' 不再误判。
 *   3. 关键字（CREATE / PRIMARY / KEY / REFERENCES ...）只在裸词 token 上匹配，
 *      引用标识符（`"select"` / `` `key` `` / `[key]`）永远不会被当成关键字。
 *      => 引用的保留字列名稳定；列 vs 约束的判定按“第二个 token”精确区分。
 *   4. 类型字符串通过 token 的源码偏移切片得到，保留原始书写（`DECIMAL(10, 2)`）。
 *
 * 语句覆盖：CREATE [OR REPLACE] [TEMP/...] TABLE、CREATE TABLE ... LIKE、
 * ALTER TABLE ... ADD COLUMN / PRIMARY KEY / UNIQUE / FOREIGN KEY（把新增的列 /
 * 约束 / 外键挂到已定义的表上），以及 COMMENT ON TABLE / COLUMN ... IS '...'。
 * 标识符支持 `$`（order$line）与 SQL Server 临时表名 `#temp` / `##global`。
 * 覆盖的边界 / 方言 / 报告问题场景见 src/test/parser-sql-*.test.ts。
 */

import type {
  ParseResult,
  ParsedColumn,
  ParsedForeignKey,
  ParsedRelationship,
  ParsedTable,
  ParserWarning,
} from "../types";

// 标识符字符（含 `$`：PostgreSQL / Oracle 允许标识符里出现 `$`，如 order$line）。
// 用 Unicode 属性类而非硬编码 `一-龥`，日文假名 / 韩文谚文等标识符同样有效。
const WORD_RE = /[\p{L}\p{N}\p{M}_$]/u;

const isWordChar = (c: string | undefined): boolean => !!c && WORD_RE.test(c);

// ---------------------------------------------------------------------------
// 1. 注释消隐（保留偏移）：把注释替换成等长空白，字符串/引用标识符原样保留。
// ---------------------------------------------------------------------------
const blankComments = (src: string, warnings: ParserWarning[]): string => {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];

    // 单引号字符串：支持 '' 与 \' 转义
    if (ch === "'") {
      out += ch;
      i++;
      while (i < n) {
        if (src[i] === "\\" && i + 1 < n) {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === "'" && src[i + 1] === "'") {
          out += "''";
          i += 2;
          continue;
        }
        if (src[i] === "'") {
          out += "'";
          i++;
          break;
        }
        out += src[i++];
      }
      continue;
    }

    // 双引号（PG/标准 SQL 的引用标识符；MySQL 的字符串）：支持 "" 与 \" 转义
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        if (src[i] === "\\" && i + 1 < n) {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === '"' && src[i + 1] === '"') {
          out += '""';
          i += 2;
          continue;
        }
        if (src[i] === '"') {
          out += '"';
          i++;
          break;
        }
        out += src[i++];
      }
      continue;
    }

    // 反引号（MySQL 引用标识符）：支持 `` 转义
    if (ch === "`") {
      out += ch;
      i++;
      while (i < n) {
        if (src[i] === "`" && src[i + 1] === "`") {
          out += "``";
          i += 2;
          continue;
        }
        if (src[i] === "`") {
          out += "`";
          i++;
          break;
        }
        out += src[i++];
      }
      continue;
    }

    // 方括号（SQLite / T-SQL 引用标识符；也可能是 PG 数组后缀 []）：支持 ]] 转义
    if (ch === "[") {
      out += ch;
      i++;
      while (i < n) {
        if (src[i] === "]" && src[i + 1] === "]") {
          out += "]]";
          i += 2;
          continue;
        }
        if (src[i] === "]") {
          out += "]";
          i++;
          break;
        }
        out += src[i++];
      }
      continue;
    }

    // dollar-quote（PostgreSQL）：$$...$$ / $tag$...$tag$ 原样保留。
    // 仅在词边界（前一字符不是标识符字符）才识别，避免把 order$line 这种
    // 标识符里的 `$` 误当成 dollar-quote 起始而吞掉后续内容。
    if (ch === "$" && !isWordChar(src[i - 1])) {
      const m = src.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (m) {
        const tag = m[0];
        out += tag;
        i += tag.length;
        const end = src.indexOf(tag, i);
        if (end === -1) {
          out += src.slice(i);
          i = n;
        } else {
          out += src.slice(i, end + tag.length);
          i = end + tag.length;
        }
        continue;
      }
    }

    // `--` 行注释 -> 等长空白（保留换行）
    if (ch === "-" && src[i + 1] === "-") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    // `#`：SQL Server 临时表名 #name / ##name（`#` 紧跟标识符字符或另一个 `#`）
    // 原样保留；否则按 MySQL `#` 行注释处理 -> 等长空白。
    if (ch === "#") {
      const next = src[i + 1];
      if (next && (next === "#" || isWordChar(next))) {
        out += ch;
        i++;
        continue;
      }
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    // `/* ... *\/` 块注释 -> 等长空白（保留换行，维持偏移）
    if (ch === "/" && src[i + 1] === "*") {
      const commentStart = i;
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      } else {
        const line = 1 + (src.slice(0, commentStart).match(/\n/g) ?? []).length;
        warnings.push({
          code: "statement_skipped",
          message: `line ${line}: block comment was not closed`,
          line,
        });
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
};

// ---------------------------------------------------------------------------
// 2. 词法分析：字符串 / 引用标识符是原子 token，注释已被消隐。
// ---------------------------------------------------------------------------
type TokType = "str" | "ident" | "word" | "punct" | "arraysuffix" | "op";
interface Token {
  type: TokType;
  value: string;
  start: number;
  end: number;
  line: number;
  // 引用标识符的引号风格：`"` / `` ` `` / `[`。仅 ident 携带，用于在需要时把
  // 双引号 ident 还原为字符串（MySQL 默认模式下 COMMENT "..." 的 "..." 是字符串）。
  q?: string;
}

const tokenize = (s: string): Token[] => {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  const n = s.length;
  const push = (type: TokType, value: string, start: number, end: number, q?: string) =>
    toks.push({ type, value, start, end, line, ...(q ? { q } : {}) });

  while (i < n) {
    const ch = s[i];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v") {
      i++;
      continue;
    }
    const start = i;

    // 单引号字符串
    if (ch === "'") {
      i++;
      let val = "";
      while (i < n) {
        if (s[i] === "\\" && i + 1 < n) {
          val += s[i + 1];
          i += 2;
          continue;
        }
        if (s[i] === "'" && s[i + 1] === "'") {
          val += "'";
          i += 2;
          continue;
        }
        if (s[i] === "'") {
          i++;
          break;
        }
        val += s[i++];
      }
      push("str", val, start, i);
      continue;
    }

    // dollar-quote 字符串
    if (ch === "$") {
      const m = s.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (m) {
        const tag = m[0];
        const close = s.indexOf(tag, i + tag.length);
        const contentEnd = close === -1 ? n : close;
        const val = s.slice(i + tag.length, contentEnd);
        i = close === -1 ? n : close + tag.length;
        push("str", val, start, i);
        continue;
      }
    }

    // 双引号引用标识符
    if (ch === '"') {
      i++;
      let val = "";
      while (i < n) {
        if (s[i] === "\\" && i + 1 < n) {
          val += s[i + 1];
          i += 2;
          continue;
        }
        if (s[i] === '"' && s[i + 1] === '"') {
          val += '"';
          i += 2;
          continue;
        }
        if (s[i] === '"') {
          i++;
          break;
        }
        val += s[i++];
      }
      push("ident", val, start, i, '"');
      continue;
    }

    // 反引号引用标识符
    if (ch === "`") {
      i++;
      let val = "";
      while (i < n) {
        if (s[i] === "`" && s[i + 1] === "`") {
          val += "`";
          i += 2;
          continue;
        }
        if (s[i] === "`") {
          i++;
          break;
        }
        val += s[i++];
      }
      push("ident", val, start, i, "`");
      continue;
    }

    // 方括号：空 / 纯数字 -> 数组后缀；否则 -> 引用标识符
    if (ch === "[") {
      let j = i + 1;
      let val = "";
      while (j < n) {
        if (s[j] === "]" && s[j + 1] === "]") {
          val += "]";
          j += 2;
          continue;
        }
        if (s[j] === "]") {
          j++;
          break;
        }
        val += s[j++];
      }
      i = j;
      const trimmed = val.trim();
      if (trimmed === "" || /^\d+$/.test(trimmed)) {
        push("arraysuffix", val, start, i);
      } else {
        push("ident", trimmed, start, i, "[");
      }
      continue;
    }

    // 结构标点
    if (ch === "(" || ch === ")" || ch === "," || ch === ";" || ch === "." || ch === "=") {
      i++;
      push("punct", ch, start, i);
      continue;
    }

    // `#` 开头：SQL Server 临时表名 #name / ##name（注释 `#` 已在消隐阶段去掉，
    // 这里看到的 `#` 必是标识符前缀）。落单的 `#` 当普通符号忽略。
    if (ch === "#") {
      let j = i;
      while (j < n && s[j] === "#") j++;
      if (j < n && WORD_RE.test(s[j])) {
        while (j < n && WORD_RE.test(s[j])) j++;
        push("word", s.slice(i, j), start, j);
        i = j;
        continue;
      }
      i++;
      push("op", "#", start, i);
      continue;
    }

    // 裸词（关键字 / 标识符 / 数字）
    if (WORD_RE.test(ch)) {
      let j = i;
      while (j < n && WORD_RE.test(s[j])) j++;
      push("word", s.slice(i, j), start, j);
      i = j;
      continue;
    }

    // 其它符号（+ - * / < > 等表达式运算符）
    i++;
    push("op", ch, start, i);
  }

  return toks;
};

// ---------------------------------------------------------------------------
// 3. 工具函数
// ---------------------------------------------------------------------------
const isNameTok = (t: Token | undefined): t is Token =>
  !!t && (t.type === "word" || t.type === "ident");

const kw = (t: Token | undefined): string | null =>
  t && t.type === "word" ? t.value.toUpperCase() : null;

const linePrefix = (line: number | undefined): string => (line ? `line ${line}: ` : "");

const pushWarning = (
  warnings: ParserWarning[],
  code: ParserWarning["code"],
  line: number | undefined,
  text: string,
): void => {
  warnings.push({
    code,
    message: `${linePrefix(line)}${text}`,
    ...(line ? { line } : {}),
  });
};

const shortTableName = (name: string): string => {
  const parts = name.split(".");
  return parts[parts.length - 1] || name;
};

interface RelationshipTypeSignature {
  value: string;
  known: boolean;
}

// 外键两端只做保守的类型兼容性判断：参数长度不影响类型族，常见别名归一化；
// 自定义类型若原文一致可视为兼容，原文不同则明确提示“无法验证”，绝不静默猜测。
const relationshipTypeSignature = (raw: string): RelationshipTypeSignature => {
  let normalized = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const arrayMatch = normalized.match(/(?:\[\s*\])+\s*$/);
  const arrays = (arrayMatch?.[0] ?? "").replace(/\s+/g, "");
  if (arrayMatch) normalized = normalized.slice(0, -arrayMatch[0].length).trim();
  normalized = normalized
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const unsigned = /\bunsigned\b/.test(normalized);
  normalized = normalized
    .replace(/\b(?:unsigned|zerofill)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const aliases: Record<string, string> = {
    int: "integer",
    int4: "integer",
    serial: "integer",
    int2: "smallint",
    smallserial: "smallint",
    int8: "bigint",
    bigserial: "bigint",
    dec: "decimal",
    "double precision": "double",
    float8: "double",
    float4: "real",
    "character varying": "varchar",
    nvarchar2: "nvarchar",
    varchar2: "varchar",
    "national character varying": "nvarchar",
    character: "char",
    "national character": "nchar",
    uniqueidentifier: "uuid",
    "timestamp with time zone": "timestamptz",
    "time with time zone": "timetz",
  };
  const base = aliases[normalized] ?? normalized;
  const value = `${base}${unsigned ? " unsigned" : ""}${arrays}`;
  const known = new Set([
    "tinyint",
    "smallint",
    "mediumint",
    "integer",
    "bigint",
    "decimal",
    "numeric",
    "real",
    "float",
    "double",
    "boolean",
    "bit",
    "char",
    "nchar",
    "varchar",
    "nvarchar",
    "text",
    "blob",
    "binary",
    "varbinary",
    "date",
    "time",
    "timetz",
    "datetime",
    "timestamp",
    "timestamptz",
    "uuid",
    "json",
    "jsonb",
    "xml",
  ]).has(base);
  return { value, known };
};

const relationshipTypesCompatible = (
  left: string,
  right: string,
): { compatible: boolean; uncertain: boolean } => {
  const a = relationshipTypeSignature(left);
  const b = relationshipTypeSignature(right);
  if (a.value === b.value) return { compatible: true, uncertain: false };
  return { compatible: false, uncertain: !a.known || !b.known };
};

// 读取 COMMENT 的值：单引号 / dollar-quote 字符串自然命中；MySQL 默认模式下
// `COMMENT "..."` 的 "..." 被词法器当作双引号 ident，这里把它还原成字符串值。
const readCommentValue = (t: Token | undefined): string | null => {
  if (!t) return null;
  if (t.type === "str") return t.value;
  if (t.type === "ident" && t.q === '"') return t.value;
  return null;
};

// 列定义里，遇到这些裸词关键字就认为类型部分结束。
const TYPE_STOP = new Set([
  "CONSTRAINT",
  "PRIMARY",
  "FOREIGN",
  "REFERENCES",
  "NOT",
  "NULL",
  "DEFAULT",
  "UNIQUE",
  "CHECK",
  "COLLATE",
  "GENERATED",
  "COMMENT",
  "AUTO_INCREMENT",
  "AUTOINCREMENT",
  "IDENTITY",
  "CHARSET",
  "ENCODING",
  "STORAGE",
  "COMPRESSION",
  "VISIBLE",
  "INVISIBLE",
]);

// 列 / 表名常见数据类型关键字。仅用于消歧 `KEY` / `INDEX` / `FULLTEXT` 等
// 既可作约束起始词、又可作（保留字）列名的情况：若其后紧跟一个已知类型词，
// 判定为列名而非索引子句。
const KNOWN_TYPES = new Set([
  "INT",
  "INTEGER",
  "INT2",
  "INT4",
  "INT8",
  "TINYINT",
  "SMALLINT",
  "MEDIUMINT",
  "BIGINT",
  "DECIMAL",
  "DEC",
  "NUMERIC",
  "FIXED",
  "NUMBER",
  "FLOAT",
  "DOUBLE",
  "REAL",
  "BIT",
  "BOOL",
  "BOOLEAN",
  "SERIAL",
  "BIGSERIAL",
  "SMALLSERIAL",
  "MONEY",
  "SMALLMONEY",
  "CHAR",
  "VARCHAR",
  "VARCHAR2",
  "NVARCHAR",
  "NCHAR",
  "CHARACTER",
  "NATIONAL",
  "STRING",
  "BINARY",
  "VARBINARY",
  "RAW",
  "BLOB",
  "TINYBLOB",
  "MEDIUMBLOB",
  "LONGBLOB",
  "BYTEA",
  "TEXT",
  "TINYTEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "CLOB",
  "NTEXT",
  "NVARCHAR2",
  "ENUM",
  "SET",
  "JSON",
  "JSONB",
  "XML",
  "UUID",
  "UNIQUEIDENTIFIER",
  "HSTORE",
  "CITEXT",
  "DATE",
  "DATETIME",
  "DATETIME2",
  "SMALLDATETIME",
  "TIMESTAMP",
  "TIMESTAMPTZ",
  "TIME",
  "TIMETZ",
  "YEAR",
  "INTERVAL",
  "DATETIMEOFFSET",
  "INET",
  "CIDR",
  "MACADDR",
  "MACADDR8",
  "BOX",
  "CIRCLE",
  "LINE",
  "LSEG",
  "PATH",
  "POINT",
  "POLYGON",
  "GEOMETRY",
  "GEOGRAPHY",
  "CUBE",
  "LTREE",
  "TSVECTOR",
  "TSQUERY",
  "ROWVERSION",
  "IMAGE",
  "SQL_VARIANT",
  "ARRAY",
  "VARIANT",
  "OBJECT",
]);

// 把一段 token（限定标识符，如 a / a.b / a.b.c）解析成限定名字符串。
// 返回 { name, next }：next 是限定名之后的 token 下标。
const readQualifiedName = (toks: Token[], from: number): { name: string; next: number } | null => {
  if (!isNameTok(toks[from])) return null;
  const parts = [toks[from].value];
  let p = from + 1;
  while (toks[p] && toks[p].type === "punct" && toks[p].value === "." && isNameTok(toks[p + 1])) {
    parts.push(toks[p + 1].value);
    p += 2;
  }
  return { name: parts.join("."), next: p };
};

// 从 openIdx（指向 '('）读到配对的 ')'，返回 [start, end]（含两端下标）。
const matchParen = (toks: Token[], openIdx: number): number => {
  let depth = 0;
  for (let i = openIdx; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === "punct" && t.value === "(") depth++;
    else if (t.type === "punct" && t.value === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

// 在 [from, end) 内找第一个顶层 '(' 的下标（end 默认到结尾）。
const findOpenParen = (toks: Token[], from: number, end?: number): number => {
  const limit = end ?? toks.length;
  for (let i = from; i < limit; i++) {
    if (toks[i].type === "punct" && toks[i].value === "(") return i;
  }
  return -1;
};

// 按顶层逗号把 token 序列切成多段。
const splitByComma = (toks: Token[]): Token[][] => {
  const parts: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.type === "punct" && t.value === "(") {
      depth++;
      cur.push(t);
    } else if (t.type === "punct" && t.value === ")") {
      depth--;
      cur.push(t);
    } else if (t.type === "punct" && t.value === "," && depth === 0) {
      if (cur.length) parts.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) parts.push(cur);
  return parts;
};

// 解析括号里的简单列名清单。除 MySQL 索引前缀 name(10) 与 ASC/DESC 外，
// 任意表达式都返回空数组，让调用方告警，不能“取第一个名字”后继续猜。
const parseColumnNameList = (toks: Token[], openIdx: number): string[] => {
  const close = matchParen(toks, openIdx);
  if (close === -1) return [];
  const columns: string[] = [];
  for (const segment of splitByComma(toks.slice(openIdx + 1, close))) {
    if (!isNameTok(segment[0])) return [];
    let p = 1;
    if (segment[p]?.type === "punct" && segment[p].value === "(") {
      const prefixClose = matchParen(segment, p);
      const prefix = segment.slice(p + 1, prefixClose);
      if (
        prefixClose === -1 ||
        prefix.length !== 1 ||
        prefix[0].type !== "word" ||
        !/^\d+$/.test(prefix[0].value)
      ) {
        return [];
      }
      p = prefixClose + 1;
    }
    if (kw(segment[p]) === "ASC" || kw(segment[p]) === "DESC") p++;
    if (p !== segment.length) return [];
    columns.push(segment[0].value);
  }
  return columns;
};

// UNIQUE INDEX 只有在每个键都确实是一个列标识符时，才能证明候选键。
// `lower(email)`、`(a + b)` 等表达式不能像普通约束一样“取首个名字”；
// MySQL 的索引前缀 `name(10)` 是唯一允许的额外语法。
const parseSimpleIndexColumnList = (toks: Token[], openIdx: number): string[] | null => {
  const close = matchParen(toks, openIdx);
  if (close === -1) return null;
  const columns: string[] = [];
  for (const segment of splitByComma(toks.slice(openIdx + 1, close))) {
    if (!isNameTok(segment[0])) return null;
    let p = 1;
    if (segment[p]?.type === "punct" && segment[p].value === "(") {
      const prefixClose = matchParen(segment, p);
      const prefix = segment.slice(p + 1, prefixClose);
      if (
        prefixClose === -1 ||
        prefix.length !== 1 ||
        prefix[0].type !== "word" ||
        !/^\d+$/.test(prefix[0].value)
      ) {
        return null;
      }
      p = prefixClose + 1;
    }
    if (kw(segment[p]) === "ASC" || kw(segment[p]) === "DESC") p++;
    if (p !== segment.length) return null;
    columns.push(segment[0].value);
  }
  return columns.length ? columns : null;
};

// ---------------------------------------------------------------------------
// 4. 语句切分（顶层 `;`，以及单独成行的 T-SQL 批处理分隔符 GO）
// ---------------------------------------------------------------------------
const splitStatements = (toks: Token[]): Token[][] => {
  const stmts: Token[][] = [];
  let cur: Token[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === "punct" && t.value === ";") {
      if (cur.length) stmts.push(cur);
      cur = [];
      continue;
    }
    // GO 单独成行（前后都不在同一行）时作为批处理分隔符。
    if (t.type === "word" && t.value.toUpperCase() === "GO") {
      const prev = toks[k - 1];
      const next = toks[k + 1];
      const aloneBefore = !prev || prev.line !== t.line;
      const aloneAfter = !next || next.line !== t.line;
      if (aloneBefore && aloneAfter) {
        if (cur.length) stmts.push(cur);
        cur = [];
        continue;
      }
    }
    // Oracle SQL*Plus 用单独成行的 `/` 结束 PL/SQL 块。若不把它作为批次边界，
    // `/` 会和紧随其后的 CREATE TABLE 落进同一 token 语句，导致后者被吞掉。
    if (t.type === "op" && t.value === "/") {
      const prev = toks[k - 1];
      const next = toks[k + 1];
      const aloneBefore = !prev || prev.line !== t.line;
      const aloneAfter = !next || next.line !== t.line;
      if (aloneBefore && aloneAfter) {
        if (cur.length) stmts.push(cur);
        cur = [];
        continue;
      }
    }
    cur.push(t);
  }
  if (cur.length) stmts.push(cur);
  return stmts;
};

// ---------------------------------------------------------------------------
// 5. 列 / 约束解析
// ---------------------------------------------------------------------------
interface TableAccum {
  columns: ParsedColumn[];
  primaryKeys: string[];
  foreignKeys: ParsedForeignKey[];
  // Candidate UNIQUE keys are kept as arrays.  A composite key must never be
  // collapsed into a comma-delimited pseudo column: quoted identifiers are
  // allowed to contain commas themselves.
  uniqueKeys: string[][];
  tableName: string;
  // 已消隐注释的源码，用于按偏移切出类型字符串（保留原始书写）。
  cleaned: string;
  warnings: ParserWarning[];
  fkLines: WeakMap<ParsedForeignKey, number>;
  fkMeta: WeakMap<ParsedForeignKey, ForeignKeyMeta>;
}

interface ForeignKeyMeta {
  columns: string[];
  referencedColumns: string[];
  constraintName?: string;
  onDelete?: string;
  onUpdate?: string;
}

const parseReferentialOptions = (
  toks: Token[],
  from: number,
  warnings: ParserWarning[],
  tableName: string,
  line: number | undefined,
): Pick<ForeignKeyMeta, "onDelete" | "onUpdate"> => {
  const out: Pick<ForeignKeyMeta, "onDelete" | "onUpdate"> = {};
  let warnedUnsupported = false;
  for (let i = from; i < toks.length; i++) {
    if (kw(toks[i]) === "ON" && (kw(toks[i + 1]) === "DELETE" || kw(toks[i + 1]) === "UPDATE")) {
      const target = kw(toks[i + 1]) === "DELETE" ? "onDelete" : "onUpdate";
      const first = kw(toks[i + 2]);
      const second = kw(toks[i + 3]);
      let action: string | undefined;
      if (first === "CASCADE" || first === "RESTRICT") action = first.toLowerCase();
      else if (first === "SET" && (second === "NULL" || second === "DEFAULT")) {
        action = `set ${second.toLowerCase()}`;
        i++;
      } else if (first === "NO" && second === "ACTION") {
        action = "no action";
        i++;
      }
      if (action) out[target] = action;
      else {
        pushWarning(
          warnings,
          "foreign_key_unrecognized",
          toks[i]?.line ?? line,
          `foreign key action in table "${tableName}" was not recognized`,
        );
      }
      i += 2;
      continue;
    }
    if (!warnedUnsupported && ["MATCH", "DEFERRABLE", "INITIALLY"].includes(kw(toks[i]) ?? "")) {
      warnedUnsupported = true;
      pushWarning(
        warnings,
        "constraint_skipped",
        toks[i]?.line ?? line,
        `foreign key option "${kw(toks[i])}" in table "${tableName}" was not represented`,
      );
    }
  }
  return out;
};

const addUniqueKey = (keys: string[][], columns: string[]): void => {
  if (!columns.length) return;
  const signature = columns.map((column) => column.toLowerCase()).join("\u0000");
  if (!keys.some((key) => key.map((column) => column.toLowerCase()).join("\u0000") === signature)) {
    keys.push([...columns]);
  }
};

// 解析一条列定义。
const parseColumn = (el: Token[], acc: TableAccum): void => {
  const nameTok = el[0];
  const name = nameTok.value;

  // 类型：从第二个 token 起，切到第一个顶层停止关键字之前。用源码偏移切片，
  // 保留原始书写（含括号、数组后缀 []、多词类型）。
  let typeStr = "";
  if (el.length > 1) {
    let depth = 0;
    let stopStart = -1;
    for (let i = 1; i < el.length; i++) {
      const t = el[i];
      if (t.type === "punct" && t.value === "(") depth++;
      else if (t.type === "punct" && t.value === ")") depth--;
      else if (depth === 0 && t.type === "word") {
        const u = t.value.toUpperCase();
        // `CHARACTER SET` 是字符集子句而非类型；`CHARACTER VARYING` 才是类型。
        if (u === "CHARACTER" && kw(el[i + 1]) === "SET") {
          stopStart = t.start;
          break;
        }
        if (TYPE_STOP.has(u)) {
          stopStart = t.start;
          break;
        }
      }
    }
    const sliceEnd = stopStart === -1 ? el[el.length - 1].end : stopStart;
    typeStr = acc.cleaned.slice(el[1].start, sliceEnd).trim();
  }
  if (!typeStr) {
    pushWarning(
      acc.warnings,
      "column_type_missing",
      nameTok.line,
      `column "${name}" in table "${acc.tableName}" has no type`,
    );
  }

  // 内联约束 / 注释 / 外键：仅扫描顶层 token。
  let isPrimaryKey = false;
  let isUnique = false;
  let comment = "";
  let depth = 0;
  for (let i = 1; i < el.length; i++) {
    const t = el[i];
    if (t.type === "punct" && t.value === "(") {
      depth++;
      continue;
    }
    if (t.type === "punct" && t.value === ")") {
      depth--;
      continue;
    }
    if (depth !== 0 || t.type !== "word") continue;
    const u = t.value.toUpperCase();
    if (u === "PRIMARY" && kw(el[i + 1]) === "KEY") {
      isPrimaryKey = true;
    } else if (u === "UNIQUE") {
      isUnique = true;
    } else if (u === "COMMENT") {
      // COMMENT 'xxx' / COMMENT = 'xxx' / COMMENT "xxx"（MySQL）
      let j = i + 1;
      if (el[j] && el[j].type === "punct" && el[j].value === "=") j++;
      const cv = readCommentValue(el[j]);
      if (cv !== null) comment = cv;
    } else if (u === "REFERENCES") {
      const q = readQualifiedName(el, i + 1);
      if (q) {
        let referencedColumn = "";
        let referencedColumns: string[] = [];
        const op = findOpenParen(el, q.next);
        let optionFrom = q.next;
        // 只接受紧跟在被引用表名之后的括号（中间不能隔着别的标识符）。
        if (op === q.next) {
          referencedColumns = parseColumnNameList(el, op);
          if (!referencedColumns.length) {
            pushWarning(
              acc.warnings,
              "foreign_key_unrecognized",
              t.line,
              `foreign key in table "${acc.tableName}" has an invalid referenced column list`,
            );
            continue;
          }
          referencedColumn = referencedColumns.join(", ");
          const close = matchParen(el, op);
          if (close !== -1) optionFrom = close + 1;
        }
        const fk: ParsedForeignKey = {
          column: name,
          referencedTable: q.name,
          referencedColumn,
        };
        acc.fkLines.set(fk, t.line);
        acc.fkMeta.set(fk, {
          columns: [name],
          referencedColumns,
          ...parseReferentialOptions(el, optionFrom, acc.warnings, acc.tableName, t.line),
        });
        acc.foreignKeys.push(fk);
      } else {
        pushWarning(
          acc.warnings,
          "foreign_key_unrecognized",
          t.line,
          `foreign key in table "${acc.tableName}" was not recognized`,
        );
      }
    } else if (u === "CHECK" || u === "GENERATED") {
      pushWarning(
        acc.warnings,
        "constraint_skipped",
        t.line,
        `${u.toLowerCase()} clause on column "${name}" in table "${acc.tableName}" was not represented`,
      );
    }
  }

  if (isPrimaryKey) acc.primaryKeys.push(name);
  if (isUnique) addUniqueKey(acc.uniqueKeys, [name]);
  const col: ParsedColumn = {
    name,
    type: typeStr,
    isPrimaryKey,
    comment,
  };
  if (isUnique && !isPrimaryKey) col.isUnique = true;
  acc.columns.push(col);
};

const parsePrimaryKeyConstraint = (el: Token[], acc: TableAccum): void => {
  // el 形如 [PRIMARY, KEY, ...(可有 CLUSTERED 等修饰), (cols)]
  const op = findOpenParen(el, 2);
  if (op === -1) {
    pushWarning(
      acc.warnings,
      "constraint_skipped",
      el[0]?.line,
      `primary key constraint in table "${acc.tableName}" was skipped`,
    );
    return;
  }
  const columns = parseColumnNameList(el, op);
  if (!columns.length) {
    pushWarning(
      acc.warnings,
      "constraint_skipped",
      el[0]?.line,
      `primary key constraint in table "${acc.tableName}" has an invalid column list`,
    );
    return;
  }
  acc.primaryKeys.push(...columns);
};

const parseForeignKeyConstraint = (el: Token[], acc: TableAccum, constraintName?: string): void => {
  // el 形如 [FOREIGN, KEY, (cols), REFERENCES, qualname, (cols)]
  const warnBadFk = () =>
    pushWarning(
      acc.warnings,
      "foreign_key_unrecognized",
      el[0]?.line,
      `foreign key in table "${acc.tableName}" was not recognized`,
    );
  const fkOpen = findOpenParen(el, 2);
  if (fkOpen === -1) {
    warnBadFk();
    return;
  }
  const fkCols = parseColumnNameList(el, fkOpen);
  if (!fkCols.length) {
    warnBadFk();
    return;
  }
  const fkClose = matchParen(el, fkOpen);

  let refIdx = -1;
  for (let i = fkClose + 1; i < el.length; i++) {
    if (kw(el[i]) === "REFERENCES") {
      refIdx = i;
      break;
    }
  }
  if (refIdx === -1) {
    warnBadFk();
    return;
  }
  const q = readQualifiedName(el, refIdx + 1);
  if (!q) {
    warnBadFk();
    return;
  }
  let refCols: string[] = [];
  const refOpen = findOpenParen(el, q.next);
  let optionFrom = q.next;
  if (refOpen === q.next) {
    refCols = parseColumnNameList(el, refOpen);
    if (!refCols.length) {
      warnBadFk();
      return;
    }
    const refClose = matchParen(el, refOpen);
    if (refClose !== -1) optionFrom = refClose + 1;
  }

  const fk: ParsedForeignKey = {
    column: fkCols.join(", "),
    referencedTable: q.name,
    referencedColumn: refCols.join(", "),
  };
  acc.fkLines.set(fk, el[0]?.line ?? refIdx);
  acc.fkMeta.set(fk, {
    columns: fkCols,
    referencedColumns: refCols,
    ...(constraintName ? { constraintName } : {}),
    ...parseReferentialOptions(el, optionFrom, acc.warnings, acc.tableName, el[0]?.line),
  });
  acc.foreignKeys.push(fk);
};

const parseUniqueConstraint = (el: Token[], acc: TableAccum): void => {
  // 取第一个括号里的列；单列时记为 unique，参与 1:1 推断。
  const op = findOpenParen(el, 1);
  if (op === -1) {
    pushWarning(
      acc.warnings,
      "constraint_skipped",
      el[0]?.line,
      `unique constraint in table "${acc.tableName}" was skipped`,
    );
    return;
  }
  const columns = parseColumnNameList(el, op);
  if (!columns.length) {
    pushWarning(
      acc.warnings,
      "constraint_skipped",
      el[0]?.line,
      `unique constraint in table "${acc.tableName}" has an invalid column list`,
    );
    return;
  }
  addUniqueKey(acc.uniqueKeys, columns);
};

// 判定一条表体元素是“约束”还是“列”，并分派解析。
const parseElement = (el: Token[], acc: TableAccum, constraintName?: string): void => {
  if (!el.length) return;
  const first = el[0];
  const firstLine = first.line;
  const head = kw(first);

  // 引用标识符（`"key"` / `` `key` `` / `[key]`）永远是列名。
  if (first.type !== "word" || head === null) {
    if (isNameTok(first)) {
      parseColumn(el, acc);
    } else {
      pushWarning(
        acc.warnings,
        "statement_skipped",
        firstLine,
        `table element in "${acc.tableName}" was not recognized`,
      );
    }
    return;
  }

  switch (head) {
    case "CONSTRAINT": {
      // CONSTRAINT <name> <PRIMARY|FOREIGN|UNIQUE|CHECK> ... 才是命名约束；
      // 否则把 CONSTRAINT 当作（保留字）列名。
      if (
        isNameTok(el[1]) &&
        ["PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "KEY", "INDEX"].includes(kw(el[2]) ?? "")
      ) {
        if (kw(el[2]) === "CHECK") {
          pushWarning(
            acc.warnings,
            "constraint_skipped",
            first.line,
            `constraint "${el[1].value}" in table "${acc.tableName}" was skipped`,
          );
          return;
        }
        parseElement(el.slice(2), acc, el[1].value);
      } else {
        parseColumn(el, acc);
      }
      return;
    }
    case "PRIMARY": {
      if (kw(el[1]) === "KEY") parsePrimaryKeyConstraint(el, acc);
      else parseColumn(el, acc);
      return;
    }
    case "FOREIGN": {
      if (kw(el[1]) === "KEY") parseForeignKeyConstraint(el, acc, constraintName);
      else parseColumn(el, acc);
      return;
    }
    case "UNIQUE": {
      const second = el[1];
      const isConstraint =
        (second && second.type === "punct" && second.value === "(") ||
        kw(second) === "KEY" ||
        kw(second) === "INDEX";
      if (isConstraint) parseUniqueConstraint(el, acc);
      else parseColumn(el, acc);
      return;
    }
    case "CHECK": {
      // CHECK ( ... ) 是约束；`check INT` 是列名。
      if (el[1] && el[1].type === "punct" && el[1].value === "(") {
        pushWarning(
          acc.warnings,
          "constraint_skipped",
          first.line,
          `check constraint in table "${acc.tableName}" was skipped`,
        );
        return;
      }
      parseColumn(el, acc);
      return;
    }
    case "KEY":
    case "INDEX":
    case "FULLTEXT":
    case "SPATIAL": {
      // 这些是 MySQL 索引子句，但也可能是（保留字）列名。判定：
      //   - 索引子句必带括号列清单；整段没有顶层 '(' 一定是列名（如 `key account_id_domain`）。
      //   - 有括号时，若第二个 token 是已知类型词，仍按列名处理（如 `key varchar(20)`）。
      const hasParen = el.some((t) => t.type === "punct" && t.value === "(");
      if (!hasParen || KNOWN_TYPES.has(kw(el[1]) ?? "")) parseColumn(el, acc);
      // 否则：索引子句，忽略。
      return;
    }
    case "PERIOD": {
      // PERIOD FOR SYSTEM_TIME (...) 是时态约束；否则列名。
      if (kw(el[1]) === "FOR") {
        pushWarning(
          acc.warnings,
          "constraint_skipped",
          first.line,
          `period constraint in table "${acc.tableName}" was skipped`,
        );
        return;
      }
      parseColumn(el, acc);
      return;
    }
    case "EXCLUDE": {
      // PG 排他约束 EXCLUDE USING ... / EXCLUDE (...)；否则列名。
      if (kw(el[1]) === "USING" || (el[1] && el[1].type === "punct" && el[1].value === "(")) {
        pushWarning(
          acc.warnings,
          "constraint_skipped",
          first.line,
          `exclude constraint in table "${acc.tableName}" was skipped`,
        );
        return;
      }
      parseColumn(el, acc);
      return;
    }
    case "LIKE": {
      // 整个 body 只有 LIKE 时由上层复制；与本地字段混用的继承语义尚未实现。
      pushWarning(
        acc.warnings,
        "statement_skipped",
        first.line,
        `LIKE clause in table "${acc.tableName}" was not represented`,
      );
      return;
    }
    default:
      parseColumn(el, acc);
  }
};

// ---------------------------------------------------------------------------
// 6. 单条 CREATE TABLE 语句解析
// ---------------------------------------------------------------------------
type StmtResult =
  | { kind: "noop" }
  | { kind: "table"; table: ParsedTable; uniqueKeys: string[][]; line: number }
  | { kind: "like"; name: string; source: string; line: number }
  | { kind: "drop_table"; names: string[]; line: number }
  | {
      kind: "alter";
      table: string;
      line: number;
      columns: ParsedColumn[];
      foreignKeys: ParsedForeignKey[];
      primaryKeys: string[];
      uniqueKeys: string[][];
      dropColumns: string[];
      dropForeignKeys: string[];
      renameColumns: Array<{ from: string; to: string }>;
      renameTo?: string;
      // CREATE UNIQUE INDEX 复用 alter 通路写回 unique 标记；
      // 挂接失败时的警告文案按该标记区分。
      via?: "create_index";
    }
  | {
      kind: "comment";
      target: "table" | "column";
      tableFull: string;
      tableShort: string;
      column?: string;
      value: string;
      line: number;
    }
  | null;

const CREATE_MODIFIERS = new Set(["TEMP", "TEMPORARY", "GLOBAL", "LOCAL", "UNLOGGED"]);

// ALTER TABLE [IF EXISTS] [ONLY] <name> <action>[, <action>]... —— 把每个 ADD 动作
// 当成一条表体元素复用 parseElement，因此 ADD COLUMN（含内联 REFERENCES）、
// ADD [CONSTRAINT ...] PRIMARY KEY / FOREIGN KEY / UNIQUE / CHECK 全部覆盖。
const parseAlter = (
  toks: Token[],
  cleaned: string,
  warnings: ParserWarning[],
  fkLines: WeakMap<ParsedForeignKey, number>,
  fkMeta: WeakMap<ParsedForeignKey, ForeignKeyMeta>,
): StmtResult => {
  let p = 1; // 跳过 ALTER
  if (kw(toks[p]) !== "TABLE") return null;
  p++;
  if (kw(toks[p]) === "IF" && kw(toks[p + 1]) === "EXISTS") p += 2;
  if (kw(toks[p]) === "ONLY") p++; // PostgreSQL: ALTER TABLE ONLY t
  const nameRead = readQualifiedName(toks, p);
  if (!nameRead) return null;

  const acc: TableAccum = {
    columns: [],
    primaryKeys: [],
    foreignKeys: [],
    uniqueKeys: [],
    tableName: nameRead.name,
    cleaned,
    warnings,
    fkLines,
    fkMeta,
  };
  const dropColumns: string[] = [];
  const dropForeignKeys: string[] = [];
  const renameColumns: Array<{ from: string; to: string }> = [];
  let renameTo: string | undefined;
  const mutationKinds = new Set<"add" | "drop" | "rename">();
  // 已对某个动作单独发过警告 / 识别出结构无关的 no-op 动作时，
  // 结尾不再重复发"整条语句被跳过"的警告。
  let warnedAction = false;
  let sawNoopAction = false;
  const warnSkippedAction = (line: number | undefined, verb: string): void => {
    warnedAction = true;
    pushWarning(
      warnings,
      "statement_skipped",
      line,
      `ALTER TABLE "${nameRead.name}" ${verb} action was skipped`,
    );
  };
  // DROP 后跟这些词时不是删列，而是删约束 / 索引 / 分区等。
  const NON_COLUMN_DROP = new Set([
    "CONSTRAINT",
    "INDEX",
    "KEY",
    "PRIMARY",
    "FOREIGN",
    "CHECK",
    "PARTITION",
    "DEFAULT",
  ]);

  const actionHeads = new Set([
    "ADD",
    "DROP",
    "RENAME",
    "MODIFY",
    "CHANGE",
    "ALTER",
    "CHECK",
    "NOCHECK",
    "WITH",
    "OWNER",
    "SET",
    "RESET",
    "ENABLE",
    "DISABLE",
    "VALIDATE",
    "ATTACH",
    "DETACH",
    "INHERIT",
    "NO",
    "CLUSTER",
    "REPLICA",
    "FORCE",
    "TRIGGER",
    "RULE",
    "SWITCH",
    "REBUILD",
    "LOCK",
    "ALGORITHM",
    "CONVERT",
    "COALESCE",
    "REORGANIZE",
    "ANALYZE",
    "OPTIMIZE",
    "REPAIR",
    "ORDER",
    "DISCARD",
    "IMPORT",
    "EXCHANGE",
  ]);
  let continuingAdd = false;
  for (const action of splitByComma(toks.slice(nameRead.next))) {
    let el = action;
    // SQL Server（SSMS 默认导出）：ALTER TABLE x WITH CHECK ADD CONSTRAINT ... /
    // WITH NOCHECK ADD ...。剥掉前缀再判动作。
    if (kw(el[0]) === "WITH" && (kw(el[1]) === "CHECK" || kw(el[1]) === "NOCHECK")) {
      el = el.slice(2);
    }
    let head = kw(el[0]);

    if (head === "ADD") {
      mutationKinds.add("add");
      continuingAdd = true;
      el = el.slice(1);
      if (kw(el[0]) === "COLUMN") {
        el = el.slice(1);
        if (kw(el[0]) === "IF" && kw(el[1]) === "NOT" && kw(el[2]) === "EXISTS") el = el.slice(3);
      }
      // Oracle: ALTER TABLE t ADD (a NUMBER, b VARCHAR2(20))
      if (el[0]?.type === "punct" && el[0].value === "(" && matchParen(el, 0) === el.length - 1) {
        for (const item of splitByComma(el.slice(1, -1))) parseElement(item, acc);
      } else if (el.length) {
        parseElement(el, acc);
      }
      continue;
    }

    // SQL Server: ALTER TABLE t ADD a INT, b VARCHAR(20).  后续列段不重复
    // `ADD`，但仍属于同一个 ADD 动作；遇到真正的新动作关键字才结束延续。
    if (continuingAdd && (head === null || !actionHeads.has(head))) {
      mutationKinds.add("add");
      parseElement(el, acc);
      continue;
    }
    continuingAdd = false;
    head = kw(el[0]);

    // SQL Server 启停约束（CHECK CONSTRAINT fk / NOCHECK CONSTRAINT all）：
    // 不影响表结构，静默跳过，也不触发结尾的整句警告。
    if ((head === "CHECK" || head === "NOCHECK") && kw(el[1]) === "CONSTRAINT") {
      sawNoopAction = true;
      continue;
    }

    if (head === "DROP") {
      let q = 1;
      if (kw(el[q]) === "COLUMN") {
        q++;
        if (kw(el[q]) === "IF" && kw(el[q + 1]) === "EXISTS") q += 2;
      } else if (kw(el[q]) === "CONSTRAINT") {
        let nameIndex = q + 1;
        if (kw(el[nameIndex]) === "IF" && kw(el[nameIndex + 1]) === "EXISTS") nameIndex += 2;
        if (isNameTok(el[nameIndex])) {
          mutationKinds.add("drop");
          dropForeignKeys.push(el[nameIndex].value);
          continue;
        }
        warnSkippedAction(el[0]?.line, "DROP CONSTRAINT");
        continue;
      } else if (kw(el[q]) === "FOREIGN" && kw(el[q + 1]) === "KEY") {
        let nameIndex = q + 2;
        if (kw(el[nameIndex]) === "IF" && kw(el[nameIndex + 1]) === "EXISTS") nameIndex += 2;
        if (isNameTok(el[nameIndex])) {
          mutationKinds.add("drop");
          dropForeignKeys.push(el[nameIndex].value);
          continue;
        }
        warnSkippedAction(el[0]?.line, "DROP FOREIGN KEY");
        continue;
      } else if (NON_COLUMN_DROP.has(kw(el[q]) ?? "")) {
        warnSkippedAction(el[0]?.line, `DROP ${kw(el[q])}`);
        continue;
      }
      if (isNameTok(el[q])) {
        mutationKinds.add("drop");
        dropColumns.push(el[q].value);
      } else {
        warnSkippedAction(el[0]?.line, "DROP");
      }
      continue;
    }

    if (head === "RENAME") {
      const second = kw(el[1]);
      if (second === "COLUMN" && isNameTok(el[2]) && kw(el[3]) === "TO" && isNameTok(el[4])) {
        mutationKinds.add("rename");
        renameColumns.push({ from: el[2].value, to: el[4].value });
        continue;
      }
      if (second === "TO" || second === "AS") {
        const q = readQualifiedName(el, 2);
        if (q) {
          mutationKinds.add("rename");
          renameTo = q.name;
          continue;
        }
      } else if (
        second !== "COLUMN" &&
        second !== "INDEX" &&
        second !== "KEY" &&
        isNameTok(el[1])
      ) {
        // MySQL: ALTER TABLE t RENAME new_name
        const q = readQualifiedName(el, 1);
        if (q) {
          mutationKinds.add("rename");
          renameTo = q.name;
          continue;
        }
      }
      warnSkippedAction(el[0]?.line, second === "COLUMN" ? "RENAME COLUMN" : "RENAME");
      continue;
    }

    if (head === "MODIFY" || head === "CHANGE") {
      warnSkippedAction(el[0]?.line, head);
      continue;
    }
    if (head === "ALTER") {
      warnSkippedAction(el[0]?.line, "ALTER COLUMN");
      continue;
    }
    if (el.length) warnSkippedAction(el[0]?.line, head ?? "unrecognized");
  }

  if (
    !acc.columns.length &&
    !acc.foreignKeys.length &&
    !acc.primaryKeys.length &&
    !acc.uniqueKeys.length &&
    !dropColumns.length &&
    !dropForeignKeys.length &&
    !renameColumns.length &&
    !renameTo
  ) {
    // 整条 ALTER 一个受支持的动作都没识别出来：发一条带行号的警告而非静默丢弃。
    if (!warnedAction && !sawNoopAction) {
      pushWarning(
        warnings,
        "statement_skipped",
        toks[0]?.line,
        `ALTER TABLE "${nameRead.name}" was skipped because no supported action was recognized`,
      );
    }
    return sawNoopAction && !warnedAction ? { kind: "noop" } : null;
  }
  if (mutationKinds.size > 1) {
    pushWarning(
      warnings,
      "statement_skipped",
      toks[0]?.line,
      `ALTER TABLE "${nameRead.name}" mixes order-sensitive action types; the final order could not be represented with certainty`,
    );
  }
  return {
    kind: "alter",
    table: nameRead.name,
    line: toks[0]?.line ?? 1,
    columns: acc.columns,
    foreignKeys: acc.foreignKeys,
    primaryKeys: acc.primaryKeys,
    uniqueKeys: acc.uniqueKeys,
    dropColumns,
    dropForeignKeys,
    renameColumns,
    ...(renameTo ? { renameTo } : {}),
  };
};

// CREATE [UNIQUE] INDEX ... ON <table> (cols) —— UNIQUE 且单列时把该列标记为
// unique（参与 1:1 推断），复用 alter 通路的 uniqueKeys 挂接。
// 非 UNIQUE、partial UNIQUE 与表达式 UNIQUE INDEX 不改变可可靠推断的 ER 语义，
// 但仍返回显式 noop，避免和“语句未识别”的 null 路径混在一起。
const parseCreateIndex = (toks: Token[], from: number, isUnique: boolean): StmtResult => {
  let p = from;
  if (kw(toks[p]) === "CONCURRENTLY") p++;
  if (kw(toks[p]) === "IF" && kw(toks[p + 1]) === "NOT" && kw(toks[p + 2]) === "EXISTS") p += 3;
  // 索引名可省略（PostgreSQL: CREATE UNIQUE INDEX ON t (col)）。
  if (kw(toks[p]) !== "ON") {
    const idxName = readQualifiedName(toks, p);
    if (!idxName) return null;
    p = idxName.next;
  }
  if (kw(toks[p]) !== "ON") return null;
  p++;
  if (kw(toks[p]) === "ONLY") p++;
  const tbl = readQualifiedName(toks, p);
  if (!tbl) return null;
  p = tbl.next;
  if (kw(toks[p]) === "USING" && toks[p + 1]) p += 2; // USING btree 等
  const open = findOpenParen(toks, p);
  if (open === -1) return null;
  const close = matchParen(toks, open);
  if (close === -1) return null;
  if (!isUnique) return { kind: "noop" };
  // PostgreSQL partial UNIQUE INDEX 只约束满足谓词的行，不能当作整表候选键。
  if (toks.slice(close + 1).some((token) => kw(token) === "WHERE")) return { kind: "noop" };
  const cols = parseSimpleIndexColumnList(toks, open);
  // 表达式索引同样不能证明原始列唯一。复合普通列索引则作为一个整体保留。
  if (!cols) return { kind: "noop" };
  return {
    kind: "alter",
    table: tbl.name,
    line: toks[0]?.line ?? 1,
    columns: [],
    foreignKeys: [],
    primaryKeys: [],
    uniqueKeys: [cols],
    dropColumns: [],
    dropForeignKeys: [],
    renameColumns: [],
    via: "create_index",
  };
};

// COMMENT ON {TABLE|COLUMN} <qual> IS '...' —— PostgreSQL / Oracle 用单独语句设置注释。
// 表名按 SQL 解析器的限定名规则保留 schema；COLUMN 形式的最后一段是列名。
const parseCommentOn = (toks: Token[]): StmtResult => {
  const target = kw(toks[2]);
  if (target !== "TABLE" && target !== "COLUMN") return null;
  const nameRead = readQualifiedName(toks, 3);
  if (!nameRead) return null;
  if (kw(toks[nameRead.next]) !== "IS") return null;
  const value = readCommentValue(toks[nameRead.next + 1]); // 字符串值；IS NULL 时为 null
  if (value === null) return null;
  const segs = nameRead.name.split(".");
  if (target === "COLUMN") {
    if (segs.length < 2) return null;
    return {
      kind: "comment",
      target: "column",
      tableFull: segs.slice(0, -1).join("."),
      tableShort: segs[segs.length - 2],
      column: segs[segs.length - 1],
      value,
      line: toks[0]?.line ?? 1,
    };
  }
  return {
    kind: "comment",
    target: "table",
    tableFull: nameRead.name,
    tableShort: segs[segs.length - 1],
    value,
    line: toks[0]?.line ?? 1,
  };
};

const extractTableComment = (suffix: Token[]): string | undefined => {
  for (let i = 0; i < suffix.length; i++) {
    if (kw(suffix[i]) === "COMMENT") {
      let j = i + 1;
      if (suffix[j] && suffix[j].type === "punct" && suffix[j].value === "=") j++;
      const cv = readCommentValue(suffix[j]);
      if (cv !== null) return cv;
    }
  }
  return undefined;
};

const parseStatement = (
  toks: Token[],
  cleaned: string,
  warnings: ParserWarning[],
  fkLines: WeakMap<ParsedForeignKey, number>,
  fkMeta: WeakMap<ParsedForeignKey, ForeignKeyMeta>,
): StmtResult => {
  if (kw(toks[0]) === "ALTER") return parseAlter(toks, cleaned, warnings, fkLines, fkMeta);
  if (kw(toks[0]) === "COMMENT" && kw(toks[1]) === "ON") return parseCommentOn(toks);
  if (kw(toks[0]) === "DROP" && kw(toks[1]) === "TABLE") {
    let p = 2;
    if (kw(toks[p]) === "IF" && kw(toks[p + 1]) === "EXISTS") p += 2;
    const names: string[] = [];
    for (const part of splitByComma(toks.slice(p))) {
      const read = readQualifiedName(part, 0);
      if (read) names.push(read.name);
    }
    return names.length ? { kind: "drop_table", names, line: toks[0]?.line ?? 1 } : null;
  }

  let p = 0;
  if (kw(toks[p]) !== "CREATE") return null;
  p++;
  // CREATE OR REPLACE TABLE ...（MariaDB / 部分方言）
  if (kw(toks[p]) === "OR" && kw(toks[p + 1]) === "REPLACE") p += 2;
  while (CREATE_MODIFIERS.has(kw(toks[p]) ?? "")) p++;
  // CREATE [UNIQUE] [CLUSTERED|NONCLUSTERED] INDEX ... ON <table> (cols)
  {
    let q = p;
    let uniqueIndex = false;
    if (kw(toks[q]) === "UNIQUE") {
      uniqueIndex = true;
      q++;
    }
    while (kw(toks[q]) === "CLUSTERED" || kw(toks[q]) === "NONCLUSTERED") q++;
    if (kw(toks[q]) === "INDEX") return parseCreateIndex(toks, q + 1, uniqueIndex);
  }
  if (kw(toks[p]) !== "TABLE") return null;
  p++;
  if (kw(toks[p]) === "IF" && kw(toks[p + 1]) === "NOT" && kw(toks[p + 2]) === "EXISTS") p += 3;

  const nameRead = readQualifiedName(toks, p);
  if (!nameRead) return null;
  const tableName = nameRead.name;
  p = nameRead.next;

  // 处理特殊形式：
  const headKw = kw(toks[p]);

  // CREATE TABLE child PARTITION OF parent ... —— 分区子表，无独立列定义，跳过。
  if (headKw === "PARTITION" && kw(toks[p + 1]) === "OF") {
    pushWarning(
      warnings,
      "statement_skipped",
      toks[p]?.line,
      `CREATE TABLE "${tableName}" PARTITION OF was skipped because it has no standalone column definition`,
    );
    return null;
  }

  // CREATE TABLE t AS SELECT ... —— 无法从 SELECT 推导列结构，跳过。
  if (headKw === "AS" || headKw === "SELECT") {
    pushWarning(
      warnings,
      "statement_skipped",
      toks[p]?.line,
      `CREATE TABLE "${tableName}" AS SELECT was skipped because columns cannot be inferred`,
    );
    return null;
  }

  // CREATE TABLE copy LIKE original —— 复制源表结构。
  if (headKw === "LIKE") {
    const src = readQualifiedName(toks, p + 1);
    return src
      ? { kind: "like", name: tableName, source: src.name, line: toks[p]?.line ?? 1 }
      : null;
  }

  // 主体括号
  const open = findOpenParen(toks, p);
  if (open === -1) {
    pushWarning(
      warnings,
      "statement_skipped",
      toks[p]?.line ?? toks[0]?.line,
      `CREATE TABLE "${tableName}" was skipped because its column list was not found`,
    );
    return null;
  }
  const close = matchParen(toks, open);
  if (close === -1) {
    pushWarning(
      warnings,
      "statement_skipped",
      toks[open]?.line,
      `CREATE TABLE "${tableName}" was skipped because its column list is not closed`,
    );
    return null;
  }

  // 顶层若整体是 `( LIKE other )`，按结构复制处理。
  const bodyToks = toks.slice(open + 1, close);
  if (kw(bodyToks[0]) === "LIKE") {
    const src = readQualifiedName(bodyToks, 1);
    if (src && splitByComma(bodyToks).length === 1) {
      return { kind: "like", name: tableName, source: src.name, line: bodyToks[0]?.line ?? 1 };
    }
  }

  const suffix = toks.slice(close + 1);
  const tableComment = extractTableComment(suffix);
  const trailingStatement = suffix.find((token) =>
    [
      "CREATE",
      "ALTER",
      "DROP",
      "COMMENT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "MERGE",
      "SELECT",
      "GRANT",
      "REVOKE",
    ].includes(kw(token) ?? ""),
  );
  if (trailingStatement) {
    pushWarning(
      warnings,
      "statement_skipped",
      trailingStatement.line,
      `content after CREATE TABLE "${tableName}" looks like another unterminated statement`,
    );
  }
  const unsupportedSuffix = suffix.find((token) =>
    ["INHERITS", "PARTITION", "AS", "OF"].includes(kw(token) ?? ""),
  );
  if (unsupportedSuffix) {
    pushWarning(
      warnings,
      "statement_skipped",
      unsupportedSuffix.line,
      `table suffix "${kw(unsupportedSuffix)}" on "${tableName}" was not represented`,
    );
  }

  const acc: TableAccum = {
    columns: [],
    primaryKeys: [],
    foreignKeys: [],
    uniqueKeys: [],
    tableName,
    cleaned,
    warnings,
    fkLines,
    fkMeta,
  };

  for (const el of splitByComma(bodyToks)) parseElement(el, acc);

  const sameColumnName = (left: string, right: string): boolean =>
    left === right || left.toLowerCase() === right.toLowerCase();
  const seenColumns = new Set<string>();
  for (const column of acc.columns) {
    const key = column.name.toLowerCase();
    if (seenColumns.has(key)) {
      pushWarning(
        warnings,
        "statement_skipped",
        toks[0]?.line,
        `column "${column.name}" is defined more than once in table "${tableName}"`,
      );
    }
    seenColumns.add(key);
  }
  const missingPrimaryKeys = acc.primaryKeys.filter(
    (name) => !acc.columns.some((column) => sameColumnName(column.name, name)),
  );
  for (const name of missingPrimaryKeys) {
    pushWarning(
      warnings,
      "constraint_skipped",
      toks[0]?.line,
      `primary key on table "${tableName}" references missing column "${name}"`,
    );
  }
  acc.primaryKeys = acc.primaryKeys.filter(
    (name, index, all) =>
      !missingPrimaryKeys.some((missing) => sameColumnName(missing, name)) &&
      all.findIndex((candidate) => sameColumnName(candidate, name)) === index,
  );
  acc.uniqueKeys = acc.uniqueKeys.filter((key) => {
    const missing = key.filter(
      (name) => !acc.columns.some((column) => sameColumnName(column.name, name)),
    );
    if (!missing.length) return true;
    pushWarning(
      warnings,
      "constraint_skipped",
      toks[0]?.line,
      `unique constraint on table "${tableName}" references missing column${missing.length > 1 ? "s" : ""} "${missing.join('", "')}"`,
    );
    return false;
  });
  if (!acc.columns.length) {
    pushWarning(
      warnings,
      "statement_skipped",
      toks[0]?.line,
      `CREATE TABLE "${tableName}" produced no supported columns`,
    );
  }

  // 表级单列 UNIQUE 约束 -> 标记列 unique（用于 1:1 推断）。复合
  // UNIQUE 仍保留在内部 candidate-key 列表中，不错误提升任一单列。
  for (const col of acc.columns) {
    if (acc.primaryKeys.some((name) => sameColumnName(name, col.name))) {
      col.isPrimaryKey = true;
    }
    if (
      acc.uniqueKeys.some((key) => key.length === 1 && key[0] === col.name) &&
      !col.isPrimaryKey
    ) {
      col.isUnique = true;
    }
  }

  const table: ParsedTable = {
    name: tableName,
    columns: acc.columns,
    primaryKeys: acc.primaryKeys,
    foreignKeys: acc.foreignKeys,
    ...(tableComment ? { comment: tableComment } : {}),
  };
  return { kind: "table", table, uniqueKeys: acc.uniqueKeys, line: toks[0]?.line ?? 1 };
};

// ---------------------------------------------------------------------------
// 7. 入口
// ---------------------------------------------------------------------------
export const parseSQLTables = (sql: string): ParseResult => {
  const warnings: ParserWarning[] = [];
  const cleaned = blankComments(sql, warnings);
  const allToks = tokenize(cleaned);
  const fkLines = new WeakMap<ParsedForeignKey, number>();
  const fkMeta = new WeakMap<ParsedForeignKey, ForeignKeyMeta>();
  const uniqueKeys = new WeakMap<ParsedTable, string[][]>();
  const tables: ParsedTable[] = [];

  interface Resolution {
    table?: ParsedTable;
    ambiguous?: boolean;
  }

  // 精确匹配 → 大小写不敏感 → 当前表 schema → 唯一短名。短名有多个候选时
  // 不再猜第一个，否则 app.account / crm.account 会产生静默错连。
  const resolveTable = (full: string, context?: ParsedTable): Resolution => {
    const exact = tables.filter((table) => table.name === full);
    if (exact.length) return { table: exact[exact.length - 1] };
    const lower = full.toLowerCase();
    const ci = tables.filter((table) => table.name.toLowerCase() === lower);
    if (ci.length) return { table: ci[ci.length - 1] };

    const queryQualified = full.includes(".");
    if (!queryQualified && context?.name.includes(".")) {
      const contextSchema = context.name.slice(0, context.name.lastIndexOf("."));
      const contextual = `${contextSchema}.${full}`.toLowerCase();
      const matches = tables.filter((table) => table.name.toLowerCase() === contextual);
      if (matches.length === 1) return { table: matches[0] };
      if (matches.length > 1) return { ambiguous: true };
    }

    const short = shortTableName(full).toLowerCase();
    const candidates = tables.filter((table) => {
      if (queryQualified && table.name.includes(".")) return false;
      return shortTableName(table.name).toLowerCase() === short;
    });
    if (candidates.length === 1) return { table: candidates[0] };
    return candidates.length > 1 ? { ambiguous: true } : {};
  };

  const noteTableName = (name: string, line: number): void => {
    if (tables.some((table) => table.name.toLowerCase() === name.toLowerCase())) {
      pushWarning(warnings, "duplicate_table", line, `table "${name}" is defined more than once`);
    }
  };

  type CommentResult = Extract<NonNullable<StmtResult>, { kind: "comment" }>;
  const pendingComments: CommentResult[] = [];
  const applyComment = (comment: CommentResult): boolean => {
    const resolution = resolveTable(comment.tableFull);
    if (!resolution.table || resolution.ambiguous) return false;
    if (comment.target === "table") {
      resolution.table.comment = comment.value;
    } else {
      const column = resolution.table.columns.find((item) => item.name === comment.column);
      if (column) column.comment = comment.value;
    }
    return true;
  };
  const applyPendingComments = (): void => {
    for (let i = pendingComments.length - 1; i >= 0; i--) {
      if (applyComment(pendingComments[i])) pendingComments.splice(i, 1);
    }
  };

  const referencedBy = (
    target: ParsedTable,
  ): Array<{ owner: ParsedTable; fk: ParsedForeignKey }> => {
    const out: Array<{ owner: ParsedTable; fk: ParsedForeignKey }> = [];
    for (const owner of tables) {
      for (const fk of owner.foreignKeys) {
        if (resolveTable(fk.referencedTable, owner).table === target) out.push({ owner, fk });
      }
    }
    return out;
  };

  const sameColumn = (left: string, right: string): boolean =>
    left === right || left.toLowerCase() === right.toLowerCase();

  const removeIncomingForeignKeys = (target: ParsedTable, column?: string): void => {
    for (const { owner, fk } of referencedBy(target)) {
      const meta = fkMeta.get(fk);
      if (!column || meta?.referencedColumns.some((name) => sameColumn(name, column))) {
        owner.foreignKeys = owner.foreignKeys.filter((candidate) => candidate !== fk);
      }
    }
  };

  // DDL 必须按源码顺序归约。旧实现先收集所有 CREATE 再统一套 ALTER，导致
  // 前置 ALTER、DROP/重建、约束删除和重命名都绑定到错误的时间点。
  for (const stmt of splitStatements(allToks)) {
    const warningCount = warnings.length;
    const result = parseStatement(stmt, cleaned, warnings, fkLines, fkMeta);
    if (!result) {
      // null 只能表示“没有完整识别”。只要具体解析分支没有给出更精确的诊断，
      // 就在统一出口补一条，保证任何非空 SQL 语句都不会被静默吞掉。
      if (warnings.length === warningCount) {
        const raw = cleaned.slice(stmt[0]?.start ?? 0, stmt[stmt.length - 1]?.end ?? 0);
        const compact = raw.replace(/\s+/g, " ").trim();
        const snippet = compact.length > 80 ? `${compact.slice(0, 80)}…` : compact;
        pushWarning(
          warnings,
          "statement_skipped",
          stmt[0]?.line,
          `statement "${snippet}" was skipped because it is unsupported or malformed`,
        );
      }
      continue;
    }
    if (result.kind === "noop") continue;

    if (result.kind === "table") {
      noteTableName(result.table.name, result.line);
      tables.push(result.table);
      const keys: string[][] = [];
      addUniqueKey(keys, result.table.primaryKeys);
      for (const key of result.uniqueKeys) addUniqueKey(keys, key);
      uniqueKeys.set(result.table, keys);
      applyPendingComments();
      continue;
    }

    if (result.kind === "like") {
      const sourceResolution = resolveTable(result.source);
      const source = sourceResolution.table;
      if (!source || sourceResolution.ambiguous) {
        pushWarning(
          warnings,
          "table_reference_missing",
          result.line,
          sourceResolution.ambiguous
            ? `CREATE TABLE "${result.name}" LIKE source "${result.source}" is ambiguous`
            : `CREATE TABLE "${result.name}" LIKE source "${result.source}" was not found`,
        );
      }
      noteTableName(result.name, result.line);
      const table: ParsedTable = {
        name: result.name,
        columns: source ? source.columns.map((column) => ({ ...column })) : [],
        primaryKeys: source ? [...source.primaryKeys] : [],
        foreignKeys: [],
      };
      tables.push(table);
      uniqueKeys.set(table, source ? (uniqueKeys.get(source) ?? []).map((key) => [...key]) : []);
      applyPendingComments();
      continue;
    }

    if (result.kind === "drop_table") {
      for (const name of result.names) {
        const resolution = resolveTable(name);
        // 脚本可能从一个已有数据库状态开始，当前输入中没定义过的 DROP 仍是
        // 可完整理解的安全 no-op（尤其常见于 DROP TABLE IF EXISTS）。
        if (!resolution.table || resolution.ambiguous) continue;
        removeIncomingForeignKeys(resolution.table);
        const index = tables.indexOf(resolution.table);
        if (index !== -1) tables.splice(index, 1);
      }
      continue;
    }

    if (result.kind === "comment") {
      if (!applyComment(result)) pendingComments.push(result);
      continue;
    }

    const resolution = resolveTable(result.table);
    const table = resolution.table;
    if (!table || resolution.ambiguous) {
      pushWarning(
        warnings,
        "table_reference_missing",
        result.line,
        result.via === "create_index"
          ? `CREATE INDEX on "${result.table}" skipped because the table ${resolution.ambiguous ? "is ambiguous" : "was not found"}`
          : `ALTER TABLE "${result.table}" skipped because the table ${resolution.ambiguous ? "is ambiguous" : "was not found"}`,
      );
      continue;
    }

    for (const column of result.columns) {
      if (!table.columns.some((item) => sameColumn(item.name, column.name))) {
        table.columns.push(column);
      } else {
        pushWarning(
          warnings,
          "statement_skipped",
          result.line,
          `column "${column.name}" was not added to table "${table.name}" because it already exists`,
        );
      }
    }
    for (const primaryKey of result.primaryKeys) {
      if (!table.columns.some((column) => sameColumn(column.name, primaryKey))) {
        pushWarning(
          warnings,
          "constraint_skipped",
          result.line,
          `primary key on table "${table.name}" references missing column "${primaryKey}"`,
        );
        continue;
      }
      if (!table.primaryKeys.some((name) => sameColumn(name, primaryKey))) {
        table.primaryKeys.push(primaryKey);
      }
      const column = table.columns.find((item) => sameColumn(item.name, primaryKey));
      if (column) column.isPrimaryKey = true;
    }
    const tableKeys = uniqueKeys.get(table) ?? [];
    const validPrimaryKeys = result.primaryKeys.filter((name) =>
      table.columns.some((column) => sameColumn(column.name, name)),
    );
    if (validPrimaryKeys.length === result.primaryKeys.length && validPrimaryKeys.length) {
      addUniqueKey(tableKeys, validPrimaryKeys);
    }
    for (const key of result.uniqueKeys) {
      const missing = key.filter(
        (name) => !table.columns.some((column) => sameColumn(column.name, name)),
      );
      if (missing.length) {
        pushWarning(
          warnings,
          "constraint_skipped",
          result.line,
          `unique constraint on table "${table.name}" references missing column${missing.length > 1 ? "s" : ""} "${missing.join('", "')}"`,
        );
        continue;
      }
      addUniqueKey(tableKeys, key);
      if (key.length === 1) {
        const column = table.columns.find((item) => sameColumn(item.name, key[0]));
        if (column && !column.isPrimaryKey) column.isUnique = true;
      }
    }
    uniqueKeys.set(table, tableKeys);
    table.foreignKeys.push(...result.foreignKeys);

    if (result.dropForeignKeys.length) {
      const names = new Set(result.dropForeignKeys.map((name) => name.toLowerCase()));
      let removed = false;
      table.foreignKeys = table.foreignKeys.filter((fk) => {
        const constraintName = fkMeta.get(fk)?.constraintName;
        if (constraintName && names.has(constraintName.toLowerCase())) {
          removed = true;
          return false;
        }
        return true;
      });
      if (!removed) {
        pushWarning(
          warnings,
          "statement_skipped",
          result.line,
          `ALTER TABLE "${result.table}" DROP CONSTRAINT action was skipped`,
        );
      }
    }

    for (const rename of result.renameColumns) {
      const column = table.columns.find((item) => sameColumn(item.name, rename.from));
      if (!column) {
        pushWarning(
          warnings,
          "table_reference_missing",
          result.line,
          `ALTER TABLE "${table.name}" cannot rename missing column "${rename.from}"`,
        );
        continue;
      }
      const incoming = referencedBy(table);
      column.name = rename.to;
      table.primaryKeys = table.primaryKeys.map((name) =>
        sameColumn(name, rename.from) ? rename.to : name,
      );
      const keys = uniqueKeys.get(table) ?? [];
      for (const key of keys) {
        for (let i = 0; i < key.length; i++) {
          if (sameColumn(key[i], rename.from)) key[i] = rename.to;
        }
      }
      for (const fk of table.foreignKeys) {
        const meta = fkMeta.get(fk);
        if (!meta) continue;
        meta.columns = meta.columns.map((name) =>
          sameColumn(name, rename.from) ? rename.to : name,
        );
        fk.column = meta.columns.join(", ");
      }
      for (const { fk } of incoming) {
        const meta = fkMeta.get(fk);
        if (!meta) continue;
        meta.referencedColumns = meta.referencedColumns.map((name) =>
          sameColumn(name, rename.from) ? rename.to : name,
        );
        fk.referencedColumn = meta.referencedColumns.join(", ");
      }
    }

    for (const droppedColumn of result.dropColumns) {
      if (!table.columns.some((column) => sameColumn(column.name, droppedColumn))) {
        pushWarning(
          warnings,
          "table_reference_missing",
          result.line,
          `ALTER TABLE "${table.name}" cannot drop missing column "${droppedColumn}"`,
        );
        continue;
      }
      if (table.primaryKeys.some((name) => sameColumn(name, droppedColumn))) {
        table.primaryKeys = [];
        for (const column of table.columns) column.isPrimaryKey = false;
      }
      table.columns = table.columns.filter((column) => !sameColumn(column.name, droppedColumn));
      table.foreignKeys = table.foreignKeys.filter(
        (fk) => !fkMeta.get(fk)?.columns.some((name) => sameColumn(name, droppedColumn)),
      );
      uniqueKeys.set(
        table,
        (uniqueKeys.get(table) ?? []).filter(
          (key) => !key.some((name) => sameColumn(name, droppedColumn)),
        ),
      );
      removeIncomingForeignKeys(table, droppedColumn);
    }

    if (result.renameTo) {
      const references = referencedBy(table);
      const oldName = table.name;
      const schema = oldName.includes(".") ? oldName.slice(0, oldName.lastIndexOf(".")) : "";
      table.name =
        result.renameTo.includes(".") || !schema ? result.renameTo : `${schema}.${result.renameTo}`;
      for (const { fk } of references) fk.referencedTable = table.name;
      applyPendingComments();
    }
  }

  for (const comment of pendingComments) {
    pushWarning(
      warnings,
      "table_reference_missing",
      comment.line,
      `COMMENT ON ${comment.target.toUpperCase()} "${comment.tableFull}" skipped because the table was not found`,
    );
  }

  // 由各表的外键推导关系，并做基数推断。关系的 to 端回写为实际命中的表名
  //（而非 FK 原文），保证 builder 端按名字查实体一定命中，不再产生同表的
  // "幽灵"占位实体。
  const relationships: ParsedRelationship[] = [];
  for (const table of tables) {
    for (const fk of table.foreignKeys) {
      const meta = fkMeta.get(fk) ?? {
        columns: [fk.column],
        referencedColumns: fk.referencedColumn ? [fk.referencedColumn] : [],
      };
      const targetResolution = resolveTable(fk.referencedTable, table);
      const target = targetResolution.table;
      if (targetResolution.ambiguous) {
        pushWarning(
          warnings,
          "table_reference_missing",
          fkLines.get(fk),
          `table "${table.name}" references ambiguous table "${fk.referencedTable}"`,
        );
        continue;
      }
      if (!target) {
        pushWarning(
          warnings,
          "table_reference_missing",
          fkLines.get(fk),
          `table "${table.name}" references missing table "${fk.referencedTable}"`,
        );
      }

      if (
        !meta.columns.length ||
        meta.columns.some((name) => !table.columns.some((column) => sameColumn(column.name, name)))
      ) {
        pushWarning(
          warnings,
          "foreign_key_unrecognized",
          fkLines.get(fk),
          `foreign key in table "${table.name}" references a missing local column`,
        );
        continue;
      }

      let referencedColumns = [...meta.referencedColumns];
      if (target && !referencedColumns.length) referencedColumns = [...target.primaryKeys];
      if (target && referencedColumns.length !== meta.columns.length) {
        pushWarning(
          warnings,
          "foreign_key_unrecognized",
          fkLines.get(fk),
          `foreign key in table "${table.name}" has mismatched local and referenced column counts`,
        );
        continue;
      }
      if (
        target &&
        referencedColumns.some(
          (name) => !target.columns.some((column) => sameColumn(column.name, name)),
        )
      ) {
        pushWarning(
          warnings,
          "foreign_key_unrecognized",
          fkLines.get(fk),
          `foreign key in table "${table.name}" references a missing column in table "${target.name}"`,
        );
        continue;
      }

      if (target && referencedColumns.length) {
        const targetKey = [...referencedColumns]
          .map((name) => name.toLowerCase())
          .sort()
          .join("\u0000");
        const referencesCandidateKey = (uniqueKeys.get(target) ?? []).some(
          (key) =>
            [...key]
              .map((name) => name.toLowerCase())
              .sort()
              .join("\u0000") === targetKey,
        );
        if (!referencesCandidateKey) {
          pushWarning(
            warnings,
            "foreign_key_unrecognized",
            fkLines.get(fk),
            `foreign key in table "${table.name}" references columns in table "${target.name}" that are not a primary or unique key`,
          );
        }

        for (let i = 0; i < meta.columns.length; i++) {
          const sourceColumn = table.columns.find((column) =>
            sameColumn(column.name, meta.columns[i]),
          );
          const targetColumn = target.columns.find((column) =>
            sameColumn(column.name, referencedColumns[i]),
          );
          if (!sourceColumn || !targetColumn || !sourceColumn.type || !targetColumn.type) continue;
          const compatibility = relationshipTypesCompatible(sourceColumn.type, targetColumn.type);
          if (!compatibility.compatible) {
            pushWarning(
              warnings,
              "foreign_key_unrecognized",
              fkLines.get(fk),
              compatibility.uncertain
                ? `foreign key column types "${sourceColumn.type}" and "${targetColumn.type}" could not be verified as compatible`
                : `foreign key column types "${sourceColumn.type}" and "${targetColumn.type}" are incompatible`,
            );
          }
        }
      }

      meta.referencedColumns = referencedColumns;
      fk.column = meta.columns.join(", ");
      fk.referencedColumn = referencedColumns.join(", ");
      if (target) fk.referencedTable = target.name;

      const sourceKey = [...meta.columns]
        .map((name) => name.toLowerCase())
        .sort()
        .join("\u0000");
      const isCandidateKey = (uniqueKeys.get(table) ?? []).some(
        (key) =>
          [...key]
            .map((name) => name.toLowerCase())
            .sort()
            .join("\u0000") === sourceKey,
      );
      const fkColumn =
        meta.columns.length === 1
          ? table.columns.find((column) => sameColumn(column.name, meta.columns[0]))
          : undefined;
      relationships.push({
        from: table.name,
        to: target ? target.name : fk.referencedTable,
        label: meta.columns.join(", "),
        fromCardinality: isCandidateKey ? "1" : "N",
        toCardinality: "1",
        ...(meta.onDelete ? { onDelete: meta.onDelete } : {}),
        ...(meta.onUpdate ? { onUpdate: meta.onUpdate } : {}),
        ...(fkColumn?.comment ? { comment: fkColumn.comment } : {}),
      });
    }
  }

  return {
    tables,
    relationships,
    ...(warnings.length ? { warnings } : {}),
  };
};
